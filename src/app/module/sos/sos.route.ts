import { Router } from 'express'
import { MAX_SOS_MEDIA_ITEMS } from '../../constants/sos'
import { Role } from '../../constants/role'
import { auth } from '../../middleware/checkAuth'
import { uploadSosMedia } from '../../middleware/upload'
import { SosController } from './sos.controller'

const router = Router()

// `/nearby` is declared before `/:id` or "nearby" would be read as an id.
router.get('/nearby', auth(Role.VOLUNTEER, Role.ADMIN), SosController.listNearby)

router.get('/', auth(), SosController.listSos)
router.post('/', auth(Role.VICTIM), SosController.createSos)

// auth() runs before the upload middleware so an anonymous caller's files are never parsed.
router.put(
  '/:id/media',
  auth(Role.VICTIM),
  uploadSosMedia.array('media', MAX_SOS_MEDIA_ITEMS),
  SosController.addMedia,
)
router.put('/:id/accept', auth(Role.VOLUNTEER), SosController.acceptSos)
router.put('/:id/reject', auth(Role.VOLUNTEER), SosController.rejectSos)
router.put('/:id/priority', auth(Role.ADMIN), SosController.setPriority)
router.put('/:id/resolve', auth(Role.VICTIM), SosController.resolveSos)
router.put('/:id/close', auth(Role.ADMIN), SosController.closeSos)
router.put('/:id/confirm', auth(Role.VICTIM), SosController.confirmSos)

router.get('/:id/timeline', auth(), SosController.getTimeline)

// Possible duplicates (commit 25): an admin compares, combines or dismisses.
router.get('/:id/duplicates', auth(Role.ADMIN), SosController.getDuplicates)
router.put('/:id/duplicates/dismiss', auth(Role.ADMIN), SosController.dismissDuplicates)
router.put('/:id/merge', auth(Role.ADMIN), SosController.mergeSos)

router.put('/:id', auth(Role.VICTIM), SosController.updateSos)
router.get('/:id', auth(), SosController.getSosById)

export const SosRoutes = router
