import type { Priority } from './relief'

// Who made an offer: the dispatch engine, or (commit 16 and 31) an admin or an NGO by hand.
export const OfferSource = {
  AUTO: 'auto',
  ADMIN: 'admin',
  NGO: 'ngo',
} as const

export type OfferSource = (typeof OfferSource)[keyof typeof OfferSource]

// The one document that holds the admin-editable settings (a singleton, found by this key).
export const DISPATCH_SETTINGS_KEY = 'default'

export interface DispatchSettingsValues {
  // Kill switch: off stops new offers, escalation and set-off checks. Offers already out still expire.
  enabled: boolean
  // Minutes a new request waits before it is first offered, by priority.
  waitMinutes: Record<Priority, number>
  volunteersPerRound: number
  offerWindowMinutes: number
  criticalOfferWindowMinutes: number
  startRadiusKm: number
  radiusFactor: number
  maxRadiusKm: number
  // Rounds with nobody accepting before the request counts as unserved.
  maxRounds: number
  retryIntervalMinutes: number
  // After accepting, a volunteer must set off within this long or the request goes back to pending.
  setOffWithinMinutes: number
  criticalSetOffWithinMinutes: number
  weights: {
    distance: number
    reliability: number
    load: number
    skillMatch: number
    noShowPenalty: number
  }
}

export const DEFAULT_DISPATCH_SETTINGS: DispatchSettingsValues = {
  enabled: true,
  waitMinutes: { critical: 5, high: 30, medium: 60, low: 120 },
  volunteersPerRound: 3,
  offerWindowMinutes: 15,
  criticalOfferWindowMinutes: 5,
  startRadiusKm: 10,
  radiusFactor: 2,
  maxRadiusKm: 80,
  maxRounds: 3,
  retryIntervalMinutes: 30,
  setOffWithinMinutes: 30,
  criticalSetOffWithinMinutes: 15,
  weights: { distance: 0.4, reliability: 0.25, load: 0.1, skillMatch: 0.2, noShowPenalty: 0.05 },
}

// Escalation level at which a request that is still unanswered is raised one priority step.
export const PRIORITY_BUMP_LEVEL = 2

// A noShowCount at or above this counts as the worst case in the score, so one very unreliable
// volunteer cannot push the score far below zero.
export const NO_SHOW_PENALTY_CAP = 5

export const METERS_PER_KM = 1000
export const MS_PER_MINUTE = 60_000

// How often the dispatch job wakes up.
export const DISPATCH_TICK_MS = 60_000
// A request being processed is "leased" for this long so a second server instance skips it, and so
// a crash in the middle still lets it be picked up again.
export const DISPATCH_LEASE_MS = 2 * MS_PER_MINUTE
// Most work done in one tick, per kind, so a backlog is worked off over several ticks.
export const DISPATCH_BATCH_SIZE = 50
// Volunteers read from the database per round before ranking; the best few are offered.
export const DISPATCH_CANDIDATE_POOL = 50

export const SosEventType = {
  OFFERED: 'offered',
  ACCEPTED: 'accepted',
  DECLINED: 'declined',
  EXPIRED: 'expired',
  OFFERS_WITHDRAWN: 'offers_withdrawn',
  ESCALATED: 'escalated',
  PRIORITY_RAISED: 'priority_raised',
  UNSERVED: 'unserved',
  SET_OFF_TIMEOUT: 'set_off_timeout',
  BACKED_OUT: 'backed_out',
  ON_THE_WAY: 'on_the_way',
  COMPLETED: 'completed',
} as const

export type SosEventType = (typeof SosEventType)[keyof typeof SosEventType]

export const TIMELINE_DEFAULT_LIMIT = 100
export const TIMELINE_MAX_LIMIT = 100

export const SET_OFF_TIMEOUT_NOTE = 'Did not set off in time, so the request was offered to others'
