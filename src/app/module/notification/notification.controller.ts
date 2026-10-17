import httpStatus from 'http-status'
import { catchAsync } from '../../utils/catchAsync'
import { getAuthUser } from '../../utils/getAuthUser'
import { normalizeQuery } from '../../utils/queryList'
import { sendResponse } from '../../utils/sendResponse'
import { idParamSchema } from '../../utils/validation'
import {
  createNotificationSchema,
  listBroadcastsQuerySchema,
  listNotificationsQuerySchema,
  readAllQuerySchema,
  updatePreferencesSchema,
} from './notification.interface'
import { NotificationService } from './notification.service'

const listNotifications = catchAsync(async (req, res) => {
  const query = listNotificationsQuerySchema.parse(req.query)
  const { items, meta } = await NotificationService.listMine(getAuthUser(req), query)

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Notifications retrieved successfully',
    data: items,
    meta,
  })
})

const getUnreadCount = catchAsync(async (req, res) => {
  const count = await NotificationService.countUnread(getAuthUser(req))

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Unread count retrieved successfully',
    data: { count },
  })
})

const markAllRead = catchAsync(async (req, res) => {
  const query = readAllQuerySchema.parse(normalizeQuery(req.query))
  const result = await NotificationService.markAllRead(getAuthUser(req), query)

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Notifications marked as read',
    data: result,
  })
})

const getPreferences = catchAsync(async (req, res) => {
  const preferences = await NotificationService.getPreferences(getAuthUser(req))

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Notification preferences retrieved successfully',
    data: preferences,
  })
})

const updatePreferences = catchAsync(async (req, res) => {
  const changes = updatePreferencesSchema.parse(req.body)
  const preferences = await NotificationService.updatePreferences(getAuthUser(req), changes)

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Notification preferences updated successfully',
    data: preferences,
  })
})

const listBroadcasts = catchAsync(async (req, res) => {
  const query = listBroadcastsQuerySchema.parse(req.query)
  const { items, meta } = await NotificationService.listBroadcasts(query)

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Broadcast history retrieved successfully',
    data: items,
    meta,
  })
})

const createNotification = catchAsync(async (req, res) => {
  const payload = createNotificationSchema.parse(req.body)
  const notification = await NotificationService.createNotification(getAuthUser(req), payload)

  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    message: payload.isEmergencyBroadcast
      ? 'Notification created. The emergency email is being sent'
      : 'Notification created successfully',
    data: notification,
  })
})

const markRead = catchAsync(async (req, res) => {
  const { id } = idParamSchema.parse(req.params)
  const notification = await NotificationService.markRead(getAuthUser(req), id)

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Notification marked as read',
    data: notification,
  })
})

export const NotificationController = {
  listNotifications,
  getUnreadCount,
  listBroadcasts,
  createNotification,
  markRead,
  markAllRead,
  getPreferences,
  updatePreferences,
}
