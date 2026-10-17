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

// Most urgent first. Priorities are stored as words, so sorting by the field would put "critical" before
// "high" before "low" before "medium"; sorting by position in this list gives the real order.
export const PRIORITY_ORDER: readonly Priority[] = [
  Priority.CRITICAL,
  Priority.HIGH,
  Priority.MEDIUM,
  Priority.LOW,
]

export const DisasterType = {
  FLOOD: 'flood',
  EARTHQUAKE: 'earthquake',
  FIRE: 'fire',
  CYCLONE: 'cyclone',
  LANDSLIDE: 'landslide',
  OTHER: 'other',
} as const

export type DisasterType = (typeof DisasterType)[keyof typeof DisasterType]
