import { z } from 'zod'
import { isValidDutyUntil } from '../../lib/availability'
import { coordinatesSchema } from '../../lib/geo'
import { skillListSchema } from '../../lib/skillSchema'
import {
  MAX_DUTY_DAYS,
  MAX_LANGUAGE_LENGTH,
  MAX_VOLUNTEER_LANGUAGES,
  MAX_VOLUNTEER_SKILLS,
  MIN_LANGUAGE_LENGTH,
} from '../../constants/skill'
import { atLeastOneField, isoDateSchema, updateBodySchema } from '../../utils/validation'
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

// Free text, but short and few; "bangla" and "Bangla" are one language.
const languagesSchema = z
  .array(
    z
      .string({ error: 'Each language must be text' })
      .trim()
      .min(MIN_LANGUAGE_LENGTH, `A language must be at least ${MIN_LANGUAGE_LENGTH} characters`)
      .max(MAX_LANGUAGE_LENGTH, `A language must be at most ${MAX_LANGUAGE_LENGTH} characters`),
    { error: 'Languages must be a list' },
  )
  .max(MAX_VOLUNTEER_LANGUAGES, `Add at most ${MAX_VOLUNTEER_LANGUAGES} languages`)
  .transform((languages) => {
    const seen = new Set<string>()
    return languages.filter((language) => {
      const key = language.toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  })

// `null` takes the volunteer off the clock; a time puts them on duty until then.
const onDutyUntilSchema = isoDateSchema
  .nullable()
  .refine((until) => until === null || isValidDutyUntil(until, new Date()), {
    message: `onDutyUntil must be in the future and at most ${MAX_DUTY_DAYS} days ahead`,
  })

// The fields only a volunteer may send; anyone else gets a 400 naming them (see AuthService.updateMe).
export const VOLUNTEER_ONLY_FIELDS = ['skills', 'languages', 'onDutyUntil'] as const

// `email` and `role` are deliberately not editable here.
export const updateMeSchema = updateBodySchema(
  {
    name: nameSchema,
    phone: phoneSchema,
    location: coordinatesSchema,
    isAvailable: z.boolean({ error: 'isAvailable must be true or false' }),
    skills: skillListSchema(MAX_VOLUNTEER_SKILLS),
    languages: languagesSchema,
    onDutyUntil: onDutyUntilSchema,
  },
  'You can only update name, phone, location, isAvailable, skills, languages and onDutyUntil',
)
  .partial()
  .refine(...atLeastOneField)

export type RegisterPayload = z.infer<typeof registerSchema>
export type LoginPayload = z.infer<typeof loginSchema>
export type ResetPasswordPayload = z.infer<typeof resetPasswordSchema>
export type ChangePasswordPayload = z.infer<typeof changePasswordSchema>
export type UpdateMePayload = z.infer<typeof updateMeSchema>
