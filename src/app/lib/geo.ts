import { z } from 'zod'

const MIN_LONGITUDE = -180
const MAX_LONGITUDE = 180
const MIN_LATITUDE = -90
const MAX_LATITUDE = 90

export const DEFAULT_SEARCH_RADIUS_METERS = 10_000
export const MAX_SEARCH_RADIUS_METERS = 50_000

export const longitudeSchema = z.number().min(MIN_LONGITUDE).max(MAX_LONGITUDE)
export const latitudeSchema = z.number().min(MIN_LATITUDE).max(MAX_LATITUDE)

// GeoJSON order is [longitude, latitude] — the reverse of how people say it. This is the one
// place that order is defined; never build a coordinate pair by hand elsewhere.
export const coordinatesSchema = z.tuple([longitudeSchema, latitudeSchema], {
  error: 'Coordinates must be [longitude, latitude] within valid ranges',
})

export type Coordinates = z.infer<typeof coordinatesSchema>

export interface GeoPoint {
  type: 'Point'
  coordinates: Coordinates
}

export const toGeoPoint = (coordinates: Coordinates): GeoPoint => ({
  type: 'Point',
  coordinates,
})

// Query-string numbers arrive as text. z.coerce.number() would turn a blank "?lng=" into 0 (a
// valid longitude), so require a non-blank string first and convert after.
const numericQuery = (schema: z.ZodNumber) =>
  z.string().trim().min(1, 'Must be a number').transform(Number).pipe(schema)

// Spread into a "nearby" endpoint's query schema: z.object({ ...nearbyQueryShape })
export const nearbyQueryShape = {
  lng: numericQuery(longitudeSchema),
  lat: numericQuery(latitudeSchema),
  radius: numericQuery(z.number().positive().max(MAX_SEARCH_RADIUS_METERS)).default(
    DEFAULT_SEARCH_RADIUS_METERS,
  ),
}

export type NearbyQuery = z.infer<z.ZodObject<typeof nearbyQueryShape>>

// Filter value for a 2dsphere field, nearest first:
//   Model.find({ location: nearQuery(query), status: 'pending' })
export const nearQuery = ({ lng, lat, radius }: NearbyQuery) => ({
  $near: {
    $geometry: toGeoPoint([lng, lat]),
    $maxDistance: radius,
  },
})
