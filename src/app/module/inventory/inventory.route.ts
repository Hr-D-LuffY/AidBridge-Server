import { Router } from 'express'
import { Role } from '../../constants/role'
import { auth } from '../../middleware/checkAuth'
import { InventoryController } from './inventory.controller'

const router = Router()

// Every inventory route is for NGOs, and each NGO sees only its own stock. `/alerts` is declared
// before `/:id` so it isn't read as an id.
router.get('/alerts', auth(Role.NGO), InventoryController.listAlerts)
router.get('/', auth(Role.NGO), InventoryController.listItems)
router.post('/', auth(Role.NGO), InventoryController.createItem)
router.put('/:id', auth(Role.NGO), InventoryController.updateItem)
router.delete('/:id', auth(Role.NGO), InventoryController.deleteItem)

export const InventoryRoutes = router
