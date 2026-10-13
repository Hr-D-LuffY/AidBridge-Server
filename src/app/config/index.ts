import 'dotenv/config'
import { z } from 'zod'

const DEFAULT_PORT = 5000
const DEFAULT_BCRYPT_SALT_ROUNDS = 10
const DEFAULT_JWT_EXPIRES_IN = '7d'
const MIN_SECRET_LENGTH = 32
const PLACEHOLDER_PREFIX = 'replace-with'
const CLOUDINARY_URL_PREFIX = 'cloudinary://'

const secret = (name: string) =>
  z
    .string()
    .min(MIN_SECRET_LENGTH, `${name} must be at least ${MIN_SECRET_LENGTH} characters`)
    .refine(
      (value) => !value.startsWith(PLACEHOLDER_PREFIX),
      `${name} is still the .env.example placeholder`,
    )

const EMAIL_VARS = ['EMAIL_USER', 'EMAIL_PASS'] as const

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.coerce.number().int().positive().default(DEFAULT_PORT),
    MONGO_URI: z
      .string()
      .min(1, 'MONGO_URI is required')
      .refine(
        (value) => value.startsWith('mongodb://') || value.startsWith('mongodb+srv://'),
        'MONGO_URI must start with mongodb:// or mongodb+srv://',
      ),
    JWT_SECRET: secret('JWT_SECRET'),
    JWT_EXPIRES_IN: z.string().min(1).default(DEFAULT_JWT_EXPIRES_IN),
    BCRYPT_SALT_ROUNDS: z.coerce.number().int().positive().default(DEFAULT_BCRYPT_SALT_ROUNDS),
    CLIENT_URL: z.url('CLIENT_URL must be a valid URL'),
    EMAIL_USER: z.string().min(1).optional(),
    EMAIL_PASS: z.string().min(1).optional(),
    // cloudinary://<api_key>:<api_secret>@<cloud_name>. Optional so the rest of the API runs without
    // it in development (media uploads answer 503); production refuses to start without it.
    CLOUDINARY_URL: z
      .string()
      .refine(
        (value) => value.startsWith(CLOUDINARY_URL_PREFIX),
        `CLOUDINARY_URL must start with ${CLOUDINARY_URL_PREFIX}`,
      )
      .optional(),
    // Only read by the seed script that creates the very first admin; the server never needs them.
    ADMIN_NAME: z.string().min(1).optional(),
    ADMIN_EMAIL: z.string().min(1).optional(),
    ADMIN_PASSWORD: z.string().min(1).optional(),
  })
  .superRefine((env, ctx) => {
    // Email is all-or-nothing: one var without the other fails at boot, not at the first reset email.
    // Only production insists on it, so local work without a Gmail app password still starts (the
    // reset link is printed to the console instead).
    const missing = EMAIL_VARS.filter((name) => !env[name])
    const partlySet = missing.length > 0 && missing.length < EMAIL_VARS.length
    const requiredHere = env.NODE_ENV === 'production' && missing.length > 0
    if (partlySet || requiredHere) {
      for (const name of missing) {
        ctx.addIssue({ code: 'custom', path: [name], message: `${name} is required for email` })
      }
    }

    if (env.NODE_ENV === 'production' && !env.CLOUDINARY_URL) {
      ctx.addIssue({
        code: 'custom',
        path: ['CLOUDINARY_URL'],
        message: 'CLOUDINARY_URL is required in production',
      })
    }
  })

// A blank `KEY=` line in .env means "not set", so optional vars can stay empty in .env.example.
const rawEnv = Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== ''))
const parsed = envSchema.safeParse(rawEnv)

if (!parsed.success) {
  const problems = parsed.error.issues
    .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
    .join('\n')
  console.error(`Invalid environment configuration:\n${problems}`)
  process.exit(1)
}

const env = parsed.data

export const config = {
  nodeEnv: env.NODE_ENV,
  isDevelopment: env.NODE_ENV === 'development',
  port: env.PORT,
  mongoUri: env.MONGO_URI,
  jwt: {
    secret: env.JWT_SECRET,
    expiresIn: env.JWT_EXPIRES_IN,
  },
  bcryptSaltRounds: env.BCRYPT_SALT_ROUNDS,
  clientUrl: env.CLIENT_URL,
  cloudinaryUrl: env.CLOUDINARY_URL,
  admin: {
    name: env.ADMIN_NAME ?? 'Admin',
    email: env.ADMIN_EMAIL,
    password: env.ADMIN_PASSWORD,
  },
  // undefined until both EMAIL_* vars are set; the mailer then logs instead of sending (dev only)
  email:
    env.EMAIL_USER && env.EMAIL_PASS ? { user: env.EMAIL_USER, pass: env.EMAIL_PASS } : undefined,
}
