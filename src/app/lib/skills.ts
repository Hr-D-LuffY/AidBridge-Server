import { NEED_TO_SKILLS, type Skill } from '../constants/skill'
import type { ReliefCategory } from '../constants/relief'

// Pure matching of what a request wants against what a volunteer can do. A match only ever boosts
// (a badge now, a score in dispatch later); an unskilled volunteer is still better than none.

// Everything a request is looking for: the skills the victim ticked plus those implied by its needs.
export const wantedSkills = (
  requiredSkills: readonly Skill[] | null | undefined,
  needs: readonly ReliefCategory[],
): Skill[] => {
  const implied = needs.flatMap((need) => NEED_TO_SKILLS[need] ?? [])
  return [...new Set([...(requiredSkills ?? []), ...implied])]
}

// The wanted skills this volunteer has.
export const matchSkills = (wanted: readonly Skill[], volunteerSkills: readonly Skill[]): Skill[] =>
  wanted.filter((skill) => volunteerSkills.includes(skill))

// The needs that imply at least one of these skills: how to turn a `?skills=` filter into a query on
// the `needs` field, since implied skills are not stored on the request.
export const needsImplyingAny = (skills: readonly Skill[]): ReliefCategory[] =>
  (Object.entries(NEED_TO_SKILLS) as [ReliefCategory, readonly Skill[]][])
    .filter(([, implied]) => implied.some((skill) => skills.includes(skill)))
    .map(([need]) => need)
