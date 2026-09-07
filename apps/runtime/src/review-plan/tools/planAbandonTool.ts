import { runtimeError, type RuntimeTool, type ToolRequest } from '@praxis/core-sdk'
import type { PlanControlServicePortV1 } from '../planControlPorts.js'
import {
  integer,
  nonEmptyString,
  planToolDefinitionV1,
  planToolResultV1,
  requirePlanInvocationV1,
} from './shared.js'

export class PlanAbandonToolV1 implements RuntimeTool {
  readonly definition = planToolDefinitionV1(
    'plan.abandon',
    'Abandon an optional ReviewPlan only when the trusted Host explicitly granted this exact action for the current turn. Never retry this Tool after PLAN_CONTROL_GRANT_REQUIRED: without a Host grant, explain the durable block and end the turn so the Runtime can return prompt_blocked. The authorization token is never a model-visible field.',
    {
      type: 'object',
      additionalProperties: false,
      required: ['expectedPlanRevision', 'explanation'],
      properties: {
        expectedPlanRevision: { type: 'integer', minimum: 1 },
        explanation: { type: 'string', minLength: 1, maxLength: 8192 },
      },
    },
  )

  constructor(private readonly control: PlanControlServicePortV1) {}

  execute(request: ToolRequest) {
    return planToolResultV1(() => {
      const invocation = requirePlanInvocationV1(request)
      const grant = request.executionContext?.planControlGrant
      if (grant === undefined || grant.action !== 'abandon') {
        throw runtimeError(
          'PLAN_CONTROL_GRANT_REQUIRED',
          'permission',
          'A matching trusted Host grant is required to abandon this Plan. Do not retry or alternate with plan.update. Explain the durable block and end the turn; the Runtime will return prompt_blocked.',
        )
      }
      return this.control.abandon({
        sessionId: invocation.sessionId,
        invocation,
        expectedPlanRevision: integer(request.input.expectedPlanRevision),
        explanation: nonEmptyString(request.input.explanation),
        controlFact: grant,
      })
    })
  }
}
