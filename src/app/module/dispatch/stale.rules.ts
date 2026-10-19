import {
  type DispatchSettingsValues,
  MS_PER_HOUR,
  STALE_MIN_ANSWER_HOURS,
} from '../../constants/dispatch'
import { Priority } from '../../constants/relief'
import { SosStatus } from '../../constants/sos'

// Pure decisions of the stale-request job: values and a clock in, answers out. No database, no config.

// How long a request may go without a sign of life before the victim is asked if they still need help.
// A request a volunteer already holds has a longer wait: help is on its way and silence is expected.
export const checkAfterMs = (status: SosStatus, settings: DispatchSettingsValues) =>
  (status === SosStatus.PENDING
    ? settings.staleCheckAfterHours
    : settings.staleCheckAssignedAfterHours) * MS_PER_HOUR

// Whether an open request has been quiet long enough to be asked. \`checkedAt\` is when it was asked
// already (a request is asked once until the victim answers).
export const isDueForCheckIn = (
  status: SosStatus,
  lastConfirmedAt: Date,
  checkedAt: Date | null,
  settings: DispatchSettingsValues,
  now: Date,
) =>
  checkedAt === null && now.getTime() - lastConfirmedAt.getTime() >= checkAfterMs(status, settings)

// Whether a request that was asked has gone unanswered long enough to act on: quiet for the full close
// time, and asked at least `STALE_MIN_ANSWER_HOURS` ago, so the victim always has time to reply.
export const isUnanswered = (
  lastConfirmedAt: Date,
  checkedAt: Date | null,
  settings: DispatchSettingsValues,
  now: Date,
) =>
  checkedAt !== null &&
  now.getTime() - lastConfirmedAt.getTime() >= settings.staleCloseAfterHours * MS_PER_HOUR &&
  now.getTime() - checkedAt.getTime() >= STALE_MIN_ANSWER_HOURS * MS_PER_HOUR

// Only medium and low requests are ever closed by silence (R9). Someone in danger may be unable to
// answer, so a high or critical request is escalated to people instead.
export const closesAutomatically = (priority: Priority) =>
  priority === Priority.MEDIUM || priority === Priority.LOW
