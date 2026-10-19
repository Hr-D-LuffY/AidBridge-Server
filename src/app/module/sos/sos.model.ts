import { Schema, model } from 'mongoose'
import { Collection } from '../../constants/collections'
import {
  MAX_SOS_ADDRESS_LENGTH,
  MAX_SOS_DESCRIPTION_LENGTH,
  MAX_SOS_MEDIA_ITEMS,
  MAX_SOS_RESOLVE_REASON_LENGTH,
  MediaType,
  ResolvedBy,
  ResolveKind,
  SosStatus,
} from '../../constants/sos'
import { Priority, ReliefCategory } from '../../constants/relief'
import { Skill } from '../../constants/skill'
import { geoPointSchema } from '../../lib/geoPointSchema'

const NEED_VALUES: ReliefCategory[] = Object.values(ReliefCategory)
const PRIORITY_VALUES: Priority[] = Object.values(Priority)
const STATUS_VALUES: SosStatus[] = Object.values(SosStatus)
const RESOLVED_BY_VALUES: ResolvedBy[] = Object.values(ResolvedBy)
const SKILL_VALUES: Skill[] = Object.values(Skill)
const RESOLVE_KIND_VALUES: ResolveKind[] = Object.values(ResolveKind)
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
    // Skills the victim asked for ("special help needed"). Optional; only ever boosts a match.
    requiredSkills: { type: [{ type: String, enum: SKILL_VALUES }], default: [] },
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
    // The last sign the victim is still there: set on create, on an edit, on a chat message and on "Yes, I
    // still need help". The stale job counts hours from it. Requests from before it existed get it on the
    // job's first pass.
    lastConfirmedAt: { type: Date },
    // When the victim was asked "Do you still need help?" (cleared by any sign of life), and when staff were
    // told about a high or critical request that stayed unanswered.
    staleCheckedAt: { type: Date },
    staleAlertedAt: { type: Date },
    // Why the victim resolved it. Absent on requests closed before this existed and on ones an admin closed.
    resolveKind: { type: String, enum: RESOLVE_KIND_VALUES },
    // The dispatch engine's bookkeeping (see module/dispatch). Requests that existed before it have none
    // of this; readers fall back to the defaults and the engine fills `nextActionAt` in.
    dispatch: {
      // How many times a round ended with nobody accepting; decides how far the search reaches.
      level: { type: Number, default: 0, min: 0 },
      // When the engine next looks at this request. Absent until it has been scheduled.
      nextActionAt: { type: Date },
      lastOfferAt: { type: Date },
      // True while offers are out and their round has not been closed yet.
      roundOpen: { type: Boolean, default: false },
      // No volunteer could be found after the maximum number of rounds; retried on a slower beat.
      unserved: { type: Boolean, default: false },
      escalatedAt: { type: Date },
      // The engine raised the priority one step because the request stayed unanswered.
      priorityBumped: { type: Boolean, default: false },
      // An admin is handling it by hand: no automatic offers (the controls arrive in commit 16).
      paused: { type: Boolean, default: false },
    },
  },
  { timestamps: true, versionKey: false },
)

// "Nearby" searches ($geoNear) need the 2dsphere index.
sosSchema.index({ location: '2dsphere' })
sosSchema.index({ status: 1, priority: 1, victim: 1 })
// A victim's own list, newest first, and the active-request count.
sosSchema.index({ victim: 1, createdAt: -1 })
// A volunteer's list of the requests they took, newest first, and the staff list with no filter.
sosSchema.index({ assignedVolunteer: 1, createdAt: -1 })
sosSchema.index({ createdAt: -1 })
// The stale job: open requests that have been quiet the longest.
sosSchema.index({ status: 1, lastConfirmedAt: 1 })
// The dispatch job: pending requests whose next action is due.
sosSchema.index({ status: 1, 'dispatch.nextActionAt': 1 })
// `GET /sos?q=`: one text index over the description and address. The description counts double. The
// language is "none" so the words of any language (Bangla included) are matched as written, without
// English stemming; it matches whole words, not parts of words. A collection may have only one.
sosSchema.index(
  { description: 'text', address: 'text' },
  { name: 'sos_text', weights: { description: 2, address: 1 }, default_language: 'none' },
)

export const SosRequest = model('SOSRequest', sosSchema, Collection.SOS_REQUESTS)

export type SosDocument = InstanceType<typeof SosRequest>
