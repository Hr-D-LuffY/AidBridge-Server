import { Router } from 'express'
import { Role } from '../../constants/role'
import { auth } from '../../middleware/checkAuth'
import { AuditController } from './audit.controller'

const router = Router()

// Read only, and only for admins. Nothing edits or deletes an entry: the log is written by the
// services that do the work, and MongoDB expires old entries on its own.
router.get('/', auth(Role.ADMIN), AuditController.listLogs)

export const AuditRoutes = router
