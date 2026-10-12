import jwt, { type SignOptions } from 'jsonwebtoken'
import { z } from 'zod'
import { config } from '../config'
import { Role } from '../constants/role'
import { objectIdSchema } from './validation'

const JWT_ALGORITHM = 'HS256'

export const tokenPayloadSchema = z.object({
  id: objectIdSchema,
  role: z.enum(Role),
})

export type TokenPayload = z.infer<typeof tokenPayloadSchema>

// What a verified token yields: the payload plus `iat`, which auth() compares with the user's
// `passwordChangedAt` to reject tokens issued before a password change.
const verifiedTokenSchema = tokenPayloadSchema.extend({ iat: z.number() })

export type VerifiedToken = z.infer<typeof verifiedTokenSchema>

export const signAccessToken = (payload: TokenPayload) =>
  jwt.sign(payload, config.jwt.secret, {
    algorithm: JWT_ALGORITHM,
    expiresIn: config.jwt.expiresIn as SignOptions['expiresIn'],
  })

// Throws a jsonwebtoken error (expired / malformed / bad signature) or a ZodError (wrong payload
// shape). Callers that want a 401 for any of these catch and rethrow an AppError.
export const verifyAccessToken = (token: string): VerifiedToken =>
  verifiedTokenSchema.parse(jwt.verify(token, config.jwt.secret, { algorithms: [JWT_ALGORITHM] }))
