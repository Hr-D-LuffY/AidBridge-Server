import httpStatus from 'http-status'
import type { QueryFilter } from 'mongoose'
import type { ClientSession } from 'mongoose'
import { ALL_ROLES_TARGET, type NotificationTarget } from '../../constants/notification'
import { Role } from '../../constants/role'
import { AppError } from '../../errorHelpers/AppError'
import { type DateRange, inRange } from '../../utils/dateRange'
import { buildMeta, getPagination } from '../../utils/pagination'
import { hashPassword } from '../../utils/password'
import type { TokenPayload } from '../../utils/jwt'
import type { CreateAccountPayload, ListUsersQuery } from './user.interface'
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
  const { page, limit, role } = query

  // Only an admin may see (or search for) admin accounts.
  if (role === Role.ADMIN && viewer.role !== Role.ADMIN) {
    throw new AppError(httpStatus.FORBIDDEN, 'Only an admin can list admin accounts')
  }

  const filter: QueryFilter<UserDocument> = { isDeleted: false }
  if (role) filter.role = role
  else if (viewer.role !== Role.ADMIN) filter.role = { $ne: Role.ADMIN }

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
  (await User.exists({ _id: id, role: Role.VOLUNTEER, isDeleted: false })) !== null

// Admin-only. The only way an NGO or another admin account comes into existence (the very first
// admin is created by the seed script). Returns the new profile but no token: the admin hands the
// credentials over and the new user logs in themselves.
const createAccount = async (payload: CreateAccountPayload) => {
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
  return toFullProfile(user)
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
  const filter: QueryFilter<UserDocument> = { isDeleted: false }
  if (!targets.includes(ALL_ROLES_TARGET)) {
    filter.role = { $in: targets.filter((target): target is Role => target !== ALL_ROLES_TARGET) }
  }
  const users = await User.find(filter).select('email').lean()
  return users.map((user) => user.email)
}

const countActiveVolunteers = () => User.countDocuments({ role: Role.VOLUNTEER, isDeleted: false })

// Accounts created within the range (everyone when no range is given), deleted ones excluded.
const countRegistered = (range: DateRange) =>
  User.countDocuments({ isDeleted: false, ...inRange('createdAt', range) })

export const UserService = {
  countActiveVolunteers,
  countRegistered,
  listEmailsForTargets,
  getDisplayName,
  listUsers,
  getUserById,
  createAccount,
  recordRating,
  isActiveVolunteer,
}
