import { Schema } from 'mongoose'
import { coordinatesSchema } from './geo'

// One GeoJSON Point sub-schema shared by every model with a location (User, SOS, Camp, Incident).
// Use it as `location: { type: geoPointSchema, default: undefined }` when the point is optional so
// a missing location stays missing — an empty or [0, 0] default would pollute `$near` queries and
// make the 2dsphere index reject the document.
export const geoPointSchema = new Schema(
  {
    type: { type: String, enum: ['Point'], default: 'Point', required: true },
    coordinates: {
      type: [Number],
      required: true,
      validate: {
        validator: (value: number[]) => coordinatesSchema.safeParse(value).success,
        message: 'Coordinates must be [longitude, latitude] within valid ranges',
      },
    },
  },
  { _id: false },
)
