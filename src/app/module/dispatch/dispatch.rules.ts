import {
  type DispatchSettingsValues,
  METERS_PER_KM,
  MS_PER_MINUTE,
  NO_SHOW_PENALTY_CAP,
  LOCATION_STALE_MINUTES,
  PRIORITY_BUMP_LEVEL,
  STALE_LOCATION_PENALTY,
  WEIGHT_SUM_TOLERANCE,
} from '../../constants/dispatch'
import { PRIORITY_ORDER, Priority } from '../../constants/relief'
import { MAX_ACTIVE_TASKS_PER_VOLUNTEER, MAX_RATING } from '../../constants/task'

// Pure decisions of the dispatch engine: they take values and a clock, never `req`, `config` or the
// database, so they can be tested without any setup.

// When a request first becomes due: how long it waits depends on how urgent it is.
export const firstOfferAt = (
  createdAt: Date,
  priority: Priority,
  settings: DispatchSettingsValues,
) => new Date(createdAt.getTime() + settings.waitMinutes[priority] * MS_PER_MINUTE)

// How long a volunteer has to answer an offer. A critical request gets a short window.
export const offerWindowMs = (priority: Priority, settings: DispatchSettingsValues) =>
  (priority === Priority.CRITICAL
    ? settings.criticalOfferWindowMinutes
    : settings.offerWindowMinutes) * MS_PER_MINUTE

// How long after accepting a volunteer has to set off.
export const setOffLimitMs = (priority: Priority, settings: DispatchSettingsValues) =>
  (priority === Priority.CRITICAL
    ? settings.criticalSetOffWithinMinutes
    : settings.setOffWithinMinutes) * MS_PER_MINUTE

// An accepted task is overdue once the set-off limit for its request's priority has passed.
export const isSetOffOverdue = (
  acceptedAt: Date,
  priority: Priority,
  settings: DispatchSettingsValues,
  now: Date,
) => now.getTime() - acceptedAt.getTime() >= setOffLimitMs(priority, settings)

// The shortest set-off limit there is: the cut-off for the first database read of the stuck check.
export const shortestSetOffLimitMs = (settings: DispatchSettingsValues) =>
  Math.min(setOffLimitMs(Priority.CRITICAL, settings), setOffLimitMs(Priority.MEDIUM, settings))

// How far from the request to look at this escalation level: the start radius, widened by the factor
// once per level, never past the maximum.
export const radiusMetersForLevel = (level: number, settings: DispatchSettingsValues) =>
  Math.min(settings.startRadiusKm * settings.radiusFactor ** level, settings.maxRadiusKm) *
  METERS_PER_KM

// One step more urgent, or null when it is already critical.
export const nextPriority = (priority: Priority): Priority | null => {
  const index = PRIORITY_ORDER.indexOf(priority)
  return index > 0 ? (PRIORITY_ORDER[index - 1] ?? null) : null
}

export interface DispatchProgress {
  level: number
  unserved: boolean
  priority: Priority
  priorityBumped: boolean
}

export interface Escalation {
  progress: DispatchProgress
  // Set when this step raised the priority: the one it had before.
  raisedFrom: Priority | null
  // True only on the step that made the request unserved (so the staff are told once).
  becameUnserved: boolean
}

// What happens when a round ends with nobody accepting, or there was nobody to ask: search wider, and
// from `PRIORITY_BUMP_LEVEL` on raise the priority one step. After `maxRounds` such rounds the request
// is unserved. Once it is, there is nothing further to escalate: it is only retried.
export const escalate = (
  progress: DispatchProgress,
  settings: DispatchSettingsValues,
): Escalation => {
  if (progress.unserved) return { progress, raisedFrom: null, becameUnserved: false }

  const level = progress.level + 1
  const raisedTo =
    !progress.priorityBumped && level >= PRIORITY_BUMP_LEVEL
      ? nextPriority(progress.priority)
      : null
  const unserved = level >= settings.maxRounds

  return {
    progress: {
      level,
      unserved,
      priority: raisedTo ?? progress.priority,
      priorityBumped: progress.priorityBumped || raisedTo !== null,
    },
    raisedFrom: raisedTo ? progress.priority : null,
    becameUnserved: unserved,
  }
}

// A volunteer's position is stale when it is older than LOCATION_STALE_MINUTES, or has no time recorded
// (it was saved before the time was kept, so nobody can say how old it is).
export const isLocationStale = (updatedAt: Date | null | undefined, now: Date) =>
  !updatedAt || now.getTime() - updatedAt.getTime() > LOCATION_STALE_MINUTES * MS_PER_MINUTE

export interface Candidate {
  id: string
  distanceMeters: number
  reliabilityScore: number
  activeTasks: number
  noShowCount: number
  // How many of the skills the request wants this volunteer has.
  matchedSkills: number
  // Their last position is old, or has no time at all.
  staleLocation: boolean
}

export interface RankContext {
  radiusMeters: number
  // How many skills the request wants in all (0 when it asks for none).
  wantedSkills: number
}

export interface ScoreParts {
  distance: number
  reliability: number
  load: number
  skillMatch: number
  noShow: number
  // 1 when the volunteer's position is stale (a penalty), else 0.
  staleLocation: number
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value))

// Each part is 0 to 1, higher is better. Skills only ever add: a request that wants none scores 0 there
// for everybody, and an unskilled volunteer is not excluded.
export const scoreParts = (candidate: Candidate, context: RankContext): ScoreParts => ({
  distance: 1 - clamp01(candidate.distanceMeters / context.radiusMeters),
  reliability: clamp01(candidate.reliabilityScore / MAX_RATING),
  load: 1 - clamp01(candidate.activeTasks / MAX_ACTIVE_TASKS_PER_VOLUNTEER),
  skillMatch:
    context.wantedSkills > 0 ? clamp01(candidate.matchedSkills / context.wantedSkills) : 0,
  noShow: clamp01(candidate.noShowCount / NO_SHOW_PENALTY_CAP),
  staleLocation: candidate.staleLocation ? 1 : 0,
})

export const scoreCandidate = (
  candidate: Candidate,
  context: RankContext,
  weights: DispatchSettingsValues['weights'],
) => {
  const parts = scoreParts(candidate, context)
  return (
    weights.distance * parts.distance +
    weights.reliability * parts.reliability +
    weights.load * parts.load +
    weights.skillMatch * parts.skillMatch -
    weights.noShowPenalty * parts.noShow -
    STALE_LOCATION_PENALTY * parts.staleLocation
  )
}

// Best first; a tie goes to the nearer volunteer, then to the lower id, so the order never flips
// between two runs.
export const rankCandidates = <T extends Candidate>(
  candidates: readonly T[],
  context: RankContext,
  settings: DispatchSettingsValues,
) =>
  candidates
    .map((candidate) => ({
      candidate,
      score: scoreCandidate(candidate, context, settings.weights),
    }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.candidate.distanceMeters - b.candidate.distanceMeters ||
        a.candidate.id.localeCompare(b.candidate.id),
    )
    .map((entry) => entry.candidate)

// --- Editing the settings ------------------------------------------------------------------------

// A settings edit as dotted paths to the value they set: `{ 'waitMinutes.critical': 3, enabled: false }`.
export type SettingsChange = Record<string, number | boolean | string>

// One level of nesting is all the settings have (`waitMinutes`, `weights`). The paths come from the
// validated body, never from the caller's own keys, so nothing but a known setting can appear here.
export const flattenSettingsPayload = (payload: object): SettingsChange => {
  const flat: SettingsChange = {}
  const add = (path: string, value: unknown) => {
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') {
      flat[path] = value
    }
  }
  for (const [key, value] of Object.entries(payload)) {
    if (typeof value === 'object' && value !== null) {
      for (const [inner, innerValue] of Object.entries(value)) add(`${key}.${inner}`, innerValue)
    } else {
      add(key, value)
    }
  }
  return flat
}

const readPath = (values: object, path: string) =>
  path.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown>)?.[key], values)

// Only the entries that would really change something.
export const onlyChanged = (current: DispatchSettingsValues, change: SettingsChange) =>
  Object.fromEntries(
    Object.entries(change).filter(([path, value]) => readPath(current, path) !== value),
  )

// One line per change for the audit entry: `waitMinutes.critical: 5 → 3`.
export const describeChanges = (current: DispatchSettingsValues, change: SettingsChange) =>
  Object.entries(change).map(
    ([path, value]) => `${path}: ${String(readPath(current, path))} → ${String(value)}`,
  )

export const applySettingsChange = (
  current: DispatchSettingsValues,
  change: SettingsChange,
): DispatchSettingsValues => {
  const next = structuredClone(current)
  for (const [path, value] of Object.entries(change)) {
    const keys = path.split('.')
    const last = keys.pop()
    const holder = keys.reduce<Record<string, unknown>>(
      (node, key) => node[key] as Record<string, unknown>,
      next as unknown as Record<string, unknown>,
    )
    if (last) holder[last] = value
  }
  return next
}

// Rules that involve more than one setting, so a single-field bound check cannot catch them. An empty
// list means the settings are fine.
export const validateSettings = (values: DispatchSettingsValues): string[] => {
  const problems: string[] = []
  if (values.startRadiusKm > values.maxRadiusKm) {
    problems.push('The start radius cannot be larger than the maximum radius')
  }
  const sum = Object.values(values.weights).reduce((total, weight) => total + weight, 0)
  if (Math.abs(sum - 1) > WEIGHT_SUM_TOLERANCE) {
    problems.push(`The score weights must add up to 1 (they add up to ${sum.toFixed(3)})`)
  }
  for (const priority of Object.keys(
    values.slaAssignMinutes,
  ) as (keyof typeof values.slaAssignMinutes)[]) {
    if (values.slaArriveMinutes[priority] < values.slaAssignMinutes[priority]) {
      problems.push(
        `The arrival target for ${priority} requests cannot be shorter than the target for a volunteer to take them`,
      )
    }
  }
  const slowestCheck = Math.max(values.staleCheckAfterHours, values.staleCheckAssignedAfterHours)
  if (values.staleCloseAfterHours <= slowestCheck) {
    problems.push(
      'Requests must stay open longer before being closed than before the victim is asked if they still need help',
    )
  }
  return problems
}
