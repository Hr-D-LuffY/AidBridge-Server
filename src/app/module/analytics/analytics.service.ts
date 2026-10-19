import {
  ADMIN_CLOSED_KIND,
  LIVE_MAP_MAX_CAMPS,
  LIVE_MAP_MAX_REQUESTS,
  TOP_DISTRIBUTED_ITEMS_LIMIT,
  TOP_VOLUNTEERS_LIMIT,
} from '../../constants/analytics'
import { Priority } from '../../constants/relief'
import { ResolveKind, SosStatus } from '../../constants/sos'
import type { DateRange } from '../../utils/dateRange'
import { CampService } from '../camp/camp.service'
import { DistributionService } from '../distribution/distribution.service'
import { IncidentService } from '../incident/incident.service'
import { SosService } from '../sos/sos.service'
import { TaskService } from '../task/task.service'
import { UserService } from '../user/user.service'

interface CountRow<T extends string> {
  _id: T
  count: number
}

// One row per possible value, in a fixed order, with 0 for the ones nobody has: a chart should not
// lose a bar (or reorder its colours) because there were no `closed` requests this week.
const withAllKeys = <T extends string>(keys: readonly T[], rows: CountRow<T>[]) =>
  keys.map((key) => ({ _id: key, count: rows.find((row) => row._id === key)?.count ?? 0 }))

const countOf = <T extends string>(rows: CountRow<T>[], key: T) =>
  rows.find((row) => row._id === key)?.count ?? 0

const sumOf = (rows: CountRow<string>[]) => rows.reduce((total, row) => total + row.count, 0)

const toPeriod = ({ startDate, endDate }: DateRange) => ({
  startDate: startDate ?? null,
  endDate: endDate ?? null,
})

// The admin dashboard. Field names are the old API's, which the client's charts will read. The five
// reads are independent, so they run together.
const getDashboard = async (range: DateRange) => {
  const [counts, avgResponseTime, volunteerActivity, distributionByItem, volunteerCount] =
    await Promise.all([
      SosService.countByStatusAndPriority(range),
      TaskService.averageResponseMinutes(range),
      TaskService.topVolunteersByCompleted(range, TOP_VOLUNTEERS_LIMIT),
      DistributionService.totalsByItem(range, TOP_DISTRIBUTED_ITEMS_LIMIT),
      UserService.countActiveVolunteers(),
    ])

  return {
    period: toPeriod(range),
    summary: {
      totalRequests: sumOf(counts.byStatus),
      rescuedCount: countOf(counts.byStatus, SosStatus.RESCUED),
      pendingCount: countOf(counts.byStatus, SosStatus.PENDING),
      volunteerCount,
    },
    requestsByStatus: withAllKeys(Object.values(SosStatus), counts.byStatus),
    requestsByPriority: withAllKeys(Object.values(Priority), counts.byPriority),
    requestsByResolveKind: withAllKeys(
      [...Object.values(ResolveKind), ADMIN_CLOSED_KIND],
      counts.byResolveKind,
    ),
    avgResponseTime,
    volunteerActivity,
    distributionByItem,
  }
}

const getReport = async (range: DateRange) => {
  const [counts, registeredUsers] = await Promise.all([
    SosService.countByStatusAndPriority(range),
    UserService.countRegistered(range),
  ])

  return {
    period: toPeriod(range),
    totalSOSRequests: sumOf(counts.byStatus),
    rescued: countOf(counts.byStatus, SosStatus.RESCUED),
    pending: countOf(counts.byStatus, SosStatus.PENDING),
    registeredUsers,
  }
}

// Open requests and active camps, for admins and NGOs alike. Both are capped; the newest come first.
const getLiveMap = async () => {
  const [requests, camps] = await Promise.all([
    SosService.listOpenForMap(LIVE_MAP_MAX_REQUESTS),
    CampService.listActiveForMap(LIVE_MAP_MAX_CAMPS),
  ])
  return { requests, camps }
}

const getAdminSummary = () => IncidentService.getSummary()

export const AnalyticsService = { getDashboard, getReport, getLiveMap, getAdminSummary }
