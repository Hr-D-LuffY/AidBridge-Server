import httpStatus from 'http-status'
import type { Types } from 'mongoose'
import {
  DEFAULT_DISPATCH_SETTINGS,
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
import { SosStatus } from '../../constants/sos'
import { MAX_ACTIVE_TASKS_PER_VOLUNTEER } from '../../constants/task'
import { AppError } from '../../errorHelpers/AppError'
import { isOnDuty } from '../../lib/availability'
import { matchSkills, wantedSkills } from '../../lib/skills'
import { runInTransaction } from '../../lib/transaction'
import { NotificationService } from '../notification/notification.service'
import { type DispatchPatch, type DueSos, SosService } from '../sos/sos.service'
import type { SosEventInput } from '../sos-event/sos-event.interface'
import { SosEventService } from '../sos-event/sos-event.service'
import { TaskService } from '../task/task.service'
import { UserService } from '../user/user.service'
import { DispatchSettings } from './dispatch.model'
import {
  type Candidate,
  type DispatchProgress,
  escalate,
  firstOfferAt,
  isSetOffOverdue,
  offerWindowMs,
  radiusMetersForLevel,
  rankCandidates,
  setOffLimitMs,
  shortestSetOffLimitMs,
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
const getSettings = async () => {
  const doc = await findOrCreateSettings().catch((error: unknown) => {
    if (!isDuplicateKey(error)) throw error
    return findOrCreateSettings()
  })
  if (!doc) throw new AppError(httpStatus.INTERNAL_SERVER_ERROR, 'Dispatch settings are missing')
  return toSettingsValues(doc)
}

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

// The best few volunteers to ask at this radius: on duty, under their task cap, not already involved
// with this request, ranked by the score. An empty list means nobody is in reach.
const pickCandidates = async (
  sos: DueSos,
  radiusMeters: number,
  excludeIds: Types.ObjectId[],
  settings: DispatchSettingsValues,
  now: Date,
): Promise<Candidate[]> => {
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
  const candidates = available.flatMap((row): Candidate[] => {
    const activeTasks = load.get(String(row._id)) ?? 0
    if (activeTasks >= MAX_ACTIVE_TASKS_PER_VOLUNTEER) return []
    return [
      {
        id: String(row._id),
        distanceMeters: row.distanceMeters,
        reliabilityScore: row.reliabilityScore,
        activeTasks,
        noShowCount: row.noShowCount ?? 0,
        matchedSkills: matchSkills(wanted, row.skills ?? []).length,
      },
    ]
  })
  return rankCandidates(candidates, { radiusMeters, wantedSkills: wanted.length }, settings).slice(
    0,
    settings.volunteersPerRound,
  )
}

const offerMessage = (priority: Priority, distanceMeters: number, windowMs: number) =>
  `A ${priority} SOS request needs help about ${toKm(distanceMeters)} km from you. Open your tasks to accept or decline. The offer expires in ${inMinutes(windowMs)} minutes.`

// Everything that is announced once the new state has been saved: timeline rows and notifications.
interface Announcements {
  events: SosEventInput[]
  offers: { volunteerId: string; message: string }[]
  tellStaff: string | null
}

// One look at one due request. It may escalate several times in a row (a round with nobody to ask
// ends at once, and the next one starts straight away) but it makes at most one set of offers, and it
// saves the request's state exactly once at the end.
const processRequest = async (sos: DueSos, settings: DispatchSettingsValues, now: Date) => {
  const leaseUntil = new Date(now.getTime() + DISPATCH_LEASE_MS)
  if (!(await SosService.claimDispatchTurn(sos.id, sos.dispatch.nextActionAt, leaseUntil))) return

  // Offers from the last round are still out (a window longer than the wait, or an early nudge): look
  // again when the last one runs out.
  const liveUntil = await TaskService.getLiveOffersExpiry(sos.id, now)
  if (liveUntil) {
    await SosService.saveDispatchState(sos.id, { nextActionAt: liveUntil })
    return
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
        return
      }
      await announceAll(sos, progress, announce)
      return
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
      return
    }
    roundEnded = true
  }

  // Unreachable with sane settings; leave the request for the next retry instead of spinning.
  await SosService.saveDispatchState(sos.id, { nextActionAt: retryAt })
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

export const DispatchService = { getSettings, runTick }
