import { Schema, model } from 'mongoose'
import { Collection } from '../../constants/collections'
import {
  MAX_SOS_ADDRESS_LENGTH,
  MAX_SOS_DESCRIPTION_LENGTH,
  MAX_SOS_MEDIA_ITEMS,
  MAX_SOS_RESOLVE_REASON_LENGTH,
  MediaType,
  ResolvedBy,
  SosStatus,
} from '../../constants/sos'
import { Priority, ReliefCategory } from '../../constants/relief'
import { geoPointSchema } from '../../lib/geoPointSchema'

const NEED_VALUES: ReliefCategory[] = Object.values(ReliefCategory)
const PRIORITY_VALUES: Priority[] = Object.values(Priority)
const STATUS_VALUES: SosStatus[] = Object.values(SosStatus)
const RESOLVED_BY_VALUES: ResolvedBy[] = Object.values(ResolvedBy)
const MEDIA_TYPE_VALUES: MediaType[] = Object.values(MediaType)

// One uploaded photo or video. `publicId` is what Cloudinary needs to delete the file; it is never
// sent to clients. Each item gets its own _id so a request can name the item to remove.
const mediaSchema = new Schema(
  {
    url: { type: String, required: true },
    publicId: { type: String, required: true },
    resourceType: { type: String, enum: MEDIA_TYPE_VALUES, required: true },
  },
  { _id: true },
)

const sosSchema = new Schema(
  {
    victim: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    needs: {
      type: [{ type: String, enum: NEED_VALUES }],
      validate: {
        validator: (value: string[]) => value.length > 0,
        message: 'Choose at least one need',
      },
    },
    description: { type: String, trim: true, maxlength: MAX_SOS_DESCRIPTION_LENGTH },
    media: {
      type: [mediaSchema],
      validate: {
        validator: (value: unknown[]) => value.length <= MAX_SOS_MEDIA_ITEMS,
        message: `A request can have at most ${MAX_SOS_MEDIA_ITEMS} photos or videos`,
      },
    },
    location: { type: geoPointSchema, required: true },
    address: { type: String, trim: true, maxlength: MAX_SOS_ADDRESS_LENGTH },
    priority: { type: String, enum: PRIORITY_VALUES, default: Priority.MEDIUM, required: true },
    status: { type: String, enum: STATUS_VALUES, default: SosStatus.PENDING, required: true },
    // Set by the accept flow (commit 5). `null` while nobody has taken the request.
    assignedVolunteer: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    resolvedAt: { type: Date },
    resolvedBy: { type: String, enum: RESOLVED_BY_VALUES },
    resolveReason: { type: String, trim: true, maxlength: MAX_SOS_RESOLVE_REASON_LENGTH },
  },
  { timestamps: true, versionKey: false },
)

// "Nearby" searches ($geoNear) need the 2dsphere index.
sosSchema.index({ location: '2dsphere' })
sosSchema.index({ status: 1, priority: 1, victim: 1 })
// A victim's own list, newest first, and the active-request count.
sosSchema.index({ victim: 1, createdAt: -1 })

export const SosRequest = model('SOSRequest', sosSchema, Collection.SOS_REQUESTS)

export type SosDocument = InstanceType<typeof SosRequest>
