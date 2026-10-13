import { Router } from 'express'
import { auth } from '../../middleware/checkAuth'
import { MessageController } from './message.controller'

// Mounted at /sos/:sosId/messages, so the router must see the parent's `:sosId`.
const router = Router({ mergeParams: true })

// Any logged-in role reaches the handler; the service decides (the two participants read and
// write, admins read only).
router.get('/', auth(), MessageController.listMessages)
router.post('/', auth(), MessageController.sendMessage)

export const MessageRoutes = router
