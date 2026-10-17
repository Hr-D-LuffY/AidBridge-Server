import { z } from 'zod'
import {
  ALL_ROLES_TARGET,
  MAX_NOTIFICATION_MESSAGE_LENGTH,
  MAX_NOTIFICATION_TITLE_LENGTH,
  NOTIFICATION_TARGETS,
  NotificationCategory,
  type NotificationTarget,
  NotificationType,
} from '../../constants/notification'
import { paginationQueryShape } from '../../utils/pagination'
import { isCategoryLocked } from './notification.rules'

export const createNotificationSchema = z.strictObject({
  title: z
    .string({ error: 'Title is required' })
    .trim()
    .min(1, 'Title is required')
    .max(
      MAX_NOTIFICATION_TITLE_LENGTH,
      `Title must be at most ${MAX_NOTIFICATION_TITLE_LENGTH} characters`,
    ),
  message: z
    .string({ error: 'Message is required' })
    .trim()
    .min(1, 'Message is required')
    .max(
      MAX_NOTIFICATION_MESSAGE_LENGTH,
      `Message must be at most ${MAX_NOTIFICATION_MESSAGE_LENGTH} characters`,
    ),
  targetRoles: z
    .array(
      z.enum(NOTIFICATION_TARGETS, {
        error: `Each target must be one of: ${NOTIFICATION_TARGETS.join(', ')}`,
      }),
      { error: 'targetRoles must be a list of roles' },
    )
    .min(1, 'Choose at least one target role, or "all"')
    // Duplicates collapse, and "all" already covers every role, so it stands alone.
    .transform((targets): NotificationTarget[] =>
      targets.includes(ALL_ROLES_TARGET) ? [ALL_ROLES_TARGET] : [...new Set(targets)],
    ),
  // A real boolean only: the old route read the string "false" as true.
  isEmergencyBroadcast: z
    .boolean({ error: 'isEmergencyBroadcast must be true or false' })
    .default(false),
})

// `?unread=true` keeps only what the caller has not opened. Query values are always strings.
export const listNotificationsQuerySchema = z.object({
  ...paginationQueryShape,
  unread: z
    .enum(['true', 'false'], { error: 'unread must be true or false' })
    .optional()
    .transform((value) => value === 'true'),
})

// `PUT /notifications/read-all`: everything unread, or only one type or one category of it.
export const readAllQuerySchema = z
  .object({
    type: z
      .enum(NotificationType, {
        error: `Type must be one of: ${Object.values(NotificationType).join(', ')}`,
      })
      .optional(),
    category: z
      .enum(NotificationCategory, {
        error: `Category must be one of: ${Object.values(NotificationCategory).join(', ')}`,
      })
      .optional(),
  })
  .refine((query) => !(query.type && query.category), {
    message: 'Use either "type" or "category", not both',
    path: ['category'],
  })

const switchesSchema = z
  .strictObject({
    inApp: z.boolean({ error: 'inApp must be true or false' }).optional(),
    email: z.boolean({ error: 'email must be true or false' }).optional(),
  })
  .refine((switches) => switches.inApp !== undefined || switches.email !== undefined, {
    message: 'Send inApp, email or both',
  })

const categoryShape = Object.fromEntries(
  Object.values(NotificationCategory).map((category) => [category, switchesSchema.optional()]),
) as Record<NotificationCategory, z.ZodOptional<typeof switchesSchema>>

// `PUT /notifications/preferences`: only the categories and switches being changed. An unknown category
// is a 400 that names it; so is switching off a category whose notifications are all mandatory.
export const updatePreferencesSchema = z
  .strictObject(categoryShape)
  .refine((body) => Object.values(body).some((switches) => switches !== undefined), {
    message: 'Send at least one category',
  })
  .superRefine((body, ctx) => {
    for (const category of Object.values(NotificationCategory)) {
      if (body[category]?.inApp === false && isCategoryLocked(category)) {
        ctx.addIssue({
          code: 'custom',
          path: [category, 'inApp'],
          message: `"${category}" notifications are always on and cannot be switched off`,
        })
      }
    }
  })

export type ReadAllQuery = z.infer<typeof readAllQuerySchema>
export type PreferencesChange = z.infer<typeof updatePreferencesSchema>

// Admin history of what was sent. Pagination only.
export const listBroadcastsQuerySchema = z.object({ ...paginationQueryShape })

export type ListBroadcastsQuery = z.infer<typeof listBroadcastsQuerySchema>
export type CreateNotificationPayload = z.infer<typeof createNotificationSchema>
export type ListNotificationsQuery = z.infer<typeof listNotificationsQuerySchema>
