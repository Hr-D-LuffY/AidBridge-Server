import httpStatus from 'http-status'
import type { QueryFilter, Types, UpdateQuery } from 'mongoose'
import { IncidentStatus, SosLinkAction } from '../../constants/incident'
import type { DisasterType, Priority } from '../../constants/relief'
import { AppError } from '../../errorHelpers/AppError'
import { toGeoPoint } from '../../lib/geo'
import { buildMeta, getPagination } from '../../utils/pagination'
import { SosService } from '../sos/sos.service'
import type {
  CreateIncidentPayload,
  LinkSosPayload,
  ListIncidentsQuery,
  UpdateIncidentPayload,
} from './incident.interface'
import { Incident } from './incident.model'

const NOT_FOUND_MESSAGE = 'Incident not found'
const NOT_DELETED = { isDeleted: false }

interface Creator {
  _id: Types.ObjectId
  name: string
}

interface IncidentFields {
  _id: Types.ObjectId
  createdBy: Creator
  title: string
  disasterType: DisasterType
  location: { type: string; coordinates: number[] }
  address?: string | null
  description?: string | null
  startDate: Date
  endDate?: Date | null
  status: IncidentStatus
  priority: Priority
  sosRequests: Types.ObjectId[]
  createdAt: Date
  updatedAt: Date
}

// `totalRescued` is counted from the linked requests that have been rescued; `rescuedIds` is that
// set for the page being shown. The ids of the linked requests themselves are only listed when
// asked for (right after linking), since an incident can gather many.
const toIncidentView = (
  incident: IncidentFields,
  rescuedIds: Set<string>,
  options: { includeLinks?: boolean } = {},
) => {
  const linked = incident.sosRequests.map(String)
  return {
    id: String(incident._id),
    title: incident.title,
    disasterType: incident.disasterType,
    location: incident.location,
    address: incident.address ?? null,
    description: incident.description ?? null,
    startDate: incident.startDate,
    endDate: incident.endDate ?? null,
    status: incident.status,
    priority: incident.priority,
    createdBy: { id: String(incident.createdBy._id), name: incident.createdBy.name },
    linkedRequests: linked.length,
    totalRescued: linked.filter((id) => rescuedIds.has(id)).length,
    ...(options.includeLinks && { sosRequests: linked }),
    createdAt: incident.createdAt,
    updatedAt: incident.updatedAt,
  }
}

const findPopulated = (filter: QueryFilter<unknown>) =>
  Incident.find(filter).populate<{ createdBy: Creator }>('createdBy', 'name')

const viewsFor = async (incidents: IncidentFields[], options: { includeLinks?: boolean } = {}) => {
  const rescuedIds = await SosService.getRescuedIds(
    incidents.flatMap((incident) => incident.sosRequests.map(String)),
  )
  return incidents.map((incident) => toIncidentView(incident, rescuedIds, options))
}

const getIncidentView = async (id: string, options: { includeLinks?: boolean } = {}) => {
  const [incident] = await findPopulated({ _id: id, ...NOT_DELETED }).lean()
  if (!incident) throw new AppError(httpStatus.NOT_FOUND, NOT_FOUND_MESSAGE)
  const [view] = await viewsFor([incident], options)
  if (!view) throw new AppError(httpStatus.NOT_FOUND, NOT_FOUND_MESSAGE)
  return view
}

const createIncident = async (adminId: string, payload: CreateIncidentPayload) => {
  const { coordinates, ...fields } = payload
  const incident = await Incident.create({
    ...fields,
    createdBy: adminId,
    location: toGeoPoint(coordinates),
  })
  return getIncidentView(String(incident._id))
}

// Any logged-in user can read the incident history.
const listIncidents = async (query: ListIncidentsQuery) => {
  const { page, limit, status, priority, disasterType } = query
  const filter: QueryFilter<unknown> = { ...NOT_DELETED }
  if (status) filter.status = status
  if (priority) filter.priority = priority
  if (disasterType) filter.disasterType = disasterType

  const [incidents, total] = await Promise.all([
    findPopulated(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip(getPagination(query).skip)
      .limit(limit)
      .lean(),
    Incident.countDocuments(filter),
  ])

  return { items: await viewsFor(incidents), meta: buildMeta({ page, limit }, total) }
}

// Resolving closes the incident and stamps an end date (now, unless one is given); reopening clears
// it. The end date can never fall before the start date, whichever of the two is being changed.
const updateIncident = async (id: string, payload: UpdateIncidentPayload) => {
  const existing = await Incident.findOne({ _id: id, ...NOT_DELETED }).lean()
  if (!existing) throw new AppError(httpStatus.NOT_FOUND, NOT_FOUND_MESSAGE)

  const { coordinates, startDate, endDate, status, ...fields } = payload
  const nextStatus = status ?? existing.status
  const nextStart = startDate ?? existing.startDate

  const set: Record<string, unknown> = Object.fromEntries(
    Object.entries({ ...fields, startDate, status }).filter(([, value]) => value !== undefined),
  )
  if (coordinates) set.location = toGeoPoint(coordinates)

  const update: UpdateQuery<unknown> = { $set: set }
  if (nextStatus === IncidentStatus.RESOLVED) {
    const nextEnd = endDate ?? existing.endDate ?? new Date()
    if (nextEnd < nextStart) {
      throw new AppError(httpStatus.BAD_REQUEST, 'End date cannot be before start date')
    }
    set.endDate = nextEnd
  } else {
    if (endDate) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        'An active incident has no end date. Set the status to resolved to give it one',
      )
    }
    update.$unset = { endDate: '' }
  }

  const updated = await Incident.findOneAndUpdate({ _id: id, ...NOT_DELETED }, update, {
    runValidators: true,
  })
  if (!updated) throw new AppError(httpStatus.NOT_FOUND, NOT_FOUND_MESSAGE)
  return getIncidentView(id)
}

const setPriority = async (id: string, priority: Priority) => {
  const updated = await Incident.findOneAndUpdate(
    { _id: id, ...NOT_DELETED },
    { $set: { priority } },
    { runValidators: true },
  )
  if (!updated) throw new AppError(httpStatus.NOT_FOUND, NOT_FOUND_MESSAGE)
  return getIncidentView(id)
}

// Link SOS requests to the incident, or take them off again. Linking something that is already
// linked changes nothing. Every id must be a real request, so a typo can't be linked silently.
const linkRequests = async (id: string, payload: LinkSosPayload) => {
  const { action, sosRequestIds } = payload
  if (!(await Incident.exists({ _id: id, ...NOT_DELETED }))) {
    throw new AppError(httpStatus.NOT_FOUND, NOT_FOUND_MESSAGE)
  }

  if (action === SosLinkAction.LINK) {
    const existing = new Set(await SosService.getExistingIds(sosRequestIds))
    const missing = sosRequestIds.filter((sosId) => !existing.has(sosId))
    if (missing.length > 0) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        'Some of those SOS requests do not exist',
        missing.map((sosId) => ({ sosRequestId: sosId })),
      )
    }
    await Incident.updateOne(
      { _id: id, ...NOT_DELETED },
      { $addToSet: { sosRequests: { $each: sosRequestIds } } },
    )
  } else {
    await Incident.updateOne(
      { _id: id, ...NOT_DELETED },
      { $pull: { sosRequests: { $in: sosRequestIds } } },
    )
  }

  return getIncidentView(id, { includeLinks: true })
}

// Soft delete: hidden from every list, kept in the database as a record.
const deleteIncident = async (id: string) => {
  const deleted = await Incident.findOneAndUpdate(
    { _id: id, ...NOT_DELETED },
    { $set: { isDeleted: true, deletedAt: new Date() } },
  )
  if (!deleted) throw new AppError(httpStatus.NOT_FOUND, NOT_FOUND_MESSAGE)
}

export const IncidentService = {
  createIncident,
  listIncidents,
  updateIncident,
  setPriority,
  linkRequests,
  deleteIncident,
}
