import type { RuntimeTool, ToolRequest } from '@praxis/core-sdk'
import type { ReviewCoordinatorPortV1 } from '../planControlPorts.js'
import {
  integer,
  nonEmptyString,
  planToolDefinitionV1,
  planToolResultV1,
  requirePlanInvocationV1,
} from './shared.js'

export class PlanReviewToolV1 implements RuntimeTool {
  readonly definition = planToolDefinitionV1(
    'plan.review',
    'Submit one Item or the whole Plan as a review candidate. Even a one-Item Plan requires scope=item Review first; wait for every Item to be accepted before scope=final. After all Items are accepted, submit final directly; additional work requires a new open Item attempt. Runtime automatically binds all evidence produced by the current Attempt (or frozen by accepted Items), freezes resolved evidence content, runs deterministic checks, and invokes the isolated semantic Reviewer only when required. Evidence selection is intentionally not model-controlled.',
    {
      type: 'object',
      additionalProperties: false,
      required: ['expectedPlanRevision', 'scope', 'summary'],
      properties: {
        expectedPlanRevision: { type: 'integer', minimum: 1 },
        scope: {
          oneOf: [
            {
              type: 'object',
              additionalProperties: false,
              required: ['kind', 'itemId'],
              properties: {
                kind: { const: 'item' },
                itemId: { type: 'string', minLength: 1, maxLength: 128 },
              },
            },
            {
              type: 'object',
              additionalProperties: false,
              required: ['kind'],
              properties: { kind: { const: 'final' } },
            },
          ],
        },
        summary: { type: 'string', minLength: 1, maxLength: 16_384 },
      },
    },
  )

  constructor(private readonly coordinator: ReviewCoordinatorPortV1) {}

  execute(request: ToolRequest) {
    return planToolResultV1(() => {
      const invocation = requirePlanInvocationV1(request)
      const scope = reviewScope(request.input.scope)
      return this.coordinator.review(
        {
          sessionId: invocation.sessionId,
          invocation,
          expectedPlanRevision: integer(request.input.expectedPlanRevision),
          scope,
          summary: nonEmptyString(request.input.summary),
          evidenceRefs: [],
        },
        request.signal,
      )
    })
  }
}

function reviewScope(value: unknown) {
  if (typeof value !== 'object' || value === null) {
    throw Object.assign(new Error('Review scope is invalid.'), {
      code: 'PLAN_REVIEW_SCOPE_INVALID',
      category: 'planner',
      retryable: false,
    })
  }
  if (Reflect.get(value, 'kind') === 'final') return { kind: 'final' as const }
  if (Reflect.get(value, 'kind') === 'item') {
    return { kind: 'item' as const, itemId: nonEmptyString(Reflect.get(value, 'itemId')) }
  }
  throw Object.assign(new Error('Review scope is invalid.'), {
    code: 'PLAN_REVIEW_SCOPE_INVALID',
    category: 'planner',
    retryable: false,
  })
}
