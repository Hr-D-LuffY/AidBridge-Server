import type { ErrorRequestHandler } from 'express'
import httpStatus from 'http-status'
import jwt from 'jsonwebtoken'
import mongoose from 'mongoose'
import multer from 'multer'
import { z } from 'zod'
import { config } from '../config'
import { MAX_SOS_MEDIA_FILE_BYTES, MAX_SOS_MEDIA_ITEMS } from '../constants/sos'
import { AppError } from '../errorHelpers/AppError'

const MONGO_DUPLICATE_KEY = 11000
const BYTES_PER_MB = 1024 * 1024
const SESSION_EXPIRED_MESSAGE = 'Your session has expired. Please log in again'
const INVALID_TOKEN_MESSAGE = 'You are not authorized. Please log in again'
const GENERIC_SERVER_ERROR_MESSAGE = 'Internal server error'

interface ErrorDetail {
  path?: string
  message: string
}

interface NormalizedError {
  statusCode: number
  message: string
  errors: unknown[]
}

const fromZodError = (error: z.ZodError): NormalizedError => ({
  statusCode: httpStatus.BAD_REQUEST,
  message: 'Validation failed',
  errors: error.issues.map(
    (issue): ErrorDetail => ({ path: issue.path.join('.'), message: issue.message }),
  ),
})

const fromMongooseValidationError = (error: mongoose.Error.ValidationError): NormalizedError => ({
  statusCode: httpStatus.BAD_REQUEST,
  message: 'Validation failed',
  errors: Object.values(error.errors).map(
    (issue): ErrorDetail => ({ path: issue.path, message: issue.message }),
  ),
})

// Mongo's duplicate-key error comes from the driver, not a mongoose class, so match on its code.
const isDuplicateKeyError = (
  error: unknown,
): error is Error & { code: number; keyValue?: Record<string, unknown> } =>
  error instanceof Error && 'code' in error && error.code === MONGO_DUPLICATE_KEY

// Names the clashing fields but not their values (an email address, say).
const fromDuplicateKeyError = (error: { keyValue?: Record<string, unknown> }): NormalizedError => ({
  statusCode: httpStatus.CONFLICT,
  message: 'A record with these values already exists',
  errors: [{ fields: Object.keys(error.keyValue ?? {}) }],
})

// Multer's own wording ("Unexpected field") means little to an API caller, so the common codes get
// a clearer message.
const fromMulterError = (error: multer.MulterError): NormalizedError => {
  const messages: Record<string, string> = {
    LIMIT_FILE_SIZE: `A file is too large (max ${MAX_SOS_MEDIA_FILE_BYTES / BYTES_PER_MB} MB each)`,
    LIMIT_UNEXPECTED_FILE: `Send at most ${MAX_SOS_MEDIA_ITEMS} files, in the "media" field`,
  }
  return {
    statusCode: httpStatus.BAD_REQUEST,
    message: messages[error.code] ?? error.message,
    errors: [],
  }
}

// Errors raised by Express itself (e.g. malformed JSON from body-parser) carry a 4xx statusCode.
const isClientHttpError = (error: unknown): error is Error & { statusCode: number } =>
  error instanceof Error &&
  'statusCode' in error &&
  typeof error.statusCode === 'number' &&
  error.statusCode >= httpStatus.BAD_REQUEST &&
  error.statusCode < httpStatus.INTERNAL_SERVER_ERROR

const normalizeError = (error: unknown): NormalizedError => {
  if (error instanceof AppError) {
    return { statusCode: error.statusCode, message: error.message, errors: error.errors }
  }
  if (error instanceof z.ZodError) {
    return fromZodError(error)
  }
  if (error instanceof mongoose.Error.ValidationError) {
    return fromMongooseValidationError(error)
  }
  if (error instanceof mongoose.Error.CastError) {
    return {
      statusCode: httpStatus.BAD_REQUEST,
      message: `Invalid value for "${error.path}"`,
      errors: [],
    }
  }
  if (isDuplicateKeyError(error)) {
    return fromDuplicateKeyError(error)
  }
  if (error instanceof jwt.TokenExpiredError) {
    return { statusCode: httpStatus.UNAUTHORIZED, message: SESSION_EXPIRED_MESSAGE, errors: [] }
  }
  if (error instanceof jwt.JsonWebTokenError) {
    return { statusCode: httpStatus.UNAUTHORIZED, message: INVALID_TOKEN_MESSAGE, errors: [] }
  }
  if (error instanceof multer.MulterError) {
    return fromMulterError(error)
  }
  if (isClientHttpError(error)) {
    return { statusCode: error.statusCode, message: error.message, errors: [] }
  }
  // Anything else is a bug. The real message is useful while developing, but in production it could
  // leak internals, so the client only ever sees a generic one.
  return {
    statusCode: httpStatus.INTERNAL_SERVER_ERROR,
    message:
      config.isDevelopment && error instanceof Error ? error.message : GENERIC_SERVER_ERROR_MESSAGE,
    errors: [],
  }
}

// The only place an error envelope is built: { success, message, errors }
// The status code goes on the HTTP response itself, and stack traces stay in the server log,
// never in the body.
// Express identifies error middleware by its 4-argument signature, so `_next` must stay.
export const globalErrorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  const { statusCode, message, errors } = normalizeError(error)

  if (statusCode >= httpStatus.INTERNAL_SERVER_ERROR || config.isDevelopment) {
    console.error(error)
  }

  res.status(statusCode).json({ success: false, message, errors })
}
