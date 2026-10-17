import httpStatus from 'http-status'
import type { QueryFilter, Types } from 'mongoose'
import { AuditAction, AuditTargetType } from '../../constants/audit'
import {
  BROADCAST_EMAIL_BATCH_SIZE,
  BROADCAST_EMAIL_SUBJECT_PREFIX,
  CHAT_NOTIFICATION_TITLE_PREFIX,
  CHAT_PREVIEW_LENGTH,
  NOTIFICATION_EMAIL_SUBJECT_PREFIX,
  NOTIFICATION_TYPE_META,
  NotificationCategory,
  type NotificationTarget,
  NotificationType,
} from '../../constants/notification'
import { AppError } from '../../errorHelpers/AppError'
import { sendMail } from '../../lib/mailer'
import { escapeHtml } from '../../utils/escapeHtml'
import type { TokenPayload } from '../../utils/jwt'
import { buildMeta, getPagination } from '../../utils/pagination'
import { AuditService } from '../audit/audit.service'
import { UserService } from '../user/user.service'
import type {
  CreateNotificationPayload,
  ListBroadcastsQuery,
  ListNotificationsQuery,
  PreferencesChange,
  ReadAllQuery,
} from './notification.interface'
import { Notification, type NotificationDocument } from './notification.model'
import {
  isCategoryLocked,
  type NotificationPreferences,
  resolvePreferences,
  shouldCreateInApp,
  shouldSendEmail,
} from './notification.rules'

const NOT_FOUND_MESSAGE = 'Notification not found'

interface NotificationFields {
  _id: Types.ObjectId
  title: string
  message: string
  type?: NotificationType | null
  isEmergencyBroadcast: boolean
  sosRequest?: Types.ObjectId | null
  camp?: Types.ObjectId | null
  readBy: Types.ObjectId[]
  createdAt: Date
}

// What a client sees. `readBy` holds other people's ids, so it is reduced to one fact: has the
// caller opened it.
const toNotificationView = (notification: NotificationFields, viewerId: string) => {
  const type = notification.type ?? NotificationType.GENERAL
  return {
    id: String(notification._id),
    type,
    category: NOTIFICATION_TYPE_META[type].category,
    title: notification.title,
    message: notification.message,
    isEmergencyBroadcast: notification.isEmergencyBroadcast,
    sosRequestId: notification.sosRequest ? String(notification.sosRequest) : null,
    campId: notification.camp ? String(notification.camp) : null,
    isRead: notification.readBy.some((reader) => String(reader) === viewerId),
    createdAt: notification.createdAt,
  }
}

// Addressed to the caller: to everyone, to their role, or to them by name.
const visibleTo = (viewer: TokenPayload): QueryFilter<NotificationDocument> => ({
  $or: [{ targetRoles: 'all' }, { targetRoles: viewer.role }, { targetUsers: viewer.id }],
})

const listMine = async (viewer: TokenPayload, query: ListNotificationsQuery) => {
  const { page, limit, unread } = query
  const filter: QueryFilter<NotificationDocument> = {
    ...visibleTo(viewer),
    ...(unread && { readBy: { $ne: viewer.id } }),
  }

  const [notifications, total] = await Promise.all([
    Notification.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip(getPagination(query).skip)
      .limit(limit)
      .lean(),
    Notification.countDocuments(filter),
  ])

  return {
    items: notifications.map((notification) => toNotificationView(notification, viewer.id)),
    meta: buildMeta({ page, limit }, total),
  }
}

// How many of the caller's notifications they have not opened: the number on the bell, without
// fetching the list.
const countUnread = (viewer: TokenPayload) =>
  Notification.countDocuments({ ...visibleTo(viewer), readBy: { $ne: viewer.id } })

// One conditional update: marks it read only if it is addressed to the caller. A notification that
// does not exist and one meant for somebody else both answer 404, so ids can't be probed. Reading
// twice is harmless ($addToSet).
const markRead = async (viewer: TokenPayload, id: string) => {
  const notification = await Notification.findOneAndUpdate(
    { _id: id, ...visibleTo(viewer) },
    { $addToSet: { readBy: viewer.id } },
    { returnDocument: 'after' },
  ).lean()
  if (!notification) throw new AppError(httpStatus.NOT_FOUND, NOT_FOUND_MESSAGE)
  return toNotificationView(notification, viewer.id)
}

// Marks everything addressed to the caller that they have not opened as read, or only one type or one
// category of it. One update for the lot; reading twice is harmless. Notifications saved before types
// existed count as `general`, so they are matched by a missing type. Answers how many were changed.
const markAllRead = async (viewer: TokenPayload, query: ReadAllQuery) => {
  const { type, category } = query
  const types: NotificationType[] = type
    ? [type]
    : category
      ? Object.values(NotificationType).filter(
          (candidate) => NOTIFICATION_TYPE_META[candidate].category === category,
        )
      : []
  const filter: Record<string, unknown> = { ...visibleTo(viewer), readBy: { $ne: viewer.id } }
  if (types.length > 0) {
    filter.type = {
      $in: types.includes(NotificationType.GENERAL) ? [...types, null] : types,
    }
  }

  const result = await Notification.updateMany(filter, { $addToSet: { readBy: viewer.id } })
  return { count: result.modifiedCount }
}

// Every category with the person's two switches and whether the in-app one is locked on.
const toPreferencesView = (preferences: NotificationPreferences) =>
  Object.fromEntries(
    Object.values(NotificationCategory).map((category) => [
      category,
      { ...preferences[category], inAppLocked: isCategoryLocked(category) },
    ]),
  )

const getPreferences = async (viewer: TokenPayload) =>
  toPreferencesView(await UserService.getNotificationPreferences(viewer.id))

const updatePreferences = async (viewer: TokenPayload, changes: PreferencesChange) =>
  toPreferencesView(await UserService.updateNotificationPreferences(viewer.id, changes))

// What an admin sent (a notification with a sender and target roles); the ones the system raises for one
// person (a chat message, a decided request) are not broadcasts and are not listed. `readCount` is how
// many people have opened it, never who.
const listBroadcasts = async (query: ListBroadcastsQuery) => {
  const { page, limit } = query
  const filter: QueryFilter<NotificationDocument> = {
    createdBy: { $exists: true },
    'targetRoles.0': { $exists: true },
  }

  const [broadcasts, total] = await Promise.all([
    Notification.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip(getPagination(query).skip)
      .limit(limit)
      .populate<{ createdBy: { _id: Types.ObjectId; name: string } | null }>('createdBy', 'name')
      .lean(),
    Notification.countDocuments(filter),
  ])

  return {
    items: broadcasts.map((broadcast) => ({
      id: String(broadcast._id),
      title: broadcast.title,
      message: broadcast.message,
      targetRoles: broadcast.targetRoles,
      isEmergencyBroadcast: broadcast.isEmergencyBroadcast,
      sentBy: broadcast.createdBy
        ? { id: String(broadcast.createdBy._id), name: broadcast.createdBy.name }
        : null,
      readCount: broadcast.readBy.length,
      createdAt: broadcast.createdAt,
    })),
    meta: buildMeta({ page, limit }, total),
  }
}

const chunk = <T>(items: T[], size: number) => {
  const batches: T[][] = []
  for (let start = 0; start < items.length; start += size) {
    batches.push(items.slice(start, start + size))
  }
  return batches
}

// Emails the alert to every active account in the targeted roles. Runs after the notification is
// saved and is never awaited by the request: a mail outage must not turn a saved alert into a 500
// (the old route did, and a retry then saved it twice). Each batch is its own message with the
// recipients in BCC; a failed batch is logged and the remaining ones still go out.
const emailBroadcast = async (title: string, message: string, targets: NotificationTarget[]) => {
  const emails = await UserService.listEmailsForTargets(targets)
  const subject = `${BROADCAST_EMAIL_SUBJECT_PREFIX}: ${title}`
  const text = `${title}\n\n${message}`
  const html = `<h2>${escapeHtml(title)}</h2><p>${escapeHtml(message).replace(/\n/g, '<br>')}</p>`

  for (const batch of chunk(emails, BROADCAST_EMAIL_BATCH_SIZE)) {
    try {
      await sendMail({ bcc: batch, subject, html, text })
    } catch (error) {
      console.error(`Emergency broadcast email failed for a batch of ${batch.length}:`, error)
    }
  }
}

const createNotification = async (admin: TokenPayload, payload: CreateNotificationPayload) => {
  const { title, message, targetRoles, isEmergencyBroadcast } = payload
  const notification = await Notification.create({
    title,
    message,
    targetRoles,
    isEmergencyBroadcast,
    type: NotificationType.BROADCAST,
    createdBy: admin.id,
  })

  if (isEmergencyBroadcast) {
    emailBroadcast(title, message, targetRoles).catch((error) => {
      console.error('Emergency broadcast could not start:', error)
    })
  }

  await AuditService.record({
    actor: admin,
    action: AuditAction.BROADCAST_SENT,
    targetType: AuditTargetType.NOTIFICATION,
    targetId: String(notification._id),
    summary: `Sent ${isEmergencyBroadcast ? 'an emergency ' : 'a '}broadcast "${title}" to ${targetRoles.join(', ')}`,
    meta: { targetRoles, isEmergencyBroadcast },
  })
  return toNotificationView(notification, admin.id)
}

const truncate = (text: string, length: number) =>
  text.length > length ? `${text.slice(0, length - 1).trimEnd()}…` : text

interface NotifyUsersInput {
  userIds: string[]
  type: NotificationType
  title: string
  message: string
  // The request or camp it is about, so a client can open it.
  sosRequestId?: string
  campId?: string
}

// Emails the same notification to several people at once (recipients in BCC, in batches, so nobody sees
// another's address). Detached from the request that caused it: a mail outage is logged, never raised.
const emailNotification = async (emails: string[], title: string, message: string) => {
  const subject = `${NOTIFICATION_EMAIL_SUBJECT_PREFIX}: ${title}`
  const html = `<h2>${escapeHtml(title)}</h2><p>${escapeHtml(message).replace(/\n/g, '<br>')}</p>`
  for (const batch of chunk(emails, BROADCAST_EMAIL_BATCH_SIZE)) {
    try {
      await sendMail({ bcc: batch, subject, html, text: `${title}\n\n${message}` })
    } catch (error) {
      console.error(`Notification email failed for a batch of ${batch.length}:`, error)
    }
  }
}

// Who gets this notification and how, from each person's saved switches, in ONE lookup for the whole
// list. In-app: always for a mandatory type, otherwise when the category's in-app switch is on. Email:
// only for an emailable type whose category email switch is on, never to a blocked account. A person
// who no longer exists gets nothing. If the lookup itself fails, everyone gets the in-app one (better
// a notification too many than a missed one) and nobody gets an email.
const decideDelivery = async (userIds: string[], type: NotificationType) => {
  try {
    const targets = await UserService.getNotificationTargets(userIds)
    const inApp: string[] = []
    const emails: string[] = []
    for (const userId of userIds) {
      const target = targets.get(userId)
      if (!target) continue
      const preferences = resolvePreferences(target.preferences)
      if (shouldCreateInApp(type, preferences)) inApp.push(userId)
      if (shouldSendEmail(type, preferences) && !target.isBlocked) emails.push(target.email)
    }
    return { inApp, emails }
  } catch (error) {
    console.error('Could not read notification preferences, using the defaults:', error)
    return { inApp: userIds, emails: [] as string[] }
  }
}

// The one way other modules tell people something happened. Call it AFTER the change has committed.
// It never throws: a failure is logged, so a write that already happened is not reported as a failed
// request. Each person gets their own notification (their own read state), unless their settings turn
// that category off and the type is not mandatory. When it is about a request, an unread notification
// of the same type about the same request is replaced rather than stacked, so a flapping event shows
// once on the bell. Only personal notifications (one named recipient, no roles) are ever replaced,
// never a broadcast. Email, when someone asked for it, goes out afterwards and is not waited for.
const notifyUsers = async (input: NotifyUsersInput) => {
  const { type, title, message, sosRequestId, campId } = input
  const userIds = [...new Set(input.userIds)]
  if (userIds.length === 0) return

  try {
    const { inApp, emails } = await decideDelivery(userIds, type)

    if (inApp.length > 0) {
      if (sosRequestId) {
        await Notification.deleteMany({
          type,
          sosRequest: sosRequestId,
          targetRoles: { $size: 0 },
          targetUsers: { $in: inApp },
          'targetUsers.1': { $exists: false },
          readBy: { $size: 0 },
        })
      }
      await Notification.insertMany(
        inApp.map((userId) => ({
          type,
          title,
          message,
          targetUsers: [userId],
          ...(sosRequestId && { sosRequest: sosRequestId }),
          ...(campId && { camp: campId }),
        })),
      )
    }

    if (emails.length > 0) void emailNotification(emails, title, message)
  } catch (error) {
    console.error(`Could not notify ${userIds.length} user(s) about ${type}:`, error)
  }
}

// Tells one person that someone wrote to them on a request, with who wrote and the start of what they
// wrote. Unread messages on the same request are replaced by the newest, so the bell counts
// conversations, not messages.
const notifyChatMessage = (
  recipientId: string,
  senderName: string,
  content: string,
  sosRequestId: string,
) =>
  notifyUsers({
    userIds: [recipientId],
    type: NotificationType.CHAT_MESSAGE,
    title: `${CHAT_NOTIFICATION_TITLE_PREFIX} ${senderName}`,
    message: truncate(content, CHAT_PREVIEW_LENGTH),
    sosRequestId,
  })

export const NotificationService = {
  listMine,
  countUnread,
  markRead,
  markAllRead,
  getPreferences,
  updatePreferences,
  listBroadcasts,
  createNotification,
  notifyUsers,
  notifyChatMessage,
}
