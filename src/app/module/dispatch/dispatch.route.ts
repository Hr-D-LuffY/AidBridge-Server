import { Router } from 'express'
import { Role } from '../../constants/role'
import { auth } from '../../middleware/checkAuth'
import { DispatchController } from './dispatch.controller'

// Mounted at /dispatch: the settings.
const settingsRouter = Router()
settingsRouter.get('/settings', auth(Role.ADMIN), DispatchController.getSettings)
settingsRouter.put('/settings', auth(Role.ADMIN), DispatchController.updateSettings)

// Mounted at /sos, before the SOS routes: what an admin does to one request's dispatch. They share the
// `/sos` prefix so the client sees one resource, but they live here because the engine owns them.
const sosRouter = Router()
sosRouter.get('/:id/candidates', auth(Role.ADMIN), DispatchController.listCandidates)
sosRouter.put('/:id/assign', auth(Role.ADMIN), DispatchController.assign)
sosRouter.put('/:id/unassign', auth(Role.ADMIN), DispatchController.unassign)
sosRouter.post('/:id/dispatch', auth(Role.ADMIN), DispatchController.dispatchNow)
sosRouter.put('/:id/dispatch/pause', auth(Role.ADMIN), DispatchController.pause)
sosRouter.put('/:id/dispatch/resume', auth(Role.ADMIN), DispatchController.resume)

export const DispatchRoutes = settingsRouter
export const SosDispatchRoutes = sosRouter
