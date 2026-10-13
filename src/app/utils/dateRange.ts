import { z } from 'zod'
import { isoDateEndSchema, isoDateSchema } from './validation'

export interface DateRange {
  startDate?: Date
  endDate?: Date
}

// Optional `startDate` / `endDate` query params. Either one alone is fine (the old reports route
// ignored the range unless both were sent). A bare end date covers that whole day.
export const dateRangeQueryShape = {
  startDate: isoDateSchema.optional(),
  endDate: isoDateEndSchema.optional(),
}

export const dateRangeQuerySchema = z
  .object(dateRangeQueryShape)
  .refine((range) => !range.startDate || !range.endDate || range.startDate <= range.endDate, {
    message: '"startDate" must not be after "endDate"',
    path: ['startDate'],
  })

// `{ [field]: { $gte, $lte } }` for a match stage or query filter, or `{}` when no range was given.
export const inRange = (field: string, { startDate, endDate }: DateRange) =>
  startDate || endDate
    ? { [field]: { ...(startDate && { $gte: startDate }), ...(endDate && { $lte: endDate }) } }
    : {}
