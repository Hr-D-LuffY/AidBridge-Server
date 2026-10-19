import { Router } from 'express'
import { Role } from '../../constants/role'
import { auth } from '../../middleware/checkAuth'
import { uploadProofPhoto } from '../../middleware/upload'
import { TaskController } from './task.controller'

const router = Router()

router.get('/', auth(Role.VOLUNTEER), TaskController.listMyTasks)
router.get('/:id', auth(Role.VOLUNTEER), TaskController.getTask)
router.put('/:id/respond', auth(Role.VOLUNTEER), TaskController.respond)
router.put('/:id/status', auth(Role.VOLUNTEER), TaskController.updateStatus)

// Proof of delivery (commit 24). auth() runs before the upload middleware so an anonymous caller's file is
// never parsed. An admin can complete a task that has no code or photo.
router.put(
  '/:id/proof-media',
  auth(Role.VOLUNTEER),
  uploadProofPhoto.single('media'),
  TaskController.addProofPhoto,
)
router.put('/:id/override-complete', auth(Role.ADMIN), TaskController.overrideComplete)

// Rating belongs to the victim the volunteer helped. The old routes had no auth at all.
router.get('/:id/rating-status', auth(Role.VICTIM), TaskController.getRatingStatus)
router.post('/:id/rate', auth(Role.VICTIM), TaskController.rateTask)

export const TaskRoutes = router
