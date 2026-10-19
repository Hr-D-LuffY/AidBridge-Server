import {
  type DispatchSettingsValues,
  MS_PER_MINUTE,
  SLA_AT_RISK_FRACTION,
} from '../../constants/dispatch'
import type { Priority } from '../../constants/relief'

// Pure rules of the dispatch board: values and a clock in, answers out.

// What a service-level target measures: the time until a volunteer has taken the request, or until one
// has reached it (the task is completed). Both count from when the request was raised.
export const SlaKind = {
  ASSIGN: 'assign',
  ARRIVE: 'arrive',
} as const

export type SlaKind = (typeof SlaKind)[keyof typeof SlaKind]

export const SlaState = {
  OK: 'ok',
  AT_RISK: 'at_risk',
  BREACHED: 'breached',
} as const

export type SlaState = (typeof SlaState)[keyof typeof SlaState]

export const slaTargetMinutes = (
  kind: SlaKind,
  priority: Priority,
  settings: DispatchSettingsValues,
) => (kind === SlaKind.ASSIGN ? settings.slaAssignMinutes : settings.slaArriveMinutes)[priority]

export const ageMinutes = (since: Date, now: Date) =>
  Math.max(0, Math.floor((now.getTime() - since.getTime()) / MS_PER_MINUTE))

// How much of the target is left (negative once it is overrun) and where that puts the request: `at_risk`
// from 75 % of the target used, `breached` once it is all used.
export const slaStatus = (since: Date, targetMinutes: number, now: Date) => {
  const usedMs = now.getTime() - since.getTime()
  const targetMs = targetMinutes * MS_PER_MINUTE
  const state =
    usedMs >= targetMs
      ? SlaState.BREACHED
      : usedMs >= targetMs * SLA_AT_RISK_FRACTION
        ? SlaState.AT_RISK
        : SlaState.OK
  return { remainingMinutes: Math.floor((targetMs - usedMs) / MS_PER_MINUTE), state }
}
