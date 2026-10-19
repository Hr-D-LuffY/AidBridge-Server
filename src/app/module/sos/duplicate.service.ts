import httpStatus from 'http-status'
import type { ClientSession, Types } from 'mongoose'
import { AuditAction, AuditTargetType } from '../../constants/audit'
import { SosEventType } from '../../constants/dispatch'
import { NotificationType } from '../../constants/notification'
import {
  DUPLICATE_RADIUS_METERS,
  MAX_DUPLICATE_LINKS,
  ResolvedBy,
  ResolveKind,
  SOS_FINISHED_STATUSES,
  SosStatus,
} from '../../constants/sos'
import { MERGED_NOTE_PREFIX } from '../../constants/task'
import { AppError } from '../../errorHelpers/AppError'
import { type Coordinates, distanceMeters, geoNearStage } from '../../lib/geo'
import { runInTransaction } from '../../lib/transaction'
import type { TokenPayload } from '../../utils/jwt'
import { AuditService } from '../audit/audit.service'
import { NotificationService } from '../notification/notification.service'
import { SosEventService } from '../sos-event/sos-event.service'
import { TaskService } from '../task/task.service'
import { approximateDistance, minutesBetween, moreUrgent, windowStart } from './duplicate.rules'
import type { MergeSosPayload } from './sos.interface'
import { SosRequest } from './sos.model'
import { SosService } from './sos.service'

const NOT_FOUND_MESSAGE = 'SOS request not found'
const RACE_MESSAGE = 'This SOS request changed while you were updating it. Please try again'
const DISTANCE_FIELD = 'distanceMeters'

const isFinished = (status: SosStatus) => SOS_FINISHED_STATUSES.includes(status)

interface NewRequest {
  _id: Types.ObjectId
  victim: Types.ObjectId
  createdAt: Date
  location: { coordinates: number[] }
}

// Called right after a request is created: finds open requests from other victims close by and recent, and
// links both ways. It is only a hint for an admin. It never blocks the request, never changes its priority
// or its place in the dispatch queue (dispatch does not read the link), and a failure here is logged and
// swallowed: the victim's request is already saved.
const detectFor = async (created: NewRequest) => {
  try {
    const [lng, lat] = created.location.coordinates as Coordinates
    const near = await SosRequest.aggregate<{ _id: Types.ObjectId }>([
      geoNearStage(
        { lng, lat, radius: DUPLICATE_RADIUS_METERS },
        {
          _id: { $ne: created._id },
          victim: { $ne: created.victim },
          status: { $nin: [...SOS_FINISHED_STATUSES] },
          createdAt: { $gte: windowStart(created.createdAt) },
        },
        DISTANCE_FIELD,
      ),
      { $limit: MAX_DUPLICATE_LINKS },
      { $project: { _id: 1 } },
    ])
    if (near.length === 0) return

    const ids = near.map((row) => row._id)
    await SosRequest.updateOne(
      { _id: created._id },
      { $addToSet: { possibleDuplicateOf: { $each: ids } } },
      { timestamps: false },
    )
    // Someone else's request is touched only to add the link, so its own clock (`updatedAt`) stays put.
    await SosRequest.updateMany(
      { _id: { $in: ids } },
      { $addToSet: { possibleDuplicateOf: created._id } },
      { timestamps: false },
    )
  } catch (error) {
    console.error(`Duplicate check failed for the SOS request ${created._id}:`, error)
  }
}

// The requests an admin should compare with this one, nearest in time first. Everything about the other
// victim is visible: this is an admin deciding whether two people are asking for the same help.
const listFor = async (id: string) => {
  const sos = await SosRequest.findById(id).select('location createdAt possibleDuplicateOf').lean()
  if (!sos) throw new AppError(httpStatus.NOT_FOUND, NOT_FOUND_MESSAGE)
  const ids = sos.possibleDuplicateOf ?? []
  if (ids.length === 0) return []

  const others = await SosRequest.find({ _id: { $in: ids } })
    .populate<{ victim: { _id: Types.ObjectId; name: string; phone?: string | null } }>(
      'victim',
      'name phone',
    )
    .populate<{ assignedVolunteer: { _id: Types.ObjectId; name: string } | null }>(
      'assignedVolunteer',
      'name',
    )
    .lean()
  const here = sos.location.coordinates as Coordinates

  return others
    .map((other) => ({
      id: String(other._id),
      victim: {
        id: String(other.victim._id),
        name: other.victim.name,
        phone: other.victim.phone ?? null,
      },
      assignedVolunteer: other.assignedVolunteer
        ? { id: String(other.assignedVolunteer._id), name: other.assignedVolunteer.name }
        : null,
      needs: other.needs,
      description: other.description ?? null,
      address: other.address ?? null,
      priority: other.priority,
      status: other.status,
      location: other.location,
      distanceMeters: Math.round(distanceMeters(here, other.location.coordinates as Coordinates)),
      minutesApart: minutesBetween(sos.createdAt, other.createdAt),
      createdAt: other.createdAt,
    }))
    .sort((a, b) => a.minutesApart - b.minutesApart)
}

// Clears the link from every request that holds it, inside the caller's transaction when there is one.
const pullLinks = (id: string, session?: ClientSession) =>
  SosRequest.updateMany(
    { possibleDuplicateOf: id },
    { $pull: { possibleDuplicateOf: id } },
    { session, timestamps: false },
  )

// "These are different people": the flag goes from this request and from every request that pointed at it.
const dismiss = async (admin: TokenPayload, id: string) => {
  const sos = await SosRequest.findById(id).select('possibleDuplicateOf').lean()
  if (!sos) throw new AppError(httpStatus.NOT_FOUND, NOT_FOUND_MESSAGE)
  const count = sos.possibleDuplicateOf?.length ?? 0
  if (count === 0) {
    throw new AppError(httpStatus.CONFLICT, 'This SOS request has no duplicate flag to dismiss')
  }

  await SosRequest.updateOne(
    { _id: id },
    { $set: { possibleDuplicateOf: [] } },
    { timestamps: false },
  )
  await pullLinks(id)

  await AuditService.record({
    actor: admin,
    action: AuditAction.SOS_DUPLICATES_DISMISSED,
    targetType: AuditTargetType.SOS_REQUEST,
    targetId: id,
    summary: `Dismissed the duplicate flag on an SOS request (${count} linked)`,
    meta: { linked: count },
  })
  return SosService.getStaffView(id)
}

// An admin combines request `id` (the duplicate) into `intoId` (the one that carries on). The duplicate
// closes with `resolveKind: merged`; its victim is told and from then on sees only the status of the main
// request. The main request never loses urgency: it takes the higher of the two priorities.
//
// A duplicate that a volunteer already holds is refused (they are on their way to a real person): the admin
// takes it back first, or merges the other way round. Offers still out on the duplicate are withdrawn.
const merge = async (admin: TokenPayload, id: string, payload: MergeSosPayload) => {
  const { intoId, reason } = payload
  if (id === intoId) {
    throw new AppError(httpStatus.BAD_REQUEST, 'A request cannot be merged into itself')
  }
  const [duplicate, main] = await Promise.all([
    SosRequest.findById(id).select('status victim priority assignedVolunteer').lean(),
    SosRequest.findById(intoId).select('status priority').lean(),
  ])
  if (!duplicate) throw new AppError(httpStatus.NOT_FOUND, NOT_FOUND_MESSAGE)
  if (!main) throw new AppError(httpStatus.NOT_FOUND, 'The request to merge into was not found')
  if (isFinished(duplicate.status)) {
    throw new AppError(httpStatus.CONFLICT, `This SOS request is already ${duplicate.status}`)
  }
  if (isFinished(main.status)) {
    throw new AppError(httpStatus.CONFLICT, `The request to merge into is already ${main.status}`)
  }
  if (duplicate.assignedVolunteer) {
    throw new AppError(
      httpStatus.CONFLICT,
      'A volunteer holds this request. Take it back first (unassign), or merge the other way round',
    )
  }

  const priority = moreUrgent(duplicate.priority, main.priority)
  const priorityRaised = priority !== main.priority
  const offered = await runInTransaction(async (session) => {
    const closed = await SosRequest.findOneAndUpdate(
      { _id: id, status: duplicate.status, assignedVolunteer: null },
      {
        $set: {
          status: SosStatus.CLOSED,
          resolvedBy: ResolvedBy.ADMIN,
          resolveReason: reason,
          resolveKind: ResolveKind.MERGED,
          mergedInto: intoId,
          resolvedAt: new Date(),
          possibleDuplicateOf: [],
        },
      },
      { runValidators: true, session },
    )
    if (!closed) throw new AppError(httpStatus.CONFLICT, RACE_MESSAGE)

    // The survivor must still be open, and no other request may keep pointing at the one that closed.
    const survivor = await SosRequest.findOneAndUpdate(
      { _id: intoId, status: { $nin: [...SOS_FINISHED_STATUSES] } },
      {
        $pull: { possibleDuplicateOf: id },
        ...(priorityRaised && { $set: { priority } }),
      },
      { session, timestamps: priorityRaised },
    )
    if (!survivor) throw new AppError(httpStatus.CONFLICT, RACE_MESSAGE)
    await pullLinks(id, session)
    return TaskService.cancelOpenTasks(session, id, reason, MERGED_NOTE_PREFIX)
  })

  await SosEventService.record(
    { sos: id, type: SosEventType.MERGED, actorId: admin.id, meta: { by: 'admin' } },
    { sos: intoId, type: SosEventType.MERGED_IN, actorId: admin.id },
  )
  // The victim hears that their request was combined, not with whom.
  await NotificationService.notifyUsers({
    userIds: [String(duplicate.victim)],
    type: NotificationType.SOS_MERGED,
    title: 'Your request was combined with another',
    message:
      'Someone nearby asked for help for the same situation, so an admin combined the two requests. Help is arranged through the other request, and you can follow its status on yours.',
    sosRequestId: id,
  })
  await NotificationService.notifyUsers({
    userIds: offered,
    type: NotificationType.TASK_CANCELLED,
    title: 'SOS request combined',
    message:
      'An SOS request that was offered to you was combined with another one. You do not need to respond.',
    sosRequestId: id,
  })
  await AuditService.record({
    actor: admin,
    action: AuditAction.SOS_MERGED,
    targetType: AuditTargetType.SOS_REQUEST,
    targetId: id,
    // The reason stays on the request (it may hold names or numbers); the log only says what was combined.
    summary: 'Combined an SOS request into another one',
    meta: { intoId, priorityRaised, offersWithdrawn: offered.length },
  })

  return {
    duplicate: await SosService.getStaffView(id),
    into: await SosService.getStaffView(intoId),
  }
}

interface NearbySource {
  location: { coordinates: number[] }
  possibleDuplicateOf?: Types.ObjectId[] | null
}

// What a volunteer with an offer sees of the other open requests flagged near this one: how many, and how
// far, rounded. Nothing about who is asking.
const nearbySummary = async (sos: NearbySource) => {
  const ids = sos.possibleDuplicateOf ?? []
  const others =
    ids.length === 0
      ? []
      : await SosRequest.find({ _id: { $in: ids }, status: { $nin: [...SOS_FINISHED_STATUSES] } })
          .select('location')
          .lean()
  const here = sos.location.coordinates as Coordinates
  return {
    count: others.length,
    approximateDistancesMeters: others
      .map((other) =>
        approximateDistance(distanceMeters(here, other.location.coordinates as Coordinates)),
      )
      .sort((a, b) => a - b),
  }
}

// What the victim of a merged request is shown of the request theirs was combined into: its status, nothing
// else, and never its id.
const mergedStatus = async (mergedInto?: Types.ObjectId | null) => {
  if (!mergedInto) return null
  const main = await SosRequest.findById(mergedInto).select('status').lean()
  return main ? { status: main.status } : null
}

export const DuplicateService = {
  detectFor,
  listFor,
  dismiss,
  merge,
  nearbySummary,
  mergedStatus,
}
