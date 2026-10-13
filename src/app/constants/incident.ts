export const IncidentStatus = {
  ACTIVE: 'active',
  RESOLVED: 'resolved',
} as const

export type IncidentStatus = (typeof IncidentStatus)[keyof typeof IncidentStatus]

export const MAX_INCIDENT_TITLE_LENGTH = 150
export const MIN_INCIDENT_TITLE_LENGTH = 3
export const MAX_INCIDENT_DESCRIPTION_LENGTH = 2000
export const MAX_INCIDENT_ADDRESS_LENGTH = 300

// SOS requests that can be linked or unlinked in one call.
export const MAX_SOS_LINKS_PER_CALL = 50

export const SosLinkAction = {
  LINK: 'link',
  UNLINK: 'unlink',
} as const

export type SosLinkAction = (typeof SosLinkAction)[keyof typeof SosLinkAction]
