export const TaskStatus = {
  PENDING: 'pending',
  ACCEPTED: 'accepted',
  REJECTED: 'rejected',
  ON_THE_WAY: 'on_the_way',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
} as const

export type TaskStatus = (typeof TaskStatus)[keyof typeof TaskStatus]

// Allowed next states for each task status. `rejected`, `completed` and `cancelled` are final.
// Revisit in commit 5 when tasks are ported (the old code had no state machine at all).
export const TASK_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  [TaskStatus.PENDING]: [TaskStatus.ACCEPTED, TaskStatus.REJECTED, TaskStatus.CANCELLED],
  [TaskStatus.ACCEPTED]: [TaskStatus.ON_THE_WAY, TaskStatus.CANCELLED],
  [TaskStatus.ON_THE_WAY]: [TaskStatus.COMPLETED, TaskStatus.CANCELLED],
  [TaskStatus.REJECTED]: [],
  [TaskStatus.COMPLETED]: [],
  [TaskStatus.CANCELLED]: [],
}
