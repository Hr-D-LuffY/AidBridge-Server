import type { ReliefCategory } from './relief'

// What a volunteer can do. The same values label a volunteer's profile and what a request asks for.
export const Skill = {
  MEDICAL: 'medical',
  FIRST_AID: 'first_aid',
  SEARCH_RESCUE: 'search_rescue',
  BOAT: 'boat',
  DRIVING: 'driving',
  FOOD_DISTRIBUTION: 'food_distribution',
  SHELTER_MANAGEMENT: 'shelter_management',
  COUNSELLING: 'counselling',
} as const

export type Skill = (typeof Skill)[keyof typeof Skill]

export const MAX_VOLUNTEER_SKILLS = 8
// What a victim can ask for on one request.
export const MAX_REQUIRED_SKILLS = 4

export const MAX_VOLUNTEER_LANGUAGES = 5
export const MIN_LANGUAGE_LENGTH = 2
export const MAX_LANGUAGE_LENGTH = 30

// "On duty until" can be set at most this far ahead, so a forgotten switch ends on its own.
export const MAX_DUTY_DAYS = 7

// Skills a request is assumed to want because of what it needs, so a victim who only ticks "medicine"
// still shows up as a match for a medic. Needs that imply nothing are left out. This only ever boosts a
// match; it never hides a request from anyone.
export const NEED_TO_SKILLS: Partial<Record<ReliefCategory, readonly Skill[]>> = {
  medicine: [Skill.MEDICAL, Skill.FIRST_AID],
  food: [Skill.FOOD_DISTRIBUTION],
  water: [Skill.FOOD_DISTRIBUTION],
  shelter: [Skill.SHELTER_MANAGEMENT],
}
