import { z } from 'zod'
import { ADMIN_CREATABLE_ROLES, Role } from '../../constants/role'
import { MAX_BLOCK_REASON_LENGTH } from '../../constants/user'
import { paginationQueryShape } from '../../utils/pagination'

const MIN_NAME_LENGTH = 2
const MAX_NAME_LENGTH = 100
const MIN_PASSWORD_LENGTH = 8
// bcrypt only uses the first 72 bytes of a password, so a longer one gives a false sense of strength.
export const MAX_PASSWORD_LENGTH = 72

// Field schemas shared by sign-up, admin-created accounts, profile updates and the seed script.
export const nameSchema = z
  .string()
  .trim()
  .min(MIN_NAME_LENGTH, `Name must be at least ${MIN_NAME_LENGTH} characters`)
  .max(MAX_NAME_LENGTH, `Name must be at most ${MAX_NAME_LENGTH} characters`)

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email('A valid email is required'))

export const phoneSchema = z
  .string()
  .trim()
  .regex(/^\+?[0-9]{7,15}$/, 'Phone must be 7-15 digits, optionally starting with +')

export const newPasswordSchema = z
  .string()
  .min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`)
  .max(MAX_PASSWORD_LENGTH, `Password must be at most ${MAX_PASSWORD_LENGTH} characters`)
  .regex(/[A-Za-z]/, 'Password must contain a letter')
  .regex(/[0-9]/, 'Password must contain a number')

// "true" / "false" in a query string -> boolean. z.coerce.boolean() would treat "false" as true.
const booleanQuery = z.enum(['true', 'false']).transform((value) => value === 'true')

export const listUsersQuerySchema = z.object({
  ...paginationQueryShape,
  // Admin only: true lists the blocked accounts, false the ones that are not blocked.
  blocked: booleanQuery.optional(),
  role: z
    .enum(Role, { error: `Role must be one of: ${Object.values(Role).join(', ')}` })
    .optional(),
})

// Admin-only: creates an NGO or another admin. The admin chooses the initial password and hands it
// over; the new user is expected to change it (PUT /auth/change-password).
export const createAccountSchema = z.object({
  name: nameSchema,
  email: emailSchema,
  password: newPasswordSchema,
  role: z.enum(ADMIN_CREATABLE_ROLES, {
    error: `Role must be one of: ${ADMIN_CREATABLE_ROLES.join(', ')}`,
  }),
  phone: phoneSchema.optional(),
})

// Admin-only. The reason is for other admins; the blocked person is never shown it.
export const blockUserSchema = z.strictObject({
  reason: z
    .string({ error: 'Reason must be text' })
    .trim()
    .max(MAX_BLOCK_REASON_LENGTH, `Reason must be at most ${MAX_BLOCK_REASON_LENGTH} characters`)
    .optional(),
})

export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>
export type BlockUserPayload = z.infer<typeof blockUserSchema>
export type CreateAccountPayload = z.infer<typeof createAccountSchema>
