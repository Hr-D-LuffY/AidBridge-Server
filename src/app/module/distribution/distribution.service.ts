import httpStatus from 'http-status'
import type { QueryFilter, Types } from 'mongoose'
import { DEFAULT_RECIPIENT_NAME } from '../../constants/distribution'
import { Role } from '../../constants/role'
import type { ReliefCategory } from '../../constants/relief'
import { AppError } from '../../errorHelpers/AppError'
import { deductStock } from '../../lib/stock.service'
import { runInTransaction } from '../../lib/transaction'
import type { TokenPayload } from '../../utils/jwt'
import { type DateRange, inRange } from '../../utils/dateRange'
import { buildMeta, getPagination } from '../../utils/pagination'
import { CampService } from '../camp/camp.service'
import { InventoryService } from '../inventory/inventory.service'
import { TaskService } from '../task/task.service'
import { UserService } from '../user/user.service'
import type { CreateDistributionPayload, ListDistributionsQuery } from './distribution.interface'
import { Distribution } from './distribution.model'

const STOCK_CHANGED_MESSAGE =
  'The stock changed while you were handing it out. Check the amount left and try again'

interface Named {
  _id: Types.ObjectId
  name: string
  address?: string | null
  phone?: string | null
}

interface DistributionFields {
  _id: Types.ObjectId
  camp: Named
  sosRequest: Types.ObjectId
  task: Types.ObjectId
  volunteer: Named
  recipient: Named
  recipientName: string
  item: {
    inventoryItem: Types.ObjectId
    itemName: string
    category: ReliefCategory
    quantity: number
    unit: string
  }
  notes?: string | null
  distributedAt: Date
}

const toDistributionView = (record: DistributionFields) => ({
  id: String(record._id),
  camp: {
    id: String(record.camp._id),
    name: record.camp.name,
    address: record.camp.address ?? null,
  },
  sosRequest: String(record.sosRequest),
  task: String(record.task),
  volunteer: {
    id: String(record.volunteer._id),
    name: record.volunteer.name,
    phone: record.volunteer.phone ?? null,
  },
  // The name is the one written down at the time. Contact details of victims are not repeated here.
  recipient: { id: String(record.recipient._id), name: record.recipientName },
  item: {
    id: String(record.item.inventoryItem),
    itemName: record.item.itemName,
    category: record.item.category,
    quantity: record.item.quantity,
    unit: record.item.unit,
  },
  notes: record.notes ?? null,
  distributedAt: record.distributedAt,
})

const findPopulated = (filter: QueryFilter<unknown>) =>
  Distribution.find(filter).populate<{
    camp: Named
    volunteer: Named
    recipient: Named
  }>([
    { path: 'camp', select: 'name address' },
    { path: 'volunteer', select: 'name phone' },
    { path: 'recipient', select: 'name' },
  ])

const getView = async (id: string) => {
  const [record] = await findPopulated({ _id: id }).lean()
  if (!record) throw new AppError(httpStatus.NOT_FOUND, 'Distribution record not found')
  return toDistributionView(record)
}

// Why a hand-out can't go ahead, said before touching anything.
const assertStockAvailable = async (campId: string, itemId: string, quantity: number) => {
  const item = await InventoryService.getCampItem(campId, itemId)
  if (!item) {
    throw new AppError(httpStatus.NOT_FOUND, 'Selected item was not found in this camp inventory')
  }
  if (item.quantity < quantity) {
    throw new AppError(
      httpStatus.CONFLICT,
      `Not enough ${item.itemName} in this camp. Available: ${item.quantity} ${item.unit}`,
    )
  }
}

// A volunteer hands one item out to the victim they are helping. The stock comes off and the record
// is written in one transaction, and the stock comes off with a conditional update, so the camp can
// never be oversold. The task is NOT completed here (D7): one rescue can involve several items, and
// the volunteer finishes it with PUT /tasks/:id/status.
const createDistribution = async (volunteerId: string, payload: CreateDistributionPayload) => {
  const { taskId, campId, inventoryItemId, quantity, notes } = payload

  const task = await TaskService.getActiveTask(taskId, volunteerId)
  const camp = await CampService.getAssignedOpenCamp(campId, volunteerId)
  if (!camp) {
    throw new AppError(
      httpStatus.FORBIDDEN,
      'You must be assigned to the selected active camp before handing out items',
    )
  }
  await assertStockAvailable(campId, inventoryItemId, quantity)
  const recipientName = (await UserService.getDisplayName(task.victim)) ?? DEFAULT_RECIPIENT_NAME

  const recordId = await runInTransaction(async (session) => {
    const item = await deductStock(session, { itemId: inventoryItemId, campId }, quantity)
    if (!item) throw new AppError(httpStatus.CONFLICT, STOCK_CHANGED_MESSAGE)

    const [record] = await Distribution.create(
      [
        {
          ngo: camp.ngo,
          camp: campId,
          sosRequest: task.sosRequest,
          task: task.id,
          volunteer: volunteerId,
          recipient: task.victim,
          recipientName,
          item: {
            inventoryItem: item._id,
            itemName: item.itemName,
            category: item.category,
            quantity,
            unit: item.unit,
          },
          notes,
        },
      ],
      { session },
    )
    if (!record) throw new AppError(httpStatus.INTERNAL_SERVER_ERROR, 'Record was not saved')
    return String(record._id)
  })

  return getView(recordId)
}

// An NGO sees the hand-outs from its own camps; an admin sees all of them.
const listDistributions = async (viewer: TokenPayload, query: ListDistributionsQuery) => {
  const { page, limit, camp, volunteer, from, to } = query

  const filter: QueryFilter<unknown> = {}
  if (viewer.role === Role.NGO) filter.ngo = viewer.id
  if (camp) filter.camp = camp
  if (volunteer) filter.volunteer = volunteer
  if (from || to) filter.distributedAt = { ...(from && { $gte: from }), ...(to && { $lte: to }) }

  const [records, total] = await Promise.all([
    findPopulated(filter)
      .sort({ distributedAt: -1, _id: -1 })
      .skip(getPagination(query).skip)
      .limit(limit)
      .lean(),
    Distribution.countDocuments(filter),
  ])

  return { items: records.map(toDistributionView), meta: buildMeta({ page, limit }, total) }
}

// Total handed out per item and unit within the range, biggest first. Two items with the same name
// but different units (kg vs packs) stay separate rows instead of adding up to nonsense.
const totalsByItem = async (range: DateRange, limit: number) => {
  const rows = await Distribution.aggregate<{
    _id: { name: string; unit: string }
    totalDistributed: number
  }>([
    { $match: inRange('distributedAt', range) },
    {
      $group: {
        _id: { name: '$item.itemName', unit: '$item.unit' },
        totalDistributed: { $sum: '$item.quantity' },
      },
    },
    { $sort: { totalDistributed: -1, '_id.name': 1 } },
    { $limit: limit },
  ])
  return rows.map((row) => ({
    _id: row._id.name,
    unit: row._id.unit,
    totalDistributed: row.totalDistributed,
  }))
}

export const DistributionService = { createDistribution, listDistributions, totalsByItem }
