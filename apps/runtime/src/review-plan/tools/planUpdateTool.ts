import type { RuntimeTool, ToolRequest } from '@praxis/core-sdk'
import type { PlanControlServicePortV1 } from '../planControlPorts.js'
import {
  integer,
  planDefinitionPropertiesV1,
  planDefinitionFromToolInputV1,
  planToolDefinitionV1,
  planToolResultV1,
  requirePlanInvocationV1,
  stringArray,
} from './shared.js'

export class PlanUpdateToolV1 implements RuntimeTool {
  readonly definition

  constructor(
    private readonly control: PlanControlServicePortV1,
    registeredChecks: readonly Record<string, unknown>[] = [],
  ) {
    this.definition = planToolDefinitionV1(
      'plan.update',
      'Replace the mutable portion of the current ordered ReviewPlan using optimistic revision control. Accepted history remains immutable. Every criterion is exactly one of: mechanical with a required check, or semantic with no check field. Review and retry budgets remain Runtime-owned and cannot be changed here.',
      {
        type: 'object',
        additionalProperties: false,
        required: ['expectedPlanRevision', 'objective', 'acceptanceCriteria', 'items'],
        properties: {
          expectedPlanRevision: { type: 'integer', minimum: 1 },
          ...planDefinitionPropertiesV1(registeredChecks),
          carryForwardAttemptIds: {
            type: 'array',
            maxItems: 128,
            uniqueItems: true,
            items: { type: 'string', minLength: 1, maxLength: 256 },
          },
        },
      },
    )
  }

  execute(request: ToolRequest) {
    return planToolResultV1(() => {
      const invocation = requirePlanInvocationV1(request)
      return this.control.update({
        sessionId: invocation.sessionId,
        invocation,
        expectedPlanRevision: integer(request.input.expectedPlanRevision),
        input: planDefinitionFromToolInputV1(request.input),
        ...(request.input.carryForwardAttemptIds === undefined
          ? {}
          : { carryForwardAttemptIds: stringArray(request.input.carryForwardAttemptIds) }),
        ...(request.executionContext?.planControlGrant === undefined
          ? {}
          : { planControlGrant: request.executionContext.planControlGrant }),
      })
    })
  }
}
