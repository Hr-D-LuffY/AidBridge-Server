import { Router } from 'express'
import { Role } from '../../constants/role'
import { auth } from '../../middleware/checkAuth'
import { NotificationController } from './notification.controller'

const router = Router()

// Everyone reads and marks their own; only admins create. Which ones a caller sees is decided in
// the service from their role and id.
router.get('/', auth(), NotificationController.listNotifications)
router.get('/unread-count', auth(), NotificationController.getUnreadCount)
router.get('/broadcasts', auth(Role.ADMIN), NotificationController.listBroadcasts)
router.post('/', auth(Role.ADMIN), NotificationController.createNotification)
router.get('/preferences', auth(), NotificationController.getPreferences)
router.put('/preferences', auth(), NotificationController.updatePreferences)
router.put('/read-all', auth(), NotificationController.markAllRead)
router.put('/:id/read', auth(), NotificationController.markRead)

export const NotificationRoutes = router
