// Top volunteers shown in the dashboard, and top handed-out items.
// Closed requests with no `resolveKind` because an admin closed them (analytics groups them under this).
export const ADMIN_CLOSED_KIND = 'admin_closed'

export const TOP_VOLUNTEERS_LIMIT = 10
export const TOP_DISTRIBUTED_ITEMS_LIMIT = 20

// The live map is a snapshot for a screen, not an export: it shows at most this many open requests
// and this many camps (the newest ones first).
export const LIVE_MAP_MAX_REQUESTS = 500
export const LIVE_MAP_MAX_CAMPS = 500

// The incident heatmap (commit 26): a grid of counts, never single requests. `cell` is the side of a square in
// degrees (0.01 is about 1 km). Positions are rounded to the same ~1 km "approximate" grid the limited
// request views use before they are counted, so a small cell never shows more than that view does.
export const HeatmapStatus = {
  OPEN: 'open',
  UNSERVED: 'unserved',
  ALL: 'all',
} as const

export type HeatmapStatus = (typeof HeatmapStatus)[keyof typeof HeatmapStatus]

export const HEATMAP_DEFAULT_CELL = 0.01
export const HEATMAP_MIN_CELL = 0.005
export const HEATMAP_MAX_CELL = 1
// Densest cells first; the response says when more existed.
export const HEATMAP_MAX_CELLS = 2000

export const MS_PER_MINUTE = 60_000
export const RESPONSE_TIME_DECIMALS = 1

// Shown when a volunteer in the activity chart has no account document any more.
export const UNKNOWN_VOLUNTEER_NAME = 'Unknown volunteer'
