import httpStatus from 'http-status'
import { catchAsync } from '../../utils/catchAsync'
import { sendResponse } from '../../utils/sendResponse'
import { analyticsQuerySchema, heatmapQuerySchema } from './analytics.interface'
import { AnalyticsService } from './analytics.service'

const getDashboard = catchAsync(async (req, res) => {
  const range = analyticsQuerySchema.parse(req.query)
  const data = await AnalyticsService.getDashboard(range)

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Analytics retrieved successfully',
    data,
  })
})

const getReport = catchAsync(async (req, res) => {
  const range = analyticsQuerySchema.parse(req.query)
  const data = await AnalyticsService.getReport(range)

  sendResponse(res, { statusCode: httpStatus.OK, message: 'Report retrieved successfully', data })
})

const getLiveMap = catchAsync(async (_req, res) => {
  const data = await AnalyticsService.getLiveMap()

  sendResponse(res, { statusCode: httpStatus.OK, message: 'Live map retrieved successfully', data })
})

const getHeatmap = catchAsync(async (req, res) => {
  const query = heatmapQuerySchema.parse(req.query)
  const data = await AnalyticsService.getHeatmap(query)

  sendResponse(res, { statusCode: httpStatus.OK, message: 'Heatmap retrieved successfully', data })
})

const getAdminSummary = catchAsync(async (_req, res) => {
  const data = await AnalyticsService.getAdminSummary()

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Admin summary retrieved successfully',
    data,
  })
})

export const AnalyticsController = {
  getDashboard,
  getReport,
  getLiveMap,
  getHeatmap,
  getAdminSummary,
}
