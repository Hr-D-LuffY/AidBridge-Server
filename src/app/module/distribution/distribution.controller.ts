import httpStatus from 'http-status'
import { catchAsync } from '../../utils/catchAsync'
import { getAuthUser } from '../../utils/getAuthUser'
import { sendResponse } from '../../utils/sendResponse'
import { createDistributionSchema, listDistributionsQuerySchema } from './distribution.interface'
import { DistributionService } from './distribution.service'

const createDistribution = catchAsync(async (req, res) => {
  const payload = createDistributionSchema.parse(req.body)
  const record = await DistributionService.createDistribution(getAuthUser(req).id, payload)

  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    message: 'Distribution recorded successfully',
    data: record,
  })
})

const listDistributions = catchAsync(async (req, res) => {
  const query = listDistributionsQuerySchema.parse(req.query)
  const { items, meta } = await DistributionService.listDistributions(getAuthUser(req), query)

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Distributions retrieved successfully',
    data: items,
    meta,
  })
})

export const DistributionController = { createDistribution, listDistributions }
