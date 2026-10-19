import { z } from 'zod'
import { Priority, ReliefCategory } from '../../constants/relief'
import {
  MAX_SOS_ADDRESS_LENGTH,
  MAX_SOS_DESCRIPTION_LENGTH,
  MAX_SOS_MEDIA_ITEMS,
  MAX_SOS_RESOLVE_REASON_LENGTH,
  MAX_SOS_SEARCH_LENGTH,
  MIN_SOS_SEARCH_LENGTH,
  ResolveKind,
  SosSort,
  SosStatus,
} from '../../constants/sos'
import { MAX_REQUIRED_SKILLS, Skill } from '../../constants/skill'
import { coordinatesSchema, nearbyQueryShape } from '../../lib/geo'
import { skillListSchema, skillSchema } from '../../lib/skillSchema'
import { paginationQueryShape } from '../../utils/pagination'
import { queryList } from '../../utils/queryList'
import {
  atLeastOneField,
  isoDateEndSchema,
  isoDateSchema,
  objectIdSchema,
  updateBodySchema,
} from '../../utils/validation'

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
  requiredSkills: skillListSchema(MAX_REQUIRED_SKILLS).optional(),
  description: descriptionSchema.optional(),
  coordinates: coordinatesSchema,
  address: addressSchema.optional(),
})

export const updateSosSchema = updateBodySchema(
  {
    needs: needsSchema.optional(),
    requiredSkills: skillListSchema(MAX_REQUIRED_SKILLS).optional(),
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

const resolveReasonSchema = z
  .string()
  .trim()
  .min(1, 'A resolve reason is required')
  .max(
    MAX_SOS_RESOLVE_REASON_LENGTH,
    `Reason must be at most ${MAX_SOS_RESOLVE_REASON_LENGTH} characters`,
  )

// `kind` says why. Any kind but `other` needs no typed reason (the server fills in a preset one, so
// "I'm safe" is one tap); `other` still has to explain itself, which keeps the old body working.
export const resolveSosSchema = z
  .strictObject({
    kind: z
      .enum(ResolveKind, {
        error: `Kind must be one of: ${Object.values(ResolveKind).join(', ')}`,
      })
      .default(ResolveKind.OTHER),
    resolveReason: resolveReasonSchema.optional(),
  })
  .refine((body) => body.kind !== ResolveKind.OTHER || body.resolveReason !== undefined, {
    message: 'A resolve reason is required',
    path: ['resolveReason'],
  })

// An admin closing a request by hand always says why: the victim and the volunteers are shown it.
export const closeSosSchema = z.strictObject({ reason: resolveReasonSchema })

export const setPrioritySchema = z.strictObject({ priority: prioritySchema })

const statusSchema = z.enum(SosStatus, {
  error: `Status must be one of: ${Object.values(SosStatus).join(', ')}`,
})

const needFilterSchema = z.enum(ReliefCategory, {
  error: `Need must be one of: ${Object.values(ReliefCategory).join(', ')}`,
})

// Parse `normalizeQuery(req.query)`, not `req.query`: the filters below are lists that may arrive as
// `status[]=a&status[]=b`, a repeated key or a comma list. Blank values are dropped before this runs.
export const listSosQuerySchema = z
  .object({
    ...paginationQueryShape,
    status: queryList(statusSchema, Object.keys(SosStatus).length),
    priority: queryList(prioritySchema, Object.keys(Priority).length),
    needs: queryList(needFilterSchema, Object.keys(ReliefCategory).length),
    q: z
      .string()
      .trim()
      .min(MIN_SOS_SEARCH_LENGTH, `Search must be at least ${MIN_SOS_SEARCH_LENGTH} characters`)
      .max(MAX_SOS_SEARCH_LENGTH, `Search must be at most ${MAX_SOS_SEARCH_LENGTH} characters`)
      .optional(),
    from: isoDateSchema.optional(),
    // A bare date means "through the end of that day".
    to: isoDateEndSchema.optional(),
    sort: z
      .enum(SosSort, { error: `Sort must be one of: ${Object.values(SosSort).join(', ')}` })
      .default(SosSort.NEWEST),
    // Admin and NGO only (the service answers 403 to anyone else).
    incidentId: objectIdSchema.optional(),
    volunteerId: objectIdSchema.optional(),
    victimId: objectIdSchema.optional(),
    // `true`: requests dispatch gave up finding a volunteer for; `false`: all the others.
    unserved: z
      .enum(['true', 'false'], { error: 'unserved must be true or false' })
      .optional()
      .transform((value) => (value === undefined ? undefined : value === 'true')),
  })
  .refine((query) => !query.from || !query.to || query.from <= query.to, {
    message: '"from" must not be after "to"',
    path: ['from'],
  })

// Parse `normalizeQuery(req.query)`. `skills` keeps only the requests that want any of those skills
// (asked for directly, or implied by what they need).
export const nearbySosQuerySchema = z.object({
  ...paginationQueryShape,
  ...nearbyQueryShape,
  skills: queryList(skillSchema, Object.keys(Skill).length),
})

export type CreateSosPayload = z.infer<typeof createSosSchema>
export type UpdateSosPayload = z.infer<typeof updateSosSchema>
export type ResolveSosPayload = z.infer<typeof resolveSosSchema>
export type CloseSosPayload = z.infer<typeof closeSosSchema>
export type SetPriorityPayload = z.infer<typeof setPrioritySchema>
export type ListSosQuery = z.infer<typeof listSosQuerySchema>
export type NearbySosQuery = z.infer<typeof nearbySosQuerySchema>
