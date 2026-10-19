import type { Types } from 'mongoose'
import type { SosEventType } from '../../constants/dispatch'
import { buildMeta, getPagination } from '../../utils/pagination'
import type { SosEventInput, TimelineQuery } from './sos-event.interface'
import { SosEvent } from './sos-event.model'

const toDocument = ({ sos, type, actorId, subjectId, meta, at }: SosEventInput) => ({
  sos,
  type,
  ...(actorId && { actor: actorId }),
  ...(subjectId && { subject: subjectId }),
  meta: meta ?? {},
  ...(at && { at }),
})

// Writes timeline rows. Call it AFTER the change it describes has committed; a failure is logged and
// swallowed, so a write that already happened is never reported as a failed request.
const record = async (...events: SosEventInput[]) => {
  if (events.length === 0) return
  try {
    await SosEvent.insertMany(events.map(toDocument))
  } catch (error) {
    console.error(`Could not write ${events.length} timeline event(s):`, error)
  }
}

interface Person {
  _id: Types.ObjectId
  name: string
}

interface EventFields {
  _id: Types.ObjectId
  type: SosEventType
  actor?: Person | null
  subject?: Person | null
  meta?: Record<string, unknown> | null
  at: Date
}

const toPerson = (person: Person | null | undefined) =>
  person ? { id: String(person._id), name: person.name } : null

// The public face of an event: what happened and when, with no names. A victim or a volunteer sees
// "a volunteer was asked", never who, and never another volunteer's distance or position.
const toParticipantView = (event: EventFields) => ({
  id: String(event._id),
  type: event.type,
  at: event.at,
})

// Admins and NGOs also see who did it and who it concerned, and the small facts (level, radius...).
const toStaffView = (event: EventFields) => ({
  ...toParticipantView(event),
  actor: toPerson(event.actor),
  subject: toPerson(event.subject),
  meta: event.meta ?? {},
})

// Oldest first, because it reads as a story. `staff` decides how much of each event is shown.
const listTimeline = async (sosId: string, query: TimelineQuery, staff: boolean) => {
  const { page, limit } = query
  const [events, total] = await Promise.all([
    SosEvent.find({ sos: sosId })
      .sort({ at: 1, _id: 1 })
      .skip(getPagination(query).skip)
      .limit(limit)
      .populate<{ actor: Person | null; subject: Person | null }>([
        { path: 'actor', select: 'name' },
        { path: 'subject', select: 'name' },
      ])
      .lean(),
    SosEvent.countDocuments({ sos: sosId }),
  ])
  return {
    items: events.map(staff ? toStaffView : toParticipantView),
    meta: buildMeta({ page, limit }, total),
  }
}

export const SosEventService = { record, listTimeline }
