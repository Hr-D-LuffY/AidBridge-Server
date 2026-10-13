import { z } from 'zod'
import {
  MAX_CAMP_ADDRESS_LENGTH,
  MAX_CAMP_CAPACITY,
  MAX_CAMP_NAME_LENGTH,
  MIN_CAMP_NAME_LENGTH,
} from '../../constants/camp'
import { coordinatesSchema, nearbyQueryShape } from '../../lib/geo'
import { paginationQueryShape } from '../../utils/pagination'
import { atLeastOneField, objectIdSchema, updateBodySchema } from '../../utils/validation'

const OCCUPANCY_ERROR = 'Occupancy cannot be more than capacity'

const nameSchema = z
  .string()
  .trim()
  .min(MIN_CAMP_NAME_LENGTH, `Name must be at least ${MIN_CAMP_NAME_LENGTH} characters`)
  .max(MAX_CAMP_NAME_LENGTH, `Name must be at most ${MAX_CAMP_NAME_LENGTH} characters`)

const addressSchema = z
  .string()
  .trim()
  .max(MAX_CAMP_ADDRESS_LENGTH, `Address must be at most ${MAX_CAMP_ADDRESS_LENGTH} characters`)

const capacitySchema = z
  .number({ error: 'Capacity must be a number' })
  .int('Capacity must be a whole number')
  .min(1, 'Capacity must be at least 1')
  .max(MAX_CAMP_CAPACITY, `Capacity must be at most ${MAX_CAMP_CAPACITY}`)

const occupancySchema = z
  .number({ error: 'Occupancy must be a number' })
  .int('Occupancy must be a whole number')
  .min(0, 'Occupancy cannot be negative')

// "true" / "false" in a query string -> boolean. z.coerce.boolean() would treat "false" as true.
const booleanQuery = z.enum(['true', 'false']).transform((value) => value === 'true')

// Strict: `ngo`, `assignedVolunteers`, `isDeleted` and the like are not the caller's to set.
export const createCampSchema = z
  .strictObject({
    name: nameSchema,
    coordinates: coordinatesSchema,
    address: addressSchema.optional(),
    capacity: capacitySchema,
    currentOccupancy: occupancySchema.optional(),
    isActive: z.boolean().optional(),
  })
  .refine((camp) => (camp.currentOccupancy ?? 0) <= camp.capacity, {
    message: OCCUPANCY_ERROR,
    path: ['currentOccupancy'],
  })

export const updateCampSchema = updateBodySchema(
  {
    name: nameSchema.optional(),
    coordinates: coordinatesSchema.optional(),
    address: addressSchema.optional(),
    capacity: capacitySchema.optional(),
    currentOccupancy: occupancySchema.optional(),
    isActive: z.boolean().optional(),
  },
  'Volunteers are managed with /assign and /unassign, and occupancy changes with /occupancy',
)
  .refine(...atLeastOneField)
  .refine(
    (camp) =>
      camp.capacity === undefined ||
      camp.currentOccupancy === undefined ||
      camp.currentOccupancy <= camp.capacity,
    { message: OCCUPANCY_ERROR, path: ['currentOccupancy'] },
  )

export const volunteerBodySchema = z.strictObject({ volunteerId: objectIdSchema })

// Check people in (positive) or out (negative). Zero would do nothing.
export const occupancyChangeSchema = z.strictObject({
  delta: z
    .number({ error: 'delta must be a number' })
    .int('delta must be a whole number')
    .min(-MAX_CAMP_CAPACITY)
    .max(MAX_CAMP_CAPACITY)
    .refine((delta) => delta !== 0, 'delta cannot be 0'),
})

export const listCampsQuerySchema = z.object({
  ...paginationQueryShape,
  isActive: booleanQuery.optional(),
})

export const nearbyCampsQuerySchema = z.object({ ...paginationQueryShape, ...nearbyQueryShape })

export const myCampsQuerySchema = z.object({ ...paginationQueryShape })

export type CreateCampPayload = z.infer<typeof createCampSchema>
export type UpdateCampPayload = z.infer<typeof updateCampSchema>
export type VolunteerBody = z.infer<typeof volunteerBodySchema>
export type OccupancyChange = z.infer<typeof occupancyChangeSchema>
export type ListCampsQuery = z.infer<typeof listCampsQuerySchema>
export type NearbyCampsQuery = z.infer<typeof nearbyCampsQuerySchema>
export type MyCampsQuery = z.infer<typeof myCampsQuerySchema>
