import { Router } from 'express'
import { Role } from '../../constants/role'
import { auth } from '../../middleware/checkAuth'
import { TaskController } from './task.controller'

const router = Router()

router.get('/', auth(Role.VOLUNTEER), TaskController.listMyTasks)
router.put('/:id/respond', auth(Role.VOLUNTEER), TaskController.respond)
router.put('/:id/status', auth(Role.VOLUNTEER), TaskController.updateStatus)

// Rating belongs to the victim the volunteer helped. The old routes had no auth at all.
router.get('/:id/rating-status', auth(Role.VICTIM), TaskController.getRatingStatus)
router.post('/:id/rate', auth(Role.VICTIM), TaskController.rateTask)

export const TaskRoutes = router
