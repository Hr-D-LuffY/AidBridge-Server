// Shared by SOS needs and inventory categories — the same six kinds of relief item.
export const ReliefCategory = {
  FOOD: 'food',
  MEDICINE: 'medicine',
  SHELTER: 'shelter',
  WATER: 'water',
  CLOTHING: 'clothing',
  OTHER: 'other',
} as const

export type ReliefCategory = (typeof ReliefCategory)[keyof typeof ReliefCategory]

// Shared by SOS requests and incidents.
export const Priority = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical',
} as const

export type Priority = (typeof Priority)[keyof typeof Priority]

export const DisasterType = {
  FLOOD: 'flood',
  EARTHQUAKE: 'earthquake',
  FIRE: 'fire',
  CYCLONE: 'cyclone',
  LANDSLIDE: 'landslide',
  OTHER: 'other',
} as const

export type DisasterType = (typeof DisasterType)[keyof typeof DisasterType]
