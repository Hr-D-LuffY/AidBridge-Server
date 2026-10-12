import { Router } from 'express'
import { Role } from '../../constants/role'
import { auth } from '../../middleware/checkAuth'
import { VolunteerRequestController } from './volunteer-request.controller'

const router = Router()

// A normal user asks; an admin decides. `/me` is declared before `/:id/...` routes.
router.post('/', auth(Role.VICTIM), VolunteerRequestController.createRequest)
router.get('/me', auth(), VolunteerRequestController.listMyRequests)
router.get('/', auth(Role.ADMIN), VolunteerRequestController.listRequests)
router.put('/:id/approve', auth(Role.ADMIN), VolunteerRequestController.approveRequest)
router.put('/:id/reject', auth(Role.ADMIN), VolunteerRequestController.rejectRequest)

export const VolunteerRequestRoutes = router
