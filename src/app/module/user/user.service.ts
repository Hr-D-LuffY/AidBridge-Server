import httpStatus from 'http-status'
import type { ClientSession, QueryFilter } from 'mongoose'
import { AuditAction, AuditTargetType } from '../../constants/audit'
import {
  ALL_ROLES_TARGET,
  type NotificationTarget,
  NotificationType,
} from '../../constants/notification'
import { Role } from '../../constants/role'
import { BLOCKED_CLOSE_REASON } from '../../constants/user'
import { AppError } from '../../errorHelpers/AppError'
import { runInTransaction } from '../../lib/transaction'
import { type DateRange, inRange } from '../../utils/dateRange'
import type { TokenPayload } from '../../utils/jwt'
import { buildMeta, getPagination } from '../../utils/pagination'
import { hashPassword } from '../../utils/password'
import { AuditService } from '../audit/audit.service'
import type { PreferencesChange } from '../notification/notification.interface'
import { resolvePreferences, type StoredPreferences } from '../notification/notification.rules'
import { NotificationService } from '../notification/notification.service'
import { SosService } from '../sos/sos.service'
import type { BlockUserPayload, CreateAccountPayload, ListUsersQuery } from './user.interface'
import { User, type UserDocument } from './user.model'

// What a viewer is allowed to see of another account. Contact details and location are the
// sensitive part: the old API handed email + phone of any user to any logged-in user.
//   self / admin -> full profile
//   ngo viewing a volunteer -> + email and phone (to coordinate camp assignments)
//   everyone else -> limited profile
// A victim and the volunteer assigned to their SOS see each other's phone through the SOS request
// itself (GET /sos/:id), so this view needs no special case for them.
export const toLimitedProfile = (user: UserDocument) => ({
  id: String(user._id),
  name: user.name,
  role: user.role,
  isAvailable: user.isAvailable,
  reliabilityScore: user.reliabilityScore,
  totalRatings: user.totalRatings,
})

export const toFullProfile = (user: UserDocument) => ({
  ...toLimitedProfile(user),
  email: user.email,
  phone: user.phone,
  location: user.location
    ? { type: user.location.type, coordinates: user.location.coordinates }
    : null,
  // Only an admin or the user themself gets this profile, and a blocked user cannot read their own.
  isBlocked: user.isBlocked,
  blockedAt: user.blockedAt ?? null,
  blockReason: user.blockReason ?? null,
  createdAt: user.createdAt,
  updatedAt: user.updatedAt,
})

const toContactProfile = (user: UserDocument) => ({
  ...toLimitedProfile(user),
  email: user.email,
  phone: user.phone,
})

export const toUserView = (viewer: TokenPayload, user: UserDocument) => {
  if (viewer.role === Role.ADMIN || viewer.id === String(user._id)) return toFullProfile(user)
  if (viewer.role === Role.NGO && user.role === Role.VOLUNTEER) return toContactProfile(user)
  return toLimitedProfile(user)
}

const listUsers = async (viewer: TokenPayload, query: ListUsersQuery) => {
  const { page, limit, role, blocked } = query

  // Only an admin may see (or search for) admin accounts.
  if (role === Role.ADMIN && viewer.role !== Role.ADMIN) {
    throw new AppError(httpStatus.FORBIDDEN, 'Only an admin can list admin accounts')
  }

  // Who is blocked is for admins to see and filter by. An NGO choosing volunteers never gets a blocked
  // one in the list.
  if (blocked !== undefined && viewer.role !== Role.ADMIN) {
    throw new AppError(httpStatus.FORBIDDEN, 'Only an admin can filter accounts by blocked')
  }

  const filter: QueryFilter<UserDocument> = { isDeleted: false }
  if (role) filter.role = role
  else if (viewer.role !== Role.ADMIN) filter.role = { $ne: Role.ADMIN }
  if (blocked === true) filter.isBlocked = true
  else if (blocked === false || viewer.role !== Role.ADMIN) filter.isBlocked = { $ne: true }

  const [users, total] = await Promise.all([
    User.find(filter).sort({ name: 1, _id: 1 }).skip(getPagination(query).skip).limit(limit),
    User.countDocuments(filter),
  ])

  return {
    items: users.map((user) => toUserView(viewer, user)),
    meta: buildMeta({ page, limit }, total),
  }
}

const getUserById = async (viewer: TokenPayload, id: string) => {
  const user = await User.findOne({ _id: id, isDeleted: false })
  if (!user) throw new AppError(httpStatus.NOT_FOUND, 'User not found')
  return toUserView(viewer, user)
}

// For modules that hand out work to volunteers (camps): is this id a live volunteer account?
const isActiveVolunteer = async (id: string) =>
  (await User.exists({
    _id: id,
    role: Role.VOLUNTEER,
    isDeleted: false,
    isBlocked: { $ne: true },
  })) !== null

// Admin-only. The only way an NGO or another admin account comes into existence (the very first
// admin is created by the seed script). Returns the new profile but no token: the admin hands the
// credentials over and the new user logs in themselves.
const createAccount = async (admin: TokenPayload, payload: CreateAccountPayload) => {
  const { name, email, password, role, phone } = payload

  if (await User.exists({ email })) {
    throw new AppError(httpStatus.CONFLICT, 'An account with this email already exists')
  }

  const user = await User.create({
    name,
    email,
    password: await hashPassword(password),
    role,
    phone,
  })

  await AuditService.record({
    actor: admin,
    action: AuditAction.ACCOUNT_CREATED,
    targetType: AuditTargetType.USER,
    targetId: String(user._id),
    summary: `Created ${role} account for ${user.name}`,
    meta: { role },
  })
  return toFullProfile(user)
}

const BLOCK_NOT_FOUND_MESSAGE = 'User not found'

// Admin-only. The account can no longer log in, and a token it already holds stops working on its next
// request (see auth()). Admin accounts cannot be blocked (that includes the caller's own). Blocking a
// victim also closes every request of theirs that is not finished, in the same transaction, so a scam
// request leaves the volunteers' maps at once; the volunteers on them are told after it commits.
const blockUser = async (admin: TokenPayload, id: string, payload: BlockUserPayload) => {
  const existing = await User.findOne({ _id: id, isDeleted: false })
  if (!existing) throw new AppError(httpStatus.NOT_FOUND, BLOCK_NOT_FOUND_MESSAGE)
  if (existing.role === Role.ADMIN) {
    throw new AppError(httpStatus.FORBIDDEN, 'Admin accounts cannot be blocked')
  }
  if (existing.isBlocked) {
    throw new AppError(httpStatus.CONFLICT, 'This account is already blocked')
  }

  const { blocked, volunteerIds } = await runInTransaction(async (session) => {
    // One conditional update: of two admins blocking at once, exactly one matches `isBlocked != true`.
    const updated = await User.findOneAndUpdate(
      { _id: id, isDeleted: false, isBlocked: { $ne: true } },
      {
        $set: {
          isBlocked: true,
          blockedAt: new Date(),
          ...(payload.reason && { blockReason: payload.reason }),
        },
      },
      { returnDocument: 'after', session },
    )
    if (!updated)
      throw new AppError(httpStatus.CONFLICT, 'This account was just changed. Please try again')

    const volunteers =
      updated.role === Role.VICTIM
        ? await SosService.closeUnfinishedForVictim(session, id, BLOCKED_CLOSE_REASON)
        : []
    return { blocked: updated, volunteerIds: volunteers }
  })

  // After the commit, and never failing the request: the volunteers on the closed requests are told.
  await NotificationService.notifyUsers({
    userIds: volunteerIds,
    type: NotificationType.TASK_CANCELLED,
    title: 'SOS request closed',
    message: `An administrator closed an SOS request you were working on: ${BLOCKED_CLOSE_REASON}`,
  })

  await AuditService.record({
    actor: admin,
    action: AuditAction.USER_BLOCKED,
    targetType: AuditTargetType.USER,
    targetId: id,
    summary: `Blocked ${blocked.name} (${blocked.role})`,
    meta: { role: blocked.role, reason: payload.reason ?? null },
  })
  return toFullProfile(blocked)
}

// Admin-only. Lifts a block. The requests that were closed with it stay closed.
const unblockUser = async (admin: TokenPayload, id: string) => {
  const existing = await User.findOne({ _id: id, isDeleted: false })
  if (!existing) throw new AppError(httpStatus.NOT_FOUND, BLOCK_NOT_FOUND_MESSAGE)
  if (!existing.isBlocked) throw new AppError(httpStatus.CONFLICT, 'This account is not blocked')

  const updated = await User.findOneAndUpdate(
    { _id: id, isDeleted: false, isBlocked: true },
    { $set: { isBlocked: false }, $unset: { blockedAt: 1, blockReason: 1 } },
    { returnDocument: 'after' },
  )
  if (!updated)
    throw new AppError(httpStatus.CONFLICT, 'This account was just changed. Please try again')

  await AuditService.record({
    actor: admin,
    action: AuditAction.USER_UNBLOCKED,
    targetType: AuditTargetType.USER,
    targetId: id,
    summary: `Unblocked ${updated.name} (${updated.role})`,
    meta: { role: updated.role },
  })
  return toFullProfile(updated)
}

const RATING_DECIMALS = 2

// Adds one rating to a volunteer in a single atomic update: the sum and count grow together and the
// average is recomputed from them in the same operation, so two ratings at once can't lose one.
// Returns null when there is no such volunteer.
const recordRating = async (volunteerId: string, score: number, session: ClientSession) => {
  const volunteer = await User.findOneAndUpdate(
    { _id: volunteerId, role: Role.VOLUNTEER },
    [
      {
        $set: {
          ratingSum: { $add: [{ $ifNull: ['$ratingSum', 0] }, score] },
          totalRatings: { $add: [{ $ifNull: ['$totalRatings', 0] }, 1] },
        },
      },
      {
        $set: {
          reliabilityScore: {
            $round: [{ $divide: ['$ratingSum', '$totalRatings'] }, RATING_DECIMALS],
          },
        },
      },
    ],
    { returnDocument: 'after', session, updatePipeline: true },
  )
  if (!volunteer) return null
  return { reliabilityScore: volunteer.reliabilityScore, totalRatings: volunteer.totalRatings }
}

// A person's name for records that keep a copy of it (a distribution notes who received the aid).
const getDisplayName = async (id: string) => {
  const user = await User.findById(id).select('name').lean()
  return user?.name ?? null
}

// Email addresses of the active accounts in the given roles, or of everyone when the target is
// 'all'. Used by the emergency broadcast; only the addresses leave this function.
const listEmailsForTargets = async (targets: readonly NotificationTarget[]) => {
  // A blocked account is not emailed.
  const filter: QueryFilter<UserDocument> = { isDeleted: false, isBlocked: { $ne: true } }
  if (!targets.includes(ALL_ROLES_TARGET)) {
    filter.role = { $in: targets.filter((target): target is Role => target !== ALL_ROLES_TARGET) }
  }
  const users = await User.find(filter).select('email').lean()
  return users.map((user) => user.email)
}

// Who to deliver a notification to, for many people in one lookup: their email and saved switches. Deleted
// accounts are absent from the result (there is nobody to tell).
const getNotificationTargets = async (ids: string[]) => {
  const users = await User.find({ _id: { $in: ids }, isDeleted: false })
    .select('email isBlocked notificationPreferences')
    .lean()
  return new Map(
    users.map((user) => [
      String(user._id),
      {
        email: user.email,
        isBlocked: user.isBlocked,
        preferences: user.notificationPreferences as StoredPreferences,
      },
    ]),
  )
}

const getNotificationPreferences = async (id: string) => {
  const user = await User.findOne({ _id: id, isDeleted: false })
    .select('notificationPreferences')
    .lean()
  if (!user) throw new AppError(httpStatus.NOT_FOUND, 'User not found')
  return resolvePreferences(user.notificationPreferences as StoredPreferences)
}

// Saves only the switches that were sent (each is its own field, so two tabs saving different
// categories don't overwrite each other) and returns every category as it now stands.
const updateNotificationPreferences = async (id: string, changes: PreferencesChange) => {
  const set: Record<string, boolean> = {}
  for (const [category, change] of Object.entries(changes)) {
    for (const [field, value] of Object.entries(change ?? {})) {
      if (value !== undefined) set[`notificationPreferences.${category}.${field}`] = value
    }
  }
  const user = await User.findOneAndUpdate(
    { _id: id, isDeleted: false },
    { $set: set },
    { returnDocument: 'after' },
  )
    .select('notificationPreferences')
    .lean()
  if (!user) throw new AppError(httpStatus.NOT_FOUND, 'User not found')
  return resolvePreferences(user.notificationPreferences as StoredPreferences)
}

const countActiveVolunteers = () => User.countDocuments({ role: Role.VOLUNTEER, isDeleted: false })

// Accounts created within the range (everyone when no range is given), deleted ones excluded.
const countRegistered = (range: DateRange) =>
  User.countDocuments({ isDeleted: false, ...inRange('createdAt', range) })

export const UserService = {
  getNotificationTargets,
  getNotificationPreferences,
  updateNotificationPreferences,
  countActiveVolunteers,
  countRegistered,
  listEmailsForTargets,
  getDisplayName,
  listUsers,
  getUserById,
  createAccount,
  blockUser,
  unblockUser,
  recordRating,
  isActiveVolunteer,
}
