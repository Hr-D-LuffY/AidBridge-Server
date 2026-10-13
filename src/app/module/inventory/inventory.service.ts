import httpStatus from 'http-status'
import type { QueryFilter, Types } from 'mongoose'
import type { ReliefCategory } from '../../constants/relief'
import { AppError } from '../../errorHelpers/AppError'
import { buildMeta, getPagination } from '../../utils/pagination'
import { CampService } from '../camp/camp.service'
import type {
  AlertsQuery,
  CreateItemPayload,
  ListItemsQuery,
  UpdateItemPayload,
} from './inventory.interface'
import { Inventory } from './inventory.model'

const ITEM_NOT_FOUND_MESSAGE = 'Item not found'
const CAMP_NOT_FOUND_MESSAGE = 'Selected camp was not found for this NGO'
const RACE_MESSAGE = 'This item changed while you were updating it. Please try again'

interface CampSummary {
  _id: Types.ObjectId
  name: string
  address?: string | null
  isActive: boolean
}

interface ItemFields {
  _id: Types.ObjectId
  camp?: CampSummary | null
  itemName: string
  category: ReliefCategory
  quantity: number
  unit: string
  lowStockThreshold: number
  isLow: boolean
  createdAt: Date
  updatedAt: Date
}

const toItemView = (item: ItemFields) => ({
  id: String(item._id),
  camp: item.camp
    ? {
        id: String(item.camp._id),
        name: item.camp.name,
        address: item.camp.address ?? null,
        isActive: item.camp.isActive,
      }
    : null,
  itemName: item.itemName,
  category: item.category,
  quantity: item.quantity,
  unit: item.unit,
  lowStockThreshold: item.lowStockThreshold,
  isLow: item.isLow,
  createdAt: item.createdAt,
  updatedAt: item.updatedAt,
})

const findPopulated = (filter: QueryFilter<unknown>) =>
  Inventory.find(filter).populate<{ camp: CampSummary | null }>('camp', 'name address isActive')

// A camp can hold this NGO's stock only if the NGO owns it (and it isn't deleted).
const assertCampOwned = async (campId: string, ngoId: string) => {
  if (!(await CampService.isOwnedByNgo(campId, ngoId))) {
    throw new AppError(httpStatus.BAD_REQUEST, CAMP_NOT_FOUND_MESSAGE)
  }
}

const getItemView = async (id: string) => {
  const [item] = await findPopulated({ _id: id }).lean()
  if (!item) throw new AppError(httpStatus.NOT_FOUND, ITEM_NOT_FOUND_MESSAGE)
  return toItemView(item)
}

// Low-stock items first, then the most recently changed.
const listItems = async (ngoId: string, query: ListItemsQuery) => {
  const { page, limit, camp, category, isLow } = query
  const filter: QueryFilter<unknown> = { ngo: ngoId }
  if (camp) filter.camp = camp
  if (category) filter.category = category
  if (isLow !== undefined) filter.isLow = isLow

  const [items, total] = await Promise.all([
    findPopulated(filter)
      .sort({ isLow: -1, updatedAt: -1, _id: -1 })
      .skip(getPagination(query).skip)
      .limit(limit)
      .lean(),
    Inventory.countDocuments(filter),
  ])

  return { items: items.map(toItemView), meta: buildMeta({ page, limit }, total) }
}

// Items at or below their threshold, emptiest first.
const listAlerts = async (ngoId: string, query: AlertsQuery) => {
  const { page, limit } = query
  const filter: QueryFilter<unknown> = { ngo: ngoId, isLow: true }

  const [items, total] = await Promise.all([
    findPopulated(filter)
      .sort({ quantity: 1, updatedAt: -1, _id: -1 })
      .skip(getPagination(query).skip)
      .limit(limit)
      .lean(),
    Inventory.countDocuments(filter),
  ])

  return { items: items.map(toItemView), meta: buildMeta({ page, limit }, total) }
}

const createItem = async (ngoId: string, payload: CreateItemPayload) => {
  if (payload.camp) await assertCampOwned(payload.camp, ngoId)

  // `isLow` is worked out by the model's validate hook.
  const item = await Inventory.create({ ...payload, ngo: ngoId })
  return getItemView(String(item._id))
}

const updateItem = async (ngoId: string, id: string, payload: UpdateItemPayload) => {
  const existing = await Inventory.findOne({ _id: id, ngo: ngoId }).lean()
  if (!existing) throw new AppError(httpStatus.NOT_FOUND, ITEM_NOT_FOUND_MESSAGE)
  if (payload.camp) await assertCampOwned(payload.camp, ngoId)

  const set: Record<string, unknown> = Object.fromEntries(
    Object.entries(payload).filter(([, value]) => value !== undefined),
  )
  const quantity = payload.quantity ?? existing.quantity
  const lowStockThreshold = payload.lowStockThreshold ?? existing.lowStockThreshold
  set.isLow = quantity <= lowStockThreshold

  // The filter pins the quantity and threshold that `isLow` was worked out from. If a distribution
  // took stock in the meantime the update doesn't match, instead of saving a stale flag.
  const updated = await Inventory.findOneAndUpdate(
    {
      _id: id,
      ngo: ngoId,
      quantity: existing.quantity,
      lowStockThreshold: existing.lowStockThreshold,
    },
    { $set: set },
    { runValidators: true },
  )
  if (!updated) throw new AppError(httpStatus.CONFLICT, RACE_MESSAGE)
  return getItemView(id)
}

// Hard delete. Distributions keep the item's name and unit, so nothing needs the item itself later.
const deleteItem = async (ngoId: string, id: string) => {
  const deleted = await Inventory.findOneAndDelete({ _id: id, ngo: ngoId })
  if (!deleted) throw new AppError(httpStatus.NOT_FOUND, ITEM_NOT_FOUND_MESSAGE)
}

// One item as it sits in one camp (null if it isn't there). Distribution asks this to explain why a
// hand-out can't happen.
const getCampItem = async (campId: string, itemId: string) => {
  const item = await Inventory.findOne({ _id: itemId, camp: campId })
    .select('itemName quantity unit')
    .lean()
  return item ? { itemName: item.itemName, quantity: item.quantity, unit: item.unit } : null
}

export const InventoryService = {
  getCampItem,
  listItems,
  listAlerts,
  createItem,
  updateItem,
  deleteItem,
}
