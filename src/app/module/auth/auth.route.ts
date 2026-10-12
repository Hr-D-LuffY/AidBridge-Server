import { Router } from 'express'
import { auth } from '../../middleware/checkAuth'
import { AuthController } from './auth.controller'

const router = Router()

router.post('/register', AuthController.register)
router.post('/login', AuthController.login)
router.post('/forgot-password', AuthController.forgotPassword)
router.put('/reset-password/:token', AuthController.resetPassword)

router.put('/change-password', auth(), AuthController.changePassword)
router.get('/me', auth(), AuthController.getMe)
router.put('/me', auth(), AuthController.updateMe)
router.delete('/me', auth(), AuthController.deleteMe)

export const AuthRoutes = router
