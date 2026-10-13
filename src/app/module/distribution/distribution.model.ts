import { Schema, model } from 'mongoose'
import { MAX_DISTRIBUTION_NOTES_LENGTH } from '../../constants/distribution'
import { MAX_ITEM_NAME_LENGTH, MAX_UNIT_LENGTH } from '../../constants/inventory'
import { ReliefCategory } from '../../constants/relief'

const CATEGORY_VALUES: ReliefCategory[] = Object.values(ReliefCategory)

// A snapshot of what was handed over. Name, category and unit are copied, so the record still reads
// correctly after the stock item is renamed, moved or deleted.
const itemSchema = new Schema(
  {
    inventoryItem: { type: Schema.Types.ObjectId, ref: 'Inventory', required: true },
    itemName: { type: String, required: true, maxlength: MAX_ITEM_NAME_LENGTH },
    category: { type: String, enum: CATEGORY_VALUES, required: true },
    quantity: { type: Number, required: true, min: 0 },
    unit: { type: String, required: true, maxlength: MAX_UNIT_LENGTH },
  },
  { _id: false },
)

// One hand-out of one item to one victim. The old model kept the same facts several times over
// (volunteerId / victimId / recipientUser, quantity / items[].quantity, date / distributedAt); each
// fact is stored once here.
const distributionSchema = new Schema(
  {
    ngo: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    camp: { type: Schema.Types.ObjectId, ref: 'Camp', required: true },
    sosRequest: { type: Schema.Types.ObjectId, ref: 'SOSRequest', required: true },
    task: { type: Schema.Types.ObjectId, ref: 'Task', required: true },
    volunteer: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    recipient: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    // The recipient's name when the aid was handed over, kept even if they later rename or leave.
    recipientName: { type: String, required: true },
    item: { type: itemSchema, required: true },
    notes: { type: String, trim: true, maxlength: MAX_DISTRIBUTION_NOTES_LENGTH },
    // Set by the server when the record is made; the client cannot back-date it.
    distributedAt: { type: Date, default: Date.now, required: true },
  },
  { timestamps: true, versionKey: false },
)

distributionSchema.index({ ngo: 1, camp: 1, distributedAt: -1 })
distributionSchema.index({ ngo: 1, distributedAt: -1 })
distributionSchema.index({ task: 1 })
distributionSchema.index({ volunteer: 1, distributedAt: -1 })

export const Distribution = model('Distribution', distributionSchema)

export type DistributionDocument = InstanceType<typeof Distribution>
