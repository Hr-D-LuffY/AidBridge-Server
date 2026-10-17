import { Role } from './role'

// "Everyone" as a target. It sits next to the four roles in `targetRoles`, so a notification for all
// users is stored as ['all'] instead of listing every role.
export const ALL_ROLES_TARGET = 'all'

export const NOTIFICATION_TARGETS = [ALL_ROLES_TARGET, ...Object.values(Role)] as const

export type NotificationTarget = (typeof NOTIFICATION_TARGETS)[number]

// What a notification is about. Preferences (a later step) switch whole categories on and off; the client
// groups the bell by category.
export const NotificationCategory = {
  REQUESTS: 'requests',
  TASKS: 'tasks',
  CAMPS: 'camps',
  SAFETY: 'safety',
  SYSTEM: 'system',
} as const

export type NotificationCategory = (typeof NotificationCategory)[keyof typeof NotificationCategory]

// One value per event that raises a notification. Add a value here (and its row in the table below) in
// the same commit that starts raising it; the client's `types/enums.ts` gets the same value.
export const NotificationType = {
  // Notifications made before types existed read as this one.
  GENERAL: 'general',
  BROADCAST: 'broadcast',
  CHAT_MESSAGE: 'chat_message',
  SOS_ASSIGNED: 'sos_assigned',
  SOS_ON_THE_WAY: 'sos_on_the_way',
  SOS_RESCUED: 'sos_rescued',
  SOS_UPDATED: 'sos_updated',
  TASK_CANCELLED: 'task_cancelled',
  VOLUNTEER_BACKED_OUT: 'volunteer_backed_out',
  VOLUNTEER_REQUEST_APPROVED: 'volunteer_request_approved',
  VOLUNTEER_REQUEST_REJECTED: 'volunteer_request_rejected',
  INVENTORY_LOW: 'inventory_low',
} as const

export type NotificationType = (typeof NotificationType)[keyof typeof NotificationType]

interface NotificationTypeMeta {
  category: NotificationCategory
  // May be sent by email when the person has switched email on for the category (a later step).
  emailable: boolean
  // Cannot be switched off: the person needs it to stay safe or to know what happened to their account.
  mandatory: boolean
}

export const NOTIFICATION_TYPE_META: Record<NotificationType, NotificationTypeMeta> = {
  // Only old notifications read as this; they are system notices, so they are never switched off.
  [NotificationType.GENERAL]: {
    category: NotificationCategory.SYSTEM,
    emailable: false,
    mandatory: true,
  },
  [NotificationType.BROADCAST]: {
    category: NotificationCategory.SYSTEM,
    emailable: false,
    mandatory: true,
  },
  [NotificationType.CHAT_MESSAGE]: {
    category: NotificationCategory.REQUESTS,
    emailable: false,
    mandatory: false,
  },
  [NotificationType.SOS_ASSIGNED]: {
    category: NotificationCategory.REQUESTS,
    emailable: true,
    mandatory: false,
  },
  [NotificationType.SOS_ON_THE_WAY]: {
    category: NotificationCategory.REQUESTS,
    emailable: false,
    mandatory: false,
  },
  [NotificationType.SOS_RESCUED]: {
    category: NotificationCategory.REQUESTS,
    emailable: true,
    mandatory: false,
  },
  [NotificationType.SOS_UPDATED]: {
    category: NotificationCategory.TASKS,
    emailable: false,
    mandatory: false,
  },
  [NotificationType.TASK_CANCELLED]: {
    category: NotificationCategory.TASKS,
    emailable: false,
    mandatory: true,
  },
  [NotificationType.VOLUNTEER_BACKED_OUT]: {
    category: NotificationCategory.SAFETY,
    emailable: true,
    mandatory: true,
  },
  [NotificationType.VOLUNTEER_REQUEST_APPROVED]: {
    category: NotificationCategory.SYSTEM,
    emailable: true,
    mandatory: true,
  },
  [NotificationType.VOLUNTEER_REQUEST_REJECTED]: {
    category: NotificationCategory.SYSTEM,
    emailable: true,
    mandatory: true,
  },
  [NotificationType.INVENTORY_LOW]: {
    category: NotificationCategory.CAMPS,
    emailable: true,
    mandatory: false,
  },
}

// Categories whose email switch starts on. Everything else starts off, and in-app starts on for all.
export const DEFAULT_EMAIL_CATEGORIES: readonly NotificationCategory[] = [
  NotificationCategory.SAFETY,
]

export const NOTIFICATION_EMAIL_SUBJECT_PREFIX = 'AidBridge'

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
