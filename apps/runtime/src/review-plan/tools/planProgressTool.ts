import type { RuntimeTool, ToolRequest } from '@praxis/core-sdk'
import type { PlanControlServicePortV1, PlanProgressRequestV1 } from '../planControlPorts.js'
import {
  integer,
  nonEmptyString,
  planToolDefinitionV1,
  planToolResultV1,
  requirePlanInvocationV1,
} from './shared.js'

export class PlanProgressToolV1 implements RuntimeTool {
  readonly definition = planToolDefinitionV1(
    'plan.progress',
    'Start or focus an Item attempt, report a durable block, or request a safe skip. Block means the current route cannot proceed and closes its current attempt; never use block for completed work. Submit completed work with plan.review. This tool cannot accept work or complete the Plan.',
    {
      type: 'object',
      additionalProperties: false,
      required: ['expectedPlanRevision', 'itemId', 'action'],
      properties: {
        expectedPlanRevision: { type: 'integer', minimum: 1 },
        itemId: { type: 'string', minLength: 1, maxLength: 128 },
        action: { enum: ['start', 'focus', 'block', 'request_skip'] },
        itemAttemptId: { type: 'string', minLength: 1, maxLength: 256 },
        reason: { type: 'string', minLength: 1, maxLength: 8192 },
        code: { type: 'string', minLength: 1, maxLength: 128 },
      },
    },
  )

  constructor(private readonly control: PlanControlServicePortV1) {}

  execute(request: ToolRequest) {
    return planToolResultV1(() => {
      const invocation = requirePlanInvocationV1(request)
      const itemId = nonEmptyString(request.input.itemId)
      const action = progressAction(request, itemId)
      return this.control.progress({
        sessionId: invocation.sessionId,
        invocation,
        expectedPlanRevision: integer(request.input.expectedPlanRevision),
        action,
      })
    })
  }
}

function progressAction(request: ToolRequest, itemId: string): PlanProgressRequestV1['action'] {
  if (request.input.action === 'start') return { kind: 'start', itemId }
  if (request.input.action === 'focus') {
    return {
      kind: 'focus',
      itemId,
      itemAttemptId: nonEmptyString(request.input.itemAttemptId),
    }
  }
  if (request.input.action === 'request_skip') return { kind: 'request_skip', itemId }
  if (request.input.action === 'block') {
    return {
      kind: 'block',
      itemId,
      ...(request.input.itemAttemptId === undefined
        ? {}
        : { itemAttemptId: nonEmptyString(request.input.itemAttemptId) }),
      reason: nonEmptyString(request.input.reason),
      ...(request.input.code === undefined ? {} : { code: nonEmptyString(request.input.code) }),
    }
  }
  throw Object.assign(new Error('Plan progress action is invalid.'), {
    code: 'PLAN_PROGRESS_ACTION_INVALID',
    category: 'planner',
    retryable: false,
  })
}
