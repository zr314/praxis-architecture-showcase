import assert from 'node:assert/strict'
import { test } from 'node:test'
import type {
  PlanCreateInputV1,
  PlanToolInvocationContextV1,
  ReviewPlanProjectionV1,
  ToolRequest,
} from '@praxis/core-sdk'
import {
  createReviewPlanToolsV1,
  RegisteredReviewChecksV1,
  type PlanControlServicePortV1,
  type PlanReviewCandidateRequestV1,
  type ReviewCoordinatorPortV1,
} from '../apps/runtime/src/review-plan/index.js'
import { ToolRuntime } from '../apps/runtime/src/tools/toolRuntime.js'

const DIGEST = `sha256:${'a'.repeat(64)}` as const
const DEFINITION: PlanCreateInputV1 = {
  objective: 'Ship reviewed work.',
  acceptanceCriteria: [
    {
      id: 'quality',
      description: 'The result is complete.',
      kind: 'semantic',
      required: true,
    },
  ],
  items: [
    {
      id: 'work',
      title: 'Do the work',
      criterionIds: ['quality'],
      reviewCheckpoint: true,
    },
  ],
}

test('registered checker schemas admit only Host-pinned identities and success codes', () => {
  const registry = new RegisteredReviewChecksV1([
    {
      id: 'host-format',
      version: '1',
      digest: DIGEST,
      description: 'Host format validator.',
      expectedExitCodes: [0],
      async evaluate() {
        return { exitCode: 0, reason: 'Verified.', evidenceRefs: ['artifact-result'] }
      },
    },
  ])
  const tools = createReviewPlanToolsV1({
    control: fakeControl(),
    coordinator: fakeCoordinator(),
    registeredChecks: registry.definitions(),
  })
  const runtime = new ToolRuntime(tools, { exposeArtifactTool: false })
  const definition = {
    ...DEFINITION,
    acceptanceCriteria: [
      {
        id: 'quality',
        description: 'Host format is valid.',
        kind: 'mechanical',
        required: true,
        check: {
          checker: 'registered_check',
          checkerId: 'host-format',
          checkerVersion: '1',
          checkerDigest: DIGEST,
          expectedExitCodes: [0],
          parameters: { format: 'json' },
        },
      },
    ],
  }
  assert.equal(runtime.validateInput('plan.create', definition), undefined)
  for (const patch of [
    { checkerVersion: '2' },
    { expectedExitCodes: [1] },
    { checkerId: 'model-invented' },
  ]) {
    assert.equal(
      runtime.validateInput('plan.create', {
        ...definition,
        acceptanceCriteria: [
          {
            ...definition.acceptanceCriteria[0],
            check: { ...definition.acceptanceCriteria[0]!.check, ...patch },
          },
        ],
      })?.ok,
      false,
    )
  }
})

test('Plan file checks explain external-path semantics without allowing workspace escape', () => {
  const tools = createReviewPlanToolsV1({ control: fakeControl(), coordinator: fakeCoordinator() })
  for (const name of ['plan.create', 'plan.update']) {
    const schema = JSON.stringify(
      tools.find((tool) => tool.definition.name === name)!.definition.parameters,
    )
    assert.match(schema, /Never strip a leading slash from an external absolute path/u)
    assert.match(schema, /use a semantic criterion with evidence from an authorized work Tool/u)
  }
})

test('Plan item criteria explain step-local evidence without weakening the task contract', () => {
  const tools = createReviewPlanToolsV1({ control: fakeControl(), coordinator: fakeCoordinator() })
  for (const name of ['plan.create', 'plan.update']) {
    const schema = JSON.stringify(
      tools.find((tool) => tool.definition.name === name)!.definition.parameters,
    )
    assert.match(schema, /Criteria must be achievable by the end of this Item, not a later Item/u)
    assert.match(schema, /preserve the original task requirements/u)
  }
})

test('the auto ReviewPlan surface is exactly five strict non-DAG tools', () => {
  const tools = createReviewPlanToolsV1({ control: fakeControl(), coordinator: fakeCoordinator() })
  assert.deepEqual(
    tools.map(({ definition }) => definition.name),
    ['plan.abandon', 'plan.create', 'plan.progress', 'plan.review', 'plan.update'],
  )
  for (const { definition } of tools) {
    assert.equal(definition.execution?.sideEffect, 'none')
    assert.equal(definition.execution?.parallelSafe, false)
    assert.equal(definition.execution?.conflictScope, 'global')
    assert.match(definition.description, /wait for its result first/u)
    const schema = JSON.stringify(definition.parameters)
    for (const forbidden of [
      'dependencies',
      'edges',
      'join',
      'quorum',
      'condition',
      'invocationId',
      'controlEventId',
      'confirmationToken',
      'tokenDigest',
    ]) {
      assert.equal(schema.includes(forbidden), false, `${definition.name}: ${forbidden}`)
    }
  }
  const createSchema = JSON.stringify(
    tools.find(({ definition }) => definition.name === 'plan.create')?.definition.parameters,
  )
  for (const unavailable of [
    'registered_check',
    'json_schema',
    'diff_boundary',
    'registered_content_rule',
    'evidenceRole',
  ]) {
    assert.equal(createSchema.includes(unavailable), false, unavailable)
  }

  const runtime = new ToolRuntime(tools, { exposeArtifactTool: false })
  assert.equal(
    runtime.validateInput('plan.create', { ...DEFINITION, dependencies: ['x'] })?.ok,
    false,
  )
  assert.equal(
    runtime.validateInput('plan.abandon', {
      expectedPlanRevision: 1,
      explanation: 'No longer needed.',
      confirmationToken: 'secret',
    })?.ok,
    false,
  )

  const fileRuleDefinition = {
    objective: 'Verify a workspace file.',
    acceptanceCriteria: [
      {
        id: 'file-exists',
        description: 'The file exists.',
        kind: 'mechanical',
        required: true,
        check: { checker: 'file_rule', path: 'README.md', rule: { kind: 'exists' } },
      },
    ],
    items: [
      {
        id: 'inspect',
        title: 'Inspect the file',
        criterionIds: ['file-exists'],
        reviewCheckpoint: false,
      },
    ],
  }
  assert.equal(runtime.validateInput('plan.create', fileRuleDefinition), undefined)
  assert.equal(
    runtime.validateInput('plan.create', {
      objective: 'Verify a successful shell command.',
      acceptanceCriteria: [
        {
          id: 'shell-succeeded',
          description: 'A Runtime-recorded shell invocation succeeded.',
          kind: 'mechanical',
          required: true,
          check: { checker: 'tool_receipt', toolName: 'shell', expectedState: 'succeeded' },
        },
      ],
      items: [
        {
          id: 'verify',
          title: 'Run the verification command',
          criterionIds: ['shell-succeeded'],
          reviewCheckpoint: false,
        },
      ],
    }),
    undefined,
  )
  assert.equal(
    runtime.validateInput('plan.create', {
      ...fileRuleDefinition,
      acceptanceCriteria: [
        {
          ...fileRuleDefinition.acceptanceCriteria[0],
          check: {
            checker: 'file_rule',
            path: 'D:\\praxis\\README.md',
            rule: { kind: 'exists' },
          },
        },
      ],
    })?.ok,
    false,
  )
})

test('Plan tools fail closed when Runtime invocation identity is absent', async () => {
  const tools = createReviewPlanToolsV1({ control: fakeControl(), coordinator: fakeCoordinator() })
  for (const tool of tools) {
    const input =
      tool.definition.name === 'plan.create'
        ? DEFINITION
        : tool.definition.name === 'plan.update'
          ? { expectedPlanRevision: 1, ...DEFINITION }
          : tool.definition.name === 'plan.progress'
            ? { expectedPlanRevision: 1, itemId: 'work', action: 'start' }
            : tool.definition.name === 'plan.review'
              ? {
                  expectedPlanRevision: 1,
                  scope: { kind: 'item', itemId: 'work' },
                  summary: 'Done.',
                }
              : { expectedPlanRevision: 1, explanation: 'No longer needed.' }
    const result = await tool.execute(request(tool.definition.name, input))
    assert.equal(result.ok, false, tool.definition.name)
    assert.equal(result.error?.code, 'PLAN_TOOL_INVOCATION_REQUIRED')
  }
})

test('plan.review delegates the candidate with Runtime-selected evidence and true invocation', async () => {
  let observed: PlanReviewCandidateRequestV1 | undefined
  const coordinator: ReviewCoordinatorPortV1 = {
    review(input) {
      observed = input
      return Promise.resolve({
        status: 'reviewing',
        summary: 'Review requested.',
        planId: 'rp_1',
        planRevision: 1,
        reviewRequestId: 'review-1',
        projection: projection(),
      })
    },
  }
  const tool = createReviewPlanToolsV1({ control: fakeControl(), coordinator }).find(
    ({ definition }) => definition.name === 'plan.review',
  )!
  const invocation = toolInvocation('review')
  const result = await tool.execute(
    request(
      'plan.review',
      {
        expectedPlanRevision: 1,
        scope: { kind: 'item', itemId: 'work' },
        summary: 'Implemented and tested.',
      },
      invocation,
    ),
  )
  assert.equal(result.ok, true)
  assert.equal(observed?.invocation, invocation)
  assert.deepEqual(observed?.evidenceRefs, [])
  assert.equal(JSON.stringify(tool.definition.parameters).includes('evidenceRefs'), false)
})

test('plan.abandon requires a matching Runtime-only grant and has no model token field', async () => {
  const tool = createReviewPlanToolsV1({
    control: fakeControl(),
    coordinator: fakeCoordinator(),
  }).find(({ definition }) => definition.name === 'plan.abandon')!
  const result = await tool.execute(
    request(
      'plan.abandon',
      { expectedPlanRevision: 1, explanation: 'User changed direction.' },
      toolInvocation('abandon'),
    ),
  )
  assert.equal(result.ok, false)
  assert.equal(result.error?.code, 'PLAN_CONTROL_GRANT_REQUIRED')
  assert.match(tool.definition.description, /Never retry/u)
  assert.equal(JSON.stringify(tool.definition.parameters).includes('grant'), false)
})

test('model-visible Plan definitions keep retry budgets Runtime-owned', () => {
  const tools = createReviewPlanToolsV1({
    control: fakeControl(),
    coordinator: fakeCoordinator(),
  })
  for (const name of ['plan.create', 'plan.update']) {
    const tool = tools.find((candidate) => candidate.definition.name === name)
    assert.ok(tool)
    const properties = tool.definition.parameters.properties as Record<string, unknown>
    assert.equal(properties.reviewPolicy, undefined)
  }
})

function fakeControl(): PlanControlServicePortV1 {
  const unsupported = () => Promise.reject(new Error('unused'))
  return {
    create: unsupported,
    update: unsupported,
    progress: unsupported,
    prepareReview: unsupported,
    abandon: unsupported,
    requestExecution: unsupported,
    bindExecution: unsupported,
    recordRootToolRequest: unsupported,
    recordRootToolResult: unsupported,
    requestSemanticReview: unsupported,
    applyReviewDecision: unsupported,
    resolveTrustedBlock: unsupported,
  }
}

function fakeCoordinator(): ReviewCoordinatorPortV1 {
  return { review: () => Promise.reject(new Error('unused')) }
}

function toolInvocation(suffix: string): PlanToolInvocationContextV1 {
  return {
    invocationId: `pti_${suffix}`,
    sessionId: 'session-plan',
    runId: 'run-plan',
    providerTurnId: 'turn-plan',
    providerToolCallId: `call-${suffix}`,
  }
}

function request(
  name: string,
  input: Readonly<Record<string, unknown>>,
  invocation?: PlanToolInvocationContextV1,
): ToolRequest {
  return {
    name,
    input: { ...input },
    cwd: process.cwd(),
    signal: new AbortController().signal,
    ...(invocation === undefined ? {} : { executionContext: { invocation } }),
  }
}

function projection(): ReviewPlanProjectionV1 {
  return {
    schemaVersion: 1,
    planId: 'rp_1',
    revision: 1,
    objective: DEFINITION.objective,
    objectiveDigest: DIGEST,
    state: 'active',
    policy: {
      semantic: 'final_and_checkpoints',
      maxRepairAttemptsPerItem: 2,
      maxReplans: 1,
      maxReviewAttempts: 2,
      maxNoProgressAttempts: 2,
    },
    criteria: [],
    items: [],
    attemptCount: 0,
    replanCount: 0,
    noProgressCount: 0,
  }
}
