import { z } from 'zod'
import {
  BOARD_DEFAULT_LIMIT,
  BOARD_MAX_LIMIT,
  DISPATCH_SETTINGS_LIMITS as LIMITS,
  MAX_DISPATCH_NOTE_LENGTH,
  ProofMode,
} from '../../constants/dispatch'
import { paginationQueryShape } from '../../utils/pagination'
import { atLeastOneField, objectIdSchema, updateBodySchema } from '../../utils/validation'

const wholeNumber = (min: number, max: number, label: string) =>
  z
    .number({ error: `${label} must be a number` })
    .int(`${label} must be a whole number`)
    .min(min, `${label} must be between ${min} and ${max}`)
    .max(max, `${label} must be between ${min} and ${max}`)

const minutes = (limit: { min: number; max: number }, label: string) =>
  wholeNumber(limit.min, limit.max, label)

const weight = (label: string) =>
  z
    .number({ error: `${label} must be a number` })
    .min(
      LIMITS.weight.min,
      `${label} must be between ${LIMITS.weight.min} and ${LIMITS.weight.max}`,
    )
    .max(
      LIMITS.weight.max,
      `${label} must be between ${LIMITS.weight.min} and ${LIMITS.weight.max}`,
    )

// A nested block may be sent in part (`{ waitMinutes: { critical: 3 } }`) but not empty.
const partialBlock = <T extends z.ZodRawShape>(shape: T) =>
  z
    .strictObject(shape)
    .refine((value) => Object.values(value).some((field) => field !== undefined), {
      message: 'Provide at least one field in this block',
    })

// Every field optional: send only what changes. Rules across fields (weights add up to 1, the start
// radius not above the maximum) are checked by the service against the merged result.
export const updateSettingsSchema = updateBodySchema(
  {
    enabled: z.boolean({ error: 'enabled must be true or false' }).optional(),
    waitMinutes: partialBlock({
      critical: minutes(LIMITS.waitMinutes, 'Critical wait').optional(),
      high: minutes(LIMITS.waitMinutes, 'High wait').optional(),
      medium: minutes(LIMITS.waitMinutes, 'Medium wait').optional(),
      low: minutes(LIMITS.waitMinutes, 'Low wait').optional(),
    }).optional(),
    volunteersPerRound: wholeNumber(
      LIMITS.volunteersPerRound.min,
      LIMITS.volunteersPerRound.max,
      'Volunteers per round',
    ).optional(),
    offerWindowMinutes: minutes(LIMITS.offerWindowMinutes, 'Offer window').optional(),
    criticalOfferWindowMinutes: minutes(
      LIMITS.offerWindowMinutes,
      'Critical offer window',
    ).optional(),
    startRadiusKm: wholeNumber(LIMITS.radiusKm.min, LIMITS.radiusKm.max, 'Start radius').optional(),
    radiusFactor: z
      .number({ error: 'Radius factor must be a number' })
      .min(
        LIMITS.radiusFactor.min,
        `Radius factor must be between ${LIMITS.radiusFactor.min} and ${LIMITS.radiusFactor.max}`,
      )
      .max(
        LIMITS.radiusFactor.max,
        `Radius factor must be between ${LIMITS.radiusFactor.min} and ${LIMITS.radiusFactor.max}`,
      )
      .optional(),
    maxRadiusKm: wholeNumber(LIMITS.radiusKm.min, LIMITS.radiusKm.max, 'Maximum radius').optional(),
    maxRounds: wholeNumber(LIMITS.maxRounds.min, LIMITS.maxRounds.max, 'Rounds').optional(),
    retryIntervalMinutes: minutes(LIMITS.retryIntervalMinutes, 'Retry interval').optional(),
    setOffWithinMinutes: minutes(LIMITS.setOffWithinMinutes, 'Set-off time').optional(),
    criticalSetOffWithinMinutes: minutes(
      LIMITS.setOffWithinMinutes,
      'Critical set-off time',
    ).optional(),
    staleCheckAfterHours: wholeNumber(
      LIMITS.staleHours.min,
      LIMITS.staleHours.max,
      'Stale check time',
    ).optional(),
    staleCheckAssignedAfterHours: wholeNumber(
      LIMITS.staleHours.min,
      LIMITS.staleHours.max,
      'Stale check time for a held request',
    ).optional(),
    staleCloseAfterHours: wholeNumber(
      LIMITS.staleHours.min,
      LIMITS.staleHours.max,
      'Stale close time',
    ).optional(),
    slaAssignMinutes: partialBlock({
      critical: minutes(LIMITS.slaMinutes, 'Critical target').optional(),
      high: minutes(LIMITS.slaMinutes, 'High target').optional(),
      medium: minutes(LIMITS.slaMinutes, 'Medium target').optional(),
      low: minutes(LIMITS.slaMinutes, 'Low target').optional(),
    }).optional(),
    slaArriveMinutes: partialBlock({
      critical: minutes(LIMITS.slaMinutes, 'Critical arrival target').optional(),
      high: minutes(LIMITS.slaMinutes, 'High arrival target').optional(),
      medium: minutes(LIMITS.slaMinutes, 'Medium arrival target').optional(),
      low: minutes(LIMITS.slaMinutes, 'Low arrival target').optional(),
    }).optional(),
    proofMode: z
      .enum(ProofMode, {
        error: `Proof mode must be one of: ${Object.values(ProofMode).join(', ')}`,
      })
      .optional(),
    weights: partialBlock({
      distance: weight('Distance weight').optional(),
      reliability: weight('Reliability weight').optional(),
      load: weight('Load weight').optional(),
      skillMatch: weight('Skill-match weight').optional(),
      noShowPenalty: weight('No-show penalty weight').optional(),
    }).optional(),
  },
  'Only dispatch settings can be edited here',
).refine(...atLeastOneField)

// Which volunteers could take a request, best first. The nearest 50 within the radius are ranked and then
// paged. `radiusKm` defaults to the maximum radius setting.
export const candidatesQuerySchema = z.object({
  ...paginationQueryShape,
  radiusKm: z.coerce
    .number({ error: 'radiusKm must be a number' })
    .min(
      LIMITS.radiusKm.min,
      `radiusKm must be between ${LIMITS.radiusKm.min} and ${LIMITS.radiusKm.max}`,
    )
    .max(
      LIMITS.radiusKm.max,
      `radiusKm must be between ${LIMITS.radiusKm.min} and ${LIMITS.radiusKm.max}`,
    )
    .optional(),
})

// The board pages each lane on its own; `limit` is shared.
export const boardQuerySchema = z.object({
  limit: z.coerce
    .number({ error: 'limit must be a number' })
    .int()
    .min(1)
    .max(BOARD_MAX_LIMIT)
    .default(BOARD_DEFAULT_LIMIT),
  unassignedPage: z.coerce.number().int().min(1).default(1),
  assignedPage: z.coerce.number().int().min(1).default(1),
  enRoutePage: z.coerce.number().int().min(1).default(1),
})

export const assignSchema = z.strictObject({
  volunteerId: objectIdSchema,
  // true: the volunteer gets the request at once (already accepted). Default: an offer they can answer.
  direct: z.boolean({ error: 'direct must be true or false' }).default(false),
})

const noteSchema = z
  .string()
  .trim()
  .min(1, 'A reason cannot be blank')
  .max(MAX_DISPATCH_NOTE_LENGTH, `Reason must be at most ${MAX_DISPATCH_NOTE_LENGTH} characters`)

export const unassignSchema = z.strictObject({
  reason: noteSchema.optional(),
  // Stop automatic offers for the request after taking it back (the admin will pick someone by hand).
  pause: z.boolean({ error: 'pause must be true or false' }).default(false),
})

export type UpdateSettingsPayload = z.infer<typeof updateSettingsSchema>
export type CandidatesQuery = z.infer<typeof candidatesQuerySchema>
export type BoardQuery = z.infer<typeof boardQuerySchema>
export type AssignPayload = z.infer<typeof assignSchema>
export type UnassignPayload = z.infer<typeof unassignSchema>
