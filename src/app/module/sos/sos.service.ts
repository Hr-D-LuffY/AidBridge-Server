import httpStatus from 'http-status'
import { type ClientSession, type QueryFilter, Types } from 'mongoose'
import { ADMIN_CLOSED_KIND, MS_PER_MINUTE, RESPONSE_TIME_DECIMALS } from '../../constants/analytics'
import { Collection } from '../../constants/collections'
import { AuditAction, AuditTargetType } from '../../constants/audit'
import { SosEventType } from '../../constants/dispatch'
import { NotificationType } from '../../constants/notification'
import { Role } from '../../constants/role'
import {
  MAX_ACTIVE_SOS_PER_VICTIM,
  MAX_SOS_MEDIA_ITEMS,
  RESOLVE_KIND_PRESET_REASONS,
  ResolvedBy,
  ResolveKind,
  SOS_FINISHED_STATUSES,
  SOS_MEDIA_FOLDER,
  SOS_MEDIA_FORMATS,
  SOS_TRANSITIONS,
  SosSort,
  SosStatus,
  STALE_CLOSE_REASON,
} from '../../constants/sos'
import type { Skill } from '../../constants/skill'
import {
  ADMIN_CLOSED_NOTE_PREFIX,
  STALE_CLOSED_NOTE_PREFIX,
  type TaskProgressStatus,
  TaskStatus,
} from '../../constants/task'
import { PRIORITY_ORDER, Priority, type ReliefCategory } from '../../constants/relief'
import { AppError } from '../../errorHelpers/AppError'
import {
  assertMediaStorageConfigured,
  deleteMedia,
  type StoredMedia,
  uploadMediaBuffer,
} from '../../lib/cloudinary'
import { approximateCoordinates, type Coordinates, geoNearStage, toGeoPoint } from '../../lib/geo'
import { matchSkills, needsImplyingAny, wantedSkills } from '../../lib/skills'
import { runInTransaction } from '../../lib/transaction'
import type { TokenPayload } from '../../utils/jwt'
import { buildMeta, getPagination } from '../../utils/pagination'
import { type DateRange, inRange } from '../../utils/dateRange'
import { assertTransition } from '../../utils/transitions'
import { AuditService } from '../audit/audit.service'
import { DuplicateService } from './duplicate.service'
import { Incident } from '../incident/incident.model'
import { NotificationService } from '../notification/notification.service'
import type { TimelineQuery } from '../sos-event/sos-event.interface'
import { SosEventService } from '../sos-event/sos-event.service'
import { TaskService } from '../task/task.service'
import { User } from '../user/user.model'
import type {
  CloseSosPayload,
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
  requiredSkills: sos.requiredSkills ?? [],
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
  resolveKind: sos.resolveKind ?? null,
  // The last sign of life, and when the victim was asked "Do you still need help?" (null if not asked, or
  // answered since). A client shows the question while `confirmationAskedAt` is set.
  lastConfirmedAt: sos.lastConfirmedAt ?? null,
  confirmationAskedAt: sos.staleCheckedAt ?? null,
  createdAt: sos.createdAt,
  updatedAt: sos.updatedAt,
})

interface DispatchFields {
  level?: number | null
  nextActionAt?: Date | null
  unserved?: boolean | null
  priorityBumped?: boolean | null
  paused?: boolean | null
}

// What admins and NGOs see of the engine's bookkeeping. A request from before dispatch existed has
// none of it, so every field falls back to its default. Victims and volunteers never get this.
const toDispatchView = (dispatch?: DispatchFields | null) => ({
  level: dispatch?.level ?? 0,
  nextActionAt: dispatch?.nextActionAt ?? null,
  unserved: dispatch?.unserved ?? false,
  priorityBumped: dispatch?.priorityBumped ?? false,
  paused: dispatch?.paused ?? false,
})

const toStaffView = (sos: SosRecord) => ({
  ...toFullView(sos),
  dispatch: toDispatchView(sos.dispatch),
  // Other requests that may be the same emergency (an admin compares them), and, once an admin combined
  // this one into another, which one.
  possibleDuplicateOf: (sos.possibleDuplicateOf ?? []).map(String),
  mergedInto: sos.mergedInto ? String(sos.mergedInto) : null,
})

interface LimitedSource {
  _id: Types.ObjectId
  status: SosStatus
  priority: Priority
  needs: ReliefCategory[]
  requiredSkills?: Skill[]
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
  requiredSkills: sos.requiredSkills ?? [],
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
  const { needs, requiredSkills, description, coordinates, address } = payload

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
    lastConfirmedAt: new Date(),
    victim: victimId,
    needs,
    requiredSkills,
    description,
    location: toGeoPoint(coordinates),
    address,
  })

  // A hint for admins only; it cannot fail or hold up the victim's request.
  await DuplicateService.detectFor(created)

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
  const {
    status,
    priority,
    needs,
    q,
    from,
    to,
    incidentId,
    volunteerId,
    victimId,
    unserved,
    possibleDuplicate,
  } = query
  const isStaff = viewer.role === Role.ADMIN || viewer.role === Role.NGO
  if (
    !isStaff &&
    (incidentId ||
      volunteerId ||
      victimId ||
      unserved !== undefined ||
      possibleDuplicate !== undefined)
  ) {
    throw new AppError(
      httpStatus.FORBIDDEN,
      'Only an admin or an NGO can filter by incident, volunteer, victim, unserved or possibleDuplicate',
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
  // A request from before dispatch existed has no flag, so "not unserved" is "not true", not "false".
  if (unserved !== undefined) filter['dispatch.unserved'] = unserved ? true : { $ne: true }
  // Flagged and still open: a flag on a finished request is no longer something to review. `false` is "not flagged".
  if (possibleDuplicate !== undefined) {
    filter['possibleDuplicateOf.0'] = { $exists: possibleDuplicate }
    if (possibleDuplicate && !status) filter.status = { $nin: [...SOS_FINISHED_STATUSES] }
  }
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
  const isStaff = viewer.role === Role.ADMIN || viewer.role === Role.NGO
  return {
    items: items.map(isStaff ? toStaffView : toFullView),
    meta: buildMeta({ page, limit }, total),
  }
}

// Pending requests around a point, nearest first, for a volunteer's map. Always the limited view:
// accepting a request is what unlocks the contact details.
const listNearby = async (volunteerId: string, query: NearbySosQuery) => {
  const { page, limit, skills } = query

  // Requests this volunteer already declined stay out of their list.
  const declinedIds = await TaskService.listRejectedSosIds(volunteerId)
  const volunteer = await User.findById(volunteerId).select('skills').lean()
  const mySkills = volunteer?.skills ?? []
  const [result] = await SosRequest.aggregate<{
    items: (LimitedSource & { distanceMeters: number })[]
    total: { count: number }[]
  }>([
    geoNearStage(
      query,
      {
        status: SosStatus.PENDING,
        _id: { $nin: declinedIds },
        // `?skills=`: wants any of them, asked for outright or implied by a need.
        ...(skills && {
          $or: [{ requiredSkills: { $in: skills } }, { needs: { $in: needsImplyingAny(skills) } }],
        }),
      },
      DISTANCE_FIELD,
    ),
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
    items: withVictims.map((sos, index) => {
      const matchedSkills = matchSkills(wantedSkills(sos.requiredSkills, sos.needs), mySkills)
      return {
        ...toLimitedView(sos, rows[index]?.distanceMeters),
        // Does this volunteer have what the request is looking for? A badge, never a filter.
        skillMatch: matchedSkills.length > 0,
        matchedSkills,
      }
    }),
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
  // If an admin combined the request into another, the victim sees that one's status and nothing else of it.
  if (isOwner) {
    return {
      ...toFullView(sos),
      task: await TaskService.getVictimSummary(id, viewer.id),
      mergedInto: await DuplicateService.mergedStatus(sos.mergedInto),
    }
  }
  // Staff also see who holds the request and how their task was shown to be finished.
  if (isStaff) return { ...toStaffView(sos), task: await TaskService.getStaffSummary(id) }
  if (isAssigned) return toFullView(sos)

  if (viewer.role === Role.VOLUNTEER && sos.status === SosStatus.PENDING) {
    // A volunteer who has an offer for it is also told how many other open requests are flagged close by.
    const offered = (await TaskService.getStatusFor(id, viewer.id)) === TaskStatus.PENDING
    return {
      ...toLimitedView(sos),
      otherRequestsNearby: offered ? await DuplicateService.nearbySummary(sos) : null,
    }
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
      ...stillHereUpdate(set),
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
    await NotificationService.notifyUsers({
      userIds: [String(existing.assignedVolunteer)],
      type: NotificationType.SOS_UPDATED,
      title: 'SOS request updated',
      message:
        'The victim changed an SOS request you are working on. Open it to see the latest details.',
      sosRequestId: id,
    })
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
    { ...stillHereUpdate(), $push: { media: { $each: uploaded } } },
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

// Any sign that the victim is still there: the stale clock starts again and a pending "Do you still need
// help?" is withdrawn. `extra` is merged into the same $set so the edit and the sign of life are one write.
const stillHereUpdate = (extra: Record<string, unknown> = {}) => ({
  $set: { ...extra, lastConfirmedAt: new Date() },
  $unset: { staleCheckedAt: '', staleAlertedAt: '' },
})

// "Yes, I still need help": the victim answers the check-in. Also counts as a sign of life on its own,
// without editing anything.
const confirmStillNeedHelp = async (victimId: string, id: string) => {
  await loadOwnedOpenRequest(id, victimId)
  const updated = await SosRequest.findOneAndUpdate(
    openOwnedFilter(id, victimId),
    stillHereUpdate(),
  )
  if (!updated) throw new AppError(httpStatus.CONFLICT, RACE_MESSAGE)
  await SosEventService.record({ sos: id, type: SosEventType.CONFIRMED, actorId: victimId })
  return getFullView(id)
}

// The victim wrote in the chat: they are there. Called by the message module; a request that is already
// finished is left alone.
const recordVictimActivity = async (id: string) => {
  await SosRequest.updateOne(
    { _id: id, status: { $nin: [...SOS_FINISHED_STATUSES] } },
    stillHereUpdate(),
  )
}

// Nothing is deleted: the request moves to `closed` and keeps the victim's reason.
const resolveSos = async (victimId: string, id: string, payload: ResolveSosPayload) => {
  const existing = await loadOwnedOpenRequest(id, victimId)
  assertTransition(SOS_TRANSITIONS, existing.status, SosStatus.CLOSED, 'SOS request')

  // A kind other than `other` may come with no words of its own: the preset text stands in.
  const { kind } = payload
  const reason =
    payload.resolveReason ??
    (kind === ResolveKind.OTHER ? undefined : RESOLVE_KIND_PRESET_REASONS[kind]) ??
    kind

  // The request closes and every unfinished task on it is cancelled, or neither happens.
  const heldBy = await runInTransaction(async (session) => {
    const closed = await SosRequest.findOneAndUpdate(
      openOwnedFilter(id, victimId),
      {
        $set: {
          status: SosStatus.CLOSED,
          resolvedBy: ResolvedBy.VICTIM,
          resolveReason: reason,
          resolveKind: kind,
          resolvedAt: new Date(),
        },
      },
      { runValidators: true, session },
    )
    if (!closed) throw new AppError(httpStatus.CONFLICT, RACE_MESSAGE)
    return TaskService.cancelOpenTasks(session, id, reason)
  })
  await SosEventService.record({
    sos: id,
    type: SosEventType.CLOSED,
    actorId: victimId,
    meta: { kind },
  })

  const assignedId = existing.assignedVolunteer ? String(existing.assignedVolunteer) : null
  if (assignedId) {
    await NotificationService.notifyUsers({
      userIds: [assignedId],
      type: NotificationType.TASK_CANCELLED,
      title: 'SOS request closed',
      message: `The victim closed an SOS request you were working on: ${reason}`,
      sosRequestId: id,
    })
  }
  // Volunteers who were only offered it are told too, so the offer does not sit in their list.
  await NotificationService.notifyUsers({
    userIds: heldBy.filter((volunteerId) => volunteerId !== assignedId),
    type: NotificationType.TASK_CANCELLED,
    title: 'SOS request closed',
    message:
      'The victim closed an SOS request that was offered to you. You do not need to respond.',
    sosRequestId: id,
  })

  return getFullView(id)
}

// An admin closes a request by hand (a scam, a duplicate they handled, something found out by phone). It
// can be in any state but already closed, `rescued` included. Every unfinished task is cancelled with it,
// and the victim and every volunteer who held it or an offer for it are told why. A rescue that was
// already completed keeps its completed task, so the victim can still rate it.
const closeSos = async (admin: TokenPayload, id: string, payload: CloseSosPayload) => {
  const { reason } = payload
  const existing = await SosRequest.findById(id)
    .select('status victim assignedVolunteer resolvedAt')
    .lean()
  if (!existing) throw new AppError(httpStatus.NOT_FOUND, NOT_FOUND_MESSAGE)
  if (existing.status === SosStatus.CLOSED) {
    throw new AppError(httpStatus.CONFLICT, 'This SOS request is already closed')
  }
  assertTransition(SOS_TRANSITIONS, existing.status, SosStatus.CLOSED, 'SOS request')

  const heldBy = await runInTransaction(async (session) => {
    const closed = await SosRequest.findOneAndUpdate(
      { _id: id, status: existing.status },
      {
        $set: {
          status: SosStatus.CLOSED,
          resolvedBy: ResolvedBy.ADMIN,
          resolveReason: reason,
          // A rescued request keeps the time it was rescued.
          resolvedAt: existing.resolvedAt ?? new Date(),
        },
        $unset: { resolveKind: '' },
      },
      { runValidators: true, session },
    )
    if (!closed) throw new AppError(httpStatus.CONFLICT, RACE_MESSAGE)
    return TaskService.cancelOpenTasks(session, id, reason, ADMIN_CLOSED_NOTE_PREFIX)
  })

  await SosEventService.record({
    sos: id,
    type: SosEventType.CLOSED,
    actorId: admin.id,
    meta: { by: 'admin' },
  })
  await NotificationService.notifyUsers({
    userIds: [String(existing.victim)],
    type: NotificationType.SOS_CLOSED_BY_ADMIN,
    title: 'An admin closed your SOS request',
    message: `An admin closed your SOS request: ${reason}. If you still need help, please raise a new request.`,
    sosRequestId: id,
  })
  const assignedId = existing.assignedVolunteer ? String(existing.assignedVolunteer) : null
  await NotificationService.notifyUsers({
    userIds: [...new Set([...(assignedId ? [assignedId] : []), ...heldBy])],
    type: NotificationType.SOS_CLOSED_BY_ADMIN,
    title: 'An admin closed an SOS request',
    message: `An admin closed an SOS request you were working on or were offered: ${reason}. You do not need to respond.`,
    sosRequestId: id,
  })
  await AuditService.record({
    actor: admin,
    action: AuditAction.SOS_CLOSED,
    targetType: AuditTargetType.SOS_REQUEST,
    targetId: id,
    // The reason is on the request itself; it may hold names or numbers, which never go in the audit log.
    summary: `Closed an SOS request that was ${existing.status}`,
    meta: { from: existing.status, volunteersTold: heldBy.length },
  })
  return getStaffView(id)
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
    {
      $set: {
        status: SosStatus.ASSIGNED,
        assignedVolunteer: volunteerId,
        'dispatch.roundOpen': false,
      },
    },
    { session },
  )
  if (!claimed) {
    throw new AppError(httpStatus.CONFLICT, 'This SOS request is no longer waiting for a volunteer')
  }
}

// Assigned -> pending again, only for the volunteer currently holding it. Dispatch starts over from
// the beginning and acts on the next tick: the request has already waited once.
const releaseToPending = async (session: ClientSession, id: string, volunteerId: string) => {
  const released = await SosRequest.findOneAndUpdate(
    { _id: id, assignedVolunteer: volunteerId, status: SosStatus.ASSIGNED },
    {
      $set: {
        status: SosStatus.PENDING,
        assignedVolunteer: null,
        'dispatch.level': 0,
        'dispatch.nextActionAt': new Date(),
        'dispatch.roundOpen': false,
        'dispatch.unserved': false,
      },
      $unset: { 'dispatch.lastOfferAt': '', 'dispatch.escalatedAt': '' },
    },
    { session },
  )
  if (!released) throw new AppError(httpStatus.CONFLICT, RACE_MESSAGE)
}

interface AcceptanceInput {
  sosId: string
  victimId: string
  volunteerId: string
  volunteerName?: string
  // Volunteers whose open offers were withdrawn because this one took the request.
  withdrawnVolunteerIds: string[]
  // Set when an admin gave the request to the volunteer, instead of the volunteer taking it.
  assignedByAdminId?: string
}

// After a volunteer's claim has committed: the victim is told who is coming, the volunteers whose offers
// were withdrawn are told it is taken, and the timeline records both. Shared by the two ways of
// accepting (`PUT /sos/:id/accept` and answering an offer with `PUT /tasks/:id/respond`).
const announceAcceptance = async (input: AcceptanceInput) => {
  const { sosId, victimId, volunteerId, volunteerName, withdrawnVolunteerIds, assignedByAdminId } =
    input
  await NotificationService.notifyUsers({
    userIds: [victimId],
    type: NotificationType.SOS_ASSIGNED,
    title: 'A volunteer accepted your request',
    message: `${volunteerName ?? 'A volunteer'} accepted your SOS request and will set off soon.`,
    sosRequestId: sosId,
  })
  await NotificationService.notifyUsers({
    userIds: withdrawnVolunteerIds,
    type: NotificationType.TASK_CANCELLED,
    title: 'Request taken',
    message: 'Another volunteer took the SOS request that was offered to you.',
    sosRequestId: sosId,
  })
  await SosEventService.record(
    {
      sos: sosId,
      type: SosEventType.ACCEPTED,
      actorId: assignedByAdminId ?? volunteerId,
      subjectId: volunteerId,
      ...(assignedByAdminId && { meta: { direct: true } }),
    },
    ...(withdrawnVolunteerIds.length > 0
      ? [
          {
            sos: sosId,
            type: SosEventType.OFFERS_WITHDRAWN,
            meta: { count: withdrawnVolunteerIds.length },
          },
        ]
      : []),
  )
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

  // Claiming the request, creating the task and withdrawing the offers still out to others stand or
  // fall together.
  const { taskId, withdrawn } = await runInTransaction(async (session) => {
    await claimForVolunteer(session, id, volunteerId)
    const created = await TaskService.createAccepted(session, {
      sosRequest: id,
      volunteer: volunteerId,
      victim: String(sos.victim),
    })
    return {
      taskId: created,
      withdrawn: await TaskService.cancelOtherOffers(session, id, volunteerId),
    }
  })

  const [sosRequest, task] = await Promise.all([getFullView(id), TaskService.getView(taskId)])

  await announceAcceptance({
    sosId: id,
    victimId: String(sos.victim),
    volunteerId,
    volunteerName: sosRequest.assignedVolunteer?.name,
    withdrawnVolunteerIds: withdrawn,
  })
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

    await SosEventService.record({
      sos: id,
      type: SosEventType.BACKED_OUT,
      actorId: volunteerId,
      subjectId: volunteerId,
    })
    await NotificationService.notifyUsers({
      userIds: [String(sos.victim)],
      type: NotificationType.VOLUNTEER_BACKED_OUT,
      title: 'Your volunteer can no longer come',
      message:
        'The volunteer who accepted your SOS request had to back out. Your request is open again for other volunteers.',
      sosRequestId: id,
    })
    return { sosRequestId: id, outcome: 'withdrawn' as const }
  }

  if (sos.status !== SosStatus.PENDING) {
    throw new AppError(httpStatus.CONFLICT, `Cannot decline: the request is already ${sos.status}`)
  }
  // Declining a request that was offered to them is an answer dispatch needs to hear; hiding one they
  // only saw on their map is not.
  const wasOffered = (await TaskService.getStatusFor(id, volunteerId)) === TaskStatus.PENDING
  await TaskService.recordRejection({
    sosRequest: id,
    volunteer: volunteerId,
    victim: String(sos.victim),
  })
  if (wasOffered) await TaskService.afterOfferDeclined(id, volunteerId, new Date())
  return { sosRequestId: id, outcome: 'declined' as const }
}

// --- Dispatch state: the engine in module/dispatch drives these ---------------------------------
// The fields live on the request, so the queries live here; the decisions are in dispatch.service.

export interface DueSos {
  id: string
  victimId: string
  priority: Priority
  needs: ReliefCategory[]
  requiredSkills: Skill[]
  coordinates: Coordinates
  createdAt: Date
  dispatch: {
    level: number
    nextActionAt: Date
    roundOpen: boolean
    unserved: boolean
    priorityBumped: boolean
  }
}

// Pending requests whose next action has come, oldest due first. A paused request is left alone.
const listDueForDispatch = async (now: Date, limit: number): Promise<DueSos[]> => {
  const due = await SosRequest.find({
    status: SosStatus.PENDING,
    'dispatch.paused': { $ne: true },
    'dispatch.nextActionAt': { $lte: now },
  })
    .sort({ 'dispatch.nextActionAt': 1 })
    .limit(limit)
    .select('victim priority needs requiredSkills location createdAt dispatch')
    .lean()

  return due.flatMap((sos) =>
    sos.dispatch?.nextActionAt
      ? [
          {
            id: String(sos._id),
            victimId: String(sos.victim),
            priority: sos.priority,
            needs: sos.needs,
            requiredSkills: sos.requiredSkills ?? [],
            // Validated on write, so a [lng, lat] pair.
            coordinates: sos.location.coordinates as Coordinates,
            createdAt: sos.createdAt,
            dispatch: {
              level: sos.dispatch.level ?? 0,
              nextActionAt: sos.dispatch.nextActionAt,
              roundOpen: sos.dispatch.roundOpen ?? false,
              unserved: sos.dispatch.unserved ?? false,
              priorityBumped: sos.dispatch.priorityBumped ?? false,
            },
          },
        ]
      : [],
  )
}

// Gives every pending request that has never been scheduled its first action time. New requests, and
// ones from before dispatch existed, are picked up this way, so creating a request needs no knowledge
// of the engine. Answers how many were scheduled.
const scheduleUnscheduled = async (
  firstOfferAt: (createdAt: Date, priority: Priority) => Date,
  limit: number,
) => {
  const unscheduled = await SosRequest.find({
    status: SosStatus.PENDING,
    'dispatch.nextActionAt': { $exists: false },
  })
    .limit(limit)
    .select('createdAt priority')
    .lean()
  if (unscheduled.length === 0) return 0

  await SosRequest.bulkWrite(
    unscheduled.map((sos) => ({
      updateOne: {
        filter: { _id: sos._id, 'dispatch.nextActionAt': { $exists: false } },
        update: { $set: { 'dispatch.nextActionAt': firstOfferAt(sos.createdAt, sos.priority) } },
      },
    })),
  )
  return unscheduled.length
}

// Takes this request's turn: moves `nextActionAt` from the value that was read to a lease in the
// future. Of two server instances reading the same due request, only one matches, so only one acts.
// An admin running a step by hand (`ignorePaused`) may do so on a paused request.
const claimDispatchTurn = async (
  id: string,
  expected: Date,
  leaseUntil: Date,
  ignorePaused = false,
) => {
  const claimed = await SosRequest.findOneAndUpdate(
    {
      _id: id,
      status: SosStatus.PENDING,
      ...(!ignorePaused && { 'dispatch.paused': { $ne: true } }),
      'dispatch.nextActionAt': expected,
    },
    { $set: { 'dispatch.nextActionAt': leaseUntil } },
  )
  return claimed !== null
}

export interface DispatchPatch {
  level?: number
  nextActionAt?: Date
  lastOfferAt?: Date
  roundOpen?: boolean
  unserved?: boolean
  escalatedAt?: Date
  priorityBumped?: boolean
  // The engine raised the priority one step (recorded with `priorityBumped`).
  priority?: Priority
}

// Writes the engine's state, only while the request is still pending. False means someone took or closed
// it in the meantime, so what the engine just did (offers) must be undone by the caller.
const saveDispatchState = async (id: string, patch: DispatchPatch) => {
  const { priority, ...state } = patch
  const set: Record<string, unknown> = {}
  for (const [field, value] of Object.entries(state)) {
    if (value !== undefined) set[`dispatch.${field}`] = value
  }
  if (priority) set.priority = priority
  const saved = await SosRequest.findOneAndUpdate(
    { _id: id, status: SosStatus.PENDING },
    { $set: set },
  )
  return saved !== null
}

// One request as the dispatch engine needs it, in any status (an admin acts on requests that are not
// due). Null when there is no such request.
const getDispatchSubject = async (id: string) => {
  const sos = await SosRequest.findById(id)
    .select(
      'victim priority status needs requiredSkills location createdAt assignedVolunteer dispatch',
    )
    .lean()
  if (!sos) return null
  return {
    id: String(sos._id),
    victimId: String(sos.victim),
    status: sos.status,
    priority: sos.priority,
    needs: sos.needs,
    requiredSkills: sos.requiredSkills ?? [],
    // Validated on write, so a [lng, lat] pair.
    coordinates: sos.location.coordinates as Coordinates,
    createdAt: sos.createdAt,
    assignedVolunteerId: sos.assignedVolunteer ? String(sos.assignedVolunteer) : null,
    dispatch: {
      level: sos.dispatch?.level ?? 0,
      nextActionAt: sos.dispatch?.nextActionAt ?? null,
      roundOpen: sos.dispatch?.roundOpen ?? false,
      unserved: sos.dispatch?.unserved ?? false,
      priorityBumped: sos.dispatch?.priorityBumped ?? false,
      paused: sos.dispatch?.paused ?? false,
    },
  }
}

// An admin takes the request off its volunteer (assigned or already on the way): it goes back to pending
// and dispatch starts over. Runs in the caller's transaction with the task being cancelled.
const unassignToPending = async (
  session: ClientSession,
  id: string,
  volunteerId: string,
  pause: boolean,
) => {
  const released = await SosRequest.findOneAndUpdate(
    {
      _id: id,
      assignedVolunteer: volunteerId,
      status: { $in: [SosStatus.ASSIGNED, SosStatus.ON_THE_WAY] },
    },
    {
      $set: {
        status: SosStatus.PENDING,
        assignedVolunteer: null,
        'dispatch.level': 0,
        'dispatch.nextActionAt': new Date(),
        'dispatch.roundOpen': false,
        'dispatch.unserved': false,
        // Pausing in the same write leaves no moment in which the engine could offer it to someone else.
        ...(pause && { 'dispatch.paused': true }),
      },
      $unset: { 'dispatch.lastOfferAt': '', 'dispatch.escalatedAt': '' },
    },
    { session },
  )
  if (!released) throw new AppError(httpStatus.CONFLICT, RACE_MESSAGE)
}

// Stops or restarts automatic offers for one request. 404 unknown, 409 finished or already in that state.
const setDispatchPaused = async (id: string, paused: boolean) => {
  const updated = await SosRequest.findOneAndUpdate(
    {
      _id: id,
      status: { $nin: [...SOS_FINISHED_STATUSES] },
      'dispatch.paused': paused ? { $ne: true } : true,
    },
    { $set: { 'dispatch.paused': paused } },
  )
  if (updated) return
  const existing = await SosRequest.findById(id).select('status').lean()
  if (!existing) throw new AppError(httpStatus.NOT_FOUND, NOT_FOUND_MESSAGE)
  throw new AppError(
    httpStatus.CONFLICT,
    SOS_FINISHED_STATUSES.includes(existing.status)
      ? `This SOS request is already ${existing.status}`
      : `Automatic dispatch is already ${paused ? 'paused' : 'running'} for this request`,
  )
}

// The full view an admin or NGO sees, with the dispatch block.
const getStaffView = async (id: string) => {
  const sos = await findPopulated({ _id: id })
  if (!sos) throw new AppError(httpStatus.NOT_FOUND, NOT_FOUND_MESSAGE)
  return toStaffView(sos)
}

// Everyone asked said no: bring the next dispatch step forward to now (only while a round is open).
const scheduleDispatchNow = async (id: string) => {
  await SosRequest.updateOne(
    { _id: id, status: SosStatus.PENDING, 'dispatch.roundOpen': true },
    { $set: { 'dispatch.nextActionAt': new Date() } },
  )
}

// Current status and priority of these requests, in one query.
const getStatusAndPriority = async (ids: string[]) => {
  const found = await SosRequest.find({ _id: { $in: ids } })
    .select('status priority')
    .lean()
  return new Map(
    found.map((sos) => [String(sos._id), { status: sos.status, priority: sos.priority }]),
  )
}

// What happened to a request, oldest first: offers, answers, escalations, progress. The victim, the
// volunteers who have a part in it, admins and NGOs may read it; only staff see names.
const getTimeline = async (viewer: TokenPayload, id: string, query: TimelineQuery) => {
  const sos = await SosRequest.findById(id).select('victim assignedVolunteer').lean()
  if (!sos) throw new AppError(httpStatus.NOT_FOUND, NOT_FOUND_MESSAGE)

  const isStaff = viewer.role === Role.ADMIN || viewer.role === Role.NGO
  const isVictim = String(sos.victim) === viewer.id
  const isAssigned = sos.assignedVolunteer !== null && String(sos.assignedVolunteer) === viewer.id
  const involved =
    isStaff || isVictim || isAssigned || (await TaskService.hasInvolvement(id, viewer.id))
  if (!involved) {
    throw new AppError(httpStatus.FORBIDDEN, 'You do not have access to this SOS request')
  }
  return SosEventService.listTimeline(id, query, isStaff)
}

// --- Stale requests (commit 23): the job in module/dispatch/stale.service drives these -----------

const STILL_OPEN_STATUSES: SosStatus[] = [
  SosStatus.PENDING,
  SosStatus.ASSIGNED,
  SosStatus.ON_THE_WAY,
]
const HELD_STATUSES: SosStatus[] = [SosStatus.ASSIGNED, SosStatus.ON_THE_WAY]

// Requests from before the stale clock existed start it now, so deploying this does not make every old
// request look abandoned at once.
const startStaleClocks = async (now: Date) => {
  await SosRequest.updateMany(
    { status: { $in: STILL_OPEN_STATUSES }, lastConfirmedAt: { $exists: false } },
    { $set: { lastConfirmedAt: now } },
  )
}

export interface StaleRef {
  id: string
  victimId: string
  priority: Priority
  status: SosStatus
  lastConfirmedAt: Date
  staleCheckedAt: Date | null
}

const toStaleRef = (sos: {
  _id: Types.ObjectId
  victim: Types.ObjectId
  priority: Priority
  status: SosStatus
  lastConfirmedAt?: Date | null
  staleCheckedAt?: Date | null
}): StaleRef[] =>
  sos.lastConfirmedAt
    ? [
        {
          id: String(sos._id),
          victimId: String(sos.victim),
          priority: sos.priority,
          status: sos.status,
          lastConfirmedAt: sos.lastConfirmedAt,
          staleCheckedAt: sos.staleCheckedAt ?? null,
        },
      ]
    : []

// Open requests that have been quiet past their check time and were not asked yet, oldest first. A pending
// request and one a volunteer holds have their own cut-offs.
const listNeedingCheckIn = async (
  pendingCutoff: Date,
  heldCutoff: Date,
  limit: number,
): Promise<StaleRef[]> => {
  const found = await SosRequest.find({
    staleCheckedAt: { $exists: false },
    $or: [
      { status: SosStatus.PENDING, lastConfirmedAt: { $lte: pendingCutoff } },
      { status: { $in: HELD_STATUSES }, lastConfirmedAt: { $lte: heldCutoff } },
    ],
  })
    .sort({ lastConfirmedAt: 1 })
    .limit(limit)
    .select('victim priority status lastConfirmedAt staleCheckedAt')
    .lean()
  return found.flatMap(toStaleRef)
}

// Marks the question as asked, only if nothing has changed since it was read: a victim who answered a
// moment ago keeps their fresh clock. True when this call is the one that asked.
const markCheckedIn = async (ref: StaleRef, now: Date) => {
  const marked = await SosRequest.findOneAndUpdate(
    {
      _id: ref.id,
      status: { $in: STILL_OPEN_STATUSES },
      lastConfirmedAt: ref.lastConfirmedAt,
      staleCheckedAt: { $exists: false },
    },
    { $set: { staleCheckedAt: now } },
  )
  return marked !== null
}

// Requests asked at least `askedBefore` ago and silent since `silentBefore`. Medium and low are closed;
// high and critical are reported once (those not reported yet are the ones listed).
const listUnanswered = async (
  silentBefore: Date,
  askedBefore: Date,
  limit: number,
): Promise<StaleRef[]> => {
  const found = await SosRequest.find({
    status: { $in: STILL_OPEN_STATUSES },
    staleCheckedAt: { $lte: askedBefore },
    lastConfirmedAt: { $lte: silentBefore },
    $or: [
      { priority: { $in: [Priority.MEDIUM, Priority.LOW] } },
      { priority: { $in: [Priority.HIGH, Priority.CRITICAL] }, staleAlertedAt: { $exists: false } },
    ],
  })
    .sort({ lastConfirmedAt: 1 })
    .limit(limit)
    .select('victim priority status lastConfirmedAt staleCheckedAt')
    .lean()
  return found.flatMap(toStaleRef)
}

// Records that staff were told about a quiet high or critical request, once. True for the one caller that did.
const markStaleAlerted = async (ref: StaleRef, now: Date) => {
  const marked = await SosRequest.findOneAndUpdate(
    {
      _id: ref.id,
      status: { $in: STILL_OPEN_STATUSES },
      lastConfirmedAt: ref.lastConfirmedAt,
      staleAlertedAt: { $exists: false },
    },
    { $set: { staleAlertedAt: now } },
  )
  return marked !== null
}

// Closes a request nobody answered for, as the system. Conditional on nothing having changed since it was
// read, so an answer that arrives at the last moment wins. Answers who held it or an offer for it, or null
// when the request changed in the meantime (which is not an error).
const autoCloseStale = async (ref: StaleRef, now: Date) => {
  return runInTransaction(async (session) => {
    const closed = await SosRequest.findOneAndUpdate(
      {
        _id: ref.id,
        status: ref.status,
        lastConfirmedAt: ref.lastConfirmedAt,
        staleCheckedAt: { $exists: true },
      },
      {
        $set: {
          status: SosStatus.CLOSED,
          resolvedBy: ResolvedBy.SYSTEM,
          resolveKind: ResolveKind.STALE,
          resolveReason: STALE_CLOSE_REASON,
          resolvedAt: now,
        },
      },
      { session },
    )
    if (!closed) return null
    return TaskService.cancelOpenTasks(
      session,
      ref.id,
      STALE_CLOSE_REASON,
      STALE_CLOSED_NOTE_PREFIX,
    )
  })
}

// --- Dispatch board and metrics (commit 23) ---------------------------------------------------------

export interface BoardRow {
  id: string
  status: SosStatus
  priority: Priority
  needs: ReliefCategory[]
  address: string | null
  coordinates: Coordinates
  createdAt: Date
  victim: { id: string; name: string }
  assignedVolunteerId: string | null
  dispatch: ReturnType<typeof toDispatchView>
}

// One page of the requests in a status, for a board lane. A lane that waits for a volunteer is ordered most
// urgent first, then oldest; the others oldest first (the longest-running is the one to look at).
const listBoardLane = async (
  status: SosStatus,
  query: { page: number; limit: number },
  byPriority: boolean,
) => {
  const { skip, limit } = getPagination(query)
  const filter = { status }

  const loadIds = async () => {
    if (!byPriority) {
      const found = await SosRequest.find(filter)
        .sort({ createdAt: 1, _id: 1 })
        .skip(skip)
        .limit(limit)
        .select('_id')
        .lean()
      return found.map((sos) => sos._id)
    }
    const rows = await SosRequest.aggregate<{ _id: Types.ObjectId }>([
      { $match: filter },
      { $addFields: { rank: { $indexOfArray: [PRIORITY_ORDER, '$priority'] } } },
      { $sort: { rank: 1, createdAt: 1, _id: 1 } },
      { $skip: skip },
      { $limit: limit },
      { $project: { _id: 1 } },
    ])
    return rows.map((row) => row._id)
  }

  const [ids, total] = await Promise.all([loadIds(), SosRequest.countDocuments(filter)])
  const found = await SosRequest.find({ _id: { $in: ids } })
    .populate<{ victim: { _id: Types.ObjectId; name: string } }>('victim', 'name')
    .lean()
  const byId = new Map(found.map((sos) => [String(sos._id), sos]))
  const rows = ids.flatMap((id): BoardRow[] => {
    const sos = byId.get(String(id))
    if (!sos) return []
    return [
      {
        id: String(sos._id),
        status: sos.status,
        priority: sos.priority,
        needs: sos.needs,
        address: sos.address ?? null,
        coordinates: sos.location.coordinates as Coordinates,
        createdAt: sos.createdAt,
        victim: { id: String(sos.victim._id), name: sos.victim.name },
        assignedVolunteerId: sos.assignedVolunteer ? String(sos.assignedVolunteer) : null,
        dispatch: toDispatchView(sos.dispatch),
      },
    ]
  })
  return { rows, total }
}

export interface SlaTargetsMs {
  assign: Record<Priority, number>
  arrive: Record<Priority, number>
}

// Picks the target for the request's priority inside an aggregation.
const targetByPriority = (targets: Record<Priority, number>) => ({
  $arrayElemAt: [
    PRIORITY_ORDER.map((priority) => targets[priority]),
    { $indexOfArray: [PRIORITY_ORDER, '$priority'] },
  ],
})

const MINUTE_DECIMALS = 10 ** RESPONSE_TIME_DECIMALS
const toMinutes = (ms: number | undefined) =>
  ms === undefined ? 0 : Math.round((ms / MS_PER_MINUTE) * MINUTE_DECIMALS) / MINUTE_DECIMALS

// How fast requests raised in the range were taken and reached, from the timeline events: the first
// `accepted` and the first `completed` of each, minus when the request was raised. Requests from before the
// timeline existed have no events and are left out of the averages. A request breaches its targets when it
// was taken or reached later than the target for its priority, or is still waiting past it.
const getDispatchMetrics = async (range: DateRange, targets: SlaTargetsMs, now: Date) => {
  const isDate = (field: string) => ({ $eq: [{ $type: field }, 'date'] })
  const assignTarget = targetByPriority(targets.assign)
  const arriveTarget = targetByPriority(targets.arrive)
  const age = { $subtract: [now, '$createdAt'] }

  const [result] = await SosRequest.aggregate<{
    assign: { avg: number }[]
    arrive: { avg: number }[]
    breached: { count: number }[]
    unserved: { count: number }[]
  }>([
    { $match: inRange('createdAt', range) },
    {
      $lookup: {
        from: Collection.SOS_EVENTS,
        localField: '_id',
        foreignField: 'sos',
        pipeline: [
          { $match: { type: { $in: [SosEventType.ACCEPTED, SosEventType.COMPLETED] } } },
          { $group: { _id: '$type', at: { $min: '$at' } } },
        ],
        as: 'marks',
      },
    },
    {
      $addFields: {
        acceptedAt: markTime(SosEventType.ACCEPTED),
        completedAt: markTime(SosEventType.COMPLETED),
      },
    },
    {
      $facet: {
        assign: [
          { $match: { acceptedAt: { $type: 'date' } } },
          { $group: { _id: null, avg: { $avg: { $subtract: ['$acceptedAt', '$createdAt'] } } } },
        ],
        arrive: [
          { $match: { completedAt: { $type: 'date' } } },
          { $group: { _id: null, avg: { $avg: { $subtract: ['$completedAt', '$createdAt'] } } } },
        ],
        breached: [
          {
            $match: {
              $expr: {
                $or: [
                  {
                    $cond: [
                      isDate('$acceptedAt'),
                      { $gt: [{ $subtract: ['$acceptedAt', '$createdAt'] }, assignTarget] },
                      {
                        $and: [
                          { $eq: ['$status', SosStatus.PENDING] },
                          { $gt: [age, assignTarget] },
                        ],
                      },
                    ],
                  },
                  {
                    $cond: [
                      isDate('$completedAt'),
                      { $gt: [{ $subtract: ['$completedAt', '$createdAt'] }, arriveTarget] },
                      {
                        $and: [
                          {
                            $in: [
                              '$status',
                              [SosStatus.PENDING, SosStatus.ASSIGNED, SosStatus.ON_THE_WAY],
                            ],
                          },
                          { $gt: [age, arriveTarget] },
                        ],
                      },
                    ],
                  },
                ],
              },
            },
          },
          { $count: 'count' },
        ],
        unserved: [
          { $match: { status: SosStatus.PENDING, 'dispatch.unserved': true } },
          { $count: 'count' },
        ],
      },
    },
  ])

  return {
    avgTimeToAssignMinutes: toMinutes(result?.assign[0]?.avg),
    avgTimeToArriveMinutes: toMinutes(result?.arrive[0]?.avg),
    slaBreachedCount: result?.breached[0]?.count ?? 0,
    unservedCount: result?.unserved[0]?.count ?? 0,
  }
}

// The time of one kind of timeline event in the `marks` the lookup attached, or null.
const markTime = (type: string) => ({
  $arrayElemAt: [
    {
      $map: {
        input: { $filter: { input: '$marks', cond: { $eq: ['$$this._id', type] } } },
        in: '$$this.at',
      },
    },
    0,
  ],
})

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
    byResolveKind: CountRow<string>[]
  }>([
    { $match: inRange('createdAt', range) },
    {
      $facet: {
        byStatus: [{ $group: { _id: '$status', count: { $sum: 1 } } }],
        byPriority: [{ $group: { _id: '$priority', count: { $sum: 1 } } }],
        // Closed requests by why. One an admin closed has no kind of its own; an older one the victim
        // resolved before kinds existed counts as `other`.
        byResolveKind: [
          { $match: { status: SosStatus.CLOSED } },
          {
            $group: {
              _id: {
                $ifNull: [
                  '$resolveKind',
                  {
                    $cond: [
                      { $eq: ['$resolvedBy', ResolvedBy.ADMIN] },
                      ADMIN_CLOSED_KIND,
                      ResolveKind.OTHER,
                    ],
                  },
                ],
              },
              count: { $sum: 1 },
            },
          },
        ],
      },
    },
  ])
  return {
    byStatus: result?.byStatus ?? [],
    byPriority: result?.byPriority ?? [],
    byResolveKind: result?.byResolveKind ?? [],
  }
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
  closeSos,
  confirmStillNeedHelp,
  recordVictimActivity,
  startStaleClocks,
  listBoardLane,
  getDispatchMetrics,
  listNeedingCheckIn,
  markCheckedIn,
  listUnanswered,
  markStaleAlerted,
  autoCloseStale,
  closeUnfinishedForVictim,
  setPriority,
  acceptSos,
  rejectSos,
  getTimeline,
  announceAcceptance,
  listDueForDispatch,
  scheduleUnscheduled,
  claimDispatchTurn,
  saveDispatchState,
  scheduleDispatchNow,
  getStatusAndPriority,
  getDispatchSubject,
  unassignToPending,
  setDispatchPaused,
  getStaffView,
  releaseToPending,
  claimForVolunteer,
  advanceForVolunteer,
  viewForTask,
  getParticipants,
  hasUnfinishedRequests,
}
