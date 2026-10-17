import {
  DEFAULT_EMAIL_CATEGORIES,
  NOTIFICATION_TYPE_META,
  NotificationCategory,
  type NotificationType,
} from '../../constants/notification'

// Pure rules for who gets which notification and how. They take values, never `req` or `config`.

export interface CategoryPreference {
  inApp: boolean
  email: boolean
}

export type NotificationPreferences = Record<NotificationCategory, CategoryPreference>

// What is saved on the user: only the switches they changed. Anything missing falls back to the default,
// so a new category or a person who never opened the settings page needs no stored data.
export type StoredPreferences =
  | Partial<Record<NotificationCategory, Partial<CategoryPreference>>>
  | null
  | undefined

const CATEGORIES = Object.values(NotificationCategory)

export const resolvePreferences = (stored: StoredPreferences): NotificationPreferences => {
  const resolved = {} as NotificationPreferences
  for (const category of CATEGORIES) {
    resolved[category] = {
      inApp: stored?.[category]?.inApp ?? true,
      email: stored?.[category]?.email ?? DEFAULT_EMAIL_CATEGORIES.includes(category),
    }
  }
  return resolved
}

// A category is locked when every type in it is mandatory: its in-app switch cannot be turned off. A
// category that mixes (tasks: an edit notice, and a cancellation) can be switched off, but the mandatory
// types in it still arrive; see `shouldCreateInApp`.
export const isCategoryLocked = (category: NotificationCategory) =>
  Object.values(NOTIFICATION_TYPE_META)
    .filter((meta) => meta.category === category)
    .every((meta) => meta.mandatory)

export const shouldCreateInApp = (type: NotificationType, preferences: NotificationPreferences) => {
  const meta = NOTIFICATION_TYPE_META[type]
  return meta.mandatory || preferences[meta.category].inApp
}

// Email is never sent for a type that is not flagged emailable, whatever the switch says.
export const shouldSendEmail = (type: NotificationType, preferences: NotificationPreferences) => {
  const meta = NOTIFICATION_TYPE_META[type]
  return meta.emailable && preferences[meta.category].email
}
