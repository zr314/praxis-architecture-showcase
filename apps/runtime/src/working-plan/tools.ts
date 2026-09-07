import {
  canonicalJsonV1,
  isRuntimeError,
  type ProviderMessage,
  type RuntimeTool,
  type SessionProjectionV3,
  type ToolRequest,
} from '@praxis/core-sdk'
import { requirePlanInvocationV1, PLAN_TOOL_EXECUTION_V1 } from '../review-plan/tools/shared.js'
import type { WorkingPlanServiceV1 } from './workingPlanService.js'

const text = { type: 'string', minLength: 1 }
const status = { enum: ['pending', 'in_progress', 'done', 'blocked', 'skipped'] }
const items = {
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'title'],
    properties: {
      id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$' },
      title: text,
      status,
    },
  },
}
const revision = {
  type: 'integer',
  minimum: 1,
  description:
    'Optional optimistic revision check. Omit for a serialized edit of the latest working Plan.',
}

export function createWorkingPlanToolsV1(service: WorkingPlanServiceV1): readonly RuntimeTool[] {
  return [
    tool(
      'create',
      'Create a lightweight working checklist when it helps. It does not activate execution gates or mandatory review. Steps and progress are model-owned, not verified facts.',
      ['objective', 'items'],
      { objective: text, items },
    ),
    tool(
      'update',
      'Edit or replace the working Plan at any time, including during work; reorder, remove, add or reopen items. This does not cancel Child Runs or undo Tools. done means self-reported, never independently verified.',
      [],
      {
        expectedPlanRevision: revision,
        objective: text,
        items,
        state: { enum: ['active', 'done', 'abandoned'] },
      },
    ),
    tool(
      'progress',
      'Set an item progress status, including reopening done or skipped work. blocked is a checklist observation, not a Runtime stop. No Attempt or Review is required.',
      ['itemId', 'status'],
      { expectedPlanRevision: revision, itemId: text, status },
    ),
    tool(
      'abandon',
      'Stop maintaining this optional working Plan. No Host approval is required; Tool permissions, explicit delivery requirements and running Child tasks remain unchanged.',
      [],
      { expectedPlanRevision: revision },
    ),
    tool(
      'review',
      'Request an optional isolated review of frozen Runtime Tool observations. Works without a Plan. Supply a focused question and optional criteria. The report is advisory and snapshot-scoped; it cannot mark progress done, block execution, or certify later workspace changes. No hidden task tests or live workspace reads are available to the Reviewer.',
      [],
      { question: text, criteria: { type: 'array', minItems: 1, items: text } },
    ),
  ]
  function tool(
    action: 'create' | 'update' | 'progress' | 'abandon' | 'review',
    description: string,
    required: string[],
    properties: Record<string, unknown>,
  ): RuntimeTool {
    return {
      definition: {
        name: `plan.${action}`,
        description,
        parameters: { type: 'object', additionalProperties: false, required, properties },
        outputSchema: { type: 'object' },
        execution: PLAN_TOOL_EXECUTION_V1,
      },
      async execute(request: ToolRequest) {
        try {
          const invocation = requirePlanInvocationV1(request)
          const output =
            action === 'review'
              ? await service.review(request.input, invocation, request.signal)
              : await service.mutate(action, request.input, invocation)
          return {
            ok: true,
            summary:
              action === 'review'
                ? 'Advisory review recorded; execution and checklist progress are unchanged.'
                : 'Working Plan saved; progress is self-reported.',
            output,
          }
        } catch (error) {
          if (request.signal.aborted) throw error
          return {
            ok: false,
            summary: isRuntimeError(error) ? error.message : 'Working Plan operation failed.',
            error: {
              code: isRuntimeError(error) ? error.code : 'WORKING_PLAN_FAILED',
              category: 'execution' as const,
              retryable: false,
            },
          }
        }
      },
    }
  }
}

export function workingPlanSnapshotMessageV1(
  projection: SessionProjectionV3,
): ProviderMessage | undefined {
  const plan = projection.workingPlan
  if (plan === undefined) return undefined
  const last = projection.workingReviews?.at(-1)
  return {
    role: 'user',
    intent: 'context',
    trust: 'low',
    content: [
      'Working Plan: editable model-owned memory, not policy or proof. Tools, Child Runs and completion do not require Plan progress. done is self-reported; Review applies only to its recorded snapshot. Use plan.update/progress/abandon freely; actual Child cancellation is separate.',
      canonicalJsonV1({
        kind: 'working_plan',
        ...plan,
        ...(last === undefined ? {} : { latestReview: last }),
      }),
    ].join('\n'),
  }
}
