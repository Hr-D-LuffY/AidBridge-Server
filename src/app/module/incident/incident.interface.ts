import { z } from 'zod'
import {
  IncidentStatus,
  MAX_INCIDENT_ADDRESS_LENGTH,
  MAX_INCIDENT_DESCRIPTION_LENGTH,
  MAX_INCIDENT_TITLE_LENGTH,
  MAX_SOS_LINKS_PER_CALL,
  MIN_INCIDENT_TITLE_LENGTH,
  SosLinkAction,
} from '../../constants/incident'
import { DisasterType, Priority } from '../../constants/relief'
import { coordinatesSchema } from '../../lib/geo'
import { paginationQueryShape } from '../../utils/pagination'
import {
  atLeastOneField,
  isoDateSchema,
  objectIdSchema,
  updateBodySchema,
} from '../../utils/validation'

const titleSchema = z
  .string()
  .trim()
  .min(MIN_INCIDENT_TITLE_LENGTH, `Title must be at least ${MIN_INCIDENT_TITLE_LENGTH} characters`)
  .max(MAX_INCIDENT_TITLE_LENGTH, `Title must be at most ${MAX_INCIDENT_TITLE_LENGTH} characters`)

const disasterTypeSchema = z.enum(DisasterType, {
  error: `Disaster type must be one of: ${Object.values(DisasterType).join(', ')}`,
})

const prioritySchema = z.enum(Priority, {
  error: `Priority must be one of: ${Object.values(Priority).join(', ')}`,
})

const statusSchema = z.enum(IncidentStatus, {
  error: `Status must be one of: ${Object.values(IncidentStatus).join(', ')}`,
})

const addressSchema = z
  .string()
  .trim()
  .max(
    MAX_INCIDENT_ADDRESS_LENGTH,
    `Address must be at most ${MAX_INCIDENT_ADDRESS_LENGTH} characters`,
  )

const descriptionSchema = z
  .string()
  .trim()
  .max(
    MAX_INCIDENT_DESCRIPTION_LENGTH,
    `Description must be at most ${MAX_INCIDENT_DESCRIPTION_LENGTH} characters`,
  )

// Strict: `createdBy`, `status`, `priority`, `sosRequests` and the like are not set on creation
// (priority has its own route, links have theirs).
export const createIncidentSchema = z.strictObject({
  title: titleSchema,
  disasterType: disasterTypeSchema,
  coordinates: coordinatesSchema,
  address: addressSchema.optional(),
  description: descriptionSchema.optional(),
  startDate: isoDateSchema,
})

export const updateIncidentSchema = updateBodySchema(
  {
    title: titleSchema.optional(),
    disasterType: disasterTypeSchema.optional(),
    coordinates: coordinatesSchema.optional(),
    address: addressSchema.optional(),
    description: descriptionSchema.optional(),
    startDate: isoDateSchema.optional(),
    endDate: isoDateSchema.optional(),
    status: statusSchema.optional(),
  },
  'Priority has its own route (PUT /incidents/:id/priority) and linked requests have PUT /incidents/:id/sos',
)
  .refine(...atLeastOneField)
  .refine(
    (incident) =>
      !incident.endDate || !incident.startDate || incident.endDate >= incident.startDate,
    {
      message: 'End date cannot be before start date',
      path: ['endDate'],
    },
  )
  .refine((incident) => !(incident.status === IncidentStatus.ACTIVE && incident.endDate), {
    message: 'An active incident has no end date. Set the status to resolved to give it one',
    path: ['endDate'],
  })

export const setIncidentPrioritySchema = z.strictObject({ priority: prioritySchema })

export const linkSosSchema = z.strictObject({
  action: z.enum(SosLinkAction, {
    error: `Action must be one of: ${Object.values(SosLinkAction).join(', ')}`,
  }),
  sosRequestIds: z
    .array(objectIdSchema)
    .min(1, 'Send at least one SOS request id')
    .max(MAX_SOS_LINKS_PER_CALL, `At most ${MAX_SOS_LINKS_PER_CALL} requests per call`)
    .transform((ids) => [...new Set(ids)]),
})

export const listIncidentsQuerySchema = z.object({
  ...paginationQueryShape,
  status: statusSchema.optional(),
  priority: prioritySchema.optional(),
  disasterType: disasterTypeSchema.optional(),
})

export type CreateIncidentPayload = z.infer<typeof createIncidentSchema>
export type UpdateIncidentPayload = z.infer<typeof updateIncidentSchema>
export type LinkSosPayload = z.infer<typeof linkSosSchema>
export type ListIncidentsQuery = z.infer<typeof listIncidentsQuerySchema>
