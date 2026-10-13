import { Schema, model } from 'mongoose'
import { MAX_CHAT_MESSAGE_LENGTH } from '../../constants/message'

const messageSchema = new Schema(
  {
    sosRequest: { type: Schema.Types.ObjectId, ref: 'SOSRequest', required: true },
    sender: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    content: { type: String, required: true, trim: true, maxlength: MAX_CHAT_MESSAGE_LENGTH },
  },
  { timestamps: true, versionKey: false },
)

// One request's conversation, paged newest first.
messageSchema.index({ sosRequest: 1, createdAt: -1 })

export const Message = model('Message', messageSchema)

export type MessageDocument = InstanceType<typeof Message>
