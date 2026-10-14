import httpStatus from 'http-status'
import { catchAsync } from '../../utils/catchAsync'
import { getAuthUser } from '../../utils/getAuthUser'
import { sendResponse } from '../../utils/sendResponse'
import { idParamSchema } from '../../utils/validation'
import {
  createCampSchema,
  listCampsQuerySchema,
  myCampsQuerySchema,
  nearbyCampsQuerySchema,
  occupancyChangeSchema,
  updateCampSchema,
  volunteerBodySchema,
} from './camp.interface'
import { CampService } from './camp.service'

const createCamp = catchAsync(async (req, res) => {
  const payload = createCampSchema.parse(req.body)
  const camp = await CampService.createCamp(getAuthUser(req).id, payload)

  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    message: 'Camp created successfully',
    data: camp,
  })
})

const listCamps = catchAsync(async (req, res) => {
  const query = listCampsQuerySchema.parse(req.query)
  const { items, meta } = await CampService.listCamps(getAuthUser(req), query)

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Camps retrieved successfully',
    data: items,
    meta,
  })
})

const listNearby = catchAsync(async (req, res) => {
  const query = nearbyCampsQuerySchema.parse(req.query)
  const { items, meta } = await CampService.listNearby(query)

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Nearby camps retrieved successfully',
    data: items,
    meta,
  })
})

const getCamp = catchAsync(async (req, res) => {
  const { id } = idParamSchema.parse(req.params)
  const camp = await CampService.getPublicCamp(id)

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Camp retrieved successfully',
    data: camp,
  })
})

const listMyAssigned = catchAsync(async (req, res) => {
  const query = myCampsQuerySchema.parse(req.query)
  const { items, meta } = await CampService.listMyAssigned(getAuthUser(req).id, query)

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Assigned camps retrieved successfully',
    data: items,
    meta,
  })
})

const updateCamp = catchAsync(async (req, res) => {
  const { id } = idParamSchema.parse(req.params)
  const payload = updateCampSchema.parse(req.body)
  const camp = await CampService.updateCamp(getAuthUser(req), id, payload)

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Camp updated successfully',
    data: camp,
  })
})

const deleteCamp = catchAsync(async (req, res) => {
  const { id } = idParamSchema.parse(req.params)
  await CampService.deleteCamp(getAuthUser(req), id)

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Camp deleted successfully',
    data: null,
  })
})

const assignVolunteer = catchAsync(async (req, res) => {
  const { id } = idParamSchema.parse(req.params)
  const { volunteerId } = volunteerBodySchema.parse(req.body)
  const camp = await CampService.assignVolunteer(getAuthUser(req), id, volunteerId)

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Volunteer assigned successfully',
    data: camp,
  })
})

const unassignVolunteer = catchAsync(async (req, res) => {
  const { id } = idParamSchema.parse(req.params)
  const { volunteerId } = volunteerBodySchema.parse(req.body)
  const camp = await CampService.unassignVolunteer(getAuthUser(req), id, volunteerId)

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Volunteer unassigned successfully',
    data: camp,
  })
})

const adjustOccupancy = catchAsync(async (req, res) => {
  const { id } = idParamSchema.parse(req.params)
  const change = occupancyChangeSchema.parse(req.body)
  const camp = await CampService.adjustOccupancy(getAuthUser(req), id, change)

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Occupancy updated successfully',
    data: camp,
  })
})

export const CampController = {
  createCamp,
  listCamps,
  listNearby,
  getCamp,
  listMyAssigned,
  updateCamp,
  deleteCamp,
  assignVolunteer,
  unassignVolunteer,
  adjustOccupancy,
}
