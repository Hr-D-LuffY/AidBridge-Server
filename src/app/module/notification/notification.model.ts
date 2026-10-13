import { Schema, model } from 'mongoose'
import {
  MAX_NOTIFICATION_MESSAGE_LENGTH,
  MAX_NOTIFICATION_TITLE_LENGTH,
  NOTIFICATION_TARGETS,
} from '../../constants/notification'

const TARGET_REQUIRED_MESSAGE = 'A notification needs at least one target role or target user'

const notificationSchema = new Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: MAX_NOTIFICATION_TITLE_LENGTH },
    message: {
      type: String,
      required: true,
      trim: true,
      maxlength: MAX_NOTIFICATION_MESSAGE_LENGTH,
    },
    // Both lists default to empty. The old model defaulted `targetRoles` to ["all"], so a
    // notification meant for one user also reached everybody.
    targetRoles: { type: [{ type: String, enum: NOTIFICATION_TARGETS }], default: [] },
    targetUsers: { type: [{ type: Schema.Types.ObjectId, ref: 'User' }], default: [] },
    isEmergencyBroadcast: { type: Boolean, default: false },
    // Absent on notifications the system raises itself (a volunteer request was decided, ...).
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    // Who has opened it. Never sent to clients: the API answers `isRead` for the caller only.
    readBy: { type: [{ type: Schema.Types.ObjectId, ref: 'User' }], default: [] },
  },
  { timestamps: true, versionKey: false },
)

notificationSchema.pre('validate', function () {
  if (this.targetRoles.length === 0 && this.targetUsers.length === 0) {
    this.invalidate('targetRoles', TARGET_REQUIRED_MESSAGE)
  }
})

// Two indexes, not one: MongoDB cannot build a compound index over two array fields. The list query
// is an $or over both, so each branch uses its own.
notificationSchema.index({ targetRoles: 1, createdAt: -1 })
notificationSchema.index({ targetUsers: 1, createdAt: -1 })

export const Notification = model('Notification', notificationSchema)

export type NotificationDocument = InstanceType<typeof Notification>
