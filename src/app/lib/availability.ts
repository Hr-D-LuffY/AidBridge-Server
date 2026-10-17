import { MAX_DUTY_DAYS } from '../constants/skill'

const MS_PER_DAY = 24 * 60 * 60 * 1000

// Pure: takes values and a clock, never reads `req`, `config` or the real time.

// Whether a volunteer can be given work right now: their availability switch is on AND any "on duty
// until" time has not passed yet. The one place this is decided; nearby search, dispatch and the board
// all call it, so none of them re-implements the check.
export const isOnDuty = (
  volunteer: { isAvailable: boolean; onDutyUntil?: Date | null },
  now: Date,
) => volunteer.isAvailable && (!volunteer.onDutyUntil || volunteer.onDutyUntil > now)

// A duty end time a volunteer may set: still ahead of `now`, and no more than a week away.
export const isValidDutyUntil = (until: Date, now: Date) =>
  until > now && until.getTime() - now.getTime() <= MAX_DUTY_DAYS * MS_PER_DAY
