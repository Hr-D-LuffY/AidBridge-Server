// Const objects (not TS enums) so `z.enum(Role)` works and values stay plain strings in MongoDB.
export const Role = {
  VICTIM: 'victim',
  VOLUNTEER: 'volunteer',
  NGO: 'ngo',
  ADMIN: 'admin',
} as const

export type Role = (typeof Role)[keyof typeof Role]

// How each role comes into existence (do not add another way):
//   victim     public sign-up (POST /auth/register) — the only role anyone can pick for themselves
//   volunteer  a victim files a volunteer request and an admin approves it
//   ngo        created by an admin (POST /users)
//   admin      created by an admin (POST /users); the very first one comes from the seed script
export const ADMIN_CREATABLE_ROLES = [Role.NGO, Role.ADMIN] as const
