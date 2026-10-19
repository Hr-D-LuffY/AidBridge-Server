export const SosStatus = {
  PENDING: 'pending',
  ASSIGNED: 'assigned',
  ON_THE_WAY: 'on_the_way',
  RESCUED: 'rescued',
  CLOSED: 'closed',
} as const

export type SosStatus = (typeof SosStatus)[keyof typeof SosStatus]

// Allowed next states for each SOS status. `assigned -> pending` is a volunteer backing out.
// Drawn from the old code's behaviour; revisit in commit 5 when accept/reject/resolve are ported.
export const SOS_TRANSITIONS: Record<SosStatus, readonly SosStatus[]> = {
  [SosStatus.PENDING]: [SosStatus.ASSIGNED, SosStatus.CLOSED],
  [SosStatus.ASSIGNED]: [SosStatus.ON_THE_WAY, SosStatus.PENDING, SosStatus.CLOSED],
  // `on_the_way -> pending` is only an admin taking the request off its volunteer (commit 16).
  [SosStatus.ON_THE_WAY]: [SosStatus.RESCUED, SosStatus.PENDING, SosStatus.CLOSED],
  [SosStatus.RESCUED]: [SosStatus.CLOSED],
  [SosStatus.CLOSED]: [],
}

// Statuses in which the victim can no longer edit the request or add media / messages.
export const SOS_FINISHED_STATUSES: readonly SosStatus[] = [SosStatus.RESCUED, SosStatus.CLOSED]

// Why the victim resolved a request. Anything but `other` needs no typed reason: the server writes a
// preset one. The rating prompt never looks at this, only at whether a volunteer completed a task.
export const ResolveKind = {
  SAFE: 'safe',
  RESCUED_ELSEWHERE: 'rescued_elsewhere',
  NO_LONGER_NEEDED: 'no_longer_needed',
  OTHER: 'other',
} as const

export type ResolveKind = (typeof ResolveKind)[keyof typeof ResolveKind]

export const RESOLVE_KIND_PRESET_REASONS: Record<Exclude<ResolveKind, 'other'>, string> = {
  [ResolveKind.SAFE]: 'I am safe now',
  [ResolveKind.RESCUED_ELSEWHERE]: 'I was helped by someone else',
  [ResolveKind.NO_LONGER_NEEDED]: 'I no longer need help',
}

// Who closed a request: the victim, or an admin (closing it by hand, or blocking the victim).
export const ResolvedBy = {
  VICTIM: 'victim',
  ADMIN: 'admin',
} as const

export type ResolvedBy = (typeof ResolvedBy)[keyof typeof ResolvedBy]

export const MediaType = {
  IMAGE: 'image',
  VIDEO: 'video',
} as const

export type MediaType = (typeof MediaType)[keyof typeof MediaType]

// A victim can have this many unfinished requests at once (stops spam; closing one frees a slot).
export const MAX_ACTIVE_SOS_PER_VICTIM = 3

// How `GET /sos` can be ordered. `priority` puts critical first, then newest within each level.
export const SosSort = {
  NEWEST: 'newest',
  OLDEST: 'oldest',
  PRIORITY: 'priority',
} as const

export type SosSort = (typeof SosSort)[keyof typeof SosSort]

// `q` is matched against the description and address with a MongoDB text index.
export const MIN_SOS_SEARCH_LENGTH = 2
export const MAX_SOS_SEARCH_LENGTH = 100

export const MAX_SOS_DESCRIPTION_LENGTH = 1000
export const MAX_SOS_ADDRESS_LENGTH = 300
export const MAX_SOS_RESOLVE_REASON_LENGTH = 500

// Uploads. Allowed MIME type -> the file format Cloudinary checks the real content against.
export const MAX_SOS_MEDIA_ITEMS = 5
export const MAX_SOS_MEDIA_FILE_BYTES = 10 * 1024 * 1024
export const SOS_MEDIA_FORMATS = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/x-msvideo': 'avi',
} as const
export const SOS_MEDIA_FOLDER = 'aidbridge/sos'
