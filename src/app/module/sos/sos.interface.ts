import { z } from 'zod'
import { Priority, ReliefCategory } from '../../constants/relief'
import {
  MAX_SOS_ADDRESS_LENGTH,
  MAX_SOS_DESCRIPTION_LENGTH,
  MAX_SOS_MEDIA_ITEMS,
  MAX_SOS_RESOLVE_REASON_LENGTH,
  SosStatus,
} from '../../constants/sos'
import { coordinatesSchema, nearbyQueryShape } from '../../lib/geo'
import { paginationQueryShape } from '../../utils/pagination'
import { atLeastOneField, objectIdSchema, updateBodySchema } from '../../utils/validation'

const needsSchema = z
  .array(
    z.enum(ReliefCategory, {
      error: `Each need must be one of: ${Object.values(ReliefCategory).join(', ')}`,
    }),
  )
  .min(1, 'Choose at least one need')
  .max(Object.keys(ReliefCategory).length)
  .transform((needs) => [...new Set(needs)])

const descriptionSchema = z
  .string()
  .trim()
  .max(
    MAX_SOS_DESCRIPTION_LENGTH,
    `Description must be at most ${MAX_SOS_DESCRIPTION_LENGTH} characters`,
  )

const addressSchema = z
  .string()
  .trim()
  .max(MAX_SOS_ADDRESS_LENGTH, `Address must be at most ${MAX_SOS_ADDRESS_LENGTH} characters`)

const prioritySchema = z.enum(Priority, {
  error: `Priority must be one of: ${Object.values(Priority).join(', ')}`,
})

// Strict: priority, status, victim and the like are not the caller's to set, so sending one is a
// 400 that names the field instead of being silently ignored.
export const createSosSchema = z.strictObject({
  needs: needsSchema,
  description: descriptionSchema.optional(),
  coordinates: coordinatesSchema,
  address: addressSchema.optional(),
})

export const updateSosSchema = updateBodySchema(
  {
    needs: needsSchema.optional(),
    description: descriptionSchema.optional(),
    address: addressSchema.optional(),
    coordinates: coordinatesSchema.optional(),
    // Ids of media items to delete (the `id` of each item in the SOS response). Replaces the old
    // index-based removal, which deleted the wrong item when indices repeated or the list changed.
    removeMediaIds: z
      .array(objectIdSchema)
      .min(1)
      .max(MAX_SOS_MEDIA_ITEMS)
      .transform((ids) => [...new Set(ids)])
      .optional(),
  },
  'Priority and status are not editable here',
).refine(...atLeastOneField)

export const resolveSosSchema = z.strictObject({
  resolveReason: z
    .string()
    .trim()
    .min(1, 'A resolve reason is required')
    .max(
      MAX_SOS_RESOLVE_REASON_LENGTH,
      `Reason must be at most ${MAX_SOS_RESOLVE_REASON_LENGTH} characters`,
    ),
})

export const setPrioritySchema = z.strictObject({ priority: prioritySchema })

export const listSosQuerySchema = z.object({
  ...paginationQueryShape,
  status: z
    .enum(SosStatus, { error: `Status must be one of: ${Object.values(SosStatus).join(', ')}` })
    .optional(),
  priority: prioritySchema.optional(),
})

export const nearbySosQuerySchema = z.object({
  ...paginationQueryShape,
  ...nearbyQueryShape,
})

export type CreateSosPayload = z.infer<typeof createSosSchema>
export type UpdateSosPayload = z.infer<typeof updateSosSchema>
export type ResolveSosPayload = z.infer<typeof resolveSosSchema>
export type SetPriorityPayload = z.infer<typeof setPrioritySchema>
export type ListSosQuery = z.infer<typeof listSosQuerySchema>
export type NearbySosQuery = z.infer<typeof nearbySosQuerySchema>
