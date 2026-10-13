import httpStatus from 'http-status'
import { catchAsync } from '../../utils/catchAsync'
import { getAuthUser } from '../../utils/getAuthUser'
import { sendResponse } from '../../utils/sendResponse'
import { idParamSchema } from '../../utils/validation'
import { createNotificationSchema, listNotificationsQuerySchema } from './notification.interface'
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

const createNotification = catchAsync(async (req, res) => {
  const payload = createNotificationSchema.parse(req.body)
  const notification = await NotificationService.createNotification(getAuthUser(req).id, payload)

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

export const NotificationController = { listNotifications, createNotification, markRead }
