import { z } from 'zod'
import { MAX_DISTRIBUTION_NOTES_LENGTH } from '../../constants/distribution'
import { MAX_STOCK_QUANTITY } from '../../constants/inventory'
import { paginationQueryShape } from '../../utils/pagination'
import { isoDateEndSchema, isoDateSchema, objectIdSchema } from '../../utils/validation'

// Strict: the recipient comes from the task, and the time from the server. The old body let the
// volunteer name any victim and any date.
export const createDistributionSchema = z.strictObject({
  taskId: objectIdSchema,
  campId: objectIdSchema,
  inventoryItemId: objectIdSchema,
  quantity: z
    .number({ error: 'Quantity must be a number' })
    .positive('Quantity must be greater than zero')
    .max(MAX_STOCK_QUANTITY, `Quantity must be at most ${MAX_STOCK_QUANTITY}`),
  notes: z
    .string()
    .trim()
    .max(
      MAX_DISTRIBUTION_NOTES_LENGTH,
      `Notes must be at most ${MAX_DISTRIBUTION_NOTES_LENGTH} characters`,
    )
    .optional(),
})

export const listDistributionsQuerySchema = z
  .object({
    ...paginationQueryShape,
    camp: objectIdSchema.optional(),
    volunteer: objectIdSchema.optional(),
    from: isoDateSchema.optional(),
    to: isoDateEndSchema.optional(),
  })
  .refine((query) => !query.from || !query.to || query.from <= query.to, {
    message: '"from" must not be after "to"',
    path: ['from'],
  })

export type CreateDistributionPayload = z.infer<typeof createDistributionSchema>
export type ListDistributionsQuery = z.infer<typeof listDistributionsQuerySchema>
