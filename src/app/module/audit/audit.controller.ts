import httpStatus from 'http-status'
import { catchAsync } from '../../utils/catchAsync'
import { sendResponse } from '../../utils/sendResponse'
import { listAuditLogsQuerySchema } from './audit.interface'
import { AuditService } from './audit.service'

const listLogs = catchAsync(async (req, res) => {
  const query = listAuditLogsQuerySchema.parse(req.query)
  const { items, meta } = await AuditService.listLogs(query)

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Audit log retrieved successfully',
    data: items,
    meta,
  })
})

export const AuditController = { listLogs }
