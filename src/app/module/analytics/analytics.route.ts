import { Router } from 'express'
import { Role } from '../../constants/role'
import { auth } from '../../middleware/checkAuth'
import { AnalyticsController } from './analytics.controller'

const router = Router()

router.get('/', auth(Role.ADMIN), AnalyticsController.getDashboard)
router.get('/reports', auth(Role.ADMIN), AnalyticsController.getReport)
router.get('/admin-summary', auth(Role.ADMIN), AnalyticsController.getAdminSummary)
// NGOs coordinate camps and relief, so they see the map too.
router.get('/live-map', auth(Role.ADMIN, Role.NGO), AnalyticsController.getLiveMap)

export const AnalyticsRoutes = router
