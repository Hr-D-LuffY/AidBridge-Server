import httpStatus from 'http-status'
import { catchAsync } from '../../utils/catchAsync'
import { getAuthUser } from '../../utils/getAuthUser'
import { sendResponse } from '../../utils/sendResponse'
import { listMessagesQuerySchema, sendMessageSchema, sosIdParamSchema } from './message.interface'
import { MessageService } from './message.service'

const listMessages = catchAsync(async (req, res) => {
  const { sosId } = sosIdParamSchema.parse(req.params)
  const query = listMessagesQuerySchema.parse(req.query)
  const { items, meta } = await MessageService.listMessages(getAuthUser(req), sosId, query)

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Messages retrieved successfully',
    data: items,
    meta,
  })
})

const sendMessage = catchAsync(async (req, res) => {
  const { sosId } = sosIdParamSchema.parse(req.params)
  const payload = sendMessageSchema.parse(req.body)
  const message = await MessageService.sendMessage(getAuthUser(req), sosId, payload)

  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    message: 'Message sent successfully',
    data: message,
  })
})

export const MessageController = { listMessages, sendMessage }
