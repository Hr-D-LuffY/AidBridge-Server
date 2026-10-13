import { z } from 'zod'
import {
  MAX_ITEM_NAME_LENGTH,
  MAX_STOCK_QUANTITY,
  MAX_UNIT_LENGTH,
} from '../../constants/inventory'
import { ReliefCategory } from '../../constants/relief'
import { paginationQueryShape } from '../../utils/pagination'
import { atLeastOneField, objectIdSchema, updateBodySchema } from '../../utils/validation'

const itemNameSchema = z
  .string()
  .trim()
  .min(1, 'Item name is required')
  .max(MAX_ITEM_NAME_LENGTH, `Item name must be at most ${MAX_ITEM_NAME_LENGTH} characters`)

const categorySchema = z.enum(ReliefCategory, {
  error: `Category must be one of: ${Object.values(ReliefCategory).join(', ')}`,
})

const unitSchema = z
  .string()
  .trim()
  .min(1, 'Unit cannot be blank')
  .max(MAX_UNIT_LENGTH, `Unit must be at most ${MAX_UNIT_LENGTH} characters`)

// Amounts may be fractional (2.5 kg) but never negative, infinite or absurdly large.
const amountSchema = (label: string) =>
  z
    .number({ error: `${label} must be a number` })
    .min(0, `${label} cannot be negative`)
    .max(MAX_STOCK_QUANTITY, `${label} must be at most ${MAX_STOCK_QUANTITY}`)

// `null` takes the item out of any camp (back to the NGO's general store).
const campSchema = objectIdSchema.nullable()

const booleanQuery = z.enum(['true', 'false']).transform((value) => value === 'true')

// Strict: `ngo`, `isLow` and the like are not the caller's to set.
export const createItemSchema = z.strictObject({
  itemName: itemNameSchema,
  category: categorySchema,
  quantity: amountSchema('Quantity'),
  unit: unitSchema.optional(),
  lowStockThreshold: amountSchema('Low-stock threshold').optional(),
  camp: campSchema.optional(),
})

export const updateItemSchema = updateBodySchema(
  {
    itemName: itemNameSchema.optional(),
    category: categorySchema.optional(),
    quantity: amountSchema('Quantity').optional(),
    unit: unitSchema.optional(),
    lowStockThreshold: amountSchema('Low-stock threshold').optional(),
    camp: campSchema.optional(),
  },
  '`isLow` is worked out from quantity and the threshold',
).refine(...atLeastOneField)

export const listItemsQuerySchema = z.object({
  ...paginationQueryShape,
  camp: objectIdSchema.optional(),
  category: categorySchema.optional(),
  isLow: booleanQuery.optional(),
})

export const alertsQuerySchema = z.object({ ...paginationQueryShape })

export type CreateItemPayload = z.infer<typeof createItemSchema>
export type UpdateItemPayload = z.infer<typeof updateItemSchema>
export type ListItemsQuery = z.infer<typeof listItemsQuerySchema>
export type AlertsQuery = z.infer<typeof alertsQuerySchema>
