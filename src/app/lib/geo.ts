import type { PipelineStage } from 'mongoose'
import { z } from 'zod'

// About 1.1 km: coarse enough to hide a victim's exact spot, fine enough to place them on a map.
const APPROXIMATE_COORDINATE_DECIMALS = 2

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

// Rounds a point so it shows roughly where someone is without giving their exact position away.
export const approximateCoordinates = ([lng, lat]: Coordinates): Coordinates => {
  const factor = 10 ** APPROXIMATE_COORDINATE_DECIMALS
  return [Math.round(lng * factor) / factor, Math.round(lat * factor) / factor]
}

const EARTH_RADIUS_METERS = 6_371_000
const DEGREES_TO_RADIANS = Math.PI / 180

// Straight-line (great-circle) distance between two points, in metres.
export const distanceMeters = ([lng1, lat1]: Coordinates, [lng2, lat2]: Coordinates) => {
  const dLat = (lat2 - lat1) * DEGREES_TO_RADIANS
  const dLng = (lng2 - lng1) * DEGREES_TO_RADIANS
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * DEGREES_TO_RADIANS) *
      Math.cos(lat2 * DEGREES_TO_RADIANS) *
      Math.sin(dLng / 2) ** 2
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(a))
}

// First stage of an aggregation: nearest first, with the distance in metres written to
// `distanceField`. Use it instead of nearQuery when you need a total count or the distance —
// countDocuments() rejects $near. Must be the first stage, and needs the 2dsphere index.
export const geoNearStage = (
  { lng, lat, radius }: NearbyQuery,
  query: Record<string, unknown>,
  distanceField: string,
): PipelineStage.GeoNear => ({
  $geoNear: {
    near: toGeoPoint([lng, lat]),
    distanceField,
    maxDistance: radius,
    spherical: true,
    query,
  },
})

// Filter value for a 2dsphere field, nearest first:
//   Model.find({ location: nearQuery(query), status: 'pending' })
export const nearQuery = ({ lng, lat, radius }: NearbyQuery) => ({
  $near: {
    $geometry: toGeoPoint([lng, lat]),
    $maxDistance: radius,
  },
})
