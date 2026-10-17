import httpStatus from 'http-status'
import type { ClientSession, QueryFilter, Types } from 'mongoose'
import {
  MAX_ACTIVE_TASKS_PER_VOLUNTEER,
  RespondAction,
  TASK_ACTIVE_STATUSES,
  TASK_OPEN_STATUSES,
  TASK_TRANSITIONS,
  TaskStatus,
} from '../../constants/task'
import { NotificationType } from '../../constants/notification'
import { AppError } from '../../errorHelpers/AppError'
import { runInTransaction } from '../../lib/transaction'
import {
  MS_PER_MINUTE,
  RESPONSE_TIME_DECIMALS,
  UNKNOWN_VOLUNTEER_NAME,
} from '../../constants/analytics'
import { Collection } from '../../constants/collections'
import { type DateRange, inRange } from '../../utils/dateRange'
import { buildMeta, getPagination } from '../../utils/pagination'
import { assertTransition } from '../../utils/transitions'
import { type SosRecord, SosService, SOS_PEOPLE_POPULATE } from '../sos/sos.service'
import { NotificationService } from '../notification/notification.service'
import { UserService } from '../user/user.service'
import type {
  ListTasksQuery,
  RateTaskPayload,
  RespondPayload,
  TaskStatusPayload,
} from './task.interface'
import { Task } from './task.model'

const TASK_NOT_FOUND_MESSAGE = 'Task not found'
const RACE_MESSAGE = 'This task changed while you were updating it. Please try again'
const CANCELLED_NOTE_PREFIX = 'SOS resolved by the victim before completion. Reason: '

// The volunteer sees the victim's phone and exact position only once they have taken the request.
const CONTACT_VISIBLE_STATUSES: readonly TaskStatus[] = [
  TaskStatus.ACCEPTED,
  TaskStatus.ON_THE_WAY,
  TaskStatus.COMPLETED,
]

interface TaskFields {
  _id: Types.ObjectId
  status: TaskStatus
  acceptedAt?: Date | null
  completedAt?: Date | null
  notes?: string | null
  isRated: boolean
  createdAt: Date
  updatedAt: Date
  sosRequest: SosRecord
}

const toTaskView = (task: TaskFields) => ({
  id: String(task._id),
  status: task.status,
  acceptedAt: task.acceptedAt ?? null,
  completedAt: task.completedAt ?? null,
  notes: task.notes ?? null,
  isRated: task.isRated,
  sosRequest: SosService.viewForTask(
    task.sosRequest,
    CONTACT_VISIBLE_STATUSES.includes(task.status),
  ),
  createdAt: task.createdAt,
  updatedAt: task.updatedAt,
})

const findTaskWithSos = (filter: QueryFilter<unknown>) =>
  Task.find(filter).populate<{ sosRequest: SosRecord }>({
    path: 'sosRequest',
    populate: SOS_PEOPLE_POPULATE,
  })

const getView = async (taskId: string) => {
  const [task] = await findTaskWithSos({ _id: taskId }).lean()
  if (!task) throw new AppError(httpStatus.NOT_FOUND, TASK_NOT_FOUND_MESSAGE)
  return toTaskView(task)
}

// The task exists and belongs to this volunteer (404 / 403 otherwise).
const loadOwnTask = async (taskId: string, volunteerId: string) => {
  const task = await Task.findById(taskId).lean()
  if (!task) throw new AppError(httpStatus.NOT_FOUND, TASK_NOT_FOUND_MESSAGE)
  if (String(task.volunteer) !== volunteerId) {
    throw new AppError(httpStatus.FORBIDDEN, 'This task belongs to another volunteer')
  }
  return task
}

// One of the volunteer's own tasks, in the same view as the list. Another volunteer's task is a 403,
// as for every other task route.
const getMyTask = async (volunteerId: string, taskId: string) => {
  await loadOwnTask(taskId, volunteerId)
  return getView(taskId)
}

const listMyTasks = async (volunteerId: string, query: ListTasksQuery) => {
  const { page, limit, status } = query
  const filter: QueryFilter<unknown> = { volunteer: volunteerId }
  if (status) filter.status = status

  const [tasks, total] = await Promise.all([
    findTaskWithSos(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip(getPagination(query).skip)
      .limit(limit)
      .lean(),
    Task.countDocuments(filter),
  ])

  return { items: tasks.map(toTaskView), meta: buildMeta({ page, limit }, total) }
}

// --- Helpers the SOS module calls while it changes a request's state ---------------------------

// Status of this volunteer's task for the request, or null when they have none.
const getStatusFor = async (sosId: string, volunteerId: string) => {
  const task = await Task.findOne({ sosRequest: sosId, volunteer: volunteerId })
    .select('status')
    .lean()
  return task?.status ?? null
}

// A soft limit: two accepts at the very same instant could both pass. It exists to stop one
// volunteer hoarding requests, not to be a security boundary.
const assertCanTakeAnotherTask = async (volunteerId: string) => {
  const active = await Task.countDocuments({
    volunteer: volunteerId,
    status: { $in: [...TASK_ACTIVE_STATUSES] },
  })
  if (active >= MAX_ACTIVE_TASKS_PER_VOLUNTEER) {
    throw new AppError(
      httpStatus.CONFLICT,
      `You already have ${MAX_ACTIVE_TASKS_PER_VOLUNTEER} active tasks. Finish one before accepting another`,
    )
  }
}

// Ids of requests this volunteer declined; they are hidden from their "nearby" list.
const listRejectedSosIds = async (volunteerId: string) => {
  const tasks = await Task.find({ volunteer: volunteerId, status: TaskStatus.REJECTED })
    .select('sosRequest')
    .lean()
  return tasks.map((task) => task.sosRequest)
}

interface TaskOwners {
  sosRequest: string
  volunteer: string
  victim: string
}

// Creates the volunteer's task as `accepted`, or turns an offered (`pending`) one into it. The
// filter allows only `pending`, so a declined task can't be silently revived (it would collide on
// the unique index instead).
const createAccepted = async (session: ClientSession, owners: TaskOwners) => {
  const { sosRequest, volunteer, victim } = owners
  const task = await Task.findOneAndUpdate(
    { sosRequest, volunteer, status: TaskStatus.PENDING },
    { $set: { status: TaskStatus.ACCEPTED, acceptedAt: new Date(), victim } },
    {
      upsert: true,
      returnDocument: 'after',
      runValidators: true,
      setDefaultsOnInsert: true,
      session,
    },
  )
  return String(task._id)
}

// Records "no thanks" so the request stops appearing for this volunteer. Idempotent.
const recordRejection = async (owners: TaskOwners) => {
  const { sosRequest, volunteer, victim } = owners
  const task = await Task.findOneAndUpdate(
    { sosRequest, volunteer, status: { $in: [TaskStatus.PENDING, TaskStatus.REJECTED] } },
    { $set: { status: TaskStatus.REJECTED, victim } },
    { upsert: true, returnDocument: 'after', runValidators: true, setDefaultsOnInsert: true },
  )
  return String(task._id)
}

// A volunteer backing out after accepting but before setting off.
const withdrawAccepted = async (session: ClientSession, sosId: string, volunteerId: string) => {
  const task = await Task.findOneAndUpdate(
    { sosRequest: sosId, volunteer: volunteerId, status: TaskStatus.ACCEPTED },
    { $set: { status: TaskStatus.REJECTED } },
    { returnDocument: 'after', session },
  )
  if (!task) throw new AppError(httpStatus.CONFLICT, RACE_MESSAGE)
  return String(task._id)
}

// The victim resolved the request: every unfinished task on it ends as cancelled.
const cancelOpenTasks = async (session: ClientSession, sosId: string, reason: string) => {
  await Task.updateMany(
    { sosRequest: sosId, status: { $in: [...TASK_OPEN_STATUSES] } },
    { $set: { status: TaskStatus.CANCELLED, notes: `${CANCELLED_NOTE_PREFIX}"${reason}"` } },
    { session },
  )
}

// --- Task routes ------------------------------------------------------------------------------

// Answer to an offered task. Nothing creates `pending` tasks yet (no allocation feature), so today
// this only ever finds tasks that are already answered and returns 409.
const respond = async (volunteerId: string, taskId: string, payload: RespondPayload) => {
  const task = await loadOwnTask(taskId, volunteerId)
  if (task.status !== TaskStatus.PENDING) {
    throw new AppError(
      httpStatus.CONFLICT,
      `This task is already ${task.status} and needs no answer`,
    )
  }

  if (payload.action === RespondAction.REJECT) {
    const rejected = await Task.findOneAndUpdate(
      { _id: taskId, volunteer: volunteerId, status: TaskStatus.PENDING },
      { $set: { status: TaskStatus.REJECTED } },
    )
    if (!rejected) throw new AppError(httpStatus.CONFLICT, RACE_MESSAGE)
    return getView(taskId)
  }

  await assertCanTakeAnotherTask(volunteerId)
  await runInTransaction(async (session) => {
    await SosService.claimForVolunteer(session, String(task.sosRequest), volunteerId)
    const accepted = await Task.findOneAndUpdate(
      { _id: taskId, volunteer: volunteerId, status: TaskStatus.PENDING },
      { $set: { status: TaskStatus.ACCEPTED, acceptedAt: new Date() } },
      { session },
    )
    if (!accepted) throw new AppError(httpStatus.CONFLICT, RACE_MESSAGE)
  })
  return getView(taskId)
}

// accepted -> on_the_way -> completed. The request moves in the same transaction, and each write is
// conditional on the state it expects, so the task and the request can't drift apart.
const updateStatus = async (volunteerId: string, taskId: string, payload: TaskStatusPayload) => {
  const { status } = payload
  const task = await loadOwnTask(taskId, volunteerId)
  assertTransition(TASK_TRANSITIONS, task.status, status, 'task')

  await runInTransaction(async (session) => {
    const moved = await Task.findOneAndUpdate(
      { _id: taskId, volunteer: volunteerId, status: task.status },
      {
        $set: {
          status,
          ...(status === TaskStatus.COMPLETED && { completedAt: new Date() }),
        },
      },
      { session },
    )
    if (!moved) throw new AppError(httpStatus.CONFLICT, RACE_MESSAGE)
    await SosService.advanceForVolunteer(session, String(task.sosRequest), volunteerId, status)
  })

  // After the commit: the victim hears about each step. Never fails the request.
  const volunteerName =
    (await UserService.getDisplayName(volunteerId).catch(() => null)) ?? 'Your volunteer'
  const finished = status === TaskStatus.COMPLETED
  await NotificationService.notifyUsers({
    userIds: [String(task.victim)],
    type: finished ? NotificationType.SOS_RESCUED : NotificationType.SOS_ON_THE_WAY,
    title: finished ? 'Your request was marked as rescued' : 'Your volunteer is on the way',
    message: finished
      ? `${volunteerName} marked your SOS request as rescued. You can now rate your volunteer.`
      : `${volunteerName} is on the way to you.`,
    sosRequestId: String(task.sosRequest),
  })
  return getView(taskId)
}

// The volunteer working (or who worked) a request, as its victim sees them: enough to show the rating
// card without a second call. `null` while nobody has taken it, or after the volunteer backed out.
const getVictimSummary = async (sosId: string, victimId: string) => {
  const task = await Task.findOne({
    sosRequest: sosId,
    victim: victimId,
    status: { $in: CONTACT_VISIBLE_STATUSES },
  })
    .sort({ createdAt: -1 })
    .lean()
  if (!task) return null
  return {
    id: String(task._id),
    status: task.status,
    isRated: task.isRated,
    canRate: task.status === TaskStatus.COMPLETED && !task.isRated,
  }
}

// The task's victim, while the task is completed and not yet rated (404 / 403 / 409 otherwise).
const loadVictimTask = async (taskId: string, victimId: string) => {
  const task = await Task.findById(taskId).lean()
  if (!task) throw new AppError(httpStatus.NOT_FOUND, TASK_NOT_FOUND_MESSAGE)
  if (String(task.victim) !== victimId) {
    throw new AppError(httpStatus.FORBIDDEN, 'You can only rate volunteers who helped you')
  }
  return task
}

const getRatingStatus = async (victimId: string, taskId: string) => {
  const task = await loadVictimTask(taskId, victimId)
  return {
    taskId,
    status: task.status,
    isRated: task.isRated,
    canRate: task.status === TaskStatus.COMPLETED && !task.isRated,
  }
}

// One rating per completed task. The task is flipped to `isRated` and the volunteer's average is
// updated in one transaction; the flip is conditional, so double-submitting rates once.
const rateTask = async (victimId: string, taskId: string, payload: RateTaskPayload) => {
  const task = await loadVictimTask(taskId, victimId)
  if (task.status !== TaskStatus.COMPLETED) {
    throw new AppError(httpStatus.CONFLICT, 'A task can only be rated once it is completed')
  }
  if (task.isRated) throw new AppError(httpStatus.CONFLICT, 'This task has already been rated')

  const volunteer = await runInTransaction(async (session) => {
    const flipped = await Task.findOneAndUpdate(
      { _id: taskId, victim: victimId, status: TaskStatus.COMPLETED, isRated: false },
      { $set: { isRated: true } },
      { session },
    )
    if (!flipped) throw new AppError(httpStatus.CONFLICT, 'This task has already been rated')

    const updated = await UserService.recordRating(String(task.volunteer), payload.score, session)
    if (!updated) throw new AppError(httpStatus.NOT_FOUND, 'Volunteer not found')
    return updated
  })

  return { taskId, isRated: true, volunteer: { id: String(task.volunteer), ...volunteer } }
}

// A task this volunteer is working on right now (accepted or on the way). Others may only be
// handed out against a live task: 404 unknown, 403 someone else's, 409 not active.
const getActiveTask = async (taskId: string, volunteerId: string) => {
  const task = await loadOwnTask(taskId, volunteerId)
  if (!TASK_ACTIVE_STATUSES.includes(task.status)) {
    throw new AppError(
      httpStatus.CONFLICT,
      `This task is ${task.status}. Items can only be handed out for an accepted or on-the-way task`,
    )
  }
  return {
    id: String(task._id),
    sosRequest: String(task.sosRequest),
    victim: String(task.victim),
  }
}

// Average minutes from a request being raised to a volunteer accepting it, over the requests raised
// in the range. A number, 0 when nothing was accepted (the old route sometimes sent a string).
const averageResponseMinutes = async (range: DateRange) => {
  const [row] = await Task.aggregate<{ averageMs: number }>([
    { $match: { acceptedAt: { $type: 'date' } } },
    {
      $lookup: {
        from: Collection.SOS_REQUESTS,
        localField: 'sosRequest',
        foreignField: '_id',
        pipeline: [{ $project: { createdAt: 1 } }],
        as: 'sos',
      },
    },
    { $unwind: '$sos' },
    { $match: inRange('sos.createdAt', range) },
    {
      $group: { _id: null, averageMs: { $avg: { $subtract: ['$acceptedAt', '$sos.createdAt'] } } },
    },
  ])
  if (!row) return 0
  const factor = 10 ** RESPONSE_TIME_DECIMALS
  return Math.round((row.averageMs / MS_PER_MINUTE) * factor) / factor
}

// Volunteers with the most completed tasks (finished within the range). A volunteer whose account
// document is gone still counts, under a placeholder name, instead of silently dropping out.
const topVolunteersByCompleted = async (range: DateRange, limit: number) => {
  const rows = await Task.aggregate<{ _id: Types.ObjectId; completedTasks: number; name: string }>([
    { $match: { status: TaskStatus.COMPLETED, ...inRange('completedAt', range) } },
    { $group: { _id: '$volunteer', completedTasks: { $sum: 1 } } },
    { $sort: { completedTasks: -1, _id: 1 } },
    { $limit: limit },
    {
      $lookup: {
        from: Collection.USERS,
        localField: '_id',
        foreignField: '_id',
        pipeline: [{ $project: { name: 1 } }],
        as: 'user',
      },
    },
    {
      $project: {
        completedTasks: 1,
        name: { $ifNull: [{ $first: '$user.name' }, UNKNOWN_VOLUNTEER_NAME] },
      },
    },
  ])
  return rows.map((row) => ({
    _id: String(row._id),
    completedTasks: row.completedTasks,
    name: row.name,
  }))
}

export const TaskService = {
  averageResponseMinutes,
  topVolunteersByCompleted,
  getActiveTask,
  getMyTask,
  listMyTasks,
  respond,
  updateStatus,
  getRatingStatus,
  getVictimSummary,
  rateTask,
  getView,
  getStatusFor,
  assertCanTakeAnotherTask,
  listRejectedSosIds,
  createAccepted,
  recordRejection,
  withdrawAccepted,
  cancelOpenTasks,
}
