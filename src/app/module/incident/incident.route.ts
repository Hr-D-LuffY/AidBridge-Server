import { Router } from 'express'
import { Role } from '../../constants/role'
import { auth } from '../../middleware/checkAuth'
import { IncidentController } from './incident.controller'

const router = Router()

// Any logged-in user can read the incident history; only admins change it.
router.get('/', auth(), IncidentController.listIncidents)
router.post('/', auth(Role.ADMIN), IncidentController.createIncident)

router.put('/:id/priority', auth(Role.ADMIN), IncidentController.setPriority)
router.put('/:id/sos', auth(Role.ADMIN), IncidentController.linkRequests)
router.put('/:id', auth(Role.ADMIN), IncidentController.updateIncident)
router.delete('/:id', auth(Role.ADMIN), IncidentController.deleteIncident)

export const IncidentRoutes = router
