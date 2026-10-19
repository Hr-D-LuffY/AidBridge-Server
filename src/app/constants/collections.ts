// MongoDB collection names that an aggregation `$lookup` has to spell out. The models are created
// with these names explicitly, so a lookup and its model can't drift apart.
export const Collection = {
  USERS: 'users',
  SOS_REQUESTS: 'sosrequests',
  SOS_EVENTS: 'sosevents',
} as const
