import httpStatus from 'http-status'
import type { Types } from 'mongoose'
import { AuditAction, AuditTargetType, MAX_AUDIT_META_IDS } from '../../constants/audit'
import {
  DEFAULT_DISPATCH_SETTINGS,
  DISPATCH_SETTINGS_LIMITS,
  DISPATCH_BATCH_SIZE,
  DISPATCH_CANDIDATE_POOL,
  DISPATCH_LEASE_MS,
  DISPATCH_SETTINGS_KEY,
  type DispatchSettingsValues,
  METERS_PER_KM,
  MS_PER_MINUTE,
  OfferSource,
  SET_OFF_TIMEOUT_NOTE,
  SosEventType,
} from '../../constants/dispatch'
import { NotificationType } from '../../constants/notification'
import type { Priority } from '../../constants/relief'
import type { Skill } from '../../constants/skill'
import { SOS_FINISHED_STATUSES, SosStatus } from '../../constants/sos'
import { MAX_ACTIVE_TASKS_PER_VOLUNTEER, TaskStatus } from '../../constants/task'
import { AppError } from '../../errorHelpers/AppError'
import { isOnDuty } from '../../lib/availability'
import { matchSkills, wantedSkills } from '../../lib/skills'
import { runInTransaction } from '../../lib/transaction'
import type { TokenPayload } from '../../utils/jwt'
import type { DateRange } from '../../utils/dateRange'
import { buildMeta, getPagination } from '../../utils/pagination'
import { AuditService } from '../audit/audit.service'
import { NotificationService } from '../notification/notification.service'
import { type DispatchPatch, type DueSos, SosService } from '../sos/sos.service'
import type { SosEventInput } from '../sos-event/sos-event.interface'
import { SosEventService } from '../sos-event/sos-event.service'
import { TaskService } from '../task/task.service'
import { UserService } from '../user/user.service'
import type {
  AssignPayload,
  CandidatesQuery,
  UnassignPayload,
  UpdateSettingsPayload,
} from './dispatch.interface'
import { DispatchSettings } from './dispatch.model'
import {
  applySettingsChange,
  type Candidate,
  describeChanges,
  type DispatchProgress,
  escalate,
  firstOfferAt,
  flattenSettingsPayload,
  isLocationStale,
  isSetOffOverdue,
  offerWindowMs,
  onlyChanged,
  radiusMetersForLevel,
  rankCandidates,
  scoreCandidate,
  scoreParts,
  setOffLimitMs,
  shortestSetOffLimitMs,
  validateSettings,
} from './dispatch.rules'

const MONGO_DUPLICATE_KEY = 11000
const ONE_DECIMAL = 1
// Rounds are bounded by `maxRounds`; this only guards the loop against a settings document gone wrong.
const MAX_ROUNDS_PER_RUN = 12

const unique = (values: string[]) => [...new Set(values)]
const inMinutes = (ms: number) => Math.round(ms / MS_PER_MINUTE)
const toKm = (meters: number) => (meters / METERS_PER_KM).toFixed(ONE_DECIMAL)

// --- Settings ------------------------------------------------------------------------------------

interface SettingsDocument {
  enabled: boolean
  waitMinutes?: Partial<DispatchSettingsValues['waitMinutes']> | null
  volunteersPerRound: number
  offerWindowMinutes: number
  criticalOfferWindowMinutes: number
  startRadiusKm: number
  radiusFactor: number
  maxRadiusKm: number
  maxRounds: number
  retryIntervalMinutes: number
  setOffWithinMinutes: number
  criticalSetOffWithinMinutes: number
  weights?: Partial<DispatchSettingsValues['weights']> | null
  // Added in commit 18: a settings document saved before then has none of the three.
  staleCheckAfterHours?: number
  staleCheckAssignedAfterHours?: number
  staleCloseAfterHours?: number
  // Added in commit 19.
  slaAssignMinutes?: Partial<DispatchSettingsValues['slaAssignMinutes']> | null
  slaArriveMinutes?: Partial<DispatchSettingsValues['slaArriveMinutes']> | null
}

// Only the settings fields leave the document (not its id, key or timestamps).
const toSettingsValues = (doc: SettingsDocument): DispatchSettingsValues => ({
  enabled: doc.enabled,
  // A nested block missing from an older document falls back to the defaults.
  waitMinutes: { ...DEFAULT_DISPATCH_SETTINGS.waitMinutes, ...doc.waitMinutes },
  volunteersPerRound: doc.volunteersPerRound,
  offerWindowMinutes: doc.offerWindowMinutes,
  criticalOfferWindowMinutes: doc.criticalOfferWindowMinutes,
  startRadiusKm: doc.startRadiusKm,
  radiusFactor: doc.radiusFactor,
  maxRadiusKm: doc.maxRadiusKm,
  maxRounds: doc.maxRounds,
  retryIntervalMinutes: doc.retryIntervalMinutes,
  setOffWithinMinutes: doc.setOffWithinMinutes,
  criticalSetOffWithinMinutes: doc.criticalSetOffWithinMinutes,
  weights: { ...DEFAULT_DISPATCH_SETTINGS.weights, ...doc.weights },
  staleCheckAfterHours: doc.staleCheckAfterHours ?? DEFAULT_DISPATCH_SETTINGS.staleCheckAfterHours,
  staleCheckAssignedAfterHours:
    doc.staleCheckAssignedAfterHours ?? DEFAULT_DISPATCH_SETTINGS.staleCheckAssignedAfterHours,
  staleCloseAfterHours: doc.staleCloseAfterHours ?? DEFAULT_DISPATCH_SETTINGS.staleCloseAfterHours,
  slaAssignMinutes: { ...DEFAULT_DISPATCH_SETTINGS.slaAssignMinutes, ...doc.slaAssignMinutes },
  slaArriveMinutes: { ...DEFAULT_DISPATCH_SETTINGS.slaArriveMinutes, ...doc.slaArriveMinutes },
})

const isDuplicateKey = (error: unknown) =>
  error instanceof Error && 'code' in error && error.code === MONGO_DUPLICATE_KEY

const findOrCreateSettings = () =>
  DispatchSettings.findOneAndUpdate(
    { key: DISPATCH_SETTINGS_KEY },
    { $setOnInsert: { key: DISPATCH_SETTINGS_KEY, ...DEFAULT_DISPATCH_SETTINGS } },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
  ).lean()

// The settings document, created with the defaults the first time it is asked for. Two servers asking
// at the same moment can both try to create it; the loser retries once and finds it.
const loadSettingsDoc = async () => {
  const doc = await findOrCreateSettings().catch((error: unknown) => {
    if (!isDuplicateKey(error)) throw error
    return findOrCreateSettings()
  })
  if (!doc) throw new AppError(httpStatus.INTERNAL_SERVER_ERROR, 'Dispatch settings are missing')
  return doc
}

const getSettings = async () => toSettingsValues(await loadSettingsDoc())

// --- Expiring offers -----------------------------------------------------------------------------

// Offers nobody answered in time end as `expired`, count as a no-show for that volunteer, and are told.
// An offer on a request that is no longer waiting (someone took it a moment ago) is just cancelled.
// Runs even when dispatch is switched off, so old offers do not hang around forever.
const expireOffers = async (now: Date) => {
  const due = await TaskService.listDueOffers(now, DISPATCH_BATCH_SIZE)
  if (due.length === 0) return
  const requests = await SosService.getStatusAndPriority(unique(due.map((o) => o.sosRequest)))

  for (const offer of due) {
    try {
      const stillNeeded = requests.get(offer.sosRequest)?.status === SosStatus.PENDING
      const closed = await TaskService.closeDueOffer(
        offer.id,
        now,
        stillNeeded ? 'expired' : 'cancelled',
      )
      if (!closed || !stillNeeded) continue

      await UserService.incrementNoShow(offer.volunteer)
      await SosEventService.record({
        sos: offer.sosRequest,
        type: SosEventType.EXPIRED,
        subjectId: offer.volunteer,
      })
      await NotificationService.notifyUsers({
        userIds: [offer.volunteer],
        type: NotificationType.OFFER_EXPIRED,
        title: 'Offer expired',
        message:
          'You did not answer in time, so the request was offered to other volunteers. It stays on your map if you still want to help.',
        sosRequestId: offer.sosRequest,
      })
    } catch (error) {
      console.error(`Could not expire the offer ${offer.id}:`, error)
    }
  }
}

// --- Accepted but never set off ----------------------------------------------------------------

// pending again for another volunteer, unless the volunteer set off a moment ago (a 409 from the
// conditional writes), in which case nothing is changed.
const returnToPending = async (sosId: string, volunteerId: string) => {
  try {
    await runInTransaction(async (session) => {
      await SosService.releaseToPending(session, sosId, volunteerId)
      await TaskService.withdrawAccepted(session, sosId, volunteerId, SET_OFF_TIMEOUT_NOTE)
    })
    return true
  } catch (error) {
    if (error instanceof AppError && error.statusCode === httpStatus.CONFLICT) return false
    throw error
  }
}

// A volunteer who accepted and did not set off within the limit loses the request: it goes back to the
// queue (dispatch starts over for it), they get a no-show, and the victim is told.
const handleStuckAccepted = async (settings: DispatchSettingsValues, now: Date) => {
  const cutoff = new Date(now.getTime() - shortestSetOffLimitMs(settings))
  const accepted = await TaskService.listAcceptedBefore(cutoff, DISPATCH_BATCH_SIZE)
  if (accepted.length === 0) return
  const requests = await SosService.getStatusAndPriority(unique(accepted.map((t) => t.sosRequest)))

  for (const task of accepted) {
    try {
      const priority = requests.get(task.sosRequest)?.priority
      if (!priority || !isSetOffOverdue(task.acceptedAt, priority, settings, now)) continue
      if (!(await returnToPending(task.sosRequest, task.volunteer))) continue

      await UserService.incrementNoShow(task.volunteer)
      await SosEventService.record({
        sos: task.sosRequest,
        type: SosEventType.SET_OFF_TIMEOUT,
        subjectId: task.volunteer,
      })
      await NotificationService.notifyUsers({
        userIds: [task.victim],
        type: NotificationType.VOLUNTEER_BACKED_OUT,
        title: 'Your volunteer did not set off',
        message:
          'The volunteer who accepted your SOS request did not set off in time. Your request is open again for other volunteers.',
        sosRequestId: task.sosRequest,
      })
      await NotificationService.notifyUsers({
        userIds: [task.volunteer],
        type: NotificationType.TASK_CANCELLED,
        title: 'Request returned',
        message: `You did not set off within ${inMinutes(setOffLimitMs(priority, settings))} minutes of accepting, so the request was offered to others.`,
        sosRequestId: task.sosRequest,
      })
    } catch (error) {
      console.error(`Could not return the stuck request ${task.sosRequest}:`, error)
    }
  }
}

// --- Offering a request --------------------------------------------------------------------------

// A volunteer who could be given the request, with what an admin needs to see about them.
export interface Eligible extends Candidate {
  locationUpdatedAt: Date | null
  name: string
  phone: string | null
  skills: Skill[]
  languages: string[]
  matchedSkillList: Skill[]
}

type Subject = Pick<DueSos, 'coordinates' | 'requiredSkills' | 'needs'>

// Every volunteer who could take the request at this radius, best first: on duty, under their task cap,
// not already involved with this request, ranked by the score. Empty means nobody is in reach.
const rankEligible = async (
  sos: Subject,
  radiusMeters: number,
  excludeIds: Types.ObjectId[],
  settings: DispatchSettingsValues,
  now: Date,
): Promise<Eligible[]> => {
  const [lng, lat] = sos.coordinates
  const rows = await UserService.findDispatchCandidates(
    { lng, lat, radius: radiusMeters },
    excludeIds,
    DISPATCH_CANDIDATE_POOL,
  )
  const available = rows.filter((row) => isOnDuty(row, now))
  if (available.length === 0) return []

  const load = await TaskService.countActiveByVolunteer(available.map((row) => row._id))
  const wanted = wantedSkills(sos.requiredSkills, sos.needs)
  const candidates = available.flatMap((row): Eligible[] => {
    const activeTasks = load.get(String(row._id)) ?? 0
    if (activeTasks >= MAX_ACTIVE_TASKS_PER_VOLUNTEER) return []
    const matched = matchSkills(wanted, row.skills ?? [])
    return [
      {
        id: String(row._id),
        name: row.name,
        phone: row.phone ?? null,
        skills: row.skills ?? [],
        languages: row.languages ?? [],
        distanceMeters: row.distanceMeters,
        reliabilityScore: row.reliabilityScore,
        activeTasks,
        noShowCount: row.noShowCount ?? 0,
        locationUpdatedAt: row.locationUpdatedAt ?? null,
        staleLocation: isLocationStale(row.locationUpdatedAt, now),
        matchedSkills: matched.length,
        matchedSkillList: matched,
      },
    ]
  })
  return rankCandidates(candidates, { radiusMeters, wantedSkills: wanted.length }, settings)
}

// The best few of them: the ones a round offers the request to.
const pickCandidates = async (
  sos: Subject,
  radiusMeters: number,
  excludeIds: Types.ObjectId[],
  settings: DispatchSettingsValues,
  now: Date,
): Promise<Eligible[]> =>
  (await rankEligible(sos, radiusMeters, excludeIds, settings, now)).slice(
    0,
    settings.volunteersPerRound,
  )

const offerMessage = (priority: Priority, distanceMeters: number, windowMs: number) =>
  `A ${priority} SOS request needs help about ${toKm(distanceMeters)} km from you. Open your tasks to accept or decline. The offer expires in ${inMinutes(windowMs)} minutes.`

// Everything that is announced once the new state has been saved: timeline rows and notifications.
interface Announcements {
  events: SosEventInput[]
  offers: { volunteerId: string; message: string }[]
  tellStaff: string | null
}

// What a look at a request came to: offers made, offers still out so nothing was done, nobody in reach,
// or another run (or a change of state) got there first.
interface ProcessResult {
  outcome: 'offered' | 'waiting' | 'nobody' | 'busy'
  offered: number
}

// One look at one due request. It may escalate several times in a row (a round with nobody to ask
// ends at once, and the next one starts straight away) but it makes at most one set of offers, and it
// saves the request's state exactly once at the end.
const processRequest = async (
  sos: DueSos,
  settings: DispatchSettingsValues,
  now: Date,
  options: { ignorePaused?: boolean } = {},
): Promise<ProcessResult> => {
  const leaseUntil = new Date(now.getTime() + DISPATCH_LEASE_MS)
  const claimed = await SosService.claimDispatchTurn(
    sos.id,
    sos.dispatch.nextActionAt,
    leaseUntil,
    options.ignorePaused,
  )
  if (!claimed) return { outcome: 'busy', offered: 0 }

  // Offers from the last round are still out (a window longer than the wait, or an early nudge): look
  // again when the last one runs out.
  const liveUntil = await TaskService.getLiveOffersExpiry(sos.id, now)
  if (liveUntil) {
    await SosService.saveDispatchState(sos.id, { nextActionAt: liveUntil })
    return { outcome: 'waiting', offered: 0 }
  }

  let progress: DispatchProgress = {
    level: sos.dispatch.level,
    unserved: sos.dispatch.unserved,
    priority: sos.priority,
    priorityBumped: sos.dispatch.priorityBumped,
  }
  const announce: Announcements = { events: [], offers: [], tellStaff: null }
  const excludeIds = await TaskService.listVolunteerIdsWithTask(sos.id)
  const retryAt = new Date(now.getTime() + settings.retryIntervalMinutes * MS_PER_MINUTE)
  let escalatedAt: Date | undefined
  // The last round had offers out and none was accepted, so the first thing to do is widen the search.
  let roundEnded = sos.dispatch.roundOpen

  for (let run = 0; run < MAX_ROUNDS_PER_RUN; run++) {
    // An unserved request has nothing wider to try, so it is only ever retried, never escalated again.
    if (roundEnded && !progress.unserved) {
      const step = escalate(progress, settings)
      progress = step.progress
      escalatedAt = now
      announce.events.push({
        sos: sos.id,
        type: SosEventType.ESCALATED,
        meta: {
          level: progress.level,
          radiusKm: radiusMetersForLevel(progress.level, settings) / METERS_PER_KM,
        },
      })
      if (step.raisedFrom) {
        announce.events.push({
          sos: sos.id,
          type: SosEventType.PRIORITY_RAISED,
          meta: { from: step.raisedFrom, to: progress.priority },
        })
      }
      if (step.becameUnserved) {
        announce.events.push({ sos: sos.id, type: SosEventType.UNSERVED, meta: {} })
        announce.tellStaff = `No volunteer has accepted a ${progress.priority} SOS request after ${settings.maxRounds} rounds of offers. It needs a person to step in.`
      }
    }

    const radiusMeters = radiusMetersForLevel(progress.level, settings)
    const chosen = await pickCandidates(sos, radiusMeters, excludeIds, settings, now)
    const windowMs = offerWindowMs(progress.priority, settings)
    const expiresAt = new Date(now.getTime() + windowMs)
    const offered =
      chosen.length > 0
        ? await TaskService.createOffers({
            sosRequest: sos.id,
            victim: sos.victimId,
            volunteerIds: chosen.map((c) => c.id),
            offeredAt: now,
            expiresAt,
            source: OfferSource.AUTO,
          })
        : []

    if (offered.length > 0) {
      for (const candidate of chosen.filter((c) => offered.includes(c.id))) {
        announce.events.push({
          sos: sos.id,
          type: SosEventType.OFFERED,
          subjectId: candidate.id,
          meta: {
            level: progress.level,
            distanceMeters: Math.round(candidate.distanceMeters),
            expiresAt: expiresAt.toISOString(),
          },
        })
        announce.offers.push({
          volunteerId: candidate.id,
          message: offerMessage(progress.priority, candidate.distanceMeters, windowMs),
        })
      }
      const saved = await saveState(sos, progress, {
        escalatedAt,
        roundOpen: true,
        lastOfferAt: now,
        nextActionAt: progress.unserved ? retryAt : expiresAt,
      })
      if (!saved) {
        // Someone took or closed the request while the offers were being made: withdraw them.
        await TaskService.cancelOffers(sos.id, offered)
        return { outcome: 'busy', offered: 0 }
      }
      await announceAll(sos, progress, announce)
      return { outcome: 'offered', offered: offered.length }
    }

    // Nobody to ask at this radius. Once the request is unserved there is nothing wider to try: wait for
    // the next retry. Before that, the round counts as ended and the search widens straight away.
    if (progress.unserved) {
      const saved = await saveState(sos, progress, {
        escalatedAt,
        roundOpen: false,
        nextActionAt: retryAt,
      })
      if (saved) await announceAll(sos, progress, announce)
      return { outcome: 'nobody', offered: 0 }
    }
    roundEnded = true
  }

  // Unreachable with sane settings; leave the request for the next retry instead of spinning.
  await SosService.saveDispatchState(sos.id, { nextActionAt: retryAt })
  return { outcome: 'nobody', offered: 0 }
}

const saveState = (
  sos: DueSos,
  progress: DispatchProgress,
  extra: Pick<DispatchPatch, 'escalatedAt' | 'roundOpen' | 'lastOfferAt' | 'nextActionAt'>,
) =>
  SosService.saveDispatchState(sos.id, {
    ...extra,
    level: progress.level,
    unserved: progress.unserved,
    priorityBumped: progress.priorityBumped,
    // Only a real change of priority is written.
    ...(progress.priority !== sos.priority && { priority: progress.priority }),
  })

// After the state is saved: the timeline rows first, then the notifications. Never throws.
const announceAll = async (sos: DueSos, progress: DispatchProgress, announce: Announcements) => {
  await SosEventService.record(...announce.events)
  for (const offer of announce.offers) {
    await NotificationService.notifyUsers({
      userIds: [offer.volunteerId],
      type: NotificationType.TASK_OFFERED,
      title: 'New SOS request near you',
      message: offer.message,
      sosRequestId: sos.id,
    })
  }
  if (announce.tellStaff) {
    await NotificationService.notifyUsers({
      userIds: await UserService.listStaffIds(),
      type: NotificationType.SOS_UNSERVED,
      title: `Unserved ${progress.priority} SOS request`,
      message: announce.tellStaff,
      sosRequestId: sos.id,
    })
  }
}

// --- Admin controls (commit 16) ------------------------------------------------------------------

const NOT_FOUND_MESSAGE = 'SOS request not found'
const SETTINGS_RACE_MESSAGE =
  'The dispatch settings changed while you were saving. Please try again'
const MAX_TASK_NOTE = 500

const loadSubject = async (id: string) => {
  const subject = await SosService.getDispatchSubject(id)
  if (!subject) throw new AppError(httpStatus.NOT_FOUND, NOT_FOUND_MESSAGE)
  return subject
}

// The settings with what a form needs to edit them safely: the defaults (for "reset") and the bounds.
const toSettingsView = (doc: SettingsDocument & { updatedAt: Date }) => ({
  settings: toSettingsValues(doc),
  defaults: DEFAULT_DISPATCH_SETTINGS,
  limits: DISPATCH_SETTINGS_LIMITS,
  updatedAt: doc.updatedAt,
})

const getSettingsView = async () => toSettingsView(await loadSettingsDoc())

// Saves only what was sent and really differs, after checking the result as a whole (weights add up to
// 1, the start radius is not above the maximum). The write is conditional on the document not having
// changed since it was read, so two admins editing at once cannot undo each other unseen.
const updateSettings = async (admin: TokenPayload, payload: UpdateSettingsPayload) => {
  const doc = await loadSettingsDoc()
  const current = toSettingsValues(doc)
  const change = onlyChanged(current, flattenSettingsPayload(payload))
  if (Object.keys(change).length === 0) return toSettingsView(doc)

  const problems = validateSettings(applySettingsChange(current, change))
  if (problems.length > 0) {
    throw new AppError(httpStatus.BAD_REQUEST, problems.join('. '), problems)
  }

  const updated = await DispatchSettings.findOneAndUpdate(
    { key: DISPATCH_SETTINGS_KEY, updatedAt: doc.updatedAt },
    { $set: change },
    { returnDocument: 'after', runValidators: true },
  ).lean()
  if (!updated) throw new AppError(httpStatus.CONFLICT, SETTINGS_RACE_MESSAGE)

  const lines = describeChanges(current, change)
  await AuditService.record({
    actor: admin,
    action: AuditAction.DISPATCH_SETTINGS_CHANGED,
    targetType: AuditTargetType.DISPATCH_SETTINGS,
    targetId: String(updated._id),
    summary: `Changed dispatch settings: ${lines.join(', ')}`,
    meta: { changes: lines.slice(0, MAX_AUDIT_META_IDS) },
  })
  return toSettingsView(updated)
}

const ROUND_FACTOR = 1000
const rounded = (value: number) => Math.round(value * ROUND_FACTOR) / ROUND_FACTOR

// The volunteers who could take a request, best first, with why they rank where they do. The same
// eligibility and the same score as the engine: what an admin sees here is what dispatch would pick from.
const listCandidates = async (id: string, query: CandidatesQuery) => {
  const subject = await loadSubject(id)
  if (SOS_FINISHED_STATUSES.includes(subject.status)) {
    throw new AppError(httpStatus.CONFLICT, `This SOS request is already ${subject.status}`)
  }
  const settings = await getSettings()
  const radiusMeters = (query.radiusKm ?? settings.maxRadiusKm) * METERS_PER_KM
  const excludeIds = await TaskService.listVolunteerIdsWithTask(id)
  const ranked = await rankEligible(subject, radiusMeters, excludeIds, settings, new Date())

  const context = {
    radiusMeters,
    wantedSkills: wantedSkills(subject.requiredSkills, subject.needs).length,
  }
  const { skip, limit } = getPagination(query)
  const items = ranked.slice(skip, skip + limit).map((candidate, index) => {
    const parts = scoreParts(candidate, context)
    return {
      rank: skip + index + 1,
      volunteer: { id: candidate.id, name: candidate.name, phone: candidate.phone },
      distanceMeters: Math.round(candidate.distanceMeters),
      score: rounded(scoreCandidate(candidate, context, settings.weights)),
      scoreParts: {
        distance: rounded(parts.distance),
        reliability: rounded(parts.reliability),
        load: rounded(parts.load),
        skillMatch: rounded(parts.skillMatch),
        noShow: rounded(parts.noShow),
        staleLocation: parts.staleLocation,
      },
      activeTasks: candidate.activeTasks,
      noShowCount: candidate.noShowCount,
      reliabilityScore: candidate.reliabilityScore,
      skills: candidate.skills,
      matchedSkills: candidate.matchedSkillList,
      locationUpdatedAt: candidate.locationUpdatedAt,
      locationStale: candidate.staleLocation,
      languages: candidate.languages,
    }
  })
  return { items, meta: buildMeta(query, ranked.length) }
}

interface AssignSubject {
  id: string
  victimId: string
  priority: Priority
}

interface AssignableVolunteer {
  id: string
  name: string
}

const assignDirectly = async (
  admin: TokenPayload,
  subject: AssignSubject,
  volunteer: AssignableVolunteer,
) => {
  // The claim, the volunteer's task and the withdrawal of everyone else's offers stand or fall together.
  const withdrawn = await runInTransaction(async (session) => {
    await SosService.claimForVolunteer(session, subject.id, volunteer.id)
    await TaskService.createAccepted(session, {
      sosRequest: subject.id,
      volunteer: volunteer.id,
      victim: subject.victimId,
    })
    return TaskService.cancelOtherOffers(session, subject.id, volunteer.id)
  })

  await SosService.announceAcceptance({
    sosId: subject.id,
    victimId: subject.victimId,
    volunteerId: volunteer.id,
    volunteerName: volunteer.name,
    withdrawnVolunteerIds: withdrawn,
    assignedByAdminId: admin.id,
  })
  await NotificationService.notifyUsers({
    userIds: [volunteer.id],
    type: NotificationType.TASK_ASSIGNED,
    title: 'An SOS request was assigned to you',
    message:
      'An admin assigned an SOS request to you. Open your tasks and set off as soon as you can.',
    sosRequestId: subject.id,
  })
  await AuditService.record({
    actor: admin,
    action: AuditAction.SOS_ASSIGNED,
    targetType: AuditTargetType.SOS_REQUEST,
    targetId: subject.id,
    summary: `Assigned an SOS request directly to ${volunteer.name}`,
    meta: { volunteerId: volunteer.id, direct: true },
  })
}

const offerTo = async (
  admin: TokenPayload,
  subject: AssignSubject,
  volunteer: AssignableVolunteer,
  now: Date,
) => {
  const settings = await getSettings()
  const windowMs = offerWindowMs(subject.priority, settings)
  const expiresAt = new Date(now.getTime() + windowMs)
  const created = await TaskService.createOffers({
    sosRequest: subject.id,
    victim: subject.victimId,
    volunteerIds: [volunteer.id],
    offeredAt: now,
    expiresAt,
    source: OfferSource.ADMIN,
    reopenExpired: true,
  })
  if (created.length === 0) {
    throw new AppError(httpStatus.CONFLICT, `${volunteer.name} already has a task on this request`)
  }

  // Someone may have taken the request while the offer was being made: withdraw it rather than leave a
  // dead offer in the volunteer's list.
  const status = (await SosService.getStatusAndPriority([subject.id])).get(subject.id)?.status
  if (status !== SosStatus.PENDING) {
    await TaskService.cancelOffers(subject.id, created)
    throw new AppError(httpStatus.CONFLICT, 'This request was taken while you were assigning it')
  }

  await SosEventService.record({
    sos: subject.id,
    type: SosEventType.OFFERED,
    actorId: admin.id,
    subjectId: volunteer.id,
    meta: { source: OfferSource.ADMIN, expiresAt: expiresAt.toISOString() },
  })
  await NotificationService.notifyUsers({
    userIds: [volunteer.id],
    type: NotificationType.TASK_OFFERED,
    title: 'An admin offered you an SOS request',
    message: `An admin picked you for a ${subject.priority} SOS request. Open your tasks to accept or decline. The offer expires in ${inMinutes(windowMs)} minutes.`,
    sosRequestId: subject.id,
  })
  await AuditService.record({
    actor: admin,
    action: AuditAction.SOS_OFFERED,
    targetType: AuditTargetType.SOS_REQUEST,
    targetId: subject.id,
    summary: `Offered an SOS request to ${volunteer.name}`,
    meta: { volunteerId: volunteer.id, direct: false },
  })
}

// Gives a pending request to one volunteer. By default as an offer they can answer (with the normal
// window; the engine carries on around it, and waits while the offer is out); `direct` makes them the
// assigned volunteer at once.
const assign = async (admin: TokenPayload, id: string, payload: AssignPayload) => {
  const subject = await loadSubject(id)
  if (subject.status !== SosStatus.PENDING) {
    throw new AppError(
      httpStatus.CONFLICT,
      `Cannot assign: the request is already ${subject.status}`,
    )
  }
  const volunteer = await UserService.getAssignableVolunteer(payload.volunteerId)
  if (!volunteer) throw new AppError(httpStatus.NOT_FOUND, 'Volunteer not found')

  const now = new Date()
  if (!isOnDuty(volunteer, now)) {
    throw new AppError(httpStatus.CONFLICT, `${volunteer.name} is off duty`)
  }
  const earlier = await TaskService.getStatusFor(id, volunteer.id)
  if (earlier && earlier !== TaskStatus.EXPIRED) {
    throw new AppError(
      httpStatus.CONFLICT,
      `${volunteer.name} already has a ${earlier} task on this request`,
    )
  }
  await TaskService.assertCanTakeAnotherTask(volunteer.id)

  if (payload.direct) await assignDirectly(admin, subject, volunteer)
  else await offerTo(admin, subject, volunteer, now)
  return SosService.getStaffView(id)
}

// Takes the request off the volunteer who holds it (before they finish). It goes back to pending, and
// dispatch starts over for it unless the admin asks to pause it, to pick someone by hand.
const unassign = async (admin: TokenPayload, id: string, payload: UnassignPayload) => {
  const subject = await loadSubject(id)
  const volunteerId = subject.assignedVolunteerId
  const holding: SosStatus[] = [SosStatus.ASSIGNED, SosStatus.ON_THE_WAY]
  if (!volunteerId || !holding.includes(subject.status)) {
    throw new AppError(httpStatus.CONFLICT, `Cannot unassign: the request is ${subject.status}`)
  }
  const { reason, pause } = payload
  const note = `Taken off by an admin${reason ? `: ${reason}` : ''}`.slice(0, MAX_TASK_NOTE)

  await runInTransaction(async (session) => {
    await SosService.unassignToPending(session, id, volunteerId, pause)
    await TaskService.cancelActiveTask(session, id, volunteerId, note)
  })

  await SosEventService.record({
    sos: id,
    type: SosEventType.UNASSIGNED,
    actorId: admin.id,
    subjectId: volunteerId,
    meta: { paused: pause },
  })
  await NotificationService.notifyUsers({
    userIds: [subject.victimId],
    type: NotificationType.VOLUNTEER_BACKED_OUT,
    title: 'Your volunteer was changed',
    message:
      'An admin took your SOS request off its volunteer. Your request is open again for other volunteers.',
    sosRequestId: id,
  })
  await NotificationService.notifyUsers({
    userIds: [volunteerId],
    type: NotificationType.TASK_CANCELLED,
    title: 'SOS request taken back',
    message: `An admin took an SOS request off you${reason ? `: ${reason}` : '.'}`,
    sosRequestId: id,
  })
  await AuditService.record({
    actor: admin,
    action: AuditAction.SOS_UNASSIGNED,
    targetType: AuditTargetType.SOS_REQUEST,
    targetId: id,
    summary: `Took an SOS request off its volunteer${pause ? ' and paused dispatch' : ''}`,
    meta: { volunteerId, paused: pause },
  })
  return SosService.getStaffView(id)
}

// Runs the next dispatch step for one request now, without waiting for its time. Works on a paused
// request (the admin is choosing to), but not while dispatch is switched off. If offers are still out
// there is nothing to do yet and the answer says so.
const dispatchNow = async (admin: TokenPayload, id: string) => {
  const settings = await getSettings()
  if (!settings.enabled) {
    throw new AppError(httpStatus.CONFLICT, 'Dispatch is switched off in the settings')
  }
  let subject = await loadSubject(id)
  if (subject.status !== SosStatus.PENDING) {
    throw new AppError(httpStatus.CONFLICT, `The request is already ${subject.status}`)
  }
  const now = new Date()
  if (!subject.dispatch.nextActionAt) {
    await SosService.saveDispatchState(id, { nextActionAt: now })
    subject = await loadSubject(id)
  }
  const nextActionAt = subject.dispatch.nextActionAt ?? now

  const result = await processRequest(
    { ...subject, dispatch: { ...subject.dispatch, nextActionAt } },
    settings,
    now,
    { ignorePaused: true },
  )
  if (result.outcome === 'busy') {
    throw new AppError(
      httpStatus.CONFLICT,
      'Dispatch is already working on this request. Try again in a moment',
    )
  }

  await AuditService.record({
    actor: admin,
    action: AuditAction.SOS_DISPATCH_RUN,
    targetType: AuditTargetType.SOS_REQUEST,
    targetId: id,
    summary: `Ran the next dispatch step now (${result.outcome}, ${result.offered} offered)`,
    meta: { outcome: result.outcome, offered: result.offered },
  })
  return {
    outcome: result.outcome,
    offered: result.offered,
    sosRequest: await SosService.getStaffView(id),
  }
}

const setPaused = async (admin: TokenPayload, id: string, paused: boolean) => {
  await SosService.setDispatchPaused(id, paused)
  await SosEventService.record({
    sos: id,
    type: paused ? SosEventType.PAUSED : SosEventType.RESUMED,
    actorId: admin.id,
  })
  await AuditService.record({
    actor: admin,
    action: paused ? AuditAction.SOS_DISPATCH_PAUSED : AuditAction.SOS_DISPATCH_RESUMED,
    targetType: AuditTargetType.SOS_REQUEST,
    targetId: id,
    summary: paused
      ? 'Paused automatic dispatch for an SOS request'
      : 'Resumed automatic dispatch for an SOS request',
  })
  return SosService.getStaffView(id)
}

// Dispatch numbers for the dashboard, measured against the service targets in the settings.
const getMetrics = async (range: DateRange) => {
  const settings = await getSettings()
  const toMs = (minutes: Record<Priority, number>) =>
    Object.fromEntries(
      Object.entries(minutes).map(([priority, value]) => [priority, value * MS_PER_MINUTE]),
    ) as Record<Priority, number>
  return SosService.getDispatchMetrics(
    range,
    { assign: toMs(settings.slaAssignMinutes), arrive: toMs(settings.slaArriveMinutes) },
    new Date(),
  )
}

// --- The job -------------------------------------------------------------------------------------

// One pass of the dispatch job (the scheduler calls it every minute). Each request is handled in its own
// try/catch: one bad document must not stall dispatch for everybody else. This is the one place an error
// is caught and only logged.
const runTick = async (now: Date = new Date()) => {
  const settings = await getSettings()
  await expireOffers(now)
  if (!settings.enabled) return

  await SosService.scheduleUnscheduled(
    (createdAt, priority) => firstOfferAt(createdAt, priority, settings),
    DISPATCH_BATCH_SIZE,
  )
  await handleStuckAccepted(settings, now)

  const due = await SosService.listDueForDispatch(now, DISPATCH_BATCH_SIZE)
  for (const sos of due) {
    try {
      await processRequest(sos, settings, now)
    } catch (error) {
      console.error(`Dispatch failed for the request ${sos.id}:`, error)
    }
  }
}

export const DispatchService = {
  getSettings,
  getSettingsView,
  getMetrics,
  updateSettings,
  listCandidates,
  assign,
  unassign,
  dispatchNow,
  setPaused,
  runTick,
}
