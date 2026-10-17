import { z } from 'zod'
import { Skill } from '../constants/skill'

export const skillSchema = z.enum(Skill, {
  error: `Each skill must be one of: ${Object.values(Skill).join(', ')}`,
})

// A list of skills for a body field: duplicates collapse, at most `max`, an empty list is allowed (it
// clears the field).
export const skillListSchema = (max: number) =>
  z
    .array(skillSchema, { error: 'Skills must be a list' })
    .max(max, `Choose at most ${max} skills`)
    .transform((skills): Skill[] => [...new Set(skills)])
