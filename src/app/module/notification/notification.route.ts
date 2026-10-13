import { Router } from 'express'
import { Role } from '../../constants/role'
import { auth } from '../../middleware/checkAuth'
import { NotificationController } from './notification.controller'

const router = Router()

// Everyone reads and marks their own; only admins create. Which ones a caller sees is decided in
// the service from their role and id.
router.get('/', auth(), NotificationController.listNotifications)
router.post('/', auth(Role.ADMIN), NotificationController.createNotification)
router.put('/:id/read', auth(), NotificationController.markRead)

export const NotificationRoutes = router
