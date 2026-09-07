import type { RuntimeTool } from '@praxis/core-sdk'
import type { PlanControlServicePortV1, ReviewCoordinatorPortV1 } from '../planControlPorts.js'
import { PlanAbandonToolV1 } from './planAbandonTool.js'
import { PlanCreateToolV1 } from './planCreateTool.js'
import { PlanProgressToolV1 } from './planProgressTool.js'
import { PlanReviewToolV1 } from './planReviewTool.js'
import { PlanUpdateToolV1 } from './planUpdateTool.js'

export type ReviewPlanToolBundleOptionsV1 = Readonly<{
  control: PlanControlServicePortV1
  coordinator: ReviewCoordinatorPortV1
  registeredChecks?: readonly Record<string, unknown>[]
}>

export function createReviewPlanToolsV1(
  options: ReviewPlanToolBundleOptionsV1,
): readonly RuntimeTool[] {
  return Object.freeze([
    new PlanAbandonToolV1(options.control),
    new PlanCreateToolV1(options.control, options.registeredChecks),
    new PlanProgressToolV1(options.control),
    new PlanReviewToolV1(options.coordinator),
    new PlanUpdateToolV1(options.control, options.registeredChecks),
  ])
}

export * from './planAbandonTool.js'
export * from './planCreateTool.js'
export * from './planProgressTool.js'
export * from './planReviewTool.js'
export * from './planUpdateTool.js'
export * from './shared.js'
