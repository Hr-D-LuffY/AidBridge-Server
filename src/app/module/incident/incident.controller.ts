import httpStatus from 'http-status'
import { catchAsync } from '../../utils/catchAsync'
import { getAuthUser } from '../../utils/getAuthUser'
import { sendResponse } from '../../utils/sendResponse'
import { idParamSchema } from '../../utils/validation'
import {
  createIncidentSchema,
  linkSosSchema,
  listIncidentsQuerySchema,
  setIncidentPrioritySchema,
  updateIncidentSchema,
} from './incident.interface'
import { IncidentService } from './incident.service'

const createIncident = catchAsync(async (req, res) => {
  const payload = createIncidentSchema.parse(req.body)
  const incident = await IncidentService.createIncident(getAuthUser(req), payload)

  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    message: 'Incident created successfully',
    data: incident,
  })
})

const listIncidents = catchAsync(async (req, res) => {
  const query = listIncidentsQuerySchema.parse(req.query)
  const { items, meta } = await IncidentService.listIncidents(query)

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Incidents retrieved successfully',
    data: items,
    meta,
  })
})

const getIncident = catchAsync(async (req, res) => {
  const { id } = idParamSchema.parse(req.params)
  const incident = await IncidentService.getIncident(getAuthUser(req), id)

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Incident retrieved successfully',
    data: incident,
  })
})

const updateIncident = catchAsync(async (req, res) => {
  const { id } = idParamSchema.parse(req.params)
  const payload = updateIncidentSchema.parse(req.body)
  const incident = await IncidentService.updateIncident(getAuthUser(req), id, payload)

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Incident updated successfully',
    data: incident,
  })
})

// Was an inline handler in the route file in the old project; now a controller like the rest.
const setPriority = catchAsync(async (req, res) => {
  const { id } = idParamSchema.parse(req.params)
  const { priority } = setIncidentPrioritySchema.parse(req.body)
  const incident = await IncidentService.setPriority(getAuthUser(req), id, priority)

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Incident priority updated successfully',
    data: incident,
  })
})

const linkRequests = catchAsync(async (req, res) => {
  const { id } = idParamSchema.parse(req.params)
  const payload = linkSosSchema.parse(req.body)
  const incident = await IncidentService.linkRequests(getAuthUser(req), id, payload)

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: payload.action === 'link' ? 'SOS requests linked' : 'SOS requests unlinked',
    data: incident,
  })
})

const deleteIncident = catchAsync(async (req, res) => {
  const { id } = idParamSchema.parse(req.params)
  await IncidentService.deleteIncident(getAuthUser(req), id)

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Incident deleted successfully',
    data: null,
  })
})

export const IncidentController = {
  getIncident,
  createIncident,
  listIncidents,
  updateIncident,
  setPriority,
  linkRequests,
  deleteIncident,
}
