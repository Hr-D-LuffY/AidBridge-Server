import { z } from 'zod'
import { MAX_CHAT_MESSAGE_LENGTH } from '../../constants/message'
import { paginationQueryShape } from '../../utils/pagination'
import { objectIdSchema } from '../../utils/validation'

// The `:sosId` in /sos/:sosId/messages.
export const sosIdParamSchema = z.object({ sosId: objectIdSchema })

export const listMessagesQuerySchema = z.object({ ...paginationQueryShape })

export const sendMessageSchema = z.strictObject({
  content: z
    .string({ error: 'Message content is required' })
    .trim()
    .min(1, 'Message content is required')
    .max(MAX_CHAT_MESSAGE_LENGTH, `Message must be at most ${MAX_CHAT_MESSAGE_LENGTH} characters`),
})

export type ListMessagesQuery = z.infer<typeof listMessagesQuerySchema>
export type SendMessagePayload = z.infer<typeof sendMessageSchema>
