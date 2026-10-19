import httpStatus from 'http-status'
import mongoose, { type ClientSession, type QueryFilter, type Types } from 'mongoose'
import { AuditAction, AuditTargetType } from '../../constants/audit'
import {
  DEFAULT_DISPATCH_SETTINGS,
  DISPATCH_SETTINGS_KEY,
  type OfferSource,
  ProofMode,
  SosEventType,
} from '../../constants/dispatch'
import { MediaType } from '../../constants/sos'
import {
  MAX_ACTIVE_TASKS_PER_VOLUNTEER,
  MAX_PROOF_ATTEMPTS,
  MAX_TASK_NOTES_LENGTH,
  OFFER_TAKEN_NOTE,
  PROOF_MEDIA_FOLDER,
  PROOF_PHOTO_FORMATS,
  ProofKind,
  RespondAction,
  TASK_ACTIVE_STATUSES,
  TASK_OPEN_STATUSES,
  TASK_TRANSITIONS,
  type TaskProgressStatus,
  TaskStatus,
} from '../../constants/task'
import { NotificationType } from '../../constants/notification'
import { AppError } from '../../errorHelpers/AppError'
import { assertMediaStorageConfigured, deleteMedia, uploadMediaBuffer } from '../../lib/cloudinary'
import { arrivalCode, codeMatches } from '../../lib/proof'
import { runInTransaction } from '../../lib/transaction'
import {
  MS_PER_MINUTE,
  RESPONSE_TIME_DECIMALS,
  UNKNOWN_VOLUNTEER_NAME,
} from '../../constants/analytics'
import { Collection } from '../../constants/collections'
import { type DateRange, inRange } from '../../utils/dateRange'
import type { TokenPayload } from '../../utils/jwt'
import { buildMeta, getPagination } from '../../utils/pagination'
import { assertTransition } from '../../utils/transitions'
import { AuditService } from '../audit/audit.service'
import { DispatchSettings } from '../dispatch/dispatch.model'
import { type SosRecord, SosService, SOS_PEOPLE_POPULATE } from '../sos/sos.service'
import { NotificationService } from '../notification/notification.service'
import { SosEventService } from '../sos-event/sos-event.service'
import { UserService } from '../user/user.service'
import type {
  ListTasksQuery,
  OverrideCompletePayload,
  RateTaskPayload,
  RespondPayload,
  TaskStatusPayload,
} from './task.interface'
import { Task } from './task.model'

const TASK_NOT_FOUND_MESSAGE = 'Task not found'
const RACE_MESSAGE = 'This task changed while you were updating it. Please try again'
const OFFER_EXPIRED_MESSAGE = 'This offer has expired'
const CANCELLED_NOTE_PREFIX = 'SOS resolved by the victim before completion. Reason: '
const PROOF_REQUIRED_MESSAGE =
  'Proof of delivery is required. Enter the arrival code the victim shows you, or upload a photo'
const PROOF_LOCKED_MESSAGE =
  'Too many wrong codes for this task. Upload a photo instead, or ask an admin to complete it'
const PROOF_UPLOAD_FAILED_MESSAGE = 'Uploading the photo failed. Please try again'

// The volunteer sees the victim's phone and exact position only once they have taken the request.
const CONTACT_VISIBLE_STATUSES: readonly TaskStatus[] = [
  TaskStatus.ACCEPTED,
  TaskStatus.ON_THE_WAY,
  TaskStatus.COMPLETED,
]

interface ProofFields {
  kind?: ProofKind | null
  at?: Date | null
  mediaUrl?: string | null
  mediaPublicId?: string | null
  by?: Types.ObjectId | null
  reason?: string | null
}

interface ProofState {
  proofRequired?: boolean | null
  proofAttempts?: number | null
  proof?: ProofFields | null
}

interface TaskFields extends ProofState {
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

// Proof of delivery as the volunteer sees it. `attemptsLeft` is how many wrong arrival codes they may still
// enter (0: the code is locked for this task, a photo is the way); null when the task needs no proof.
const toProofView = (task: ProofState) => ({
  required: task.proofRequired ?? false,
  attemptsLeft: task.proofRequired
    ? Math.max(0, MAX_PROOF_ATTEMPTS - (task.proofAttempts ?? 0))
    : null,
  submitted: task.proof?.kind
    ? {
        kind: task.proof.kind,
        at: task.proof.at ?? null,
        mediaUrl: task.proof.kind === ProofKind.PHOTO ? (task.proof.mediaUrl ?? null) : null,
      }
    : null,
})

// What an admin or NGO sees: the same, plus who overrode and why.
const toStaffProofView = (task: ProofState) => {
  const view = toProofView(task)
  return {
    ...view,
    submitted: view.submitted && {
      ...view.submitted,
      overriddenBy: task.proof?.by ? String(task.proof.by) : null,
      overrideReason: task.proof?.reason ?? null,
    },
  }
}

const toTaskView = (task: TaskFields) => ({
  id: String(task._id),
  status: task.status,
  acceptedAt: task.acceptedAt ?? null,
  completedAt: task.completedAt ?? null,
  notes: task.notes ?? null,
  isRated: task.isRated,
  proof: toProofView(task),
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

// Whether a task created now has to be finished with proof of delivery. Read from the setting at that
// moment and stored on the task, so switching the setting later never changes a task already under way.
const isProofRequiredNow = async () => {
  const settings = await DispatchSettings.findOne({ key: DISPATCH_SETTINGS_KEY })
    .select('proofMode')
    .lean()
  return (settings?.proofMode ?? DEFAULT_DISPATCH_SETTINGS.proofMode) !== ProofMode.OFF
}

// Creates the volunteer's task as `accepted`, or turns an offered (`pending`) one into it. An offer
// that ran out (`expired`) can still be taken: the volunteer is choosing it themselves from their
// nearby list, which an expired offer never hides. The filter allows nothing else, so a declined task
// can't be silently revived (it would collide on the unique index instead). A task made here from
// scratch decides on proof of delivery; one that began as an offer decided when it was offered.
const createAccepted = async (session: ClientSession, owners: TaskOwners) => {
  const { sosRequest, volunteer, victim } = owners
  const proofRequired = await isProofRequiredNow()
  const task = await Task.findOneAndUpdate(
    { sosRequest, volunteer, status: { $in: [TaskStatus.PENDING, TaskStatus.EXPIRED] } },
    {
      $set: { status: TaskStatus.ACCEPTED, acceptedAt: new Date(), victim },
      $setOnInsert: { proofRequired },
    },
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
const cancelOpenTasks = async (
  session: ClientSession,
  sosId: string,
  reason: string,
  notePrefix = CANCELLED_NOTE_PREFIX,
) => {
  const filter = { sosRequest: sosId, status: { $in: [...TASK_OPEN_STATUSES] } }
  const open = await Task.find(filter).select('volunteer').session(session).lean()
  await Task.updateMany(
    filter,
    {
      $set: {
        status: TaskStatus.CANCELLED,
        notes: `${notePrefix}"${reason}"`.slice(0, MAX_TASK_NOTES_LENGTH),
      },
    },
    { session },
  )
  return open.map((task) => String(task.volunteer))
}

// --- Offers (dispatch, commit 20) ---------------------------------------------------------------
// An offer is a `pending` task with an expiry. The unique (request, volunteer) index means a volunteer
// is offered a request at most once, whatever happened to the earlier offer.

interface OfferInput {
  sosRequest: string
  victim: string
  volunteerIds: string[]
  offeredAt: Date
  expiresAt: Date
  source: OfferSource
  // An admin may re-offer to a volunteer whose earlier offer ran out; the engine never does.
  reopenExpired?: boolean
}

// Creates the offers and answers the ids that were really created: a volunteer who already has a task
// on this request is skipped without error.
const createOffers = async (input: OfferInput) => {
  const { sosRequest, victim, volunteerIds, offeredAt, expiresAt, source, reopenExpired } = input
  const created: string[] = []
  const proofRequired = await isProofRequiredNow()
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
          proofRequired,
        },
      },
      { upsert: true },
    )
    if (result.upsertedCount > 0) {
      created.push(volunteer)
      continue
    }
    if (!reopenExpired) continue
    const reopened = await Task.updateOne(
      { sosRequest, volunteer, status: TaskStatus.EXPIRED },
      {
        $set: {
          status: TaskStatus.PENDING,
          offeredAt,
          offerExpiresAt: expiresAt,
          offerSource: source,
        },
      },
    )
    if (reopened.modifiedCount > 0) created.push(volunteer)
  }
  return created
}

// An admin takes the request off its volunteer: their live task (accepted or on the way) is cancelled,
// inside the caller's transaction. 409 when they no longer hold one.
const cancelActiveTask = async (
  session: ClientSession,
  sosId: string,
  volunteerId: string,
  note: string,
) => {
  const task = await Task.findOneAndUpdate(
    {
      sosRequest: sosId,
      volunteer: volunteerId,
      status: { $in: [...TASK_ACTIVE_STATUSES] },
    },
    { $set: { status: TaskStatus.CANCELLED, notes: note } },
    { session },
  )
  if (!task) throw new AppError(httpStatus.CONFLICT, RACE_MESSAGE)
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

// How many offers are still open on each of these requests (for the dispatch board).
const countLiveOffersBySos = async (sosIds: string[], now: Date) => {
  if (sosIds.length === 0) return new Map<string, number>()
  const rows = await Task.aggregate<{ _id: Types.ObjectId; count: number }>([
    {
      $match: {
        sosRequest: { $in: sosIds.map((id) => new mongoose.Types.ObjectId(id)) },
        status: TaskStatus.PENDING,
        offerExpiresAt: { $gt: now },
      },
    },
    { $group: { _id: '$sosRequest', count: { $sum: 1 } } },
  ])
  return new Map(rows.map((row) => [String(row._id), row.count]))
}

// The live task (accepted or on the way) on each of these requests, for the dispatch board.
const listActiveBySos = async (sosIds: string[]) => {
  if (sosIds.length === 0) return new Map<string, { volunteer: string; acceptedAt: Date | null }>()
  const tasks = await Task.find({
    sosRequest: { $in: sosIds },
    status: { $in: [...TASK_ACTIVE_STATUSES] },
  })
    .select('sosRequest volunteer acceptedAt')
    .lean()
  return new Map(
    tasks.map((task) => [
      String(task.sosRequest),
      { volunteer: String(task.volunteer), acceptedAt: task.acceptedAt ?? null },
    ]),
  )
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

interface MovableTask {
  _id: Types.ObjectId
  sosRequest: Types.ObjectId
  volunteer: Types.ObjectId
  status: TaskStatus
}

// The task and its request move one step together, in one transaction. The write is conditional on the
// state it expects, so the task and the request can't drift apart. `extra` is set in the same write.
const moveTask = (task: MovableTask, status: TaskProgressStatus, extra: Record<string, unknown>) =>
  runInTransaction(async (session) => {
    const moved = await Task.findOneAndUpdate(
      { _id: task._id, volunteer: task.volunteer, status: task.status },
      {
        $set: {
          status,
          ...(status === TaskStatus.COMPLETED && { completedAt: new Date() }),
          ...extra,
        },
      },
      { session, runValidators: true },
    )
    if (!moved) throw new AppError(httpStatus.CONFLICT, RACE_MESSAGE)
    await SosService.advanceForVolunteer(
      session,
      String(task.sosRequest),
      String(task.volunteer),
      status,
    )
  })

interface ProgressDetails {
  // How a completion was shown (goes on the timeline).
  proof?: ProofKind | null
  // Set when an admin, not the volunteer, made the step.
  adminId?: string
}

interface AnnouncedTask {
  sosRequest: Types.ObjectId
  victim: Types.ObjectId
  volunteer: Types.ObjectId
  proofRequired?: boolean | null
}

// After the commit: the timeline records the step and the victim hears about it. Never fails the request.
const announceProgress = async (
  task: AnnouncedTask,
  status: TaskProgressStatus,
  details: ProgressDetails = {},
) => {
  const volunteerId = String(task.volunteer)
  const volunteerName =
    (await UserService.getDisplayName(volunteerId).catch(() => null)) ?? 'Your volunteer'
  const finished = status === TaskStatus.COMPLETED
  await SosEventService.record({
    sos: String(task.sosRequest),
    type: finished ? SosEventType.COMPLETED : SosEventType.ON_THE_WAY,
    actorId: details.adminId ?? volunteerId,
    subjectId: volunteerId,
    ...(finished && details.proof && { meta: { proof: details.proof } }),
  })
  // The arrival code itself is never put in a notification (it can be read from lock screens and email);
  // the victim is only told where to find it.
  const onTheWay = task.proofRequired
    ? `${volunteerName} is on the way to you. When they arrive they will ask for the arrival code shown on your request in the app.`
    : `${volunteerName} is on the way to you.`
  await NotificationService.notifyUsers({
    userIds: [String(task.victim)],
    type: finished ? NotificationType.SOS_RESCUED : NotificationType.SOS_ON_THE_WAY,
    title: finished ? 'Your request was marked as rescued' : 'Your volunteer is on the way',
    message: finished
      ? `${details.adminId ? 'An admin' : volunteerName} marked your SOS request as rescued. You can now rate your volunteer.`
      : onTheWay,
    sosRequestId: String(task.sosRequest),
  })
}

type OwnTask = Awaited<ReturnType<typeof loadOwnTask>>

// What finishing this task has to be backed with: null when it needs no proof, else the kind that was shown.
// A photo already stored counts and the code is not looked at. A code costs one try before it is compared,
// taken with a conditional update, so guesses sent at the very same moment still get five tries in all.
const checkProof = async (task: OwnTask, code: string | undefined): Promise<ProofKind | null> => {
  if (!task.proofRequired) return null
  if (task.proof?.kind === ProofKind.PHOTO) return ProofKind.PHOTO
  if (!code) throw new AppError(httpStatus.BAD_REQUEST, PROOF_REQUIRED_MESSAGE)

  const reserved = await Task.findOneAndUpdate(
    { _id: task._id, proofAttempts: { $not: { $gte: MAX_PROOF_ATTEMPTS } } },
    { $inc: { proofAttempts: 1 } },
    { returnDocument: 'after' },
  )
    .select('proofAttempts')
    .lean()
  if (!reserved) throw new AppError(httpStatus.CONFLICT, PROOF_LOCKED_MESSAGE)

  if (!codeMatches(arrivalCode(String(task.sosRequest), String(task._id)), code)) {
    const left = Math.max(0, MAX_PROOF_ATTEMPTS - (reserved.proofAttempts ?? 0))
    throw new AppError(
      httpStatus.BAD_REQUEST,
      left > 0
        ? `That code is not right. ${left} ${left === 1 ? 'try' : 'tries'} left`
        : 'That code is not right, and the code is now locked for this task. Upload a photo instead, or ask an admin to complete it',
    )
  }
  return ProofKind.CODE
}

// accepted -> on_the_way -> completed. Completing a task that needs proof takes the victim's arrival code
// or a photo uploaded earlier (`addProofPhoto`); the proof is stored with the completion itself.
const updateStatus = async (volunteerId: string, taskId: string, payload: TaskStatusPayload) => {
  const { status, proof } = payload
  const task = await loadOwnTask(taskId, volunteerId)
  assertTransition(TASK_TRANSITIONS, task.status, status, 'task')

  const finished = status === TaskStatus.COMPLETED
  const proofKind = finished ? await checkProof(task, proof?.code) : null
  // A photo is already on the task; a code is written now.
  const stored = proofKind === ProofKind.CODE ? { proof: { kind: proofKind, at: new Date() } } : {}
  await moveTask(task, status, stored)
  await announceProgress(task, status, { proof: proofKind })
  return getView(taskId)
}

// The volunteer's photo of arrival, replacing an earlier one. It does not complete the task: it makes the
// completion possible without the code, so the volunteer still presses "completed".
const addProofPhoto = async (
  volunteerId: string,
  taskId: string,
  file: Express.Multer.File | undefined,
) => {
  if (!file) throw new AppError(httpStatus.BAD_REQUEST, 'Attach one image in the "media" field')
  assertMediaStorageConfigured()

  const task = await loadOwnTask(taskId, volunteerId)
  if (task.status !== TaskStatus.ON_THE_WAY) {
    throw new AppError(
      httpStatus.CONFLICT,
      `A proof photo can only be added while you are on the way, and this task is ${task.status}`,
    )
  }
  if (!task.proofRequired) {
    throw new AppError(httpStatus.CONFLICT, 'This task does not need proof of delivery')
  }

  const uploaded = await uploadMediaBuffer(
    file.buffer,
    PROOF_MEDIA_FOLDER,
    Object.values(PROOF_PHOTO_FORMATS),
  ).catch((error: unknown) => {
    console.error('Proof photo upload failed:', error)
    throw new AppError(httpStatus.BAD_GATEWAY, PROOF_UPLOAD_FAILED_MESSAGE)
  })

  // The write hands back the task as it was, which is where the photo being replaced is found.
  const before = await Task.findOneAndUpdate(
    { _id: taskId, volunteer: volunteerId, status: TaskStatus.ON_THE_WAY, proofRequired: true },
    {
      $set: {
        proof: {
          kind: ProofKind.PHOTO,
          at: new Date(),
          mediaUrl: uploaded.url,
          mediaPublicId: uploaded.publicId,
        },
      },
    },
    { runValidators: true },
  )
    .select('proof')
    .lean()
  if (!before) {
    await deleteMedia(uploaded)
    throw new AppError(httpStatus.CONFLICT, RACE_MESSAGE)
  }

  // Only once the task no longer points at the old file: a failed delete leaves an orphan, not a broken link.
  if (before.proof?.mediaPublicId) {
    await deleteMedia({ publicId: before.proof.mediaPublicId, resourceType: MediaType.IMAGE })
  }
  return getView(taskId)
}

// An admin completes a task whose volunteer is on the way, with no code or photo: the victim has no phone,
// or the app failed at the door. The reason stays on the task; the audit log only says it happened.
const overrideComplete = async (
  admin: TokenPayload,
  taskId: string,
  payload: OverrideCompletePayload,
) => {
  const task = await Task.findById(taskId).lean()
  if (!task) throw new AppError(httpStatus.NOT_FOUND, TASK_NOT_FOUND_MESSAGE)
  if (task.status !== TaskStatus.ON_THE_WAY) {
    throw new AppError(
      httpStatus.CONFLICT,
      `This task is ${task.status}. An admin can only complete a task whose volunteer is on the way`,
    )
  }

  await moveTask(task, TaskStatus.COMPLETED, {
    proof: { kind: ProofKind.ADMIN, at: new Date(), by: admin.id, reason: payload.reason },
  })
  await announceProgress(task, TaskStatus.COMPLETED, { proof: ProofKind.ADMIN, adminId: admin.id })
  await NotificationService.notifyUsers({
    userIds: [String(task.volunteer)],
    type: NotificationType.TASK_COMPLETED_BY_ADMIN,
    title: 'An admin completed your task',
    message: 'An admin marked one of your tasks as completed.',
    sosRequestId: String(task.sosRequest),
  })
  await AuditService.record({
    actor: admin,
    action: AuditAction.TASK_COMPLETED_BY_ADMIN,
    targetType: AuditTargetType.SOS_REQUEST,
    targetId: String(task.sosRequest),
    // The reason may hold names or numbers, so it stays on the task and never goes in the audit log.
    summary: 'Completed a task without an arrival code or photo',
    meta: { taskId, volunteerId: String(task.volunteer) },
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
    // The victim shows this to the volunteer on arrival. It exists only while the volunteer is on the way
    // and the task needs proof, and nobody but the victim is ever sent it.
    arrivalCode:
      task.status === TaskStatus.ON_THE_WAY && task.proofRequired
        ? arrivalCode(String(task.sosRequest), String(task._id))
        : null,
  }
}

// The volunteer who is working (or worked) a request, as an admin or NGO sees them, with how the task was
// shown to be finished. `null` while nobody holds it.
const getStaffSummary = async (sosId: string) => {
  const task = await Task.findOne({
    sosRequest: sosId,
    status: { $in: [...TASK_ACTIVE_STATUSES, TaskStatus.COMPLETED] },
  })
    .sort({ createdAt: -1 })
    .lean()
  if (!task) return null
  return {
    id: String(task._id),
    status: task.status,
    volunteer: {
      id: String(task.volunteer),
      name: (await UserService.getDisplayName(String(task.volunteer)).catch(() => null)) ?? null,
    },
    acceptedAt: task.acceptedAt ?? null,
    completedAt: task.completedAt ?? null,
    proof: toStaffProofView(task),
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
  addProofPhoto,
  overrideComplete,
  getRatingStatus,
  getVictimSummary,
  getStaffSummary,
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
  cancelActiveTask,
  createOffers,
  listVolunteerIdsWithTask,
  countActiveByVolunteer,
  getLiveOffersExpiry,
  listDueOffers,
  closeDueOffer,
  cancelOffers,
  listAcceptedBefore,
  afterOfferDeclined,
  countLiveOffersBySos,
  listActiveBySos,
  hasInvolvement,
}
