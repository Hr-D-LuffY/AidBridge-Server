import httpStatus from 'http-status'
import type { QueryFilter, Types } from 'mongoose'
import { Role } from '../../constants/role'
import {
  MAX_ACTIVE_SOS_PER_VICTIM,
  MAX_SOS_MEDIA_ITEMS,
  ResolvedBy,
  SOS_FINISHED_STATUSES,
  SOS_MEDIA_FOLDER,
  SOS_MEDIA_FORMATS,
  SOS_TRANSITIONS,
  SosStatus,
} from '../../constants/sos'
import type { Priority } from '../../constants/relief'
import { AppError } from '../../errorHelpers/AppError'
import {
  assertMediaStorageConfigured,
  deleteMedia,
  type StoredMedia,
  uploadMediaBuffer,
} from '../../lib/cloudinary'
import { approximateCoordinates, type Coordinates, geoNearStage, toGeoPoint } from '../../lib/geo'
import type { TokenPayload } from '../../utils/jwt'
import { buildMeta, getPagination } from '../../utils/pagination'
import { assertTransition } from '../../utils/transitions'
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

const POPULATE_PEOPLE = [
  { path: 'victim', select: 'name phone' },
  { path: 'assignedVolunteer', select: 'name phone' },
]

// Every read that is shown to a person goes through here so victim and volunteer arrive populated.
const findPopulated = (filter: QueryFilter<unknown>) =>
  SosRequest.findOne(filter)
    .populate<{ victim: Person; assignedVolunteer: Person | null }>(POPULATE_PEOPLE)
    .lean()

type SosRecord = NonNullable<Awaited<ReturnType<typeof findPopulated>>>

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
// no phone, no street address, no photos and only a rounded position. Once they accept it
// (commit 5) they are the assigned volunteer and get the full view.
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

// Admins and NGOs see every request. Everyone else sees the ones they raised or were assigned.
const listSos = async (viewer: TokenPayload, query: ListSosQuery) => {
  const { page, limit, status, priority } = query

  const filter: QueryFilter<unknown> = {}
  if (viewer.role !== Role.ADMIN && viewer.role !== Role.NGO) {
    filter.$or = [{ victim: viewer.id }, { assignedVolunteer: viewer.id }]
  }
  if (status) filter.status = status
  if (priority) filter.priority = priority

  const [items, total] = await Promise.all([
    SosRequest.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip(getPagination(query).skip)
      .limit(limit)
      .populate<{ victim: Person; assignedVolunteer: Person | null }>(POPULATE_PEOPLE)
      .lean(),
    SosRequest.countDocuments(filter),
  ])

  return { items: items.map(toFullView), meta: buildMeta({ page, limit }, total) }
}

// Pending requests around a point, nearest first, for a volunteer's map. Always the limited view:
// accepting a request is what unlocks the contact details.
const listNearby = async (query: NearbySosQuery) => {
  const { page, limit } = query

  // TODO(commit 5): also hide requests this volunteer already rejected (they live in Task).
  const [result] = await SosRequest.aggregate<{
    items: (LimitedSource & { distanceMeters: number })[]
    total: { count: number }[]
  }>([
    geoNearStage(query, { status: SosStatus.PENDING }, DISTANCE_FIELD),
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
  if (isOwner || isAssigned || isStaff) return toFullView(sos)

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

  // TODO(commit 8): notify the assigned volunteer that the victim changed the request.

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
    { runValidators: true },
  )
  if (!closed) throw new AppError(httpStatus.CONFLICT, RACE_MESSAGE)

  // TODO(commit 5): cancel the assigned volunteer's open Task in the same transaction as the close.
  // TODO(commit 8): notify the assigned volunteer that the victim resolved the request.

  return getFullView(id)
}

const setPriority = async (id: string, priority: Priority) => {
  const updated = await SosRequest.findByIdAndUpdate(
    id,
    { $set: { priority } },
    { runValidators: true },
  )
  if (!updated) throw new AppError(httpStatus.NOT_FOUND, NOT_FOUND_MESSAGE)
  return getFullView(id)
}

const getFullView = async (id: string) => {
  const sos = await findPopulated({ _id: id })
  if (!sos) throw new AppError(httpStatus.NOT_FOUND, NOT_FOUND_MESSAGE)
  return toFullView(sos)
}

export const SosService = {
  createSos,
  listSos,
  listNearby,
  getSosById,
  updateSos,
  addMedia,
  resolveSos,
  setPriority,
}
