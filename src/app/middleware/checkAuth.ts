import type { Request, RequestHandler } from 'express'
import httpStatus from 'http-status'
import type { Role } from '../constants/role'
import { AppError } from '../errorHelpers/AppError'
import { User } from '../module/user/user.model'
import { catchAsync } from '../utils/catchAsync'
import { verifyAccessToken } from '../utils/jwt'

const BEARER_PREFIX = 'Bearer '
const MS_PER_SECOND = 1000
const UNAUTHORIZED_MESSAGE = 'You are not authorized. Please log in again'
const FORBIDDEN_MESSAGE = 'You do not have permission to access this resource'
const BLOCKED_MESSAGE = 'Your account has been blocked. Please contact support'

const extractAccessToken = (req: Request): string | undefined => {
  const header = req.headers.authorization
  if (!header?.startsWith(BEARER_PREFIX)) return undefined
  return header.slice(BEARER_PREFIX.length).trim() || undefined
}

// JWT + role guard. Pass the allowed roles; pass none to allow any logged-in user.
//   router.get('/x', auth(Role.ADMIN), Controller.x)
// Only a bad or expired token is a 401. A failing database lookup is a real error and reaches the
// error handler as a 500 — the old `protect` reported both as "invalid token".
export const auth = (...roles: Role[]): RequestHandler =>
  catchAsync(async (req, _res, next) => {
    const token = extractAccessToken(req)
    if (!token) throw new AppError(httpStatus.UNAUTHORIZED, UNAUTHORIZED_MESSAGE)

    let verified: ReturnType<typeof verifyAccessToken>
    try {
      verified = verifyAccessToken(token)
    } catch {
      throw new AppError(httpStatus.UNAUTHORIZED, UNAUTHORIZED_MESSAGE)
    }

    // Always re-read the user: a soft-deleted account, a changed role or a password change must take
    // effect immediately, not when the (still validly signed) token expires.
    const user = await User.findOne({ _id: verified.id, isDeleted: false }).select(
      'role passwordChangedAt isBlocked',
    )
    if (!user) throw new AppError(httpStatus.UNAUTHORIZED, UNAUTHORIZED_MESSAGE)

    // A block takes effect on the next request, like a deletion. It is a 401 so the client ends the
    // session; the login that follows explains why (see AuthService.login).
    if (user.isBlocked) throw new AppError(httpStatus.UNAUTHORIZED, BLOCKED_MESSAGE)

    // `iat` is in whole seconds, so compare at second precision: a token issued in the same second
    // as the password change (the fresh one handed out by change-password) is still accepted.
    const changedAtSeconds = user.passwordChangedAt
      ? Math.floor(user.passwordChangedAt.getTime() / MS_PER_SECOND)
      : 0
    if (verified.iat < changedAtSeconds) {
      throw new AppError(httpStatus.UNAUTHORIZED, UNAUTHORIZED_MESSAGE)
    }

    if (roles.length > 0 && !roles.includes(user.role)) {
      throw new AppError(httpStatus.FORBIDDEN, FORBIDDEN_MESSAGE)
    }

    req.user = { id: String(user._id), role: user.role }
    next()
  })
