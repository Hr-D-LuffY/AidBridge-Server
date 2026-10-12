import httpStatus from 'http-status'
import { AppError } from '../errorHelpers/AppError'

type TransitionMap<S extends string> = Record<S, readonly S[]>

export const canTransition = <S extends string>(map: TransitionMap<S>, from: S, to: S) =>
  map[from].includes(to)

// Throws 409 when `from -> to` isn't an allowed move. `label` names the thing in the message,
// e.g. assertTransition(SOS_TRANSITIONS, request.status, next, 'SOS request').
export const assertTransition = <S extends string>(
  map: TransitionMap<S>,
  from: S,
  to: S,
  label: string,
) => {
  if (canTransition(map, from, to)) return
  throw new AppError(httpStatus.CONFLICT, `A ${label} cannot move from "${from}" to "${to}"`)
}
