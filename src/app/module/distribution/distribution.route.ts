import { Router } from 'express'
import { Role } from '../../constants/role'
import { auth } from '../../middleware/checkAuth'
import { DistributionController } from './distribution.controller'

const router = Router()

router.get('/', auth(Role.ADMIN, Role.NGO), DistributionController.listDistributions)
router.post('/', auth(Role.VOLUNTEER), DistributionController.createDistribution)

export const DistributionRoutes = router
