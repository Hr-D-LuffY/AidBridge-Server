import httpStatus from 'http-status'
import type { QueryFilter, Types } from 'mongoose'
import {
  BROADCAST_EMAIL_BATCH_SIZE,
  BROADCAST_EMAIL_SUBJECT_PREFIX,
  type NotificationTarget,
} from '../../constants/notification'
import { AppError } from '../../errorHelpers/AppError'
import { sendMail } from '../../lib/mailer'
import { escapeHtml } from '../../utils/escapeHtml'
import type { TokenPayload } from '../../utils/jwt'
import { buildMeta, getPagination } from '../../utils/pagination'
import { UserService } from '../user/user.service'
import type { CreateNotificationPayload, ListNotificationsQuery } from './notification.interface'
import { Notification, type NotificationDocument } from './notification.model'

const NOT_FOUND_MESSAGE = 'Notification not found'

interface NotificationFields {
  _id: Types.ObjectId
  title: string
  message: string
  isEmergencyBroadcast: boolean
  readBy: Types.ObjectId[]
  createdAt: Date
}

// What a client sees. `readBy` holds other people's ids, so it is reduced to one fact: has the
// caller opened it.
const toNotificationView = (notification: NotificationFields, viewerId: string) => ({
  id: String(notification._id),
  title: notification.title,
  message: notification.message,
  isEmergencyBroadcast: notification.isEmergencyBroadcast,
  isRead: notification.readBy.some((reader) => String(reader) === viewerId),
  createdAt: notification.createdAt,
})

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

const createNotification = async (adminId: string, payload: CreateNotificationPayload) => {
  const { title, message, targetRoles, isEmergencyBroadcast } = payload
  const notification = await Notification.create({
    title,
    message,
    targetRoles,
    isEmergencyBroadcast,
    createdBy: adminId,
  })

  if (isEmergencyBroadcast) {
    emailBroadcast(title, message, targetRoles).catch((error) => {
      console.error('Emergency broadcast could not start:', error)
    })
  }

  return toNotificationView(notification, adminId)
}

// For other modules: tell one person something happened (a volunteer request was decided, the victim
// changed a request you are working). The caller's own write has already committed by now, so a
// failure here is logged and swallowed rather than reported as a failed request.
const notifyUser = async (userId: string, title: string, message: string) => {
  try {
    await Notification.create({ title, message, targetUsers: [userId] })
  } catch (error) {
    console.error(`Could not notify user ${userId}:`, error)
  }
}

export const NotificationService = { listMine, markRead, createNotification, notifyUser }
