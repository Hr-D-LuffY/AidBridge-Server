import { Router } from 'express'
import { Role } from '../../constants/role'
import { auth } from '../../middleware/checkAuth'
import { CampController } from './camp.controller'

const router = Router()

// `/nearby` and `/my-assigned` are declared before `/:id` so they aren't read as ids.
router.get('/nearby', auth(Role.VICTIM, Role.ADMIN), CampController.listNearby)
router.get('/my-assigned', auth(Role.VOLUNTEER), CampController.listMyAssigned)

router.get('/', auth(Role.NGO, Role.ADMIN), CampController.listCamps)
router.post('/', auth(Role.NGO), CampController.createCamp)

// The owning NGO manages its camps; an admin may manage any of them.
// One active camp as a victim sees it (the camp's own page); an admin may read it too.
router.get('/:id', auth(Role.VICTIM, Role.ADMIN), CampController.getCamp)

router.put('/:id/assign', auth(Role.NGO, Role.ADMIN), CampController.assignVolunteer)
router.put('/:id/unassign', auth(Role.NGO, Role.ADMIN), CampController.unassignVolunteer)
router.put('/:id/occupancy', auth(Role.NGO, Role.ADMIN), CampController.adjustOccupancy)
router.put('/:id', auth(Role.NGO, Role.ADMIN), CampController.updateCamp)
router.delete('/:id', auth(Role.NGO, Role.ADMIN), CampController.deleteCamp)

export const CampRoutes = router
