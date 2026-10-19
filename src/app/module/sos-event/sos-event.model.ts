import { Schema, model } from 'mongoose'
import { Collection } from '../../constants/collections'
import { SosEventType } from '../../constants/dispatch'

const TYPE_VALUES: SosEventType[] = Object.values(SosEventType)

// One thing that happened to a request (an offer, an answer, an escalation...). Written once, never
// edited: the timeline the board and the victim read, and the data for response-time numbers later.
const sosEventSchema = new Schema(
  {
    sos: { type: Schema.Types.ObjectId, ref: 'SOSRequest', required: true },
    type: { type: String, enum: TYPE_VALUES, required: true },
    // Who did it. Absent when the system did (an offer going out, an escalation, a timeout).
    actor: { type: Schema.Types.ObjectId, ref: 'User' },
    // The volunteer it is about, when there is one (the one offered, or who declined).
    subject: { type: Schema.Types.ObjectId, ref: 'User' },
    // Small facts only: ids, counts, levels, priorities. Never contact details or free text.
    meta: { type: Schema.Types.Mixed, default: {} },
    at: { type: Date, default: Date.now, required: true },
  },
  { versionKey: false },
)

sosEventSchema.index({ sos: 1, at: 1 })

export const SosEvent = model('SosEvent', sosEventSchema, Collection.SOS_EVENTS)
