import {
  isRuntimeError,
  type PlanCreateInputV1,
  type PlanToolInvocationContextV1,
  runtimeError,
  type ToolDefinition,
  type ToolRequest,
  type ToolResult,
} from '@praxis/core-sdk'

export const PLAN_TOOL_EXECUTION_V1 = Object.freeze({
  sideEffect: 'none' as const,
  target: { kind: 'none' as const },
  parallelSafe: false,
  conflictScope: 'global' as const,
  maxInlineBytes: 64 * 1024,
})

const digest = { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' }
const identifier = {
  type: 'string',
  minLength: 1,
  maxLength: 128,
  pattern: '^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$',
}
const workspacePath = {
  type: 'string',
  minLength: 1,
  maxLength: 2_048,
  pattern: '^(?![A-Za-z]:)(?![/\\\\])(?!.*(?:^|[/\\\\])\\.\\.(?:[/\\\\]|$))[^\\u0000]+$',
  description:
    'Workspace-relative path only: no drive letter, leading slash/backslash, NUL, or parent-directory segment (..). Never strip a leading slash from an external absolute path: that checks a different file inside the workspace. For required outputs outside the workspace, use a semantic criterion with evidence from an authorized work Tool; do not create a duplicate file merely to satisfy an incorrect file_rule.',
}

const mechanicalCheck = {
  oneOf: [
    {
      type: 'object',
      description:
        'A narrow mechanical predicate: exists proves only path existence, sha256 proves only byte identity. Keep the criterion description within that proof boundary. Use a separate semantic criterion for content correctness or business behavior. kind must be mechanical and check is required.',
      additionalProperties: false,
      required: ['checker', 'path', 'rule'],
      properties: {
        checker: { const: 'file_rule' },
        path: workspacePath,
        rule: {
          oneOf: [
            {
              type: 'object',
              additionalProperties: false,
              required: ['kind'],
              properties: { kind: { const: 'exists' } },
            },
            {
              type: 'object',
              additionalProperties: false,
              required: ['kind', 'expectedDigest'],
              properties: { kind: { const: 'sha256' }, expectedDigest: digest },
            },
          ],
        },
      },
    },
    {
      type: 'object',
      description:
        'Exact content-addressed digest check. This can prove byte identity, but not broader behavioral correctness.',
      additionalProperties: false,
      required: ['checker', 'expectedDigest'],
      properties: {
        checker: { const: 'content_digest' },
        expectedDigest: digest,
      },
    },
    {
      type: 'object',
      description:
        'Runtime-recorded successful Tool receipt. This proves that the Tool returned success; an isolated Reviewer still evaluates whether it proves the intended outcome.',
      additionalProperties: false,
      required: ['checker', 'expectedState'],
      properties: {
        checker: { const: 'tool_receipt' },
        toolName: identifier,
        expectedState: { const: 'succeeded' },
      },
    },
    {
      type: 'object',
      description:
        'Durable committed-effect receipt. This proves that the effect committed; an isolated Reviewer still evaluates whether it proves the intended outcome.',
      additionalProperties: false,
      required: ['checker', 'expectedState'],
      properties: {
        checker: { const: 'effect_receipt' },
        effectKind: {
          enum: ['workspace_write', 'external_idempotent', 'external_non_idempotent'],
        },
        expectedState: { const: 'committed' },
      },
    },
    {
      type: 'object',
      description:
        'Runtime-recorded Artifact or Child result. This proves provenance and availability; an isolated Reviewer still evaluates whether the content satisfies the criterion.',
      additionalProperties: false,
      required: ['checker', 'source'],
      properties: {
        checker: { const: 'artifact_or_child_result' },
        source: { enum: ['artifact', 'child_result'] },
      },
    },
  ],
}

const criterion = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'description', 'kind', 'required', 'check'],
      properties: {
        id: identifier,
        description: { type: 'string', minLength: 1, maxLength: 8192 },
        kind: { const: 'mechanical' },
        required: { type: 'boolean' },
        reviewRequired: { type: 'boolean' },
        check: mechanicalCheck,
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'description', 'kind', 'required'],
      properties: {
        id: identifier,
        description: { type: 'string', minLength: 1, maxLength: 8192 },
        kind: {
          const: 'semantic',
          description: 'Semantic criteria never contain a check field.',
        },
        required: { type: 'boolean' },
        reviewRequired: { type: 'boolean' },
      },
    },
  ],
}

const item = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'title', 'criterionIds', 'reviewCheckpoint'],
  properties: {
    id: identifier,
    title: { type: 'string', minLength: 1, maxLength: 8192 },
    criterionIds: {
      type: 'array',
      description:
        'Criteria must be achievable by the end of this Item, not a later Item. Give investigation its own evidence-based criteria instead of requiring the final repaired behavior before implementation. Combine tightly coupled work into one Item or update the Plan when the mapping forces future work into an earlier step; preserve the original task requirements.',
      minItems: 1,
      maxItems: 128,
      uniqueItems: true,
      items: identifier,
    },
    reviewCheckpoint: { type: 'boolean' },
  },
}

export const PLAN_DEFINITION_PROPERTIES_V1 = Object.freeze({
  objective: { type: 'string', minLength: 1, maxLength: 16_384 },
  acceptanceCriteria: {
    type: 'array',
    minItems: 1,
    maxItems: 128,
    items: criterion,
  },
  items: { type: 'array', minItems: 1, maxItems: 128, items: item },
})

export function planDefinitionPropertiesV1(
  registeredChecks: readonly Record<string, unknown>[] = [],
) {
  if (registeredChecks.length === 0) return PLAN_DEFINITION_PROPERTIES_V1
  return {
    ...PLAN_DEFINITION_PROPERTIES_V1,
    acceptanceCriteria: {
      ...PLAN_DEFINITION_PROPERTIES_V1.acceptanceCriteria,
      items: {
        oneOf: [
          {
            ...criterion.oneOf[0],
            properties: {
              ...criterion.oneOf[0]!.properties,
              check: { oneOf: [...mechanicalCheck.oneOf, ...registeredChecks] },
            },
          },
          criterion.oneOf[1],
        ],
      },
    },
  }
}

export function planToolDefinitionV1(
  name: ToolDefinition['name'],
  description: string,
  parameters: Record<string, unknown>,
): ToolDefinition {
  return {
    name,
    description: `${description} Do not combine this Plan control call with work-tool calls in the same response; wait for its result first.`,
    parameters,
    outputSchema: { type: 'object' },
    execution: PLAN_TOOL_EXECUTION_V1,
  }
}

export function requirePlanInvocationV1(request: ToolRequest): PlanToolInvocationContextV1 {
  const invocation = request.executionContext?.invocation
  if (invocation === undefined) {
    throw runtimeError(
      'PLAN_TOOL_INVOCATION_REQUIRED',
      'planner',
      'Plan tools require Runtime-owned invocation identity.',
    )
  }
  if (invocation.sessionId.length === 0 || invocation.runId.length === 0) {
    throw runtimeError(
      'PLAN_TOOL_INVOCATION_INVALID',
      'planner',
      'Plan tool invocation identity is incomplete.',
    )
  }
  return invocation
}

export function planDefinitionFromToolInputV1(input: Record<string, unknown>): PlanCreateInputV1 {
  return {
    objective: input.objective as string,
    acceptanceCriteria: input.acceptanceCriteria as PlanCreateInputV1['acceptanceCriteria'],
    items: input.items as PlanCreateInputV1['items'],
    ...(input.reviewPolicy === undefined
      ? {}
      : { reviewPolicy: input.reviewPolicy as PlanCreateInputV1['reviewPolicy'] }),
  }
}

export async function planToolResultV1<T>(operation: () => Promise<T>): Promise<ToolResult> {
  try {
    const output = await operation()
    const projection = Reflect.get(output as object, 'projection') as
      | { planId?: unknown; revision?: unknown; state?: unknown }
      | undefined
    return {
      ok: true,
      summary:
        projection === undefined
          ? 'ReviewPlan operation completed.'
          : `ReviewPlan ${String(projection.planId)} is ${String(projection.state)} at revision ${String(projection.revision)}.`,
      output,
    }
  } catch (error) {
    const failure = isRuntimeError(error)
      ? error
      : runtimeError('PLAN_TOOL_FAILED', 'planner', 'ReviewPlan operation failed.')
    return {
      ok: false,
      summary: failure.message,
      error: {
        code: failure.code,
        category: failure.category === 'permission' ? 'permission' : 'execution',
        retryable: failure.retryable,
      },
    }
  }
}

export function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw runtimeError('PLAN_TOOL_INPUT_INVALID', 'planner', 'Expected a positive integer.')
  }
  return Number(value)
}

export function nonEmptyString(value: unknown, code = 'PLAN_TOOL_INPUT_INVALID'): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw runtimeError(code, 'planner', 'Expected a non-empty string.')
  }
  return value
}

export function stringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw runtimeError('PLAN_TOOL_INPUT_INVALID', 'planner', 'Expected a string array.')
  }
  return value
}
