export const TaskStatus = {
  PENDING: 'pending',
  ACCEPTED: 'accepted',
  REJECTED: 'rejected',
  ON_THE_WAY: 'on_the_way',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
  // An offer nobody answered in time (dispatch, commit 15).
  EXPIRED: 'expired',
} as const

export type TaskStatus = (typeof TaskStatus)[keyof typeof TaskStatus]

// Allowed next states for each task status. `rejected`, `completed`, `cancelled` and `expired` are final.
// `accepted -> rejected` is a volunteer backing out before they set off (the request goes back to
// pending); once `on_the_way` they can only finish, or the victim cancels by resolving the request.
// `pending` is also an offer: it ends as `expired` if the volunteer does not answer in time.
export const TASK_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  [TaskStatus.PENDING]: [
    TaskStatus.ACCEPTED,
    TaskStatus.REJECTED,
    TaskStatus.CANCELLED,
    TaskStatus.EXPIRED,
  ],
  [TaskStatus.ACCEPTED]: [TaskStatus.ON_THE_WAY, TaskStatus.REJECTED, TaskStatus.CANCELLED],
  [TaskStatus.ON_THE_WAY]: [TaskStatus.COMPLETED, TaskStatus.CANCELLED],
  [TaskStatus.REJECTED]: [],
  [TaskStatus.COMPLETED]: [],
  [TaskStatus.CANCELLED]: [],
  [TaskStatus.EXPIRED]: [],
}

// A volunteer is "busy" with a task in these statuses; they count towards the cap and block deleting
// the account.
export const TASK_ACTIVE_STATUSES: readonly TaskStatus[] = [
  TaskStatus.ACCEPTED,
  TaskStatus.ON_THE_WAY,
]

// Not yet finished either way, so resolving the SOS request must cancel them.
export const TASK_OPEN_STATUSES: readonly TaskStatus[] = [
  TaskStatus.PENDING,
  ...TASK_ACTIVE_STATUSES,
]

// A volunteer can hold this many unfinished tasks at once.
export const MAX_ACTIVE_TASKS_PER_VOLUNTEER = 3

export const MAX_TASK_NOTES_LENGTH = 500

export const OFFER_TAKEN_NOTE = 'Another volunteer took this request'
export const ADMIN_CLOSED_NOTE_PREFIX = 'SOS closed by an admin before completion. Reason: '

// Task statuses a volunteer may set with PUT /tasks/:id/status, and what each does to the SOS
// request. `from` is the SOS status it must be in, `to` the one it moves to.
export const TASK_PROGRESS_STATUSES = [TaskStatus.ON_THE_WAY, TaskStatus.COMPLETED] as const
export type TaskProgressStatus = (typeof TASK_PROGRESS_STATUSES)[number]

export const RespondAction = {
  ACCEPT: 'accept',
  REJECT: 'reject',
} as const

export type RespondAction = (typeof RespondAction)[keyof typeof RespondAction]

export const MIN_RATING = 1
export const MAX_RATING = 5
