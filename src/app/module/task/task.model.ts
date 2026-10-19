import { Schema, model } from 'mongoose'
import { OfferSource } from '../../constants/dispatch'
import { MAX_TASK_NOTES_LENGTH, TaskStatus } from '../../constants/task'

const STATUS_VALUES: TaskStatus[] = Object.values(TaskStatus)
const OFFER_SOURCE_VALUES: OfferSource[] = Object.values(OfferSource)

// One volunteer's involvement with one SOS request: they accepted it, declined it, or were offered
// it. At most one task per (request, volunteer), so declining twice is a no-op, not a second row.
const taskSchema = new Schema(
  {
    sosRequest: { type: Schema.Types.ObjectId, ref: 'SOSRequest', required: true },
    volunteer: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    // Copied from the request when the task is created. It never changes, and it lets rating and
    // ownership checks happen without reaching into the SOS module.
    victim: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    status: { type: String, enum: STATUS_VALUES, default: TaskStatus.PENDING, required: true },
    acceptedAt: { type: Date },
    completedAt: { type: Date },
    notes: { type: String, trim: true, maxlength: MAX_TASK_NOTES_LENGTH },
    // Flipped by the rating write itself, only while the task is completed and not yet rated.
    isRated: { type: Boolean, default: false },
    // Set only when the task started as an offer (a `pending` task made by dispatch or an admin). A
    // volunteer who accepted a request on their own has none of the three.
    offeredAt: { type: Date },
    offerExpiresAt: { type: Date },
    offerSource: { type: String, enum: OFFER_SOURCE_VALUES },
  },
  { timestamps: true, versionKey: false },
)

taskSchema.index({ sosRequest: 1, volunteer: 1 }, { unique: true })
taskSchema.index({ volunteer: 1, status: 1, createdAt: -1 })
taskSchema.index({ sosRequest: 1 })
// The expiry job: pending offers whose time is up.
taskSchema.index({ status: 1, offerExpiresAt: 1 })
// The set-off check: accepted tasks, oldest first.
taskSchema.index({ status: 1, acceptedAt: 1 })

export const Task = model('Task', taskSchema)

export type TaskDocument = InstanceType<typeof Task>
