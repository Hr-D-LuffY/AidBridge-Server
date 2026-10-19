import httpStatus from 'http-status'
import type { ClientSession, QueryFilter, Types } from 'mongoose'
import { type OfferSource, SosEventType } from '../../constants/dispatch'
import {
  MAX_ACTIVE_TASKS_PER_VOLUNTEER,
  OFFER_TAKEN_NOTE,
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
import { SosEventService } from '../sos-event/sos-event.service'
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
const OFFER_EXPIRED_MESSAGE = 'This offer has expired'
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
  offeredAt?: Date | null
  offerExpiresAt?: Date | null
  offerSource?: OfferSource | null
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
  // Present when the task started as an offer. A pending task with an offer is waiting for an answer
  // until `expiresAt`; after that it is `expired`.
  offer: task.offerExpiresAt
    ? {
        source: task.offerSource ?? null,
        offeredAt: task.offeredAt ?? null,
        expiresAt: task.offerExpiresAt,
      }
    : null,
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

// Creates the volunteer's task as `accepted`, or turns an offered (`pending`) one into it. An offer
// that ran out (`expired`) can still be taken: the volunteer is choosing it themselves from their
// nearby list, which an expired offer never hides. The filter allows nothing else, so a declined task
// can't be silently revived (it would collide on the unique index instead).
const createAccepted = async (session: ClientSession, owners: TaskOwners) => {
  const { sosRequest, volunteer, victim } = owners
  const task = await Task.findOneAndUpdate(
    { sosRequest, volunteer, status: { $in: [TaskStatus.PENDING, TaskStatus.EXPIRED] } },
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

// Records "no thanks" so the request stops appearing for this volunteer. Idempotent. A volunteer whose
// offer ran out can still say no to it themselves.
const recordRejection = async (owners: TaskOwners) => {
  const { sosRequest, volunteer, victim } = owners
  const task = await Task.findOneAndUpdate(
    {
      sosRequest,
      volunteer,
      status: { $in: [TaskStatus.PENDING, TaskStatus.REJECTED, TaskStatus.EXPIRED] },
    },
    { $set: { status: TaskStatus.REJECTED, victim } },
    { upsert: true, returnDocument: 'after', runValidators: true, setDefaultsOnInsert: true },
  )
  return String(task._id)
}

// A volunteer backing out after accepting but before setting off.
const withdrawAccepted = async (
  session: ClientSession,
  sosId: string,
  volunteerId: string,
  note?: string,
) => {
  const task = await Task.findOneAndUpdate(
    { sosRequest: sosId, volunteer: volunteerId, status: TaskStatus.ACCEPTED },
    { $set: { status: TaskStatus.REJECTED, ...(note && { notes: note }) } },
    { returnDocument: 'after', session },
  )
  if (!task) throw new AppError(httpStatus.CONFLICT, RACE_MESSAGE)
  return String(task._id)
}

// The victim resolved the request: every unfinished task on it ends as cancelled. Answers who held
// them (the volunteer who accepted, and everyone with an open offer) so the caller can tell them.
const cancelOpenTasks = async (session: ClientSession, sosId: string, reason: string) => {
  const filter = { sosRequest: sosId, status: { $in: [...TASK_OPEN_STATUSES] } }
  const open = await Task.find(filter).select('volunteer').session(session).lean()
  await Task.updateMany(
    filter,
    { $set: { status: TaskStatus.CANCELLED, notes: `${CANCELLED_NOTE_PREFIX}"${reason}"` } },
    { session },
  )
  return open.map((task) => String(task.volunteer))
}

// --- Offers (dispatch, commit 15) ---------------------------------------------------------------
// An offer is a `pending` task with an expiry. The unique (request, volunteer) index means a volunteer
// is offered a request at most once, whatever happened to the earlier offer.

interface OfferInput {
  sosRequest: string
  victim: string
  volunteerIds: string[]
  offeredAt: Date
  expiresAt: Date
  source: OfferSource
}

// Creates the offers and answers the ids that were really created: a volunteer who already has a task
// on this request is skipped without error.
const createOffers = async (input: OfferInput) => {
  const { sosRequest, victim, volunteerIds, offeredAt, expiresAt, source } = input
  const created: string[] = []
  for (const volunteer of volunteerIds) {
    const result = await Task.updateOne(
      { sosRequest, volunteer },
      {
        $setOnInsert: {
          victim,
          status: TaskStatus.PENDING,
          offeredAt,
          offerExpiresAt: expiresAt,
          offerSource: source,
        },
      },
      { upsert: true },
    )
    if (result.upsertedCount > 0) created.push(volunteer)
  }
  return created
}

// Everyone who already has a task (any status) on the request: they are never offered it again.
const listVolunteerIdsWithTask = async (sosId: string) => {
  const tasks = await Task.find({ sosRequest: sosId }).select('volunteer').lean()
  return tasks.map((task) => task.volunteer)
}

// Open tasks per volunteer for these volunteers (the load part of the dispatch score).
const countActiveByVolunteer = async (volunteerIds: Types.ObjectId[]) => {
  const rows = await Task.aggregate<{ _id: Types.ObjectId; count: number }>([
    { $match: { volunteer: { $in: volunteerIds }, status: { $in: [...TASK_ACTIVE_STATUSES] } } },
    { $group: { _id: '$volunteer', count: { $sum: 1 } } },
  ])
  return new Map(rows.map((row) => [String(row._id), row.count]))
}

// When the last still-open offer on the request runs out, or null when none is open.
const getLiveOffersExpiry = async (sosId: string, now: Date) => {
  const latest = await Task.findOne({
    sosRequest: sosId,
    status: TaskStatus.PENDING,
    offerExpiresAt: { $gt: now },
  })
    .sort({ offerExpiresAt: -1 })
    .select('offerExpiresAt')
    .lean()
  return latest?.offerExpiresAt ?? null
}

// Offers on this request that are still open (not past their time).
const countLiveOffers = (sosId: string, now: Date) =>
  Task.countDocuments({
    sosRequest: sosId,
    status: TaskStatus.PENDING,
    offerExpiresAt: { $gt: now },
  })

// Another volunteer took the request, so the offers still out for it are withdrawn. Runs inside the
// accepting transaction, so no offer can outlive the claim. Answers who to tell.
const cancelOtherOffers = async (
  session: ClientSession,
  sosId: string,
  exceptVolunteerId: string,
) => {
  const filter = {
    sosRequest: sosId,
    volunteer: { $ne: exceptVolunteerId },
    status: TaskStatus.PENDING,
  }
  const offers = await Task.find(filter).select('volunteer').session(session).lean()
  if (offers.length === 0) return []
  await Task.updateMany(
    filter,
    { $set: { status: TaskStatus.CANCELLED, notes: OFFER_TAKEN_NOTE } },
    { session },
  )
  return offers.map((offer) => String(offer.volunteer))
}

interface TaskRef {
  id: string
  sosRequest: string
  volunteer: string
}

// Offers whose time is up and nobody answered, oldest first.
const listDueOffers = async (now: Date, limit: number): Promise<TaskRef[]> => {
  const tasks = await Task.find({ status: TaskStatus.PENDING, offerExpiresAt: { $lte: now } })
    .sort({ offerExpiresAt: 1 })
    .limit(limit)
    .select('sosRequest volunteer')
    .lean()
  return tasks.map((task) => ({
    id: String(task._id),
    sosRequest: String(task.sosRequest),
    volunteer: String(task.volunteer),
  }))
}

// pending -> expired (or cancelled, when the request no longer needs it), only if it is still pending
// and still past its time: of the expiry job and the volunteer answering at the same moment, exactly
// one wins. True when this call is the one that changed it.
const closeDueOffer = async (taskId: string, now: Date, to: 'expired' | 'cancelled') => {
  const closed = await Task.findOneAndUpdate(
    { _id: taskId, status: TaskStatus.PENDING, offerExpiresAt: { $lte: now } },
    {
      $set:
        to === 'expired'
          ? { status: TaskStatus.EXPIRED }
          : { status: TaskStatus.CANCELLED, notes: OFFER_TAKEN_NOTE },
    },
  )
  return closed !== null
}

// A just-made offer that the request no longer needs (someone took it in the meantime).
const cancelOffers = async (sosId: string, volunteerIds: string[]) => {
  await Task.updateMany(
    { sosRequest: sosId, volunteer: { $in: volunteerIds }, status: TaskStatus.PENDING },
    { $set: { status: TaskStatus.CANCELLED, notes: OFFER_TAKEN_NOTE } },
  )
}

interface AcceptedRef extends TaskRef {
  victim: string
  acceptedAt: Date
}

// Accepted tasks that have waited at least until `cutoff` without setting off, oldest first.
const listAcceptedBefore = async (cutoff: Date, limit: number): Promise<AcceptedRef[]> => {
  const tasks = await Task.find({ status: TaskStatus.ACCEPTED, acceptedAt: { $lte: cutoff } })
    .sort({ acceptedAt: 1 })
    .limit(limit)
    .select('sosRequest volunteer victim acceptedAt')
    .lean()
  return tasks.flatMap((task) =>
    task.acceptedAt
      ? [
          {
            id: String(task._id),
            sosRequest: String(task.sosRequest),
            volunteer: String(task.volunteer),
            victim: String(task.victim),
            acceptedAt: task.acceptedAt,
          },
        ]
      : [],
  )
}

// A volunteer said no to an offer: it goes on the timeline, and if nobody else is still being asked the
// engine is told to widen the search now instead of waiting out the rest of the window.
const afterOfferDeclined = async (sosId: string, volunteerId: string, now: Date) => {
  await SosEventService.record({
    sos: sosId,
    type: SosEventType.DECLINED,
    actorId: volunteerId,
    subjectId: volunteerId,
  })
  if ((await countLiveOffers(sosId, now)) === 0) await SosService.scheduleDispatchNow(sosId)
}

// Whether the volunteer has a part in the request: an open offer, or a task they took on. Declined and
// expired offers do not count. Decides who may read its timeline.
const hasInvolvement = async (sosId: string, volunteerId: string) => {
  const task = await Task.exists({
    sosRequest: sosId,
    volunteer: volunteerId,
    status: {
      $in: [TaskStatus.PENDING, TaskStatus.ACCEPTED, TaskStatus.ON_THE_WAY, TaskStatus.COMPLETED],
    },
  })
  return task !== null
}

// --- Task routes ------------------------------------------------------------------------------

// Answer to an offer (a `pending` task made by dispatch or an admin). An offer past its time is a 409,
// and the same condition sits in the update, so answering at the very moment it expires cannot succeed
// twice. Accepting also withdraws the offers still out to other volunteers, in the same transaction.
const respond = async (volunteerId: string, taskId: string, payload: RespondPayload) => {
  const task = await loadOwnTask(taskId, volunteerId)
  if (task.status !== TaskStatus.PENDING) {
    throw new AppError(
      httpStatus.CONFLICT,
      `This task is already ${task.status} and needs no answer`,
    )
  }
  const now = new Date()
  if (task.offerExpiresAt && task.offerExpiresAt <= now) {
    throw new AppError(httpStatus.CONFLICT, OFFER_EXPIRED_MESSAGE)
  }
  const sosId = String(task.sosRequest)
  const stillOpen = {
    _id: taskId,
    volunteer: volunteerId,
    status: TaskStatus.PENDING,
    $or: [{ offerExpiresAt: null }, { offerExpiresAt: { $gt: now } }],
  }

  if (payload.action === RespondAction.REJECT) {
    const rejected = await Task.findOneAndUpdate(stillOpen, {
      $set: { status: TaskStatus.REJECTED },
    })
    if (!rejected) throw new AppError(httpStatus.CONFLICT, RACE_MESSAGE)

    await afterOfferDeclined(sosId, volunteerId, now)
    return getView(taskId)
  }

  await assertCanTakeAnotherTask(volunteerId)
  const withdrawn = await runInTransaction(async (session) => {
    await SosService.claimForVolunteer(session, sosId, volunteerId)
    const accepted = await Task.findOneAndUpdate(
      stillOpen,
      { $set: { status: TaskStatus.ACCEPTED, acceptedAt: now } },
      { session },
    )
    if (!accepted) throw new AppError(httpStatus.CONFLICT, RACE_MESSAGE)
    return cancelOtherOffers(session, sosId, volunteerId)
  })

  await SosService.announceAcceptance({
    sosId,
    victimId: String(task.victim),
    volunteerId,
    volunteerName: (await UserService.getDisplayName(volunteerId).catch(() => null)) ?? undefined,
    withdrawnVolunteerIds: withdrawn,
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
  await SosEventService.record({
    sos: String(task.sosRequest),
    type: finished ? SosEventType.COMPLETED : SosEventType.ON_THE_WAY,
    actorId: volunteerId,
    subjectId: volunteerId,
  })
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
  cancelOtherOffers,
  createOffers,
  listVolunteerIdsWithTask,
  countActiveByVolunteer,
  getLiveOffersExpiry,
  listDueOffers,
  closeDueOffer,
  cancelOffers,
  listAcceptedBefore,
  afterOfferDeclined,
  hasInvolvement,
}
