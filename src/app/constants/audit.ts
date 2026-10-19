// What an admin or NGO did to somebody else's data. One value per kind of action, so the audit page can
// filter on it. Add a value here in the same commit that starts recording it.
export const AuditAction = {
  ACCOUNT_CREATED: 'account_created',
  USER_BLOCKED: 'user_blocked',
  USER_UNBLOCKED: 'user_unblocked',
  VOLUNTEER_REQUEST_APPROVED: 'volunteer_request_approved',
  VOLUNTEER_REQUEST_REJECTED: 'volunteer_request_rejected',
  SOS_PRIORITY_CHANGED: 'sos_priority_changed',
  INCIDENT_CREATED: 'incident_created',
  INCIDENT_UPDATED: 'incident_updated',
  INCIDENT_PRIORITY_CHANGED: 'incident_priority_changed',
  INCIDENT_SOS_LINKED: 'incident_sos_linked',
  INCIDENT_SOS_UNLINKED: 'incident_sos_unlinked',
  INCIDENT_DELETED: 'incident_deleted',
  CAMP_VOLUNTEER_ASSIGNED: 'camp_volunteer_assigned',
  CAMP_VOLUNTEER_UNASSIGNED: 'camp_volunteer_unassigned',
  CAMP_DELETED: 'camp_deleted',
  BROADCAST_SENT: 'broadcast_sent',
  DISPATCH_SETTINGS_CHANGED: 'dispatch_settings_changed',
  SOS_CLOSED: 'sos_closed',
  SOS_AUTO_CLOSED: 'sos_auto_closed',
  SOS_OFFERED: 'sos_offered',
  SOS_ASSIGNED: 'sos_assigned',
  SOS_UNASSIGNED: 'sos_unassigned',
  SOS_DISPATCH_RUN: 'sos_dispatch_run',
  SOS_DISPATCH_PAUSED: 'sos_dispatch_paused',
  SOS_DISPATCH_RESUMED: 'sos_dispatch_resumed',
  TASK_COMPLETED_BY_ADMIN: 'task_completed_by_admin',
} as const

export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction]

// The kind of record the action was done to; `targetId` is that record's id.
export const AuditTargetType = {
  USER: 'user',
  VOLUNTEER_REQUEST: 'volunteer_request',
  SOS_REQUEST: 'sos_request',
  INCIDENT: 'incident',
  CAMP: 'camp',
  NOTIFICATION: 'notification',
  DISPATCH_SETTINGS: 'dispatch_settings',
} as const

export type AuditTargetType = (typeof AuditTargetType)[keyof typeof AuditTargetType]

export const MAX_AUDIT_SUMMARY_LENGTH = 300

// Entries older than this are removed by MongoDB itself (a TTL index on `createdAt`).
export const AUDIT_RETENTION_DAYS = 365
export const AUDIT_RETENTION_SECONDS = AUDIT_RETENTION_DAYS * 24 * 60 * 60

// Lists of ids kept in `meta` stop here: it is a pointer to the records, not a copy of them.
export const MAX_AUDIT_META_IDS = 20
