import type { DispatchSettingsValues } from '../../constants/dispatch'
import { SosStatus } from '../../constants/sos'
import { distanceMeters, toGeoPoint } from '../../lib/geo'
import { buildMeta } from '../../utils/pagination'
import { type BoardRow, SosService } from '../sos/sos.service'
import { TaskService } from '../task/task.service'
import { UserService } from '../user/user.service'
import { ageMinutes, SlaKind, slaStatus, slaTargetMinutes } from './board.rules'
import type { BoardQuery } from './dispatch.interface'
import { DispatchService } from './dispatch.service'
import { isLocationStale } from './dispatch.rules'

// The live picture for the dispatch board: three lanes of requests, each with how long it has been
// waiting against its service target. Only admins and NGOs ever read this, because it carries volunteers'
// last known positions.

// What every lane shows about a request.
const toBaseItem = (row: BoardRow, kind: SlaKind, settings: DispatchSettingsValues, now: Date) => {
  const target = slaTargetMinutes(kind, row.priority, settings)
  const sla = slaStatus(row.createdAt, target, now)
  return {
    id: row.id,
    priority: row.priority,
    status: row.status,
    needs: row.needs,
    address: row.address,
    location: toGeoPoint(row.coordinates),
    victim: row.victim,
    createdAt: row.createdAt,
    ageMinutes: ageMinutes(row.createdAt, now),
    slaKind: kind,
    slaTargetMinutes: target,
    slaRemainingMinutes: sla.remainingMinutes,
    slaState: sla.state,
    dispatch: row.dispatch,
  }
}

const getBoard = async (query: BoardQuery) => {
  const now = new Date()
  const settings = await DispatchService.getSettings()

  const [unassigned, assigned, enRoute] = await Promise.all([
    SosService.listBoardLane(
      SosStatus.PENDING,
      { page: query.unassignedPage, limit: query.limit },
      true,
    ),
    SosService.listBoardLane(
      SosStatus.ASSIGNED,
      { page: query.assignedPage, limit: query.limit },
      false,
    ),
    SosService.listBoardLane(
      SosStatus.ON_THE_WAY,
      { page: query.enRoutePage, limit: query.limit },
      false,
    ),
  ])

  // Offers still open for the waiting requests, and what each held request's volunteer has been doing.
  const held = [...assigned.rows, ...enRoute.rows]
  const [offerCounts, tasks, positions] = await Promise.all([
    TaskService.countLiveOffersBySos(
      unassigned.rows.map((row) => row.id),
      now,
    ),
    TaskService.listActiveBySos(held.map((row) => row.id)),
    UserService.getPositions(
      held.flatMap((row) => (row.assignedVolunteerId ? [row.assignedVolunteerId] : [])),
    ),
  ])

  // The volunteer who holds a request: where they last were and how far that is from it. The position is
  // only here while the task is open; a request that is finished is on no lane.
  const toHeldItem = (row: BoardRow) => {
    const task = tasks.get(row.id)
    const person = row.assignedVolunteerId ? positions.get(row.assignedVolunteerId) : undefined
    return {
      ...toBaseItem(row, SlaKind.ARRIVE, settings, now),
      acceptedAt: task?.acceptedAt ?? null,
      volunteer: row.assignedVolunteerId
        ? {
            id: row.assignedVolunteerId,
            name: person?.name ?? null,
            location: person?.coordinates ? toGeoPoint(person.coordinates) : null,
            locationUpdatedAt: person?.locationUpdatedAt ?? null,
            locationStale: isLocationStale(person?.locationUpdatedAt, now),
            distanceMeters: person?.coordinates
              ? Math.round(distanceMeters(person.coordinates, row.coordinates))
              : null,
          }
        : null,
    }
  }

  return {
    generatedAt: now,
    unassigned: {
      items: unassigned.rows.map((row) => ({
        ...toBaseItem(row, SlaKind.ASSIGN, settings, now),
        outstandingOffers: offerCounts.get(row.id) ?? 0,
      })),
      meta: buildMeta({ page: query.unassignedPage, limit: query.limit }, unassigned.total),
    },
    assigned: {
      items: assigned.rows.map(toHeldItem),
      meta: buildMeta({ page: query.assignedPage, limit: query.limit }, assigned.total),
    },
    enRoute: {
      items: enRoute.rows.map(toHeldItem),
      meta: buildMeta({ page: query.enRoutePage, limit: query.limit }, enRoute.total),
    },
  }
}

export const BoardService = { getBoard }
