// Const objects (not TS enums) so `z.enum(Role)` works and values stay plain strings in MongoDB.
export const Role = {
  VICTIM: 'victim',
  VOLUNTEER: 'volunteer',
  NGO: 'ngo',
  ADMIN: 'admin',
} as const

export type Role = (typeof Role)[keyof typeof Role]

// Roles a person may pick when registering. `admin` comes from the seed script only.
export const SELF_REGISTER_ROLES = [Role.VICTIM, Role.VOLUNTEER, Role.NGO] as const
