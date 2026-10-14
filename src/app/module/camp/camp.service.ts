import httpStatus from 'http-status'
import type { QueryFilter, Types } from 'mongoose'
import { Role } from '../../constants/role'
import { AppError } from '../../errorHelpers/AppError'
import { geoNearStage, toGeoPoint } from '../../lib/geo'
import { changeOccupancy, listStockForCamps, unlinkCampStock } from '../../lib/stock.service'
import { runInTransaction } from '../../lib/transaction'
import type { TokenPayload } from '../../utils/jwt'
import { buildMeta, getPagination } from '../../utils/pagination'
import { User } from '../user/user.model'
import { UserService } from '../user/user.service'
import type {
  CreateCampPayload,
  ListCampsQuery,
  MyCampsQuery,
  NearbyCampsQuery,
  OccupancyChange,
  UpdateCampPayload,
} from './camp.interface'
import { Camp } from './camp.model'

const CAMP_NOT_FOUND_MESSAGE = 'Camp not found'
const DISTANCE_FIELD = 'distanceMeters'

interface Person {
  _id: Types.ObjectId
  name: string
  phone?: string | null
}

const POPULATE_CAMP = [
  { path: 'ngo', select: 'name' },
  { path: 'assignedVolunteers', select: 'name phone' },
]

const findPopulated = (filter: QueryFilter<unknown>) =>
  Camp.find(filter).populate<{ ngo: Person; assignedVolunteers: Person[] }>(POPULATE_CAMP).lean()

type CampRecord = Awaited<ReturnType<typeof findPopulated>>[number]

const availableSpots = (camp: { capacity: number; currentOccupancy: number }) =>
  Math.max(camp.capacity - camp.currentOccupancy, 0)

// The full picture, for the camp's NGO and for admins.
const toCampView = (camp: CampRecord) => ({
  id: String(camp._id),
  ngo: { id: String(camp.ngo._id), name: camp.ngo.name },
  name: camp.name,
  location: camp.location,
  address: camp.address ?? null,
  capacity: camp.capacity,
  currentOccupancy: camp.currentOccupancy,
  availableSpots: availableSpots(camp),
  isActive: camp.isActive,
  assignedVolunteers: camp.assignedVolunteers.map((volunteer) => ({
    id: String(volunteer._id),
    name: volunteer.name,
    phone: volunteer.phone ?? null,
  })),
  createdAt: camp.createdAt,
  updatedAt: camp.updatedAt,
})

interface NearbyRow {
  _id: Types.ObjectId
  name: string
  address?: string | null
  location: { type: string; coordinates: number[] }
  capacity: number
  currentOccupancy: number
  distanceMeters: number
  // The camp's NGO, joined in by listNearby (name only).
  ngoAccount?: { name: string }[]
}

// What a victim sees when looking for shelter: where it is, who runs it and whether there is room.
// Nothing about the volunteers, and only the NGO's name.
const toNearbyView = (camp: NearbyRow) => ({
  id: String(camp._id),
  name: camp.name,
  ngo: { name: camp.ngoAccount?.[0]?.name ?? null },
  address: camp.address ?? null,
  location: camp.location,
  capacity: camp.capacity,
  currentOccupancy: camp.currentOccupancy,
  availableSpots: availableSpots(camp),
  distanceMeters: Math.round(camp.distanceMeters),
})

// An NGO works only on its own camps; an admin on any (D: admins may edit and delete every camp).
const scopeTo = (viewer: TokenPayload): QueryFilter<unknown> =>
  viewer.role === Role.ADMIN ? {} : { ngo: viewer.id }

const manageableFilter = (viewer: TokenPayload, id: string): QueryFilter<unknown> => ({
  _id: id,
  isDeleted: false,
  ...scopeTo(viewer),
})

const getCampView = async (id: string) => {
  const [camp] = await findPopulated({ _id: id })
  if (!camp) throw new AppError(httpStatus.NOT_FOUND, CAMP_NOT_FOUND_MESSAGE)
  return toCampView(camp)
}

// Another module (inventory) asking: may this NGO put stock in this camp?
const isOwnedByNgo = async (campId: string, ngoId: string) =>
  (await Camp.exists({ _id: campId, ngo: ngoId, isDeleted: false })) !== null

const createCamp = async (ngoId: string, payload: CreateCampPayload) => {
  const { coordinates, ...fields } = payload
  const camp = await Camp.create({ ...fields, ngo: ngoId, location: toGeoPoint(coordinates) })
  return getCampView(String(camp._id))
}

const listCamps = async (viewer: TokenPayload, query: ListCampsQuery) => {
  const { page, limit, isActive } = query
  const filter: QueryFilter<unknown> = { isDeleted: false, ...scopeTo(viewer) }
  if (isActive !== undefined) filter.isActive = isActive

  const [camps, total] = await Promise.all([
    Camp.find(filter)
      .sort({ isActive: -1, updatedAt: -1, _id: -1 })
      .skip(getPagination(query).skip)
      .limit(limit)
      .populate<{ ngo: Person; assignedVolunteers: Person[] }>(POPULATE_CAMP)
      .lean(),
    Camp.countDocuments(filter),
  ])

  return { items: camps.map(toCampView), meta: buildMeta({ page, limit }, total) }
}

// Active camps around a point, nearest first. $geoNear gives the distance and a true total.
const listNearby = async (query: NearbyCampsQuery) => {
  const { page, limit } = query

  const [result] = await Camp.aggregate<{ items: NearbyRow[]; total: { count: number }[] }>([
    geoNearStage(query, { isActive: true, isDeleted: false }, DISTANCE_FIELD),
    {
      $facet: {
        items: [
          { $skip: getPagination(query).skip },
          { $limit: limit },
          {
            $lookup: {
              from: User.collection.name,
              localField: 'ngo',
              foreignField: '_id',
              pipeline: [{ $project: { name: 1 } }],
              as: 'ngoAccount',
            },
          },
        ],
        total: [{ $count: 'count' }],
      },
    },
  ])

  return {
    items: (result?.items ?? []).map(toNearbyView),
    meta: buildMeta({ page, limit }, result?.total[0]?.count ?? 0),
  }
}

// The volunteer's own camps, each with what is in stock there for handing out.
const listMyAssigned = async (volunteerId: string, query: MyCampsQuery) => {
  const { page, limit } = query
  const filter: QueryFilter<unknown> = {
    assignedVolunteers: volunteerId,
    isActive: true,
    isDeleted: false,
  }

  const [camps, total] = await Promise.all([
    Camp.find(filter)
      .select('name address location capacity currentOccupancy isActive')
      .sort({ updatedAt: -1, _id: -1 })
      .skip(getPagination(query).skip)
      .limit(limit)
      .lean(),
    Camp.countDocuments(filter),
  ])

  const stock = await listStockForCamps(camps.map((camp) => camp._id))
  const items = camps.map((camp) => ({
    id: String(camp._id),
    name: camp.name,
    address: camp.address ?? null,
    location: camp.location,
    capacity: camp.capacity,
    currentOccupancy: camp.currentOccupancy,
    availableSpots: availableSpots(camp),
    isActive: camp.isActive,
    inventory: stock
      .filter((item) => String(item.camp) === String(camp._id))
      .map((item) => ({
        id: String(item._id),
        itemName: item.itemName,
        category: item.category,
        quantity: item.quantity,
        unit: item.unit,
        lowStockThreshold: item.lowStockThreshold,
        isLow: item.isLow,
      })),
  }))

  return { items, meta: buildMeta({ page, limit }, total) }
}

// A guarded update just failed. Say why: no such camp for this caller (404) or the change would
// break a limit (409).
const explainFailure = async (viewer: TokenPayload, id: string, conflictMessage: string) => {
  if (!(await Camp.exists(manageableFilter(viewer, id)))) {
    throw new AppError(httpStatus.NOT_FOUND, CAMP_NOT_FOUND_MESSAGE)
  }
  throw new AppError(httpStatus.CONFLICT, conflictMessage)
}

const updateCamp = async (viewer: TokenPayload, id: string, payload: UpdateCampPayload) => {
  const { coordinates, ...fields } = payload

  const set: Record<string, unknown> = Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  )
  if (coordinates) set.location = toGeoPoint(coordinates)

  // Occupancy may never exceed capacity, whichever of the two the caller changes. The numbers not
  // being changed are read from the document inside the same update, so there is no window for
  // another request to slip a different value in.
  const changesLimits = fields.capacity !== undefined || fields.currentOccupancy !== undefined
  const guard = changesLimits && {
    $expr: {
      $lte: [fields.currentOccupancy ?? '$currentOccupancy', fields.capacity ?? '$capacity'],
    },
  }

  const updated = await Camp.findOneAndUpdate(
    { ...manageableFilter(viewer, id), ...guard },
    { $set: set },
    { runValidators: true },
  )
  if (!updated) {
    return explainFailure(viewer, id, 'Occupancy cannot be more than capacity')
  }
  return getCampView(id)
}

// Soft delete. The camp's stock goes back to the NGO's general store, in the same transaction.
const deleteCamp = async (viewer: TokenPayload, id: string) => {
  await runInTransaction(async (session) => {
    const deleted = await Camp.findOneAndUpdate(
      manageableFilter(viewer, id),
      { $set: { isDeleted: true, deletedAt: new Date(), isActive: false } },
      { session },
    )
    if (!deleted) throw new AppError(httpStatus.NOT_FOUND, CAMP_NOT_FOUND_MESSAGE)
    await unlinkCampStock(session, id)
  })
}

// The camp is checked first, so a caller can't learn whether a volunteer id exists by probing
// camps that aren't theirs. Assigning someone already assigned is a no-op, not an error.
const assignVolunteer = async (viewer: TokenPayload, id: string, volunteerId: string) => {
  if (!(await Camp.exists(manageableFilter(viewer, id)))) {
    throw new AppError(httpStatus.NOT_FOUND, CAMP_NOT_FOUND_MESSAGE)
  }
  if (!(await UserService.isActiveVolunteer(volunteerId))) {
    throw new AppError(httpStatus.NOT_FOUND, 'Volunteer not found')
  }

  const updated = await Camp.findOneAndUpdate(manageableFilter(viewer, id), {
    $addToSet: { assignedVolunteers: volunteerId },
  })
  if (!updated) throw new AppError(httpStatus.NOT_FOUND, CAMP_NOT_FOUND_MESSAGE)
  return getCampView(id)
}

const unassignVolunteer = async (viewer: TokenPayload, id: string, volunteerId: string) => {
  const updated = await Camp.findOneAndUpdate(
    { ...manageableFilter(viewer, id), assignedVolunteers: volunteerId },
    { $pull: { assignedVolunteers: volunteerId } },
  )
  if (!updated) {
    if (!(await Camp.exists(manageableFilter(viewer, id)))) {
      throw new AppError(httpStatus.NOT_FOUND, CAMP_NOT_FOUND_MESSAGE)
    }
    throw new AppError(httpStatus.NOT_FOUND, 'That volunteer is not assigned to this camp')
  }
  return getCampView(id)
}

// Check people in (delta > 0) or out (delta < 0) with one guarded update: occupancy stays within
// 0..capacity even if two staff members do this at the same instant.
const adjustOccupancy = async (viewer: TokenPayload, id: string, change: OccupancyChange) => {
  const updated = await changeOccupancy(manageableFilter(viewer, id), change.delta)
  if (!updated) {
    return explainFailure(
      viewer,
      id,
      change.delta > 0
        ? 'Not enough room: this would put the camp over its capacity'
        : 'This would take the camp below 0 people',
    )
  }
  return getCampView(id)
}

// The camp, if this volunteer is assigned to it and it is open (active, not deleted); else null.
// Distribution asks this: a volunteer can only hand out stock from a camp they work at.
const getAssignedOpenCamp = async (campId: string, volunteerId: string) => {
  const camp = await Camp.findOne({
    _id: campId,
    assignedVolunteers: volunteerId,
    isActive: true,
    isDeleted: false,
  })
    .select('ngo name')
    .lean()
  return camp ? { id: String(camp._id), ngo: String(camp.ngo), name: camp.name } : null
}

// Active camps for the live map, newest first. Public facts only: where, how full, who runs it.
const listActiveForMap = async (limit: number) => {
  const camps = await Camp.find({ isActive: true, isDeleted: false })
    .select('ngo name location address capacity currentOccupancy')
    .sort({ updatedAt: -1, _id: -1 })
    .limit(limit)
    .populate<{ ngo: { _id: Types.ObjectId; name: string } }>('ngo', 'name')
    .lean()

  return camps.map((camp) => ({
    id: String(camp._id),
    name: camp.name,
    location: camp.location,
    address: camp.address ?? null,
    capacity: camp.capacity,
    currentOccupancy: camp.currentOccupancy,
    availableSpots: availableSpots(camp),
    ngo: { id: String(camp.ngo._id), name: camp.ngo.name },
  }))
}

export const CampService = {
  listActiveForMap,
  getAssignedOpenCamp,
  createCamp,
  listCamps,
  listNearby,
  listMyAssigned,
  updateCamp,
  deleteCamp,
  assignVolunteer,
  unassignVolunteer,
  adjustOccupancy,
  isOwnedByNgo,
}
