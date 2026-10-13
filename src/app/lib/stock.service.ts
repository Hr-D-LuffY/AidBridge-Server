import type { ClientSession, QueryFilter, Types } from 'mongoose'
import { Camp } from '../module/camp/camp.model'
import { Inventory } from '../module/inventory/inventory.model'

// Atomic stock and occupancy changes, shared by the camp and inventory modules and (commit 7) by
// distribution. Each is ONE conditional update: the safety condition is part of the filter, so two
// callers racing can never push a number out of range. They return the updated document, or null
// when the condition failed (missing, or the change would break a limit) — the caller works out
// which and answers 404 / 409.

// Moves a camp's occupancy by `delta` (negative to check people out), keeping it within
// 0..capacity. `filter` says which camp (id, and the owner when the caller is an NGO).
export const changeOccupancy = (filter: QueryFilter<unknown>, delta: number) => {
  const next = { $add: ['$currentOccupancy', delta] }
  return Camp.findOneAndUpdate(
    {
      ...filter,
      isDeleted: false,
      $expr: { $and: [{ $gte: [next, 0] }, { $lte: [next, '$capacity'] }] },
    },
    { $inc: { currentOccupancy: delta } },
    { returnDocument: 'after' },
  )
}

// Takes `quantity` out of one item in one camp, only if enough is there, and re-derives `isLow` in
// the same operation (a pipeline update, so `$inc` isn't available — `$subtract` does the job).
export const deductStock = (
  session: ClientSession,
  where: { itemId: string | Types.ObjectId; campId: string | Types.ObjectId },
  quantity: number,
) =>
  Inventory.findOneAndUpdate(
    { _id: where.itemId, camp: where.campId, quantity: { $gte: quantity } },
    [
      { $set: { quantity: { $subtract: ['$quantity', quantity] } } },
      { $set: { isLow: { $lte: ['$quantity', '$lowStockThreshold'] } } },
    ],
    { returnDocument: 'after', session, updatePipeline: true },
  )

// A camp is going away: its stock stays with the NGO, just no longer attached to a camp.
export const unlinkCampStock = (session: ClientSession, campId: string) =>
  Inventory.updateMany({ camp: campId }, { $set: { camp: null } }, { session })

// What a volunteer can hand out: the in-stock items of these camps.
export const listStockForCamps = (campIds: Types.ObjectId[]) =>
  Inventory.find({ camp: { $in: campIds }, quantity: { $gt: 0 } })
    .select('camp itemName category quantity unit lowStockThreshold isLow')
    .sort({ itemName: 1, _id: 1 })
    .lean()
