import type { RuntimeTool, ToolRequest } from '@praxis/core-sdk'
import type { PlanControlServicePortV1 } from '../planControlPorts.js'
import {
  planDefinitionPropertiesV1,
  planDefinitionFromToolInputV1,
  planToolDefinitionV1,
  planToolResultV1,
  requirePlanInvocationV1,
} from './shared.js'

export class PlanCreateToolV1 implements RuntimeTool {
  readonly definition

  constructor(
    private readonly control: PlanControlServicePortV1,
    registeredChecks: readonly Record<string, unknown>[] = [],
  ) {
    this.definition = planToolDefinitionV1(
      'plan.create',
      'Create an ordered, non-DAG ReviewPlan when direct ReAct is no longer sufficient. The Plan becomes durable and must pass Review before successful completion. Every criterion is exactly one of: mechanical with a required check, or semantic with no check field. Review and retry budgets are Runtime policy and are intentionally not model-configurable.',
      {
        type: 'object',
        additionalProperties: false,
        required: ['objective', 'acceptanceCriteria', 'items'],
        properties: planDefinitionPropertiesV1(registeredChecks),
      },
    )
  }

  execute(request: ToolRequest) {
    return planToolResultV1(() =>
      this.control.create({
        sessionId: requirePlanInvocationV1(request).sessionId,
        invocation: requirePlanInvocationV1(request),
        input: planDefinitionFromToolInputV1(request.input),
      }),
    )
  }
}
