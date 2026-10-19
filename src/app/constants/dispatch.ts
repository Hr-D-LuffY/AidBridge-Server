import type { Priority } from './relief'

// Who made an offer: the dispatch engine, or (commit 21 and 35) an admin or an NGO by hand.
export const OfferSource = {
  AUTO: 'auto',
  ADMIN: 'admin',
  NGO: 'ngo',
} as const

export type OfferSource = (typeof OfferSource)[keyof typeof OfferSource]

// Whether finishing a task needs proof that the volunteer reached the victim (commit 24). `off` is the
// kill switch; it only affects tasks created afterwards.
export const ProofMode = {
  OFF: 'off',
  CODE_OR_PHOTO: 'code_or_photo',
} as const

export type ProofMode = (typeof ProofMode)[keyof typeof ProofMode]

// The one document that holds the admin-editable settings (a singleton, found by this key).
export const DISPATCH_SETTINGS_KEY = 'default'

export interface DispatchSettingsValues {
  // Kill switch: off stops new offers, escalation and set-off checks. Offers already out still expire.
  enabled: boolean
  // Minutes a new request waits before it is first offered, by priority.
  waitMinutes: Record<Priority, number>
  volunteersPerRound: number
  offerWindowMinutes: number
  criticalOfferWindowMinutes: number
  startRadiusKm: number
  radiusFactor: number
  maxRadiusKm: number
  // Rounds with nobody accepting before the request counts as unserved.
  maxRounds: number
  retryIntervalMinutes: number
  // After accepting, a volunteer must set off within this long or the request goes back to pending.
  setOffWithinMinutes: number
  criticalSetOffWithinMinutes: number
  weights: {
    distance: number
    reliability: number
    load: number
    skillMatch: number
    noShowPenalty: number
  }
  // Stale cleanup (commit 23): hours without a sign of life before the victim is asked "Do you still
  // need help?" (a pending request / one a volunteer holds), and before an unanswered medium or low
  // request is closed.
  staleCheckAfterHours: number
  staleCheckAssignedAfterHours: number
  staleCloseAfterHours: number
  // Service-level targets by priority, in minutes since the request was raised: until a volunteer has taken
  // it, and until one has arrived (the task is completed). The board and the dashboard measure against them.
  slaAssignMinutes: Record<Priority, number>
  slaArriveMinutes: Record<Priority, number>
  // Proof of delivery (commit 24): a task created while this is `code_or_photo` can only be completed with
  // the victim's arrival code or a photo (or by an admin). Tasks created earlier are unaffected.
  proofMode: ProofMode
}

export const DEFAULT_DISPATCH_SETTINGS: DispatchSettingsValues = {
  enabled: true,
  waitMinutes: { critical: 5, high: 30, medium: 60, low: 120 },
  volunteersPerRound: 3,
  offerWindowMinutes: 15,
  criticalOfferWindowMinutes: 5,
  startRadiusKm: 10,
  radiusFactor: 2,
  maxRadiusKm: 80,
  maxRounds: 3,
  retryIntervalMinutes: 30,
  setOffWithinMinutes: 30,
  criticalSetOffWithinMinutes: 15,
  weights: { distance: 0.4, reliability: 0.25, load: 0.1, skillMatch: 0.2, noShowPenalty: 0.05 },
  staleCheckAfterHours: 6,
  staleCheckAssignedAfterHours: 12,
  staleCloseAfterHours: 24,
  slaAssignMinutes: { critical: 10, high: 30, medium: 90, low: 240 },
  slaArriveMinutes: { critical: 30, high: 60, medium: 180, low: 480 },
  proofMode: ProofMode.CODE_OR_PHOTO,
}

// Escalation level at which a request that is still unanswered is raised one priority step.
export const PRIORITY_BUMP_LEVEL = 2

// A noShowCount at or above this counts as the worst case in the score, so one very unreliable
// volunteer cannot push the score far below zero.
export const NO_SHOW_PENALTY_CAP = 5

export const METERS_PER_KM = 1000
export const MS_PER_MINUTE = 60_000

// How often the dispatch job wakes up.
export const DISPATCH_TICK_MS = 60_000
// A request being processed is "leased" for this long so a second server instance skips it, and so
// a crash in the middle still lets it be picked up again.
export const DISPATCH_LEASE_MS = 2 * MS_PER_MINUTE
// Most work done in one tick, per kind, so a backlog is worked off over several ticks.
export const DISPATCH_BATCH_SIZE = 50
// Volunteers read from the database per round before ranking; the best few are offered.
export const DISPATCH_CANDIDATE_POOL = 50

export const SosEventType = {
  OFFERED: 'offered',
  ACCEPTED: 'accepted',
  DECLINED: 'declined',
  EXPIRED: 'expired',
  OFFERS_WITHDRAWN: 'offers_withdrawn',
  ESCALATED: 'escalated',
  PRIORITY_RAISED: 'priority_raised',
  UNSERVED: 'unserved',
  SET_OFF_TIMEOUT: 'set_off_timeout',
  BACKED_OUT: 'backed_out',
  CLOSED: 'closed',
  STILL_NEED_HELP_ASKED: 'still_need_help_asked',
  CONFIRMED: 'confirmed',
  STALE_UNANSWERED: 'stale_unanswered',
  UNASSIGNED: 'unassigned',
  PAUSED: 'paused',
  RESUMED: 'resumed',
  ON_THE_WAY: 'on_the_way',
  COMPLETED: 'completed',
  // An admin combined this request into another one / another one into this request (commit 25).
  MERGED: 'merged',
  MERGED_IN: 'merged_in',
} as const

export type SosEventType = (typeof SosEventType)[keyof typeof SosEventType]

export const TIMELINE_DEFAULT_LIMIT = 100
export const TIMELINE_MAX_LIMIT = 100

// Bounds the settings route enforces (and sends to the client so its form can mirror them).
const range = (min: number, max: number) => ({ min, max })
export const DISPATCH_SETTINGS_LIMITS = {
  waitMinutes: range(1, 1440),
  offerWindowMinutes: range(1, 120),
  radiusKm: range(1, 200),
  radiusFactor: range(1, 5),
  volunteersPerRound: range(1, 10),
  maxRounds: range(1, 10),
  retryIntervalMinutes: range(1, 1440),
  setOffWithinMinutes: range(1, 240),
  staleHours: range(1, 720),
  slaMinutes: range(1, 10_080),
  weight: range(0, 1),
  proofModes: Object.values(ProofMode),
} as const

// A target counts as "at risk" once this much of it has gone.
export const SLA_AT_RISK_FRACTION = 0.75

// A volunteer's position older than this is shown as stale and ranks lower in dispatch. A volunteer whose
// position has no time at all (saved before it was recorded) counts as stale.
export const LOCATION_STALE_MINUTES = 30
// Taken off a candidate's score when their position is stale (not one of the weights, so they still add up to 1).
export const STALE_LOCATION_PENALTY = 0.15

export const BOARD_DEFAULT_LIMIT = 20
export const BOARD_MAX_LIMIT = 100

// How often the stale-request job wakes up (it works in hours, so a few minutes is plenty).
export const STALE_TICK_MS = 5 * MS_PER_MINUTE
// A victim always gets at least this long between the check-in and an automatic closure.
export const STALE_MIN_ANSWER_HOURS = 1
export const MS_PER_HOUR = 60 * MS_PER_MINUTE

// The five score weights must add up to 1, give or take this much (so 0.1 + 0.2 + 0.7 is fine).
export const WEIGHT_SUM_TOLERANCE = 0.001

export const MAX_DISPATCH_NOTE_LENGTH = 500

export const SET_OFF_TIMEOUT_NOTE = 'Did not set off in time, so the request was offered to others'
