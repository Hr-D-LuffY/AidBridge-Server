import { z } from 'zod'
import {
  HEATMAP_DEFAULT_CELL,
  HEATMAP_MAX_CELL,
  HEATMAP_MIN_CELL,
  HeatmapStatus,
} from '../../constants/analytics'
import { dateRangeQuerySchema } from '../../utils/dateRange'
import { isoDateEndSchema, isoDateSchema, objectIdSchema } from '../../utils/validation'

// Both the dashboard and the report take the same optional range. Either end can be sent alone.
export const analyticsQuerySchema = dateRangeQuerySchema

// `from` / `to` are when the request was raised (like `GET /sos`); a bare `to` date covers that whole day.
export const heatmapQuerySchema = z
  .object({
    incidentId: objectIdSchema.optional(),
    status: z
      .enum(HeatmapStatus, {
        error: `Status must be one of: ${Object.values(HeatmapStatus).join(', ')}`,
      })
      .default(HeatmapStatus.OPEN),
    from: isoDateSchema.optional(),
    to: isoDateEndSchema.optional(),
    cell: z.coerce
      .number({ error: 'cell must be a number' })
      .min(HEATMAP_MIN_CELL, `cell must be between ${HEATMAP_MIN_CELL} and ${HEATMAP_MAX_CELL}`)
      .max(HEATMAP_MAX_CELL, `cell must be between ${HEATMAP_MIN_CELL} and ${HEATMAP_MAX_CELL}`)
      .default(HEATMAP_DEFAULT_CELL),
  })
  .refine((query) => !query.from || !query.to || query.from <= query.to, {
    message: '"from" must not be after "to"',
    path: ['from'],
  })

export type AnalyticsQuery = z.infer<typeof analyticsQuerySchema>
export type HeatmapQuery = z.infer<typeof heatmapQuerySchema>
