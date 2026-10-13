import { z } from 'zod'
import {
  MAX_RATING,
  MIN_RATING,
  RespondAction,
  TASK_PROGRESS_STATUSES,
  TaskStatus,
} from '../../constants/task'
import { paginationQueryShape } from '../../utils/pagination'

export const listTasksQuerySchema = z.object({
  ...paginationQueryShape,
  status: z
    .enum(TaskStatus, { error: `Status must be one of: ${Object.values(TaskStatus).join(', ')}` })
    .optional(),
})

export const respondSchema = z.strictObject({
  action: z.enum(RespondAction, {
    error: `Action must be one of: ${Object.values(RespondAction).join(', ')}`,
  }),
})

export const taskStatusSchema = z.strictObject({
  status: z.enum(TASK_PROGRESS_STATUSES, {
    error: `Status must be one of: ${TASK_PROGRESS_STATUSES.join(', ')}`,
  }),
})

// Whole stars only. The old API took any number, so 4.37 was a valid rating.
export const rateTaskSchema = z.strictObject({
  score: z
    .number({ error: 'Score must be a number' })
    .int('Score must be a whole number')
    .min(MIN_RATING, `Score must be between ${MIN_RATING} and ${MAX_RATING}`)
    .max(MAX_RATING, `Score must be between ${MIN_RATING} and ${MAX_RATING}`),
})

export type ListTasksQuery = z.infer<typeof listTasksQuerySchema>
export type RespondPayload = z.infer<typeof respondSchema>
export type TaskStatusPayload = z.infer<typeof taskStatusSchema>
export type RateTaskPayload = z.infer<typeof rateTaskSchema>
