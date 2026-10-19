import httpStatus from 'http-status'
import { RespondAction } from '../../constants/task'
import { catchAsync } from '../../utils/catchAsync'
import { getAuthUser } from '../../utils/getAuthUser'
import { sendResponse } from '../../utils/sendResponse'
import { idParamSchema } from '../../utils/validation'
import {
  listTasksQuerySchema,
  overrideCompleteSchema,
  rateTaskSchema,
  respondSchema,
  taskStatusSchema,
} from './task.interface'
import { TaskService } from './task.service'

const listMyTasks = catchAsync(async (req, res) => {
  const query = listTasksQuerySchema.parse(req.query)
  const { items, meta } = await TaskService.listMyTasks(getAuthUser(req).id, query)

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Tasks retrieved successfully',
    data: items,
    meta,
  })
})

const getTask = catchAsync(async (req, res) => {
  const { id } = idParamSchema.parse(req.params)
  const task = await TaskService.getMyTask(getAuthUser(req).id, id)

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Task retrieved successfully',
    data: task,
  })
})

const respond = catchAsync(async (req, res) => {
  const { id } = idParamSchema.parse(req.params)
  const payload = respondSchema.parse(req.body)
  const task = await TaskService.respond(getAuthUser(req).id, id, payload)

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: payload.action === RespondAction.ACCEPT ? 'Task accepted' : 'Task rejected',
    data: task,
  })
})

const updateStatus = catchAsync(async (req, res) => {
  const { id } = idParamSchema.parse(req.params)
  const payload = taskStatusSchema.parse(req.body)
  const task = await TaskService.updateStatus(getAuthUser(req).id, id, payload)

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Task status updated successfully',
    data: task,
  })
})

const addProofPhoto = catchAsync(async (req, res) => {
  const { id } = idParamSchema.parse(req.params)
  // upload.single() puts the file on req.file (undefined when the field was missing).
  const task = await TaskService.addProofPhoto(getAuthUser(req).id, id, req.file)

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Proof photo uploaded successfully',
    data: task,
  })
})

const overrideComplete = catchAsync(async (req, res) => {
  const { id } = idParamSchema.parse(req.params)
  const payload = overrideCompleteSchema.parse(req.body)
  const task = await TaskService.overrideComplete(getAuthUser(req), id, payload)

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Task completed by an admin',
    data: task,
  })
})

const getRatingStatus = catchAsync(async (req, res) => {
  const { id } = idParamSchema.parse(req.params)
  const status = await TaskService.getRatingStatus(getAuthUser(req).id, id)

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Rating status retrieved successfully',
    data: status,
  })
})

const rateTask = catchAsync(async (req, res) => {
  const { id } = idParamSchema.parse(req.params)
  const payload = rateTaskSchema.parse(req.body)
  const result = await TaskService.rateTask(getAuthUser(req).id, id, payload)

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Task rated successfully',
    data: result,
  })
})

export const TaskController = {
  listMyTasks,
  getTask,
  respond,
  updateStatus,
  addProofPhoto,
  overrideComplete,
  getRatingStatus,
  rateTask,
}
