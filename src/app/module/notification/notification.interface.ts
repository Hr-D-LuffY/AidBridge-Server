import { z } from 'zod'
import {
  ALL_ROLES_TARGET,
  MAX_NOTIFICATION_MESSAGE_LENGTH,
  MAX_NOTIFICATION_TITLE_LENGTH,
  NOTIFICATION_TARGETS,
  type NotificationTarget,
} from '../../constants/notification'
import { paginationQueryShape } from '../../utils/pagination'

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

export type CreateNotificationPayload = z.infer<typeof createNotificationSchema>
export type ListNotificationsQuery = z.infer<typeof listNotificationsQuerySchema>
