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

// A chat message tells the other person, with who wrote and the start of what they wrote. Unread ones
// from the same sender on the same request are replaced by the newest, so a long conversation is one
// line on the bell, not fifty.
export const CHAT_NOTIFICATION_TITLE_PREFIX = 'New message from'
export const CHAT_PREVIEW_LENGTH = 100
