import httpStatus from 'http-status'
import { type QueryFilter, Types } from 'mongoose'
import { HEATMAP_MAX_CELLS, HeatmapStatus } from '../../constants/analytics'
import { PRIORITY_ORDER } from '../../constants/relief'
import { SOS_FINISHED_STATUSES } from '../../constants/sos'
import { AppError } from '../../errorHelpers/AppError'
import { inRange } from '../../utils/dateRange'
import {
  EDGE_TOLERANCE,
  HUNDREDTHS_PER_DEGREE,
  cellCentre,
  cellInHundredths,
  priorityFromRank,
} from './heatmap.rules'
import type { HeatmapQuery } from '../analytics/analytics.interface'
import { Incident } from '../incident/incident.model'
import { SosRequest } from './sos.model'

interface CellRow {
  _id: { x: number; y: number }
  count: number
  unserved: number
  topRank: number
}

// Which requests are counted. `open` and `unserved` leave out finished ones; `unserved` also needs the
// dispatch engine to have given up on the request. A request from before dispatch existed has no flag, so
// it is never "unserved".
const buildFilter = async (query: HeatmapQuery) => {
  const { status, incidentId, from, to } = query
  const filter: QueryFilter<unknown> = { ...inRange('createdAt', { startDate: from, endDate: to }) }
  if (status !== HeatmapStatus.ALL) filter.status = { $nin: [...SOS_FINISHED_STATUSES] }
  if (status === HeatmapStatus.UNSERVED) filter['dispatch.unserved'] = true

  // The link lives on the incident, so the request ids come from there.
  if (incidentId) {
    const incident = await Incident.findOne({ _id: incidentId, isDeleted: false })
      .select('sosRequests')
      .lean()
    if (!incident) throw new AppError(httpStatus.NOT_FOUND, 'Incident not found')
    filter._id = { $in: incident.sosRequests.map((id) => new Types.ObjectId(String(id))) }
  }
  return filter
}

// Counts of requests per square of the map, densest first. Each position is rounded to hundredths of a
// degree (the approximate location) before it is placed in a cell, and only counts leave the database:
// no id, name, phone, address or exact position is ever in the result.
const getHeatmap = async (query: HeatmapQuery) => {
  const { cell } = query
  const cellSize = cellInHundredths(cell)
  const filter = await buildFilter(query)

  // Half-up rounding to whole hundredths (Mongo's `$round` rounds half to even, which would disagree with
  // the approximate coordinates other views show).
  const hundredths = (axis: 0 | 1) => ({
    $floor: {
      $add: [
        { $multiply: [{ $arrayElemAt: ['$location.coordinates', axis] }, HUNDREDTHS_PER_DEGREE] },
        0.5,
      ],
    },
  })
  const cellOf = (hundredthsField: string) => ({
    $floor: { $add: [{ $divide: [hundredthsField, cellSize] }, EDGE_TOLERANCE] },
  })

  const rows = await SosRequest.aggregate<CellRow>([
    { $match: filter },
    {
      $project: {
        lngH: hundredths(0),
        latH: hundredths(1),
        rank: { $indexOfArray: [[...PRIORITY_ORDER], '$priority'] },
        unserved: { $cond: [{ $eq: ['$dispatch.unserved', true] }, 1, 0] },
      },
    },
    { $addFields: { x: cellOf('$lngH'), y: cellOf('$latH') } },
    {
      $group: {
        _id: { x: '$x', y: '$y' },
        count: { $sum: 1 },
        unserved: { $sum: '$unserved' },
        topRank: { $min: '$rank' },
      },
    },
    { $sort: { count: -1, '_id.x': 1, '_id.y': 1 } },
    // One more than the cap, to know whether anything was left out.
    { $limit: HEATMAP_MAX_CELLS + 1 },
  ])

  return {
    cell,
    status: query.status,
    truncated: rows.length > HEATMAP_MAX_CELLS,
    cells: rows.slice(0, HEATMAP_MAX_CELLS).map((row) => ({
      lng: cellCentre(row._id.x, cell),
      lat: cellCentre(row._id.y, cell),
      count: row.count,
      unserved: row.unserved,
      maxPriority: priorityFromRank(row.topRank),
    })),
  }
}

export const HeatmapService = { getHeatmap }
