import { z } from 'zod'
import { coordinatesSchema } from '../../lib/geo'
import { atLeastOneField, updateBodySchema } from '../../utils/validation'
import {
  MAX_PASSWORD_LENGTH,
  emailSchema,
  nameSchema,
  newPasswordSchema,
  phoneSchema,
} from '../user/user.interface'

const RESET_TOKEN_PATTERN = /^[0-9a-f]{64}$/
const ROLE_AT_SIGNUP_MESSAGE =
  'You cannot choose a role when signing up. Sign up as a normal user, then request to become a volunteer'

// Public sign-up always creates a normal user (role `victim`). A `role` field is rejected with an
// explanation instead of silently ignored, so nobody thinks they signed up as something else.
export const registerSchema = z.object({
  name: nameSchema,
  email: emailSchema,
  password: newPasswordSchema,
  phone: phoneSchema.optional(),
  role: z.never({ error: ROLE_AT_SIGNUP_MESSAGE }).optional(),
})

export const loginSchema = z.object({
  email: emailSchema,
  // Not run through the password policy: login must accept whatever the account already has.
  password: z.string().min(1, 'Password is required').max(MAX_PASSWORD_LENGTH),
})

export const forgotPasswordSchema = z.object({ email: emailSchema })

export const resetPasswordParamsSchema = z.object({
  token: z.string().regex(RESET_TOKEN_PATTERN, 'Reset token is invalid or has expired'),
})

export const resetPasswordSchema = z.object({ password: newPasswordSchema })

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Current password is required').max(MAX_PASSWORD_LENGTH),
    newPassword: newPasswordSchema,
  })
  .refine((value) => value.currentPassword !== value.newPassword, {
    path: ['newPassword'],
    message: 'New password must be different from the current password',
  })

// `email` and `role` are deliberately not editable here.
export const updateMeSchema = updateBodySchema(
  {
    name: nameSchema,
    phone: phoneSchema,
    location: coordinatesSchema,
    isAvailable: z.boolean({ error: 'isAvailable must be true or false' }),
  },
  'You can only update name, phone, location and isAvailable',
)
  .partial()
  .refine(...atLeastOneField)

export type RegisterPayload = z.infer<typeof registerSchema>
export type LoginPayload = z.infer<typeof loginSchema>
export type ResetPasswordPayload = z.infer<typeof resetPasswordSchema>
export type ChangePasswordPayload = z.infer<typeof changePasswordSchema>
export type UpdateMePayload = z.infer<typeof updateMeSchema>
