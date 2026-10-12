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
  [SosStatus.ON_THE_WAY]: [SosStatus.RESCUED, SosStatus.CLOSED],
  [SosStatus.RESCUED]: [SosStatus.CLOSED],
  [SosStatus.CLOSED]: [],
}

// Statuses in which the victim can no longer edit the request or add media / messages.
export const SOS_FINISHED_STATUSES: readonly SosStatus[] = [SosStatus.RESCUED, SosStatus.CLOSED]
