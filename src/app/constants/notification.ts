import { Role } from './role'

// "Everyone" as a target. It sits next to the four roles in `targetRoles`, so a notification for all
// users is stored as ['all'] instead of listing every role.
export const ALL_ROLES_TARGET = 'all'

export const NOTIFICATION_TARGETS = [ALL_ROLES_TARGET, ...Object.values(Role)] as const

export type NotificationTarget = (typeof NOTIFICATION_TARGETS)[number]

export const MAX_NOTIFICATION_TITLE_LENGTH = 150
export const MAX_NOTIFICATION_MESSAGE_LENGTH = 2000

// Recipients per broadcast email. Each batch is one message with everyone in BCC, so no recipient
// sees another's address, and a failed batch does not stop the rest. Gmail caps a message at 100
// recipients; this stays well under it.
export const BROADCAST_EMAIL_BATCH_SIZE = 50

export const BROADCAST_EMAIL_SUBJECT_PREFIX = 'AidBridge emergency alert'
