import { z } from 'zod'
import { VolunteerRequestStatus } from '../../constants/volunteerRequest'
import { paginationQueryShape } from '../../utils/pagination'
import { MAX_MESSAGE_LENGTH } from './volunteer-request.model'

const MIN_REQUEST_MESSAGE_LENGTH = 10

export const createVolunteerRequestSchema = z.object({
  message: z
    .string()
    .trim()
    .min(
      MIN_REQUEST_MESSAGE_LENGTH,
      `Tell us why in at least ${MIN_REQUEST_MESSAGE_LENGTH} characters`,
    )
    .max(MAX_MESSAGE_LENGTH, `Message must be at most ${MAX_MESSAGE_LENGTH} characters`),
})

export const reviewVolunteerRequestSchema = z.object({
  note: z
    .string()
    .trim()
    .max(MAX_MESSAGE_LENGTH, `Note must be at most ${MAX_MESSAGE_LENGTH} characters`)
    .optional(),
})

export const listVolunteerRequestsQuerySchema = z.object({
  ...paginationQueryShape,
  status: z
    .enum(VolunteerRequestStatus, {
      error: `Status must be one of: ${Object.values(VolunteerRequestStatus).join(', ')}`,
    })
    .optional(),
})

export type CreateVolunteerRequestPayload = z.infer<typeof createVolunteerRequestSchema>
export type ReviewVolunteerRequestPayload = z.infer<typeof reviewVolunteerRequestSchema>
export type ListVolunteerRequestsQuery = z.infer<typeof listVolunteerRequestsQuerySchema>
