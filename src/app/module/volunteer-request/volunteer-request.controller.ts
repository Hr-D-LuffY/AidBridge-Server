import httpStatus from 'http-status'
import { catchAsync } from '../../utils/catchAsync'
import { getAuthUser } from '../../utils/getAuthUser'
import { sendResponse } from '../../utils/sendResponse'
import { idParamSchema } from '../../utils/validation'
import {
  createVolunteerRequestSchema,
  listVolunteerRequestsQuerySchema,
  reviewVolunteerRequestSchema,
} from './volunteer-request.interface'
import { VolunteerRequestService } from './volunteer-request.service'

const createRequest = catchAsync(async (req, res) => {
  const payload = createVolunteerRequestSchema.parse(req.body)
  const request = await VolunteerRequestService.createRequest(getAuthUser(req).id, payload)

  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    message: 'Volunteer request submitted. An admin will review it',
    data: request,
  })
})

const listMyRequests = catchAsync(async (req, res) => {
  const query = listVolunteerRequestsQuerySchema.parse(req.query)
  const { items, meta } = await VolunteerRequestService.listMyRequests(getAuthUser(req).id, query)

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Your volunteer requests retrieved successfully',
    data: items,
    meta,
  })
})

const listRequests = catchAsync(async (req, res) => {
  const query = listVolunteerRequestsQuerySchema.parse(req.query)
  const { items, meta } = await VolunteerRequestService.listRequests(query)

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Volunteer requests retrieved successfully',
    data: items,
    meta,
  })
})

const approveRequest = catchAsync(async (req, res) => {
  const { id } = idParamSchema.parse(req.params)
  const payload = reviewVolunteerRequestSchema.parse(req.body ?? {})
  const request = await VolunteerRequestService.approveRequest(getAuthUser(req), id, payload)

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Volunteer request approved. The user is now a volunteer',
    data: request,
  })
})

const rejectRequest = catchAsync(async (req, res) => {
  const { id } = idParamSchema.parse(req.params)
  const payload = reviewVolunteerRequestSchema.parse(req.body ?? {})
  const request = await VolunteerRequestService.rejectRequest(getAuthUser(req), id, payload)

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Volunteer request rejected',
    data: request,
  })
})

export const VolunteerRequestController = {
  createRequest,
  listMyRequests,
  listRequests,
  approveRequest,
  rejectRequest,
}
