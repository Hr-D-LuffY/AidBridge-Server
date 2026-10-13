import { Schema, model } from 'mongoose'
import { ReliefCategory } from '../../constants/relief'
import {
  DEFAULT_LOW_STOCK_THRESHOLD,
  DEFAULT_STOCK_UNIT,
  MAX_ITEM_NAME_LENGTH,
  MAX_UNIT_LENGTH,
} from '../../constants/inventory'

const CATEGORY_VALUES: ReliefCategory[] = Object.values(ReliefCategory)

const inventorySchema = new Schema(
  {
    ngo: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    // The camp this stock sits in; null while it is in the NGO's general store.
    camp: { type: Schema.Types.ObjectId, ref: 'Camp', default: null },
    itemName: { type: String, required: true, trim: true, maxlength: MAX_ITEM_NAME_LENGTH },
    category: { type: String, enum: CATEGORY_VALUES, required: true },
    quantity: { type: Number, required: true, min: 0 },
    unit: { type: String, trim: true, default: DEFAULT_STOCK_UNIT, maxlength: MAX_UNIT_LENGTH },
    lowStockThreshold: { type: Number, default: DEFAULT_LOW_STOCK_THRESHOLD, min: 0 },
    // Derived: quantity <= lowStockThreshold. Kept in step on every write path — this hook covers
    // create/save; InventoryService.updateItem and lib/stock.service.ts set it in their own updates.
    isLow: { type: Boolean, default: false },
  },
  { timestamps: true, versionKey: false },
)

inventorySchema.pre('validate', function () {
  this.isLow = this.quantity <= this.lowStockThreshold
})

inventorySchema.index({ ngo: 1, isLow: 1, updatedAt: -1 })
inventorySchema.index({ ngo: 1, camp: 1 })
inventorySchema.index({ camp: 1, quantity: 1 })

export const Inventory = model('Inventory', inventorySchema)

export type InventoryDocument = InstanceType<typeof Inventory>
