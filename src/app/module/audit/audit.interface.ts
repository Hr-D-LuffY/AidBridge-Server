import { z } from 'zod'
import { AuditAction, AuditTargetType } from '../../constants/audit'
import type { Role } from '../../constants/role'
import { paginationQueryShape } from '../../utils/pagination'
import { isoDateEndSchema, isoDateSchema, objectIdSchema } from '../../utils/validation'

export const listAuditLogsQuerySchema = z
  .object({
    ...paginationQueryShape,
    actor: objectIdSchema.optional(),
    action: z
      .enum(AuditAction, {
        error: `Action must be one of: ${Object.values(AuditAction).join(', ')}`,
      })
      .optional(),
    targetType: z
      .enum(AuditTargetType, {
        error: `Target type must be one of: ${Object.values(AuditTargetType).join(', ')}`,
      })
      .optional(),
    from: isoDateSchema.optional(),
    // A bare date means "through the end of that day".
    to: isoDateEndSchema.optional(),
  })
  .refine((query) => !query.from || !query.to || query.from <= query.to, {
    message: '"from" must not be after "to"',
    path: ['from'],
  })

export type ListAuditLogsQuery = z.infer<typeof listAuditLogsQuerySchema>

// Ids, numbers, flags and short text only: `meta` is a pointer to what changed, not a copy of it.
export type AuditMetaValue = string | number | boolean | null | string[]

export interface AuditEntry {
  // Whoever did it; null when the system acted on its own.
  actor: { id: string; role: Role } | null
  action: AuditAction
  targetType: AuditTargetType
  targetId: string
  summary: string
  meta?: Record<string, AuditMetaValue>
}
