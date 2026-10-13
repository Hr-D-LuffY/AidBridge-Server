import httpStatus from 'http-status'
import { catchAsync } from '../../utils/catchAsync'
import { getAuthUser } from '../../utils/getAuthUser'
import { sendResponse } from '../../utils/sendResponse'
import { idParamSchema } from '../../utils/validation'
import {
  alertsQuerySchema,
  createItemSchema,
  listItemsQuerySchema,
  updateItemSchema,
} from './inventory.interface'
import { InventoryService } from './inventory.service'

const listItems = catchAsync(async (req, res) => {
  const query = listItemsQuerySchema.parse(req.query)
  const { items, meta } = await InventoryService.listItems(getAuthUser(req).id, query)

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Inventory retrieved successfully',
    data: items,
    meta,
  })
})

const listAlerts = catchAsync(async (req, res) => {
  const query = alertsQuerySchema.parse(req.query)
  const { items, meta } = await InventoryService.listAlerts(getAuthUser(req).id, query)

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Low-stock alerts retrieved successfully',
    data: items,
    meta,
  })
})

const createItem = catchAsync(async (req, res) => {
  const payload = createItemSchema.parse(req.body)
  const item = await InventoryService.createItem(getAuthUser(req).id, payload)

  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    message: 'Inventory item created successfully',
    data: item,
  })
})

const updateItem = catchAsync(async (req, res) => {
  const { id } = idParamSchema.parse(req.params)
  const payload = updateItemSchema.parse(req.body)
  const item = await InventoryService.updateItem(getAuthUser(req).id, id, payload)

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Inventory item updated successfully',
    data: item,
  })
})

const deleteItem = catchAsync(async (req, res) => {
  const { id } = idParamSchema.parse(req.params)
  await InventoryService.deleteItem(getAuthUser(req).id, id)

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Inventory item deleted successfully',
    data: null,
  })
})

export const InventoryController = { listItems, listAlerts, createItem, updateItem, deleteItem }
