import httpStatus from 'http-status'
import mongoose, { type QueryFilter } from 'mongoose'
import { AuditAction, AuditTargetType } from '../../constants/audit'
import { Role } from '../../constants/role'
import { VolunteerRequestStatus } from '../../constants/volunteerRequest'
import { AppError } from '../../errorHelpers/AppError'
import type { TokenPayload } from '../../utils/jwt'
import { buildMeta, getPagination } from '../../utils/pagination'
import { AuditService } from '../audit/audit.service'
import { NotificationService } from '../notification/notification.service'
import { User } from '../user/user.model'
import type {
  CreateVolunteerRequestPayload,
  ListVolunteerRequestsQuery,
  ReviewVolunteerRequestPayload,
} from './volunteer-request.interface'
import { VolunteerRequest, type VolunteerRequestDocument } from './volunteer-request.model'

interface PopulatedUser {
  _id: mongoose.Types.ObjectId
  name: string
  email: string
  phone?: string | null
  role: Role
}

const USER_FIELDS_FOR_REVIEW = 'name email phone role'

// The fields toRequestView reads. A plain document and one whose `user` was populated both fit,
// which is why `user` is typed loosely here.
interface RequestFields {
  _id: unknown
  user: unknown
  message: string
  status: VolunteerRequestStatus
  reviewedBy?: unknown
  reviewedAt?: Date | null
  reviewNote?: string | null
  createdAt: Date
  updatedAt: Date
}

// The applicant's contact details are shown to admins only (the only role that lists requests).
const toRequestView = (request: RequestFields, user?: PopulatedUser) => ({
  id: String(request._id),
  user: user
    ? {
        id: String(user._id),
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
      }
    : String(request.user),
  message: request.message,
  status: request.status,
  reviewedBy: request.reviewedBy ? String(request.reviewedBy) : null,
  reviewedAt: request.reviewedAt ?? null,
  reviewNote: request.reviewNote ?? null,
  createdAt: request.createdAt,
  updatedAt: request.updatedAt,
})

// Who applied, for the audit summary. Falls back to the id if the account is gone.
const applicantName = async (userId: unknown) =>
  (await User.findById(userId).select('name').lean())?.name ?? String(userId)

// The admin's optional note, ready to append to a sentence.
const noteSuffix = (note?: string) => (note ? ` Note from the admin: ${note}` : '')

const createRequest = async (userId: string, payload: CreateVolunteerRequestPayload) => {
  const user = await User.findOne({ _id: userId, isDeleted: false })
  if (!user) throw new AppError(httpStatus.NOT_FOUND, 'User not found')

  if (user.role !== Role.VICTIM) {
    throw new AppError(httpStatus.FORBIDDEN, 'Only a normal user can request to become a volunteer')
  }
  // Volunteers are contacted by phone, so an admin can't approve someone nobody can call.
  if (!user.phone) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      'Add a phone number to your profile before requesting to become a volunteer',
    )
  }
  if (await VolunteerRequest.exists({ user: user._id, status: VolunteerRequestStatus.PENDING })) {
    throw new AppError(httpStatus.CONFLICT, 'You already have a pending volunteer request')
  }

  const request = await VolunteerRequest.create({ user: user._id, message: payload.message })
  return toRequestView(request)
}

const listMyRequests = async (userId: string, query: ListVolunteerRequestsQuery) => {
  const { page, limit } = query
  const filter: QueryFilter<VolunteerRequestDocument> = { user: userId }
  if (query.status) filter.status = query.status

  const [requests, total] = await Promise.all([
    VolunteerRequest.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip(getPagination(query).skip)
      .limit(limit),
    VolunteerRequest.countDocuments(filter),
  ])

  return {
    items: requests.map((request) => toRequestView(request)),
    meta: buildMeta({ page, limit }, total),
  }
}

const listRequests = async (query: ListVolunteerRequestsQuery) => {
  const { page, limit, status } = query
  const filter: QueryFilter<VolunteerRequestDocument> = {}
  if (status) filter.status = status

  const [requests, total] = await Promise.all([
    VolunteerRequest.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip(getPagination(query).skip)
      .limit(limit)
      .populate<{ user: PopulatedUser }>('user', USER_FIELDS_FOR_REVIEW),
    VolunteerRequest.countDocuments(filter),
  ])

  return {
    items: requests.map((request) => toRequestView(request, request.user)),
    meta: buildMeta({ page, limit }, total),
  }
}

// Throws the right error when a pending request could not be claimed: it never existed (404) or
// someone already decided it (409).
const explainUnclaimable = async (requestId: string) => {
  const exists = await VolunteerRequest.exists({ _id: requestId })
  if (!exists) throw new AppError(httpStatus.NOT_FOUND, 'Volunteer request not found')
  throw new AppError(httpStatus.CONFLICT, 'This volunteer request has already been reviewed')
}

// Approving does two writes that must stand or fall together — the request becomes `approved` and
// the user's role becomes `volunteer` — so they share one transaction. The request is claimed with a
// `status: pending` filter, so two admins approving at once can't both succeed.
const approveRequest = async (
  admin: TokenPayload,
  requestId: string,
  payload: ReviewVolunteerRequestPayload,
) => {
  const session = await mongoose.startSession()
  try {
    let approved = null as VolunteerRequestDocument | null

    await session.withTransaction(async () => {
      const request = await VolunteerRequest.findOneAndUpdate(
        { _id: requestId, status: VolunteerRequestStatus.PENDING },
        {
          $set: {
            status: VolunteerRequestStatus.APPROVED,
            reviewedBy: admin.id,
            reviewedAt: new Date(),
            reviewNote: payload.note,
          },
        },
        { returnDocument: 'after', session },
      )
      if (!request) return explainUnclaimable(requestId)

      // Only a still-active normal user can be promoted; otherwise the whole approval rolls back
      // and the admin can reject the request instead.
      const promoted = await User.updateOne(
        { _id: request.user, role: Role.VICTIM, isDeleted: false, isBlocked: { $ne: true } },
        { $set: { role: Role.VOLUNTEER } },
        { session },
      )
      if (promoted.matchedCount === 0) {
        throw new AppError(
          httpStatus.CONFLICT,
          'This user can no longer become a volunteer (account deleted, blocked or role changed). Reject the request instead',
        )
      }
      approved = request
    })

    if (!approved) throw new AppError(httpStatus.INTERNAL_SERVER_ERROR, 'Approval did not complete')

    await NotificationService.notifyUser(
      String(approved.user),
      'Volunteer request approved',
      `You are now a volunteer.${noteSuffix(payload.note)}`,
    )
    await AuditService.record({
      actor: admin,
      action: AuditAction.VOLUNTEER_REQUEST_APPROVED,
      targetType: AuditTargetType.VOLUNTEER_REQUEST,
      targetId: requestId,
      summary: `Approved the volunteer request of ${await applicantName(approved.user)}`,
      meta: { applicantId: String(approved.user), note: payload.note ?? null },
    })
    return toRequestView(approved)
  } finally {
    await session.endSession()
  }
}

const rejectRequest = async (
  admin: TokenPayload,
  requestId: string,
  payload: ReviewVolunteerRequestPayload,
) => {
  const request = await VolunteerRequest.findOneAndUpdate(
    { _id: requestId, status: VolunteerRequestStatus.PENDING },
    {
      $set: {
        status: VolunteerRequestStatus.REJECTED,
        reviewedBy: admin.id,
        reviewedAt: new Date(),
        reviewNote: payload.note,
      },
    },
    { returnDocument: 'after' },
  )
  if (!request) return explainUnclaimable(requestId)

  await NotificationService.notifyUser(
    String(request.user),
    'Volunteer request not approved',
    `An admin reviewed your volunteer request and did not approve it.${noteSuffix(payload.note)}`,
  )
  await AuditService.record({
    actor: admin,
    action: AuditAction.VOLUNTEER_REQUEST_REJECTED,
    targetType: AuditTargetType.VOLUNTEER_REQUEST,
    targetId: requestId,
    summary: `Rejected the volunteer request of ${await applicantName(request.user)}`,
    meta: { applicantId: String(request.user), note: payload.note ?? null },
  })
  return toRequestView(request)
}

export const VolunteerRequestService = {
  createRequest,
  listMyRequests,
  listRequests,
  approveRequest,
  rejectRequest,
}
