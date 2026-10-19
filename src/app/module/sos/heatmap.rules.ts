import { PRIORITY_ORDER, type Priority } from '../../constants/relief'

// Pure maths of the heatmap grid: no database, no clock.

// Positions are first rounded to hundredths of a degree (about 1.1 km, the "approximate" location of the
// limited request views). Working in whole hundredths keeps the grid free of floating-point drift: 0.29 is
// 28.999999999999996 hundredths-of-a-cell away from zero, but 29 is exact.
export const HUNDREDTHS_PER_DEGREE = 100

// Cell side in hundredths of a degree (0.01 -> 1, 0.005 -> 0.5), cleaned of float noise.
export const cellInHundredths = (cell: number) =>
  Math.round(cell * HUNDREDTHS_PER_DEGREE * 1e6) / 1e6

// Tolerance added before flooring, so a position on a cell edge lands in the cell it belongs to.
export const EDGE_TOLERANCE = 1e-9

// The index of the cell a position (in whole hundredths) falls in.
export const cellIndex = (hundredths: number, cell: number) =>
  Math.floor(hundredths / cellInHundredths(cell) + EDGE_TOLERANCE)

// The middle of cell `index`, in degrees, to six decimals.
export const cellCentre = (index: number, cell: number) =>
  Math.round((index + 0.5) * cell * 1e6) / 1e6

// `$group` keeps the lowest rank (0 is the most urgent); this turns it back into a priority.
export const priorityFromRank = (rank: number): Priority | null => PRIORITY_ORDER[rank] ?? null
