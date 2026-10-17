import httpStatus from 'http-status'
import { config } from '../../config'
import { Role } from '../../constants/role'
import { AppError } from '../../errorHelpers/AppError'
import { toGeoPoint } from '../../lib/geo'
import { sendMail } from '../../lib/mailer'
import { type TokenPayload, signAccessToken } from '../../utils/jwt'
import { comparePassword, hashPassword } from '../../utils/password'
import { generateResetToken, hashToken } from '../../utils/resetToken'
import { SosService } from '../sos/sos.service'
import { User, type UserDocument } from '../user/user.model'
import { toFullProfile } from '../user/user.service'
import type {
  ChangePasswordPayload,
  LoginPayload,
  RegisterPayload,
  ResetPasswordPayload,
  UpdateMePayload,
} from './auth.interface'
import { VOLUNTEER_ONLY_FIELDS } from './auth.interface'

const RESET_TOKEN_TTL_MINUTES = 30
const MS_PER_MINUTE = 60 * 1000
const INVALID_CREDENTIALS_MESSAGE = 'Invalid email or password'
const BLOCKED_MESSAGE = 'This account has been blocked. Please contact support'

// A real bcrypt hash of a throwaway string. Login compares against it when the email is unknown so
// that "no such user" takes as long as "wrong password" and response time can't be used to find out
// which emails are registered.
const DUMMY_PASSWORD_HASH = '$2b$10$sQfevbl69NwcR7wppHl1ve0IcJhMuWVoyYGHsIAXtlpIkg/p6K5Fm'

const issueToken = (user: UserDocument) =>
  signAccessToken({ id: String(user._id), role: user.role })

const buildAuthResult = (user: UserDocument) => ({
  token: issueToken(user),
  user: toFullProfile(user),
})

const findActiveUserOrThrow = async (id: string) => {
  const user = await User.findOne({ _id: id, isDeleted: false })
  if (!user) throw new AppError(httpStatus.NOT_FOUND, 'User not found')
  return user
}

const register = async (payload: RegisterPayload) => {
  const { name, email, password, phone } = payload

  // Soft-deleted accounts keep their row, so their email stays taken too.
  if (await User.exists({ email })) {
    throw new AppError(httpStatus.CONFLICT, 'An account with this email already exists')
  }

  const hashedPassword = await hashPassword(password)
  // Public sign-up only ever creates a normal user; volunteers, NGOs and admins come from the
  // volunteer-request flow and admin account creation.
  const user = await User.create({
    name,
    email,
    password: hashedPassword,
    role: Role.VICTIM,
    phone,
  })

  return buildAuthResult(user)
}

const login = async (payload: LoginPayload) => {
  const { email, password } = payload

  const user = await User.findOne({ email, isDeleted: false }).select('+password')
  const passwordMatches = await comparePassword(password, user?.password ?? DUMMY_PASSWORD_HASH)
  if (!user || !passwordMatches) {
    throw new AppError(httpStatus.UNAUTHORIZED, INVALID_CREDENTIALS_MESSAGE)
  }
  // Said only after the password is right, so a wrong guess learns nothing about the account.
  if (user.isBlocked) throw new AppError(httpStatus.FORBIDDEN, BLOCKED_MESSAGE)

  return buildAuthResult(user)
}

// Never says whether the email exists — the controller always answers the same way.
const forgotPassword = async (email: string) => {
  const user = await User.findOne({ email, isDeleted: false })
  // A blocked account gets no link either, and the answer stays the same as for an unknown email.
  if (!user || user.isBlocked) return

  const { token, hashedToken } = generateResetToken()
  await User.updateOne(
    { _id: user._id },
    {
      $set: {
        passwordResetToken: hashedToken,
        passwordResetExpires: new Date(Date.now() + RESET_TOKEN_TTL_MINUTES * MS_PER_MINUTE),
      },
    },
  )

  const resetUrl = `${config.clientUrl.replace(/\/$/, '')}/reset-password/${token}`
  try {
    await sendMail({
      to: user.email,
      subject: 'Reset your AidBridge password',
      text: `Hi ${user.name},\n\nUse this link to reset your password (valid for ${RESET_TOKEN_TTL_MINUTES} minutes):\n${resetUrl}\n\nIf you did not ask for this, ignore this email.`,
      html: `<p>Hi ${user.name},</p><p>Use this link to reset your password (valid for ${RESET_TOKEN_TTL_MINUTES} minutes):</p><p><a href="${resetUrl}">${resetUrl}</a></p><p>If you did not ask for this, ignore this email.</p>`,
    })
  } catch (error) {
    // Logged, not surfaced: telling the caller the mail failed would reveal that the email exists.
    console.error('Failed to send password reset email:', error)
  }
}

const resetPassword = async (token: string, payload: ResetPasswordPayload) => {
  const hashedPassword = await hashPassword(payload.password)
  const now = new Date()

  // One atomic claim: the token is matched, checked for expiry and consumed in a single update, so
  // two simultaneous requests with the same token can't both succeed.
  const user = await User.findOneAndUpdate(
    { passwordResetToken: hashToken(token), passwordResetExpires: { $gt: now }, isDeleted: false },
    {
      $set: { password: hashedPassword, passwordChangedAt: now },
      $unset: { passwordResetToken: '', passwordResetExpires: '' },
    },
  )
  if (!user) throw new AppError(httpStatus.BAD_REQUEST, 'Reset token is invalid or has expired')
}

const changePassword = async (userId: string, payload: ChangePasswordPayload) => {
  const user = await User.findOne({ _id: userId, isDeleted: false }).select('+password')
  if (!user) throw new AppError(httpStatus.NOT_FOUND, 'User not found')

  if (!(await comparePassword(payload.currentPassword, user.password))) {
    throw new AppError(httpStatus.UNAUTHORIZED, 'Current password is incorrect')
  }

  user.password = await hashPassword(payload.newPassword)
  user.passwordChangedAt = new Date()
  await user.save()

  // Every older token is now rejected by auth(), so hand back a fresh one to keep this session.
  return { token: issueToken(user) }
}

const getMe = async (userId: string) => toFullProfile(await findActiveUserOrThrow(userId))

// Skills, languages and "on duty until" describe a volunteer. Anyone else sending them gets a 400 that
// names the fields, rather than having them saved on an account that can never use them.
const updateMe = async (viewer: TokenPayload, payload: UpdateMePayload) => {
  const { name, phone, location, isAvailable, skills, languages, onDutyUntil } = payload

  const volunteerOnlySent = VOLUNTEER_ONLY_FIELDS.filter((field) => payload[field] !== undefined)
  if (viewer.role !== Role.VOLUNTEER && volunteerOnlySent.length > 0) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      `Only volunteers can set ${volunteerOnlySent.join(', ')}`,
      volunteerOnlySent.map((field) => ({ field, message: 'Only volunteers can set this' })),
    )
  }

  const user = await User.findOneAndUpdate(
    { _id: viewer.id, isDeleted: false },
    {
      $set: {
        name,
        phone,
        isAvailable,
        skills,
        languages,
        onDutyUntil,
        location: location && toGeoPoint(location),
      },
    },
    { returnDocument: 'after', runValidators: true },
  )
  if (!user) throw new AppError(httpStatus.NOT_FOUND, 'User not found')

  return toFullProfile(user)
}

// Refused while the user is a party to an unfinished SOS request: their own open request as a
// victim, or the one they are assigned to as a volunteer. Leaving it hanging would strand the other
// person.
const deleteMe = async (userId: string) => {
  if (await SosService.hasUnfinishedRequests(userId)) {
    throw new AppError(
      httpStatus.CONFLICT,
      'Finish or resolve your open SOS requests before deleting your account',
    )
  }

  const result = await User.updateOne(
    { _id: userId, isDeleted: false },
    { $set: { isDeleted: true, deletedAt: new Date() } },
  )
  if (result.matchedCount === 0) throw new AppError(httpStatus.NOT_FOUND, 'User not found')
}

export const AuthService = {
  register,
  login,
  forgotPassword,
  resetPassword,
  changePassword,
  getMe,
  updateMe,
  deleteMe,
}
