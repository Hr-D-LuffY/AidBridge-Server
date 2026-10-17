import httpStatus from 'http-status'
import { type ClientSession, type QueryFilter, Types } from 'mongoose'
import { AuditAction, AuditTargetType } from '../../constants/audit'
import { Role } from '../../constants/role'
import {
  MAX_ACTIVE_SOS_PER_VICTIM,
  MAX_SOS_MEDIA_ITEMS,
  ResolvedBy,
  SOS_FINISHED_STATUSES,
  SOS_MEDIA_FOLDER,
  SOS_MEDIA_FORMATS,
  SOS_TRANSITIONS,
  SosSort,
  SosStatus,
} from '../../constants/sos'
import { type TaskProgressStatus, TaskStatus } from '../../constants/task'
import { PRIORITY_ORDER, type Priority } from '../../constants/relief'
import { AppError } from '../../errorHelpers/AppError'
import {
  assertMediaStorageConfigured,
  deleteMedia,
  type StoredMedia,
  uploadMediaBuffer,
} from '../../lib/cloudinary'
import { approximateCoordinates, type Coordinates, geoNearStage, toGeoPoint } from '../../lib/geo'
import { runInTransaction } from '../../lib/transaction'
import type { TokenPayload } from '../../utils/jwt'
import { buildMeta, getPagination } from '../../utils/pagination'
import { type DateRange, inRange } from '../../utils/dateRange'
import { assertTransition } from '../../utils/transitions'
import { AuditService } from '../audit/audit.service'
import { Incident } from '../incident/incident.model'
import { NotificationService } from '../notification/notification.service'
import { TaskService } from '../task/task.service'
import type {
  CreateSosPayload,
  ListSosQuery,
  NearbySosQuery,
  ResolveSosPayload,
  UpdateSosPayload,
} from './sos.interface'
import { SosRequest } from './sos.model'

const NOT_FOUND_MESSAGE = 'SOS request not found'
const RACE_MESSAGE = 'This SOS request changed while you were updating it. Please try again'
const MEDIA_UPLOAD_FAILED_MESSAGE = 'Uploading the media failed. Please try again'
const DISTANCE_FIELD = 'distanceMeters'
const ALLOWED_MEDIA_FORMATS: string[] = Object.values(SOS_MEDIA_FORMATS)

interface Person {
  _id: Types.ObjectId
  name: string
  phone?: string | null
}

export const SOS_PEOPLE_POPULATE = [
  { path: 'victim', select: 'name phone' },
  { path: 'assignedVolunteer', select: 'name phone' },
]

// Every read that is shown to a person goes through here so victim and volunteer arrive populated.
const findPopulated = (filter: QueryFilter<unknown>) =>
  SosRequest.findOne(filter)
    .populate<{ victim: Person; assignedVolunteer: Person | null }>(SOS_PEOPLE_POPULATE)
    .lean()

export type SosRecord = NonNullable<Awaited<ReturnType<typeof findPopulated>>>

const toPerson = (person: Person) => ({
  id: String(person._id),
  name: person.name,
  phone: person.phone ?? null,
})

// What the victim, the assigned volunteer, admins and NGOs see. Contact details and exact position
// are included. Cloudinary's publicId stays server-side.
const toFullView = (sos: SosRecord) => ({
  id: String(sos._id),
  victim: toPerson(sos.victim),
  assignedVolunteer: sos.assignedVolunteer ? toPerson(sos.assignedVolunteer) : null,
  needs: sos.needs,
  description: sos.description ?? null,
  media: sos.media.map((item) => ({
    id: String(item._id),
    url: item.url,
    resourceType: item.resourceType,
  })),
  location: sos.location,
  address: sos.address ?? null,
  priority: sos.priority,
  status: sos.status,
  resolvedAt: sos.resolvedAt ?? null,
  resolvedBy: sos.resolvedBy ?? null,
  resolveReason: sos.resolveReason ?? null,
  createdAt: sos.createdAt,
  updatedAt: sos.updatedAt,
})

interface LimitedSource {
  _id: Types.ObjectId
  status: SosStatus
  priority: Priority
  needs: string[]
  description?: string | null
  victim: { name: string }
  location: { coordinates: number[] }
  createdAt: Date
}

const firstName = (name: string) => name.split(/\s+/)[0] ?? name

// What a volunteer who has not taken a pending request sees: enough to decide whether to help, but
// no phone, no street address, no photos and only a rounded position. Once they accept it they
// are the assigned volunteer and get the full view.
const toLimitedView = (sos: LimitedSource, distanceMeters?: number) => ({
  id: String(sos._id),
  victim: { name: firstName(sos.victim.name) },
  needs: sos.needs,
  description: sos.description ?? null,
  // Stored coordinates were validated on write, so they are a [lng, lat] pair.
  approximateLocation: toGeoPoint(approximateCoordinates(sos.location.coordinates as Coordinates)),
  priority: sos.priority,
  status: sos.status,
  createdAt: sos.createdAt,
  ...(distanceMeters !== undefined && { distanceMeters: Math.round(distanceMeters) }),
})

// The request exists, belongs to the caller and is not rescued/closed yet. Gives the right 404 /
// 403 / 409 up front; the conditional update that follows (`openOwnedFilter`) is what actually
// makes the change safe against a concurrent write.
const loadOwnedOpenRequest = async (id: string, victimId: string) => {
  const sos = await SosRequest.findById(id).lean()
  if (!sos) throw new AppError(httpStatus.NOT_FOUND, NOT_FOUND_MESSAGE)
  if (String(sos.victim) !== victimId) {
    throw new AppError(httpStatus.FORBIDDEN, 'You can only change your own SOS requests')
  }
  if (SOS_FINISHED_STATUSES.includes(sos.status)) {
    throw new AppError(
      httpStatus.CONFLICT,
      `This SOS request is already ${sos.status} and can no longer be changed`,
    )
  }
  return sos
}

const openOwnedFilter = (id: string, victimId: string) => ({
  _id: id,
  victim: victimId,
  status: { $nin: [...SOS_FINISHED_STATUSES] },
})

const createSos = async (victimId: string, payload: CreateSosPayload) => {
  const { needs, description, coordinates, address } = payload

  // A soft limit: two requests created at the very same instant could both pass. That is accepted;
  // the limit exists to stop spam, not to be a security boundary.
  const activeCount = await SosRequest.countDocuments({
    victim: victimId,
    status: { $nin: [...SOS_FINISHED_STATUSES] },
  })
  if (activeCount >= MAX_ACTIVE_SOS_PER_VICTIM) {
    throw new AppError(
      httpStatus.CONFLICT,
      `You already have ${MAX_ACTIVE_SOS_PER_VICTIM} active SOS requests. Resolve one before creating another`,
    )
  }

  const created = await SosRequest.create({
    victim: victimId,
    needs,
    description,
    location: toGeoPoint(coordinates),
    address,
  })

  const sos = await findPopulated({ _id: created._id })
  if (!sos) throw new AppError(httpStatus.INTERNAL_SERVER_ERROR, 'SOS request was not saved')
  return toFullView(sos)
}

const toObjectId = (id: string) => new Types.ObjectId(id)

// The filter for `GET /sos`, composed only from values the schema has already parsed. Ids are cast
// here because the priority sort runs as an aggregation, which (unlike `find`) does not cast strings.
// Admins and NGOs see every request, and alone may filter by incident, volunteer or victim. Everyone
// else sees the ones they raised or were assigned.
const buildListFilter = async (viewer: TokenPayload, query: ListSosQuery) => {
  const { status, priority, needs, q, from, to, incidentId, volunteerId, victimId } = query
  const isStaff = viewer.role === Role.ADMIN || viewer.role === Role.NGO
  if (!isStaff && (incidentId || volunteerId || victimId)) {
    throw new AppError(
      httpStatus.FORBIDDEN,
      'Only an admin or an NGO can filter by incident, volunteer or victim',
    )
  }

  const filter: QueryFilter<unknown> = { ...inRange('createdAt', { startDate: from, endDate: to }) }
  if (!isStaff) {
    filter.$or = [{ victim: toObjectId(viewer.id) }, { assignedVolunteer: toObjectId(viewer.id) }]
  }
  if (status) filter.status = { $in: status }
  if (priority) filter.priority = { $in: priority }
  if (needs) filter.needs = { $in: needs }
  if (volunteerId) filter.assignedVolunteer = toObjectId(volunteerId)
  if (victimId) filter.victim = toObjectId(victimId)
  // The user's words go to MongoDB's text search as data. Nothing is built into a regex.
  if (q) filter.$text = { $search: q }

  // The link lives on the incident, so the request ids come from there.
  if (incidentId) {
    const incident = await Incident.findOne({ _id: incidentId, isDeleted: false })
      .select('sosRequests')
      .lean()
    if (!incident) throw new AppError(httpStatus.NOT_FOUND, 'Incident not found')
    filter._id = { $in: incident.sosRequests }
  }
  return filter
}

// Page of ids, most urgent first (see PRIORITY_ORDER), then newest. A string field cannot be sorted
// into that order, so the rank is worked out in the pipeline.
const pageIdsByPriority = async (filter: QueryFilter<unknown>, query: ListSosQuery) => {
  const rows = await SosRequest.aggregate<{ _id: Types.ObjectId }>([
    { $match: filter },
    { $addFields: { rank: { $indexOfArray: [PRIORITY_ORDER, '$priority'] } } },
    { $sort: { rank: 1, createdAt: -1, _id: -1 } },
    { $skip: getPagination(query).skip },
    { $limit: query.limit },
    { $project: { _id: 1 } },
  ])
  return rows.map((row) => row._id)
}

const listSos = async (viewer: TokenPayload, query: ListSosQuery) => {
  const { page, limit, sort } = query
  const filter = await buildListFilter(viewer, query)
  const populate = [...SOS_PEOPLE_POPULATE]

  const loadPage = async () => {
    if (sort === SosSort.PRIORITY) {
      const ids = await pageIdsByPriority(filter, query)
      const found = await SosRequest.find({ _id: { $in: ids } })
        .populate<{ victim: Person; assignedVolunteer: Person | null }>(populate)
        .lean()
      const byId = new Map(found.map((sos) => [String(sos._id), sos]))
      return ids.flatMap((id) => byId.get(String(id)) ?? [])
    }
    const direction = sort === SosSort.OLDEST ? 1 : -1
    return SosRequest.find(filter)
      .sort({ createdAt: direction, _id: direction })
      .skip(getPagination(query).skip)
      .limit(limit)
      .populate<{ victim: Person; assignedVolunteer: Person | null }>(populate)
      .lean()
  }

  const [items, total] = await Promise.all([loadPage(), SosRequest.countDocuments(filter)])
  return { items: items.map(toFullView), meta: buildMeta({ page, limit }, total) }
}

// Pending requests around a point, nearest first, for a volunteer's map. Always the limited view:
// accepting a request is what unlocks the contact details.
const listNearby = async (volunteerId: string, query: NearbySosQuery) => {
  const { page, limit } = query

  // Requests this volunteer already declined stay out of their list.
  const declinedIds = await TaskService.listRejectedSosIds(volunteerId)
  const [result] = await SosRequest.aggregate<{
    items: (LimitedSource & { distanceMeters: number })[]
    total: { count: number }[]
  }>([
    geoNearStage(query, { status: SosStatus.PENDING, _id: { $nin: declinedIds } }, DISTANCE_FIELD),
    {
      $facet: {
        items: [{ $skip: getPagination(query).skip }, { $limit: limit }],
        total: [{ $count: 'count' }],
      },
    },
  ])

  const rows = result?.items ?? []
  const withVictims = await SosRequest.populate<{ victim: { name: string } }>(rows, {
    path: 'victim',
    select: 'name',
  })

  return {
    items: withVictims.map((sos, index) => toLimitedView(sos, rows[index]?.distanceMeters)),
    meta: buildMeta({ page, limit }, result?.total[0]?.count ?? 0),
  }
}

// Full detail for the victim, the assigned volunteer, admins and NGOs. A volunteer who has not
// taken the request may open it only while it is pending, and sees the limited view (D2).
const getSosById = async (viewer: TokenPayload, id: string) => {
  const sos = await findPopulated({ _id: id })
  if (!sos) throw new AppError(httpStatus.NOT_FOUND, NOT_FOUND_MESSAGE)

  const isOwner = String(sos.victim._id) === viewer.id
  const isAssigned = sos.assignedVolunteer && String(sos.assignedVolunteer._id) === viewer.id
  const isStaff = viewer.role === Role.ADMIN || viewer.role === Role.NGO
  // The victim also gets the volunteer's task, so the page can offer the rating without another call.
  if (isOwner) {
    return { ...toFullView(sos), task: await TaskService.getVictimSummary(id, viewer.id) }
  }
  if (isAssigned || isStaff) return toFullView(sos)

  if (viewer.role === Role.VOLUNTEER && sos.status === SosStatus.PENDING) {
    return toLimitedView(sos)
  }
  throw new AppError(httpStatus.FORBIDDEN, 'You do not have access to this SOS request')
}

const updateSos = async (victimId: string, id: string, payload: UpdateSosPayload) => {
  const { removeMediaIds, coordinates, ...fields } = payload
  const existing = await loadOwnedOpenRequest(id, victimId)

  const removed = existing.media.filter((item) => removeMediaIds?.includes(String(item._id)))
  if (removed.length !== (removeMediaIds?.length ?? 0)) {
    throw new AppError(httpStatus.BAD_REQUEST, 'Some media ids do not belong to this SOS request')
  }

  const set: Record<string, unknown> = Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  )
  if (coordinates) set.location = toGeoPoint(coordinates)

  const updated = await SosRequest.findOneAndUpdate(
    openOwnedFilter(id, victimId),
    {
      ...(Object.keys(set).length > 0 && { $set: set }),
      ...(removed.length > 0 && {
        $pull: { media: { _id: { $in: removed.map((item) => item._id) } } },
      }),
    },
    { runValidators: true },
  )
  if (!updated) throw new AppError(httpStatus.CONFLICT, RACE_MESSAGE)

  // Only after the document no longer points at them: a failed delete leaves an orphaned file,
  // never a broken link.
  await Promise.all(removed.map(deleteMedia))

  if (existing.assignedVolunteer) {
    await NotificationService.notifyUser(
      String(existing.assignedVolunteer),
      'SOS request updated',
      'The victim changed an SOS request you are working on. Open it to see the latest details.',
    )
  }

  return getFullView(id)
}

// Uploads first, then one atomic write: the filter only matches while the request is still open
// and still has room (`media.<n>` not existing means at most n items), so two simultaneous uploads
// can't push it past the limit.
const addMedia = async (victimId: string, id: string, files: Express.Multer.File[]) => {
  if (files.length === 0) {
    throw new AppError(httpStatus.BAD_REQUEST, 'Attach at least one file in the "media" field')
  }
  assertMediaStorageConfigured()

  const existing = await loadOwnedOpenRequest(id, victimId)
  if (existing.media.length + files.length > MAX_SOS_MEDIA_ITEMS) {
    throw new AppError(
      httpStatus.CONFLICT,
      `A request can have at most ${MAX_SOS_MEDIA_ITEMS} files and this one already has ${existing.media.length}`,
    )
  }

  const uploaded = await uploadAll(files)

  const updated = await SosRequest.findOneAndUpdate(
    {
      ...openOwnedFilter(id, victimId),
      [`media.${MAX_SOS_MEDIA_ITEMS - files.length}`]: { $exists: false },
    },
    { $push: { media: { $each: uploaded } } },
    { runValidators: true },
  )
  if (!updated) {
    await Promise.all(uploaded.map(deleteMedia))
    throw new AppError(httpStatus.CONFLICT, RACE_MESSAGE)
  }

  return getFullView(id)
}

// All or nothing: if any file fails, the ones that did upload are removed again.
const uploadAll = async (files: Express.Multer.File[]) => {
  const results = await Promise.allSettled(
    files.map((file) => uploadMediaBuffer(file.buffer, SOS_MEDIA_FOLDER, ALLOWED_MEDIA_FORMATS)),
  )

  const uploaded: StoredMedia[] = []
  let failure: unknown
  for (const result of results) {
    if (result.status === 'fulfilled') uploaded.push(result.value)
    else failure = result.reason
  }
  if (failure === undefined) return uploaded

  console.error('SOS media upload failed:', failure)
  await Promise.all(uploaded.map(deleteMedia))
  throw new AppError(httpStatus.BAD_GATEWAY, MEDIA_UPLOAD_FAILED_MESSAGE)
}

// Nothing is deleted: the request moves to `closed` and keeps the victim's reason.
const resolveSos = async (victimId: string, id: string, payload: ResolveSosPayload) => {
  const existing = await loadOwnedOpenRequest(id, victimId)
  assertTransition(SOS_TRANSITIONS, existing.status, SosStatus.CLOSED, 'SOS request')

  // The request closes and every unfinished task on it is cancelled, or neither happens.
  await runInTransaction(async (session) => {
    const closed = await SosRequest.findOneAndUpdate(
      openOwnedFilter(id, victimId),
      {
        $set: {
          status: SosStatus.CLOSED,
          resolvedBy: ResolvedBy.VICTIM,
          resolveReason: payload.resolveReason,
          resolvedAt: new Date(),
        },
      },
      { runValidators: true, session },
    )
    if (!closed) throw new AppError(httpStatus.CONFLICT, RACE_MESSAGE)
    await TaskService.cancelOpenTasks(session, id, payload.resolveReason)
  })

  if (existing.assignedVolunteer) {
    await NotificationService.notifyUser(
      String(existing.assignedVolunteer),
      'SOS request closed',
      `The victim closed an SOS request you were working on: ${payload.resolveReason}`,
    )
  }

  return getFullView(id)
}

// An admin blocked the victim: every request of theirs that is not finished is closed (as an admin
// closing it) and the tasks on them are cancelled, so a scam request leaves the volunteers' maps at
// once. Runs inside the caller's transaction, so the block and the closing happen together or not at
// all. Returns the volunteers who were on those requests, for the caller to tell after it commits.
const closeUnfinishedForVictim = async (
  session: ClientSession,
  victimId: string,
  reason: string,
) => {
  const open = await SosRequest.find({
    victim: victimId,
    status: { $nin: [...SOS_FINISHED_STATUSES] },
  })
    .select('_id assignedVolunteer')
    .session(session)
    .lean()
  if (open.length === 0) return []

  await SosRequest.updateMany(
    { _id: { $in: open.map((sos) => sos._id) } },
    {
      $set: {
        status: SosStatus.CLOSED,
        resolvedBy: ResolvedBy.ADMIN,
        resolveReason: reason,
        resolvedAt: new Date(),
      },
    },
    { session },
  )
  for (const sos of open) await TaskService.cancelOpenTasks(session, String(sos._id), reason)

  return open.flatMap((sos) => (sos.assignedVolunteer ? [String(sos.assignedVolunteer)] : []))
}

// `findByIdAndUpdate` hands back the document as it was before the change, which is where the audit
// entry gets the old priority. Setting the priority it already has changes nothing and records nothing.
const setPriority = async (admin: TokenPayload, id: string, priority: Priority) => {
  const before = await SosRequest.findByIdAndUpdate(
    id,
    { $set: { priority } },
    { runValidators: true },
  )
  if (!before) throw new AppError(httpStatus.NOT_FOUND, NOT_FOUND_MESSAGE)

  if (before.priority !== priority) {
    await AuditService.record({
      actor: admin,
      action: AuditAction.SOS_PRIORITY_CHANGED,
      targetType: AuditTargetType.SOS_REQUEST,
      targetId: id,
      summary: `Changed SOS priority from ${before.priority} to ${priority}`,
      meta: { from: before.priority, to: priority },
    })
  }
  return getFullView(id)
}

// --- Volunteer side: accept, decline, progress ------------------------------------------------

// Pending -> assigned for this volunteer, as one conditional update: of two volunteers accepting at
// once, exactly one matches `status: pending`.
const claimForVolunteer = async (session: ClientSession, id: string, volunteerId: string) => {
  const claimed = await SosRequest.findOneAndUpdate(
    { _id: id, status: SosStatus.PENDING },
    { $set: { status: SosStatus.ASSIGNED, assignedVolunteer: volunteerId } },
    { session },
  )
  if (!claimed) {
    throw new AppError(httpStatus.CONFLICT, 'This SOS request is no longer waiting for a volunteer')
  }
}

// Assigned -> pending again, only for the volunteer currently holding it.
const releaseToPending = async (session: ClientSession, id: string, volunteerId: string) => {
  const released = await SosRequest.findOneAndUpdate(
    { _id: id, assignedVolunteer: volunteerId, status: SosStatus.ASSIGNED },
    { $set: { status: SosStatus.PENDING, assignedVolunteer: null } },
    { session },
  )
  if (!released) throw new AppError(httpStatus.CONFLICT, RACE_MESSAGE)
}

// What each task progress step does to the request it belongs to.
const REQUEST_STEP_FOR_PROGRESS: Record<TaskProgressStatus, { from: SosStatus; to: SosStatus }> = {
  [TaskStatus.ON_THE_WAY]: { from: SosStatus.ASSIGNED, to: SosStatus.ON_THE_WAY },
  [TaskStatus.COMPLETED]: { from: SosStatus.ON_THE_WAY, to: SosStatus.RESCUED },
}

const advanceForVolunteer = async (
  session: ClientSession,
  id: string,
  volunteerId: string,
  progress: TaskProgressStatus,
) => {
  const { from, to } = REQUEST_STEP_FOR_PROGRESS[progress]
  assertTransition(SOS_TRANSITIONS, from, to, 'SOS request')

  const moved = await SosRequest.findOneAndUpdate(
    { _id: id, assignedVolunteer: volunteerId, status: from },
    { $set: { status: to, ...(to === SosStatus.RESCUED && { resolvedAt: new Date() }) } },
    { session },
  )
  if (!moved) throw new AppError(httpStatus.CONFLICT, RACE_MESSAGE)
}

const acceptSos = async (volunteerId: string, id: string) => {
  const sos = await SosRequest.findById(id).select('status victim').lean()
  if (!sos) throw new AppError(httpStatus.NOT_FOUND, NOT_FOUND_MESSAGE)
  if (sos.status !== SosStatus.PENDING) {
    throw new AppError(httpStatus.CONFLICT, `Cannot accept: the request is already ${sos.status}`)
  }
  if ((await TaskService.getStatusFor(id, volunteerId)) === TaskStatus.REJECTED) {
    throw new AppError(httpStatus.CONFLICT, 'You declined this request earlier')
  }
  await TaskService.assertCanTakeAnotherTask(volunteerId)

  // Claiming the request and creating the task stand or fall together.
  const taskId = await runInTransaction(async (session) => {
    await claimForVolunteer(session, id, volunteerId)
    return TaskService.createAccepted(session, {
      sosRequest: id,
      volunteer: volunteerId,
      victim: String(sos.victim),
    })
  })

  const [sosRequest, task] = await Promise.all([getFullView(id), TaskService.getView(taskId)])
  return { sosRequest, task }
}

// Two meanings, depending on who asks. Someone who has not taken the request just hides it from
// their own list. The volunteer who holds it backs out: it goes back to pending for others, but
// only before they set off.
const rejectSos = async (volunteerId: string, id: string) => {
  const sos = await SosRequest.findById(id).select('status victim assignedVolunteer').lean()
  if (!sos) throw new AppError(httpStatus.NOT_FOUND, NOT_FOUND_MESSAGE)

  if (sos.assignedVolunteer && String(sos.assignedVolunteer) === volunteerId) {
    if (sos.status !== SosStatus.ASSIGNED) {
      throw new AppError(
        httpStatus.CONFLICT,
        `You can no longer back out: the request is ${sos.status}`,
      )
    }
    await runInTransaction(async (session) => {
      await releaseToPending(session, id, volunteerId)
      await TaskService.withdrawAccepted(session, id, volunteerId)
    })
    return { sosRequestId: id, outcome: 'withdrawn' as const }
  }

  if (sos.status !== SosStatus.PENDING) {
    throw new AppError(httpStatus.CONFLICT, `Cannot decline: the request is already ${sos.status}`)
  }
  await TaskService.recordRejection({
    sosRequest: id,
    volunteer: volunteerId,
    victim: String(sos.victim),
  })
  return { sosRequestId: id, outcome: 'declined' as const }
}

// --- Questions other modules ask ---------------------------------------------------------------

const viewForTask = (sos: SosRecord, contactVisible: boolean) =>
  contactVisible ? toFullView(sos) : toLimitedView(sos)

// Who is in the conversation about a request (used by the chat).
const getParticipants = async (id: string) => {
  const sos = await SosRequest.findById(id).select('victim assignedVolunteer status').lean()
  if (!sos) throw new AppError(httpStatus.NOT_FOUND, NOT_FOUND_MESSAGE)
  return {
    victimId: String(sos.victim),
    assignedVolunteerId: sos.assignedVolunteer ? String(sos.assignedVolunteer) : null,
    status: sos.status,
  }
}

// True while the user has a request that is not rescued/closed, as its victim or its volunteer.
const hasUnfinishedRequests = async (userId: string) =>
  (await SosRequest.exists({
    $or: [{ victim: userId }, { assignedVolunteer: userId }],
    status: { $nin: [...SOS_FINISHED_STATUSES] },
  })) !== null

const getFullView = async (id: string) => {
  const sos = await findPopulated({ _id: id })
  if (!sos) throw new AppError(httpStatus.NOT_FOUND, NOT_FOUND_MESSAGE)
  return toFullView(sos)
}

// Which of these ids are real SOS requests (the incident module links requests by id).
const getExistingIds = async (ids: string[]) => {
  const found = await SosRequest.find({ _id: { $in: ids } })
    .select('_id')
    .lean()
  return found.map((sos) => String(sos._id))
}

// Of these ids, the ones whose request has been rescued: one query for a whole page of incidents.
const getRescuedIds = async (ids: string[]) => {
  if (ids.length === 0) return new Set<string>()
  const rescued = await SosRequest.find({ _id: { $in: ids }, status: SosStatus.RESCUED })
    .select('_id')
    .lean()
  return new Set(rescued.map((sos) => String(sos._id)))
}

interface CountRow<T extends string> {
  _id: T
  count: number
}

// How many requests were raised in the range, by status and by priority: one pass over the
// collection, two groupings. Statuses nobody has are simply absent from the result.
const countByStatusAndPriority = async (range: DateRange) => {
  const [result] = await SosRequest.aggregate<{
    byStatus: CountRow<SosStatus>[]
    byPriority: CountRow<Priority>[]
  }>([
    { $match: inRange('createdAt', range) },
    {
      $facet: {
        byStatus: [{ $group: { _id: '$status', count: { $sum: 1 } } }],
        byPriority: [{ $group: { _id: '$priority', count: { $sum: 1 } } }],
      },
    },
  ])
  return { byStatus: result?.byStatus ?? [], byPriority: result?.byPriority ?? [] }
}

// Requests still open (not rescued / closed) for the live map, newest first. Names only, no
// phone numbers: the map shows where help is needed, the detail screen shows who to call.
const listOpenForMap = async (limit: number) => {
  const requests = await SosRequest.find({ status: { $nin: [...SOS_FINISHED_STATUSES] } })
    .select('victim assignedVolunteer needs location address priority status createdAt')
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit)
    .populate<{ victim: { _id: Types.ObjectId; name: string } }>('victim', 'name')
    .populate<{ assignedVolunteer: { _id: Types.ObjectId; name: string } | null }>(
      'assignedVolunteer',
      'name',
    )
    .lean()

  return requests.map((sos) => ({
    id: String(sos._id),
    status: sos.status,
    priority: sos.priority,
    needs: sos.needs,
    location: sos.location,
    address: sos.address ?? null,
    victim: { id: String(sos.victim._id), name: sos.victim.name },
    assignedVolunteer: sos.assignedVolunteer
      ? { id: String(sos.assignedVolunteer._id), name: sos.assignedVolunteer.name }
      : null,
    createdAt: sos.createdAt,
  }))
}

export const SosService = {
  countByStatusAndPriority,
  listOpenForMap,
  getExistingIds,
  getRescuedIds,
  createSos,
  listSos,
  listNearby,
  getSosById,
  updateSos,
  addMedia,
  resolveSos,
  closeUnfinishedForVictim,
  setPriority,
  acceptSos,
  rejectSos,
  claimForVolunteer,
  advanceForVolunteer,
  viewForTask,
  getParticipants,
  hasUnfinishedRequests,
}
