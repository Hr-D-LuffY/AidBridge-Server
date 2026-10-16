// The reason an admin may write when blocking an account (kept for other admins, never shown to the user).
export const MAX_BLOCK_REASON_LENGTH = 500

// What a blocked victim's unfinished SOS requests say when they are closed with the block (volunteers on
// them are told this too, so it does not carry the admin's private reason).
export const BLOCKED_CLOSE_REASON =
  'Closed by an administrator: the account that raised it was blocked.'
