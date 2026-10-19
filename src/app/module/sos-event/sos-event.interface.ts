import { z } from 'zod'
import { TIMELINE_DEFAULT_LIMIT, TIMELINE_MAX_LIMIT } from '../../constants/dispatch'
import type { SosEventType } from '../../constants/dispatch'

export const timelineQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(TIMELINE_MAX_LIMIT).default(TIMELINE_DEFAULT_LIMIT),
})

export type TimelineQuery = z.infer<typeof timelineQuerySchema>

type MetaValue = string | number | boolean | null

export interface SosEventInput {
  sos: string
  type: SosEventType
  actorId?: string
  subjectId?: string
  meta?: Record<string, MetaValue>
  at?: Date
}
