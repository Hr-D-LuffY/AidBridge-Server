import { MS_PER_MINUTE } from '../../constants/dispatch'
import { PRIORITY_ORDER, type Priority } from '../../constants/relief'
import { DUPLICATE_DISTANCE_STEP_METERS, DUPLICATE_WINDOW_MINUTES } from '../../constants/sos'

// Pure decisions of duplicate detection: values and a clock in, answers out, no database.

// How far back from a new request another one may have been created and still count as a possible duplicate.
export const windowStart = (createdAt: Date) =>
  new Date(createdAt.getTime() - DUPLICATE_WINDOW_MINUTES * MS_PER_MINUTE)

// What a volunteer is told about another request's distance: rounded up to the next step (and never below
// one), so it says "up to 100 m" and does not pinpoint anyone.
export const approximateDistance = (meters: number) =>
  Math.max(
    DUPLICATE_DISTANCE_STEP_METERS,
    Math.ceil(meters / DUPLICATE_DISTANCE_STEP_METERS) * DUPLICATE_DISTANCE_STEP_METERS,
  )

// Combining two requests must never lower how urgent the people in them are: the survivor keeps the more
// urgent of the two priorities.
export const moreUrgent = (a: Priority, b: Priority) =>
  PRIORITY_ORDER.indexOf(a) <= PRIORITY_ORDER.indexOf(b) ? a : b

export const minutesBetween = (a: Date, b: Date) =>
  Math.round(Math.abs(a.getTime() - b.getTime()) / MS_PER_MINUTE)
