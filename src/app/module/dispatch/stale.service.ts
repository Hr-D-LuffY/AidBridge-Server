import { AuditAction, AuditTargetType } from '../../constants/audit'
import {
  DISPATCH_BATCH_SIZE,
  type DispatchSettingsValues,
  MS_PER_HOUR,
  SosEventType,
  STALE_MIN_ANSWER_HOURS,
} from '../../constants/dispatch'
import { NotificationType } from '../../constants/notification'
import { AuditService } from '../audit/audit.service'
import { NotificationService } from '../notification/notification.service'
import { type StaleRef, SosService } from '../sos/sos.service'
import { SosEventService } from '../sos-event/sos-event.service'
import { UserService } from '../user/user.service'
import { DispatchService } from './dispatch.service'
import { closesAutomatically, isDueForCheckIn, isUnanswered } from './stale.rules'

// "Do you still need help?" for requests that have gone quiet, and cleanup of the ones nobody answers for.
// It never closes a request someone may still need: only medium and low are closed by silence, and only
// after the victim was asked and had time to reply; high and critical go to the staff instead (R9).

const hoursAgo = (hours: number, now: Date) => new Date(now.getTime() - hours * MS_PER_HOUR)

// Asks each quiet request's victim once. Every step is a conditional update, so two server instances or a
// victim answering at the same moment cannot double-ask or ask someone who just replied.
const sendCheckIns = async (settings: DispatchSettingsValues, now: Date) => {
  const due = await SosService.listNeedingCheckIn(
    hoursAgo(settings.staleCheckAfterHours, now),
    hoursAgo(settings.staleCheckAssignedAfterHours, now),
    DISPATCH_BATCH_SIZE,
  )

  for (const ref of due) {
    try {
      if (!isDueForCheckIn(ref.status, ref.lastConfirmedAt, ref.staleCheckedAt, settings, now))
        continue
      if (!(await SosService.markCheckedIn(ref, now))) continue

      await SosEventService.record({ sos: ref.id, type: SosEventType.STILL_NEED_HELP_ASKED })
      await NotificationService.notifyUsers({
        userIds: [ref.victimId],
        type: NotificationType.SOS_STILL_NEED_HELP,
        title: 'Do you still need help?',
        message: closesAutomatically(ref.priority)
          ? `Your SOS request has had no update for a while. Please confirm that you still need help. If we do not hear back, the request will be closed after ${settings.staleCloseAfterHours} hours.`
          : 'Your SOS request has had no update for a while. We are keeping it open, but please confirm that you still need help.',
        sosRequestId: ref.id,
      })
    } catch (error) {
      console.error(`Could not send the check-in for the request ${ref.id}:`, error)
    }
  }
}

const closeUnanswered = async (ref: StaleRef, settings: DispatchSettingsValues, now: Date) => {
  const heldBy = await SosService.autoCloseStale(ref, now)
  if (heldBy === null) return

  await SosEventService.record({
    sos: ref.id,
    type: SosEventType.CLOSED,
    meta: { by: 'system', kind: 'stale' },
  })
  await NotificationService.notifyUsers({
    userIds: [ref.victimId],
    type: NotificationType.SOS_CLOSED_STALE,
    title: 'Your SOS request was closed',
    message:
      'We did not hear back from you, so your SOS request was closed. If you still need help, please raise a new request.',
    sosRequestId: ref.id,
  })
  await NotificationService.notifyUsers({
    userIds: heldBy,
    type: NotificationType.SOS_CLOSED_STALE,
    title: 'An SOS request was closed',
    message:
      'An SOS request you were working on or were offered was closed automatically because the victim stopped responding. You do not need to respond.',
    sosRequestId: ref.id,
  })
  await AuditService.record({
    actor: null,
    action: AuditAction.SOS_AUTO_CLOSED,
    targetType: AuditTargetType.SOS_REQUEST,
    targetId: ref.id,
    summary: `Closed a ${ref.priority} SOS request automatically: no answer for ${settings.staleCloseAfterHours} hours`,
    meta: { from: ref.status, volunteersTold: heldBy.length },
  })
}

// A high or critical request nobody answers for stays open. Staff are told once, so someone looks into it.
const escalateUnanswered = async (ref: StaleRef, now: Date) => {
  if (!(await SosService.markStaleAlerted(ref, now))) return

  await SosEventService.record({ sos: ref.id, type: SosEventType.STALE_UNANSWERED })
  await NotificationService.notifyUsers({
    userIds: await UserService.listStaffIds(),
    type: NotificationType.SOS_STALE_UNANSWERED,
    title: `Quiet ${ref.priority} SOS request`,
    message: `A ${ref.priority} SOS request has had no sign of life and its victim has not answered the "Do you still need help?" check. It is still open: please look into it.`,
    sosRequestId: ref.id,
  })
}

const handleUnanswered = async (settings: DispatchSettingsValues, now: Date) => {
  const unanswered = await SosService.listUnanswered(
    hoursAgo(settings.staleCloseAfterHours, now),
    hoursAgo(STALE_MIN_ANSWER_HOURS, now),
    DISPATCH_BATCH_SIZE,
  )

  for (const ref of unanswered) {
    try {
      if (!isUnanswered(ref.lastConfirmedAt, ref.staleCheckedAt, settings, now)) continue
      if (closesAutomatically(ref.priority)) await closeUnanswered(ref, settings, now)
      else await escalateUnanswered(ref, now)
    } catch (error) {
      console.error(`Could not handle the quiet request ${ref.id}:`, error)
    }
  }
}

// One pass of the stale job. Each request has its own try/catch: one bad document must not stall the rest.
const runStaleCheck = async (now: Date = new Date()) => {
  const settings = await DispatchService.getSettings()
  await SosService.startStaleClocks(now)
  await sendCheckIns(settings, now)
  await handleUnanswered(settings, now)
}

export const StaleService = { runStaleCheck }
