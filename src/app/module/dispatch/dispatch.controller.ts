import httpStatus from 'http-status'
import { catchAsync } from '../../utils/catchAsync'
import { getAuthUser } from '../../utils/getAuthUser'
import { sendResponse } from '../../utils/sendResponse'
import { idParamSchema } from '../../utils/validation'
import { BoardService } from './board.service'
import {
  assignSchema,
  boardQuerySchema,
  candidatesQuerySchema,
  unassignSchema,
  updateSettingsSchema,
} from './dispatch.interface'
import { DispatchService } from './dispatch.service'

const getSettings = catchAsync(async (_req, res) => {
  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Dispatch settings retrieved successfully',
    data: await DispatchService.getSettingsView(),
  })
})

const updateSettings = catchAsync(async (req, res) => {
  const payload = updateSettingsSchema.parse(req.body)
  const settings = await DispatchService.updateSettings(getAuthUser(req), payload)

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Dispatch settings updated successfully',
    data: settings,
  })
})

const getBoard = catchAsync(async (req, res) => {
  const query = boardQuerySchema.parse(req.query)

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Dispatch board retrieved successfully',
    data: await BoardService.getBoard(query),
  })
})

const listCandidates = catchAsync(async (req, res) => {
  const { id } = idParamSchema.parse(req.params)
  const query = candidatesQuerySchema.parse(req.query)
  const { items, meta } = await DispatchService.listCandidates(id, query)

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Candidates retrieved successfully',
    data: items,
    meta,
  })
})

const assign = catchAsync(async (req, res) => {
  const { id } = idParamSchema.parse(req.params)
  const payload = assignSchema.parse(req.body)
  const sos = await DispatchService.assign(getAuthUser(req), id, payload)

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: payload.direct ? 'SOS request assigned' : 'SOS request offered',
    data: sos,
  })
})

const unassign = catchAsync(async (req, res) => {
  const { id } = idParamSchema.parse(req.params)
  const payload = unassignSchema.parse(req.body ?? {})
  const sos = await DispatchService.unassign(getAuthUser(req), id, payload)

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'SOS request taken off its volunteer',
    data: sos,
  })
})

const dispatchNow = catchAsync(async (req, res) => {
  const { id } = idParamSchema.parse(req.params)
  const result = await DispatchService.dispatchNow(getAuthUser(req), id)

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Dispatch step run',
    data: result,
  })
})

const pause = catchAsync(async (req, res) => {
  const { id } = idParamSchema.parse(req.params)
  const sos = await DispatchService.setPaused(getAuthUser(req), id, true)

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Automatic dispatch paused for this request',
    data: sos,
  })
})

const resume = catchAsync(async (req, res) => {
  const { id } = idParamSchema.parse(req.params)
  const sos = await DispatchService.setPaused(getAuthUser(req), id, false)

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Automatic dispatch resumed for this request',
    data: sos,
  })
})

export const DispatchController = {
  getBoard,
  getSettings,
  updateSettings,
  listCandidates,
  assign,
  unassign,
  dispatchNow,
  pause,
  resume,
}
