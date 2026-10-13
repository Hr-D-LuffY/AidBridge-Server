import { Schema, model } from 'mongoose'
import {
  MAX_CAMP_ADDRESS_LENGTH,
  MAX_CAMP_CAPACITY,
  MAX_CAMP_NAME_LENGTH,
} from '../../constants/camp'
import { geoPointSchema } from '../../lib/geoPointSchema'

const campSchema = new Schema(
  {
    ngo: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    name: { type: String, required: true, trim: true, maxlength: MAX_CAMP_NAME_LENGTH },
    location: { type: geoPointSchema, required: true },
    address: { type: String, trim: true, maxlength: MAX_CAMP_ADDRESS_LENGTH },
    capacity: { type: Number, required: true, min: 1, max: MAX_CAMP_CAPACITY },
    // 0 <= currentOccupancy <= capacity. Every write that changes either number is guarded in the
    // query itself (see CampService and lib/stock.service.ts), not only validated up front.
    currentOccupancy: { type: Number, default: 0, min: 0 },
    isActive: { type: Boolean, default: true },
    assignedVolunteers: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date },
  },
  { timestamps: true, versionKey: false },
)

campSchema.index({ location: '2dsphere' })
campSchema.index({ ngo: 1, isDeleted: 1, isActive: -1, updatedAt: -1 })
campSchema.index({ assignedVolunteers: 1, isActive: 1, isDeleted: 1 })

export const Camp = model('Camp', campSchema)

export type CampDocument = InstanceType<typeof Camp>
