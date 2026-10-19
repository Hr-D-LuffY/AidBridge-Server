import { Schema, model } from 'mongoose'
import { DEFAULT_DISPATCH_SETTINGS as D, DISPATCH_SETTINGS_KEY } from '../../constants/dispatch'

const minutes = (value: number) => ({ type: Number, default: value, min: 1 })
const positive = (value: number) => ({ type: Number, default: value, min: 0 })

// The dispatch engine's settings: one document, created the first time anyone asks for it. Every
// default lives in constants/dispatch.ts; nothing here is a magic number. Bounds for editing are
// validated by the Zod schema of the settings route (commit 16), not here.
const dispatchSettingsSchema = new Schema(
  {
    key: { type: String, default: DISPATCH_SETTINGS_KEY, unique: true, required: true },
    enabled: { type: Boolean, default: D.enabled },
    waitMinutes: {
      critical: minutes(D.waitMinutes.critical),
      high: minutes(D.waitMinutes.high),
      medium: minutes(D.waitMinutes.medium),
      low: minutes(D.waitMinutes.low),
    },
    volunteersPerRound: minutes(D.volunteersPerRound),
    offerWindowMinutes: minutes(D.offerWindowMinutes),
    criticalOfferWindowMinutes: minutes(D.criticalOfferWindowMinutes),
    startRadiusKm: minutes(D.startRadiusKm),
    radiusFactor: { type: Number, default: D.radiusFactor, min: 1 },
    maxRadiusKm: minutes(D.maxRadiusKm),
    maxRounds: minutes(D.maxRounds),
    retryIntervalMinutes: minutes(D.retryIntervalMinutes),
    setOffWithinMinutes: minutes(D.setOffWithinMinutes),
    criticalSetOffWithinMinutes: minutes(D.criticalSetOffWithinMinutes),
    weights: {
      distance: positive(D.weights.distance),
      reliability: positive(D.weights.reliability),
      load: positive(D.weights.load),
      skillMatch: positive(D.weights.skillMatch),
      noShowPenalty: positive(D.weights.noShowPenalty),
    },
    staleCheckAfterHours: minutes(D.staleCheckAfterHours),
    staleCheckAssignedAfterHours: minutes(D.staleCheckAssignedAfterHours),
    staleCloseAfterHours: minutes(D.staleCloseAfterHours),
    slaAssignMinutes: {
      critical: minutes(D.slaAssignMinutes.critical),
      high: minutes(D.slaAssignMinutes.high),
      medium: minutes(D.slaAssignMinutes.medium),
      low: minutes(D.slaAssignMinutes.low),
    },
    slaArriveMinutes: {
      critical: minutes(D.slaArriveMinutes.critical),
      high: minutes(D.slaArriveMinutes.high),
      medium: minutes(D.slaArriveMinutes.medium),
      low: minutes(D.slaArriveMinutes.low),
    },
  },
  { timestamps: true, versionKey: false },
)

export const DispatchSettings = model('DispatchSettings', dispatchSettingsSchema)
