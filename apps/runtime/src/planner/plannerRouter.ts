import { type ExecutionBudget, runtimeError } from '@praxis/core-sdk'
import { LONG_LIVED_EXECUTION_POLICY_V1 } from '../longLivedExecutionPolicy.js'
import type { Planner } from '../planner-api/index.js'

export type PlannerModeV1 = 'auto' | 'solo' | 'workflow'
export type LegacyPlannerModeV1 = 'direct' | 'supervisor'
export type PlannerModeInputV1 = PlannerModeV1 | LegacyPlannerModeV1

export type PlannerRouterOptionsV1 = Readonly<{
  mode?: PlannerModeInputV1
}>

export type PlannerRouteV1 = Readonly<{
  mode: PlannerModeV1
  enabled: true
  access: 'workspace_write'
  childBudget: Readonly<Pick<ExecutionBudget, 'maxChildRuns' | 'maxParallelChildren' | 'maxDepth'>>
}>

const SOLO_CHILD_BUDGET = Object.freeze({ maxChildRuns: 0, maxParallelChildren: 0, maxDepth: 0 })
const AUTO_CHILD_BUDGET = Object.freeze({
  maxChildRuns: LONG_LIVED_EXECUTION_POLICY_V1.maxChildRuns,
  maxParallelChildren: LONG_LIVED_EXECUTION_POLICY_V1.maxParallelChildren,
  maxDepth: LONG_LIVED_EXECUTION_POLICY_V1.maxDepth,
})

/** Parses policy only. There is exactly one execution implementation. */
export class PlannerRouter {
  readonly #defaultMode: PlannerModeV1

  constructor(input: PlannerRouterOptionsV1 = {}) {
    validateOptions(input)
    this.#defaultMode = normalizePlannerModeV1(input.mode ?? 'auto')
  }

  defaultMode(): PlannerModeV1 {
    return this.#defaultMode
  }

  route(mode: PlannerModeInputV1 = this.#defaultMode): PlannerRouteV1 {
    const normalized = normalizePlannerModeV1(mode)
    return Object.freeze({
      mode: normalized,
      enabled: true,
      access: 'workspace_write',
      childBudget: normalized === 'solo' ? SOLO_CHILD_BUDGET : AUTO_CHILD_BUDGET,
    })
  }

  select(unified: Planner, _mode: PlannerModeInputV1 = this.#defaultMode): Planner {
    return unified
  }
}

export function normalizePlannerModeV1(mode: PlannerModeInputV1): PlannerModeV1 {
  if (mode === 'direct') return 'solo'
  if (mode === 'supervisor') return 'workflow'
  return mode
}

function validateOptions(input: PlannerRouterOptionsV1): void {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) invalid()
  if (Object.keys(input).some((key) => key !== 'mode')) invalid()
  if (
    input.mode !== undefined &&
    !['auto', 'solo', 'workflow', 'direct', 'supervisor'].includes(input.mode)
  )
    invalid()
}

function invalid(): never {
  throw runtimeError(
    'PLANNER_ROUTER_CONFIG_INVALID',
    'configuration',
    'Planner mode policy is invalid.',
  )
}
