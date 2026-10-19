import httpStatus from 'http-status'
import type { Types } from 'mongoose'
import { Role } from '../../constants/role'
import { SOS_FINISHED_STATUSES } from '../../constants/sos'
import { AppError } from '../../errorHelpers/AppError'
import type { TokenPayload } from '../../utils/jwt'
import { buildMeta, getPagination } from '../../utils/pagination'
import { NotificationService } from '../notification/notification.service'
import { SosService } from '../sos/sos.service'
import type { ListMessagesQuery, SendMessagePayload } from './message.interface'
import { Message } from './message.model'

interface Sender {
  _id: Types.ObjectId
  name: string
  role: Role
}

interface MessageFields {
  _id: Types.ObjectId
  sosRequest: Types.ObjectId
  sender: Sender
  content: string
  createdAt: Date
}

const toMessageView = (message: MessageFields) => ({
  id: String(message._id),
  sosRequest: String(message.sosRequest),
  sender: { id: String(message.sender._id), name: message.sender.name, role: message.sender.role },
  content: message.content,
  createdAt: message.createdAt,
})

// Who may open a conversation: its two participants (the victim and the assigned volunteer), and
// admins to read it. One check shared by reading and writing.
const getAccess = async (viewer: TokenPayload, sosId: string) => {
  const participants = await SosService.getParticipants(sosId)
  const isParticipant =
    viewer.id === participants.victimId || viewer.id === participants.assignedVolunteerId

  if (!isParticipant && viewer.role !== Role.ADMIN) {
    throw new AppError(httpStatus.FORBIDDEN, 'You are not part of this conversation')
  }
  return { ...participants, isParticipant }
}

// Newest first, so page 1 is the latest messages and older ones come with higher pages. A chat
// screen asks for page 1 and reverses it.
const listMessages = async (viewer: TokenPayload, sosId: string, query: ListMessagesQuery) => {
  const { page, limit } = query
  await getAccess(viewer, sosId)

  const [messages, total] = await Promise.all([
    Message.find({ sosRequest: sosId })
      .sort({ createdAt: -1, _id: -1 })
      .skip(getPagination(query).skip)
      .limit(limit)
      .populate<{ sender: Sender }>('sender', 'name role')
      .lean(),
    Message.countDocuments({ sosRequest: sosId }),
  ])

  return { items: messages.map(toMessageView), meta: buildMeta({ page, limit }, total) }
}

const logActivityError = (error: unknown) =>
  console.error("Could not record the victim's activity:", error)

const sendMessage = async (viewer: TokenPayload, sosId: string, payload: SendMessagePayload) => {
  const access = await getAccess(viewer, sosId)
  if (!access.isParticipant) {
    throw new AppError(httpStatus.FORBIDDEN, 'Admins can read this conversation but not post in it')
  }
  if (SOS_FINISHED_STATUSES.includes(access.status)) {
    throw new AppError(
      httpStatus.CONFLICT,
      `This request is already ${access.status}. No new messages can be sent`,
    )
  }

  const created = await Message.create({
    sosRequest: sosId,
    sender: viewer.id,
    content: payload.content,
  })
  const message = await Message.findById(created._id)
    .populate<{ sender: Sender }>('sender', 'name role')
    .lean()
  if (!message) throw new AppError(httpStatus.INTERNAL_SERVER_ERROR, 'Message was not saved')

  // The victim writing is a sign of life: the stale clock starts again.
  if (viewer.id === access.victimId)
    await SosService.recordVictimActivity(sosId).catch(logActivityError)

  // The other person finds out without opening the request: a notification with who wrote and how it
  // starts. The message is already saved, so this can't fail the send.
  const recipientId = viewer.id === access.victimId ? access.assignedVolunteerId : access.victimId
  if (recipientId) {
    await NotificationService.notifyChatMessage(
      recipientId,
      message.sender.name,
      message.content,
      sosId,
    )
  }
  return toMessageView(message)
}

export const MessageService = { listMessages, sendMessage }
