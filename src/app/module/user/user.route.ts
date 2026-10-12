import { Router } from 'express'
import { Role } from '../../constants/role'
import { auth } from '../../middleware/checkAuth'
import { UserController } from './user.controller'

const router = Router()

router.post('/', auth(Role.ADMIN), UserController.createAccount)
router.get('/', auth(Role.NGO, Role.ADMIN), UserController.listUsers)
router.get('/:id', auth(), UserController.getUserById)

export const UserRoutes = router
