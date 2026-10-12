export const VolunteerRequestStatus = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
} as const

export type VolunteerRequestStatus =
  (typeof VolunteerRequestStatus)[keyof typeof VolunteerRequestStatus]
