import 'dotenv/config'
import { z } from 'zod'

const DEFAULT_PORT = 5000
const DEFAULT_BCRYPT_SALT_ROUNDS = 10
const DEFAULT_JWT_EXPIRES_IN = '7d'
const MIN_SECRET_LENGTH = 32
const PLACEHOLDER_PREFIX = 'replace-with'

const secret = (name: string) =>
  z
    .string()
    .min(MIN_SECRET_LENGTH, `${name} must be at least ${MIN_SECRET_LENGTH} characters`)
    .refine(
      (value) => !value.startsWith(PLACEHOLDER_PREFIX),
      `${name} is still the .env.example placeholder`,
    )

const envSchema = z.object({
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
}
