import type { QueryFilter, Types } from 'mongoose'
import {
  type AuditAction,
  type AuditTargetType,
  MAX_AUDIT_SUMMARY_LENGTH,
} from '../../constants/audit'
import type { Role } from '../../constants/role'
import { inRange } from '../../utils/dateRange'
import { buildMeta, getPagination } from '../../utils/pagination'
import { User } from '../user/user.model'
import type { AuditEntry, ListAuditLogsQuery } from './audit.interface'
import { AuditLog, type AuditLogDocument } from './audit.model'

const truncate = (text: string, length: number) =>
  text.length > length ? `${text.slice(0, length - 1).trimEnd()}…` : text

// The one way anything gets into the audit log. Call it AFTER the change it describes has committed,
// and do not guard the call: a failure here is logged and swallowed, so a write that already happened
// is never reported to the caller as a failed request. A too-long summary is cut, never rejected.
const record = async (entry: AuditEntry) => {
  try {
    await AuditLog.create({
      actor: entry.actor?.id,
      actorRole: entry.actor?.role,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      summary: truncate(entry.summary, MAX_AUDIT_SUMMARY_LENGTH),
      meta: entry.meta ?? {},
    })
  } catch (error) {
    console.error(`Could not write the audit entry ${entry.action} for ${entry.targetId}:`, error)
  }
}

interface AuditFields {
  _id: Types.ObjectId
  actor?: Types.ObjectId | null
  actorRole?: Role | null
  action: AuditAction
  targetType: AuditTargetType
  targetId: Types.ObjectId
  summary: string
  meta?: unknown
  createdAt: Date
}

// `actor` is null for an entry the system wrote. `name` is null when that account no longer exists
// (the id is still there, so the entry stays attributable).
const toAuditView = (entry: AuditFields, names: Map<string, string>) => ({
  id: String(entry._id),
  actor: entry.actor
    ? { id: String(entry.actor), name: names.get(String(entry.actor)) ?? null }
    : null,
  actorRole: entry.actorRole ?? null,
  action: entry.action,
  targetType: entry.targetType,
  targetId: String(entry.targetId),
  summary: entry.summary,
  meta: entry.meta ?? {},
  createdAt: entry.createdAt,
})

const listLogs = async (query: ListAuditLogsQuery) => {
  const { page, limit, actor, action, targetType, from, to } = query
  const filter: QueryFilter<AuditLogDocument> = {
    ...inRange('createdAt', { startDate: from, endDate: to }),
  }
  if (actor) filter.actor = actor
  if (action) filter.action = action
  if (targetType) filter.targetType = targetType

  const [entries, total] = await Promise.all([
    AuditLog.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip(getPagination(query).skip)
      .limit(limit)
      .lean(),
    AuditLog.countDocuments(filter),
  ])

  // One lookup for the whole page, not one per row.
  const actorIds = [
    ...new Set(entries.flatMap((entry) => (entry.actor ? [String(entry.actor)] : []))),
  ]
  const users =
    actorIds.length > 0
      ? await User.find({ _id: { $in: actorIds } })
          .select('name')
          .lean()
      : []
  const names = new Map(users.map((user) => [String(user._id), user.name]))

  return {
    items: entries.map((entry) => toAuditView(entry, names)),
    meta: buildMeta({ page, limit }, total),
  }
}

export const AuditService = { record, listLogs }
