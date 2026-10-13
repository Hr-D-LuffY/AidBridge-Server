import { Schema, model } from 'mongoose'
import { DisasterType, Priority } from '../../constants/relief'
import {
  IncidentStatus,
  MAX_INCIDENT_ADDRESS_LENGTH,
  MAX_INCIDENT_DESCRIPTION_LENGTH,
  MAX_INCIDENT_TITLE_LENGTH,
} from '../../constants/incident'
import { geoPointSchema } from '../../lib/geoPointSchema'

const DISASTER_VALUES: DisasterType[] = Object.values(DisasterType)
const PRIORITY_VALUES: Priority[] = Object.values(Priority)
const STATUS_VALUES: IncidentStatus[] = Object.values(IncidentStatus)

const incidentSchema = new Schema(
  {
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    title: { type: String, required: true, trim: true, maxlength: MAX_INCIDENT_TITLE_LENGTH },
    disasterType: { type: String, enum: DISASTER_VALUES, required: true },
    location: { type: geoPointSchema, required: true },
    address: { type: String, trim: true, maxlength: MAX_INCIDENT_ADDRESS_LENGTH },
    description: { type: String, trim: true, maxlength: MAX_INCIDENT_DESCRIPTION_LENGTH },
    startDate: { type: Date, required: true },
    // Set when the incident is resolved, and cleared if it is reopened.
    endDate: { type: Date },
    status: { type: String, enum: STATUS_VALUES, default: IncidentStatus.ACTIVE, required: true },
    priority: { type: String, enum: PRIORITY_VALUES, default: Priority.LOW, required: true },
    // SOS requests that belong to this incident, linked by an admin (PUT /incidents/:id/sos). How
    // many were rescued is counted from them when read, never stored, so it can't go stale.
    sosRequests: [{ type: Schema.Types.ObjectId, ref: 'SOSRequest' }],
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date },
  },
  { timestamps: true, versionKey: false },
)

incidentSchema.index({ location: '2dsphere' })
incidentSchema.index({ isDeleted: 1, createdAt: -1 })
incidentSchema.index({ isDeleted: 1, status: 1, priority: 1 })

export const Incident = model('Incident', incidentSchema)

export type IncidentDocument = InstanceType<typeof Incident>
