import type { z } from 'zod'
import { dateRangeQuerySchema } from '../../utils/dateRange'

// Both the dashboard and the report take the same optional range. Either end can be sent alone.
export const analyticsQuerySchema = dateRangeQuerySchema

export type AnalyticsQuery = z.infer<typeof analyticsQuerySchema>
