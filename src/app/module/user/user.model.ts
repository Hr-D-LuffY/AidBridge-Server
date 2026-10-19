import { Schema, model } from 'mongoose'
import { NotificationCategory } from '../../constants/notification'
import { Collection } from '../../constants/collections'
import { Role } from '../../constants/role'
import { MAX_LANGUAGE_LENGTH, MIN_LANGUAGE_LENGTH, Skill } from '../../constants/skill'
import { MAX_RATING } from '../../constants/task'
import { MAX_BLOCK_REASON_LENGTH } from '../../constants/user'
import { geoPointSchema } from '../../lib/geoPointSchema'

const ROLE_VALUES: Role[] = Object.values(Role)
const DEFAULT_RELIABILITY_SCORE = 5
const SKILL_VALUES: Skill[] = Object.values(Skill)

// One switch pair per notification category. Nothing is defaulted here: a switch the person never touched
// is absent and the rules (notification.rules.ts) fill in the default.
const categoryPreferenceSchema = new Schema(
  { inApp: { type: Boolean }, email: { type: Boolean } },
  { _id: false },
)
const notificationPreferencesSchema = new Schema(
  Object.fromEntries(
    Object.values(NotificationCategory).map((category) => [category, categoryPreferenceSchema]),
  ),
  { _id: false },
)

const userSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    // select:false — a query only returns it when it asks with .select('+password').
    password: { type: String, required: true, select: false },
    role: { type: String, enum: ROLE_VALUES, default: Role.VICTIM, required: true },
    phone: { type: String, trim: true },
    isAvailable: { type: Boolean, default: true },
    // Volunteer profile. Volunteers who joined before these existed have none of the three fields.
    skills: { type: [{ type: String, enum: SKILL_VALUES }], default: [] },
    languages: {
      type: [
        {
          type: String,
          trim: true,
          minlength: MIN_LANGUAGE_LENGTH,
          maxlength: MAX_LANGUAGE_LENGTH,
        },
      ],
      default: [],
    },
    // "On duty until": past this moment the volunteer counts as off duty even with `isAvailable` on
    // (see lib/availability.ts). Null means no end time.
    onDutyUntil: { type: Date, default: null },
    // No default on purpose: a user without a set location is simply absent from nearby searches
    // (the old model defaulted to [0, 0], a point in the Atlantic that every such user shared).
    location: { type: geoPointSchema, default: undefined },
    reliabilityScore: { type: Number, default: DEFAULT_RELIABILITY_SCORE, min: 0, max: MAX_RATING },
    // reliabilityScore is ratingSum / totalRatings, kept in step by UserService.recordRating. The sum
    // is stored so the average is recomputed exactly each time instead of drifting through rounding.
    totalRatings: { type: Number, default: 0, min: 0 },
    ratingSum: { type: Number, default: 0, min: 0 },
    // Offers left unanswered plus accepted requests never set off for. Dispatch ranks a volunteer lower
    // for it. Kept apart from reliabilityScore on purpose: that one is an exact average of ratings.
    noShowCount: { type: Number, default: 0, min: 0 },
    // Tokens issued before this moment are rejected by auth().
    passwordChangedAt: { type: Date },
    // Hashed reset token + expiry, set by forgot-password and cleared by reset-password.
    passwordResetToken: { type: String, select: false },
    passwordResetExpires: { type: Date, select: false },
    // A blocked account cannot log in and its token stops working at once (see auth()). It is not
    // deleted: an admin can lift the block, and the email stays taken.
    isBlocked: { type: Boolean, default: false },
    blockedAt: { type: Date },
    blockReason: { type: String, trim: true, maxlength: MAX_BLOCK_REASON_LENGTH },
    notificationPreferences: { type: notificationPreferencesSchema, default: undefined },
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date },
  },
  { timestamps: true, versionKey: false },
)

userSchema.index({ location: '2dsphere' })
userSchema.index({ role: 1, isDeleted: 1, name: 1 })
userSchema.index({ passwordResetToken: 1 }, { sparse: true })

export const User = model('User', userSchema, Collection.USERS)

export type UserDocument = InstanceType<typeof User>
