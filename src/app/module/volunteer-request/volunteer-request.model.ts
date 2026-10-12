import { Schema, model } from 'mongoose'
import { VolunteerRequestStatus } from '../../constants/volunteerRequest'

const STATUS_VALUES: VolunteerRequestStatus[] = Object.values(VolunteerRequestStatus)
export const MAX_MESSAGE_LENGTH = 500

const volunteerRequestSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    // Why the person wants to volunteer — what the admin reads when deciding.
    message: { type: String, required: true, trim: true, maxlength: MAX_MESSAGE_LENGTH },
    status: {
      type: String,
      enum: STATUS_VALUES,
      default: VolunteerRequestStatus.PENDING,
      required: true,
    },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: { type: Date },
    reviewNote: { type: String, trim: true, maxlength: MAX_MESSAGE_LENGTH },
  },
  { timestamps: true, versionKey: false },
)

// A person can have at most one pending request; the database enforces it so two simultaneous
// submissions can't both get in. Rejected/approved ones are history and don't count.
volunteerRequestSchema.index(
  { user: 1 },
  { unique: true, partialFilterExpression: { status: VolunteerRequestStatus.PENDING } },
)
volunteerRequestSchema.index({ status: 1, createdAt: -1 })
volunteerRequestSchema.index({ user: 1, createdAt: -1 })

export const VolunteerRequest = model('VolunteerRequest', volunteerRequestSchema)

export type VolunteerRequestDocument = InstanceType<typeof VolunteerRequest>
