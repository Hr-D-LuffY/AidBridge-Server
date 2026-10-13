import { Schema, model } from 'mongoose'
import { Collection } from '../../constants/collections'
import { Role } from '../../constants/role'
import { MAX_RATING } from '../../constants/task'
import { geoPointSchema } from '../../lib/geoPointSchema'

const ROLE_VALUES: Role[] = Object.values(Role)
const DEFAULT_RELIABILITY_SCORE = 5

const userSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    // select:false — a query only returns it when it asks with .select('+password').
    password: { type: String, required: true, select: false },
    role: { type: String, enum: ROLE_VALUES, default: Role.VICTIM, required: true },
    phone: { type: String, trim: true },
    isAvailable: { type: Boolean, default: true },
    // No default on purpose: a user without a set location is simply absent from nearby searches
    // (the old model defaulted to [0, 0], a point in the Atlantic that every such user shared).
    location: { type: geoPointSchema, default: undefined },
    reliabilityScore: { type: Number, default: DEFAULT_RELIABILITY_SCORE, min: 0, max: MAX_RATING },
    // reliabilityScore is ratingSum / totalRatings, kept in step by UserService.recordRating. The sum
    // is stored so the average is recomputed exactly each time instead of drifting through rounding.
    totalRatings: { type: Number, default: 0, min: 0 },
    ratingSum: { type: Number, default: 0, min: 0 },
    // Tokens issued before this moment are rejected by auth().
    passwordChangedAt: { type: Date },
    // Hashed reset token + expiry, set by forgot-password and cleared by reset-password.
    passwordResetToken: { type: String, select: false },
    passwordResetExpires: { type: Date, select: false },
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
