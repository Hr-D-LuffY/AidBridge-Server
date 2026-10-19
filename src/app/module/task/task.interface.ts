import { z } from 'zod'
import {
  MAX_RATING,
  MAX_TASK_NOTES_LENGTH,
  MIN_RATING,
  PROOF_CODE_LENGTH,
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

const arrivalCodeSchema = z
  .string({ error: 'The arrival code must be text' })
  .trim()
  .regex(
    new RegExp(`^\\d{${PROOF_CODE_LENGTH}}$`),
    `The arrival code is ${PROOF_CODE_LENGTH} digits`,
  )

// `proof` goes with `completed` only. Whether it is needed at all depends on the task (a task from before
// proof of delivery, or one created while it was switched off, ignores it), so the service decides that.
export const taskStatusSchema = z
  .strictObject({
    status: z.enum(TASK_PROGRESS_STATUSES, {
      error: `Status must be one of: ${TASK_PROGRESS_STATUSES.join(', ')}`,
    }),
    proof: z.strictObject({ code: arrivalCodeSchema }).optional(),
  })
  .refine((value) => value.proof === undefined || value.status === TaskStatus.COMPLETED, {
    message: 'Proof can only be sent with the status "completed"',
    path: ['proof'],
  })

// Why an admin is completing a task that has no code or photo. Kept on the task, not in the audit log.
export const overrideCompleteSchema = z.strictObject({
  reason: z
    .string({ error: 'A reason is required' })
    .trim()
    .min(1, 'A reason is required')
    .max(MAX_TASK_NOTES_LENGTH, `Reason must be at most ${MAX_TASK_NOTES_LENGTH} characters`),
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
export type OverrideCompletePayload = z.infer<typeof overrideCompleteSchema>
