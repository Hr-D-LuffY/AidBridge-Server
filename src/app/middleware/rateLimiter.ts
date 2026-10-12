import { rateLimit } from 'express-rate-limit'
import httpStatus from 'http-status'
import { AppError } from '../errorHelpers/AppError'

const FIFTEEN_MINUTES_IN_MS = 15 * 60 * 1000
const TOO_MANY_REQUESTS_MESSAGE = 'Too many requests. Please try again later.'

// Generous ceiling for ordinary API traffic — this guards against abuse, not normal use. One
// screen of the web app makes several API calls, so a person clicking around needs room.
const GENERAL_LIMIT = { windowMs: FIFTEEN_MINUTES_IN_MS, limit: 600 }

// Login, register and forgot-password are brute-force targets, so they get a much tighter cap.
// 100 still leaves room for several people trying demo accounts from one network (a classroom).
const AUTH_LIMIT = { windowMs: FIFTEEN_MINUTES_IN_MS, limit: 100 }

// In-memory counters per client IP — fine for a single server instance. Rejections go through
// AppError so they come back in the standard error envelope.
const createLimiter = ({ windowMs, limit }: { windowMs: number; limit: number }) =>
  rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req, _res, next) => {
      next(new AppError(httpStatus.TOO_MANY_REQUESTS, TOO_MANY_REQUESTS_MESSAGE))
    },
  })

export const generalLimiter = createLimiter(GENERAL_LIMIT)
export const authLimiter = createLimiter(AUTH_LIMIT)
