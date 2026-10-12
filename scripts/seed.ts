// Creates the very first admin account, then you delete this file (and the "seed" npm script).
// Every later admin or NGO is created by an admin through POST /api/v1/users.
//
//   1. Put ADMIN_EMAIL, ADMIN_PASSWORD (and optionally ADMIN_NAME) in .env
//   2. npm run seed
//   3. Delete scripts/seed.ts, the "seed" script in package.json, and ADMIN_PASSWORD from .env
//
// Safe to run twice: if an admin already exists it does nothing.
import { z } from 'zod'
import { config } from '../src/app/config'
import { Role } from '../src/app/constants/role'
import { connectDB, disconnectDB } from '../src/app/lib/db'
import {
  emailSchema,
  nameSchema,
  newPasswordSchema,
} from '../src/app/module/user/user.interface'
import { User } from '../src/app/module/user/user.model'
import { hashPassword } from '../src/app/utils/password'

const adminInputSchema = z.object({
  name: nameSchema,
  email: emailSchema,
  password: newPasswordSchema,
})

const main = async () => {
  const input = adminInputSchema.safeParse(config.admin)
  if (!input.success) {
    const problems = input.error.issues
      .map((issue) => `  - ADMIN_${issue.path.join('.').toUpperCase()}: ${issue.message}`)
      .join('\n')
    console.error(`Cannot seed the admin. Fix your .env:\n${problems}`)
    return 1
  }

  await connectDB()

  if (await User.exists({ role: Role.ADMIN, isDeleted: false })) {
    console.log('An admin account already exists. Nothing to do.')
    return 0
  }

  const { name, email, password } = input.data
  if (await User.exists({ email })) {
    console.error(`An account with ${email} already exists and is not an admin. Use another ADMIN_EMAIL.`)
    return 1
  }

  await User.create({ name, email, password: await hashPassword(password), role: Role.ADMIN })
  console.log(`First admin created: ${email}`)
  console.log('Now delete scripts/seed.ts, the "seed" npm script, and ADMIN_PASSWORD from .env.')
  return 0
}

main()
  .then(async (code) => {
    await disconnectDB()
    process.exit(code)
  })
  .catch(async (error) => {
    console.error('Seed failed:', error)
    await disconnectDB()
    process.exit(1)
  })
