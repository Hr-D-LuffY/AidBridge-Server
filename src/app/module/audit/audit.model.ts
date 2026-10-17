import { Schema, model } from 'mongoose'
import {
  AUDIT_RETENTION_SECONDS,
  AuditAction,
  AuditTargetType,
  MAX_AUDIT_SUMMARY_LENGTH,
} from '../../constants/audit'
import { Role } from '../../constants/role'

const ACTION_VALUES: AuditAction[] = Object.values(AuditAction)
const TARGET_TYPE_VALUES: AuditTargetType[] = Object.values(AuditTargetType)
const ROLE_VALUES: Role[] = Object.values(Role)

const auditLogSchema = new Schema(
  {
    // Absent when the system acted on its own (nothing does yet; the dispatch steps will).
    actor: { type: Schema.Types.ObjectId, ref: 'User' },
    actorRole: { type: String, enum: ROLE_VALUES },
    action: { type: String, enum: ACTION_VALUES, required: true },
    targetType: { type: String, enum: TARGET_TYPE_VALUES, required: true },
    targetId: { type: Schema.Types.ObjectId, required: true },
    summary: { type: String, required: true, trim: true, maxlength: MAX_AUDIT_SUMMARY_LENGTH },
    // Ids and changed values only (never a password, token, hash or phone number).
    meta: { type: Schema.Types.Mixed, default: {} },
  },
  // An entry is written once and never changed, so there is no `updatedAt`.
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false, minimize: false },
)

// The newest-first list, and the TTL that removes entries after a year. One index does both: a TTL
// index must be on a single field.
auditLogSchema.index({ createdAt: -1 }, { expireAfterSeconds: AUDIT_RETENTION_SECONDS })
auditLogSchema.index({ actor: 1, createdAt: -1 })
auditLogSchema.index({ targetType: 1, targetId: 1, createdAt: -1 })

export const AuditLog = model('AuditLog', auditLogSchema)

export type AuditLogDocument = InstanceType<typeof AuditLog>
