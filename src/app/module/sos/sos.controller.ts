import httpStatus from 'http-status'
import { catchAsync } from '../../utils/catchAsync'
import { getAuthUser } from '../../utils/getAuthUser'
import { sendResponse } from '../../utils/sendResponse'
import { idParamSchema } from '../../utils/validation'
import {
  createSosSchema,
  listSosQuerySchema,
  nearbySosQuerySchema,
  resolveSosSchema,
  setPrioritySchema,
  updateSosSchema,
} from './sos.interface'
import { SosService } from './sos.service'

const createSos = catchAsync(async (req, res) => {
  const payload = createSosSchema.parse(req.body)
  const sos = await SosService.createSos(getAuthUser(req).id, payload)

  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    message: 'SOS request created successfully',
    data: sos,
  })
})

const listSos = catchAsync(async (req, res) => {
  const query = listSosQuerySchema.parse(req.query)
  const { items, meta } = await SosService.listSos(getAuthUser(req), query)

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'SOS requests retrieved successfully',
    data: items,
    meta,
  })
})

const listNearby = catchAsync(async (req, res) => {
  const query = nearbySosQuerySchema.parse(req.query)
  const { items, meta } = await SosService.listNearby(getAuthUser(req).id, query)

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Nearby SOS requests retrieved successfully',
    data: items,
    meta,
  })
})

const getSosById = catchAsync(async (req, res) => {
  const { id } = idParamSchema.parse(req.params)
  const sos = await SosService.getSosById(getAuthUser(req), id)

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'SOS request retrieved successfully',
    data: sos,
  })
})

const updateSos = catchAsync(async (req, res) => {
  const { id } = idParamSchema.parse(req.params)
  const payload = updateSosSchema.parse(req.body)
  const sos = await SosService.updateSos(getAuthUser(req).id, id, payload)

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'SOS request updated successfully',
    data: sos,
  })
})

const addMedia = catchAsync(async (req, res) => {
  const { id } = idParamSchema.parse(req.params)
  // upload.array() puts the files on req.files as an array (an object only for upload.fields()).
  const files = Array.isArray(req.files) ? req.files : []
  const sos = await SosService.addMedia(getAuthUser(req).id, id, files)

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Media uploaded successfully',
    data: sos,
  })
})

const resolveSos = catchAsync(async (req, res) => {
  const { id } = idParamSchema.parse(req.params)
  const payload = resolveSosSchema.parse(req.body)
  const sos = await SosService.resolveSos(getAuthUser(req).id, id, payload)

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'SOS request resolved successfully',
    data: sos,
  })
})

const acceptSos = catchAsync(async (req, res) => {
  const { id } = idParamSchema.parse(req.params)
  const result = await SosService.acceptSos(getAuthUser(req).id, id)

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'SOS request accepted',
    data: result,
  })
})

const rejectSos = catchAsync(async (req, res) => {
  const { id } = idParamSchema.parse(req.params)
  const result = await SosService.rejectSos(getAuthUser(req).id, id)

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: result.outcome === 'withdrawn' ? 'You backed out of this request' : 'Request declined',
    data: result,
  })
})

const setPriority = catchAsync(async (req, res) => {
  const { id } = idParamSchema.parse(req.params)
  const { priority } = setPrioritySchema.parse(req.body)
  const sos = await SosService.setPriority(id, priority)

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'SOS priority updated successfully',
    data: sos,
  })
})

export const SosController = {
  createSos,
  listSos,
  listNearby,
  getSosById,
  updateSos,
  addMedia,
  resolveSos,
  setPriority,
  acceptSos,
  rejectSos,
}
