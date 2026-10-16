import { Router } from 'express'
import { Role } from '../../constants/role'
import { auth } from '../../middleware/checkAuth'
import { UserController } from './user.controller'

const router = Router()

router.post('/', auth(Role.ADMIN), UserController.createAccount)
router.get('/', auth(Role.NGO, Role.ADMIN), UserController.listUsers)
router.get('/:id', auth(), UserController.getUserById)
router.put('/:id/block', auth(Role.ADMIN), UserController.blockUser)
router.put('/:id/unblock', auth(Role.ADMIN), UserController.unblockUser)

export const UserRoutes = router
