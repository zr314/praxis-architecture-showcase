import assert from 'node:assert/strict'
import test from 'node:test'
import {
  offlinePlanFixtureV1,
  PLAN_PROPOSAL_JSON_SCHEMA_V1,
  type PlanGeneratorModelInputV1,
  type PlanGeneratorModelOutputV1,
  type PlanGeneratorModelPortV1,
  StructuredPlanGeneratorV1,
} from '../apps/runtime/src/planner/planGenerator.js'
import { PlanValidator } from '../apps/runtime/src/planner/planValidator.js'
import { buildPlanningContextV1 } from '../apps/runtime/src/planner/planningContextBuilder.js'

const BUDGET = {
  maxInputTokens: 1_000,
  maxOutputTokens: 2_000,
  maxCostUsd: 0.05,
  deadlineMs: 100,
  maxSteps: 4,
  maxDependencies: 4,
  maxProviderAttempts: 1,
}

test('StructuredPlanGenerator emits only a strict proposal and PlanValidator owns durable authority', async () => {
  const model = new FixtureModel(() => ({ output: proposal(), usage: usage() }))
  const generated = await new StructuredPlanGeneratorV1(model, { budget: BUDGET }).generate({
    objective: 'Inspect the repository',
  })

  assert.equal(generated.source, 'model')
  assert.equal(generated.generatorId, 'fixture-planner')
  assert.equal(Object.hasOwn(generated.proposal, 'planId'), false)
  assert.equal(Object.hasOwn(generated.proposal.steps[0]!, 'stepId'), false)
  assert.equal(model.input?.responseFormat.type, 'json_schema')
  assert.equal(model.input?.responseFormat.strict, true)
  assert.equal(model.input?.responseFormat.schema, PLAN_PROPOSAL_JSON_SCHEMA_V1)

  const graph = new PlanValidator({
    parentBudget: {
      maxTurns: 4,
      maxToolCalls: 8,
      maxTokens: 4_000,
      maxChildRuns: 2,
      maxParallelChildren: 1,
      maxDepth: 1,
    },
    defaultStepBudget: { maxTurns: 2, maxToolCalls: 2, maxTokens: 1_000 },
    accessGrant: { mode: 'read_only', paths: ['.'] },
    allowedCapabilities: ['builtin.read'],
    createId: (kind, key) => `${kind}-${key}`,
  }).validate(generated.proposal)
  assert.equal(graph.planId, 'plan-root')
  assert.equal(graph.steps[0]?.stepId, 'step-inspect')
  assert.deepEqual(graph.steps[0]?.budget, {
    maxTurns: 2,
    maxToolCalls: 2,
    maxTokens: 1_000,
    maxChildRuns: 0,
    maxParallelChildren: 0,
    maxDepth: 0,
  })
})

test('Planner tool schema declares explicit types for Moonshot enum validation', () => {
  const enumNodes: Array<Record<string, unknown>> = []
  const visit = (value: unknown): void => {
    if (typeof value !== 'object' || value === null) return
    const record = value as Record<string, unknown>
    if (Array.isArray(record.enum)) enumNodes.push(record)
    for (const nested of Object.values(record)) visit(nested)
  }
  visit(PLAN_PROPOSAL_JSON_SCHEMA_V1)

  assert.ok(enumNodes.length >= 2)
  assert.equal(
    enumNodes.every((node) => typeof node.type === 'string'),
    true,
  )
})

test('Planner tool schema tells models to use portable workspace-relative paths', () => {
  const step = PLAN_PROPOSAL_JSON_SCHEMA_V1.properties.steps.items.properties
  const access = step.access
  const paths = access.properties.paths
  assert.match(String(access.description), /workspace-relative/)
  assert.match(String(paths.items.description), /workspace-relative/)
})

test('Planner accepts an explicit parent-only route without fabricating DAG work', async () => {
  const generated = await new StructuredPlanGeneratorV1(
    new FixtureModel(() => ({
      output: { execution: 'parent_only', objective: 'Explain the Planner', steps: [] },
      usage: usage(),
    })),
    { budget: BUDGET },
  ).generate({ objective: 'Explain the Planner' })

  assert.equal(generated.proposal.execution, 'parent_only')
  assert.deepEqual(generated.proposal.steps, [])
})

test('planning context excludes prior low-trust Supervisor synthesis', () => {
  const context = buildPlanningContextV1({
    workspace: 'D:/workspace',
    objective: 'Explain what happened',
    messages: [
      { role: 'user', content: 'original request', intent: 'prompt', trust: 'user' },
      {
        role: 'user',
        content: 'stale supervisor_verified_context',
        intent: 'context',
        trust: 'low',
      },
      { role: 'user', content: 'Explain what happened', intent: 'follow_up', trust: 'user' },
    ],
    tools: [],
    skills: [],
    mcpToolNames: [],
    budget: {
      maxTurns: 32,
      maxToolCalls: 96,
      maxChildRuns: 8,
      maxParallelChildren: 4,
      maxDepth: 1,
    },
  })

  assert.deepEqual(context.recentMessages, [
    { role: 'user', content: 'original request' },
    { role: 'user', content: 'Explain what happened' },
  ])
})

test('Planner preserves stable upstream HTTP failure classes', async () => {
  const cases = [
    [400, 'PLAN_GENERATOR_PROVIDER_REQUEST_INVALID'],
    [401, 'PLAN_GENERATOR_PROVIDER_AUTH_FAILED'],
    [404, 'PLAN_GENERATOR_MODEL_UNAVAILABLE'],
    [429, 'PLAN_GENERATOR_PROVIDER_RATE_LIMITED'],
    [503, 'PLAN_GENERATOR_PROVIDER_UNAVAILABLE'],
  ] as const
  for (const [status, code] of cases) {
    await assert.rejects(
      new StructuredPlanGeneratorV1(
        new FixtureModel(() => {
          throw Object.assign(new Error('fixture upstream failure'), { status })
        }),
        { budget: BUDGET },
      ).generate({ objective: 'Classify the Provider failure' }),
      hasCode(code),
      code,
    )
  }
})

test('Planner retries pre-output 429 and 5xx failures within its attempt budget', async () => {
  for (const status of [429, 503]) {
    let attempts = 0
    const generated = await new StructuredPlanGeneratorV1(
      new FixtureModel(() => {
        attempts += 1
        if (attempts < 3) {
          throw Object.assign(new Error('fixture transient failure'), {
            status,
            data: { retryAfterMs: 0 },
          })
        }
        return { output: proposal(), usage: usage() }
      }),
      { budget: { ...BUDGET, maxProviderAttempts: 3 } },
    ).generate({ objective: 'Retry the Planner request' })

    assert.equal(generated.source, 'model')
    assert.equal(attempts, 3)
  }
})

test('Planner does not retry a Provider failure after output has started', async () => {
  let attempts = 0
  await assert.rejects(
    new StructuredPlanGeneratorV1(
      new FixtureModel(() => {
        attempts += 1
        throw Object.assign(new Error('fixture partial failure'), {
          status: 429,
          planProviderOutputStarted: true,
        })
      }),
      { budget: { ...BUDGET, maxProviderAttempts: 3 } },
    ).generate({ objective: 'Do not duplicate partial output' }),
    hasCode('PLAN_GENERATOR_PROVIDER_RATE_LIMITED'),
  )
  assert.equal(attempts, 1)
})

test('schema failures never parse Markdown and use only an explicit validated fallback', async () => {
  for (const output of [
    '```json\n{"objective":"guessed","steps":[]}\n```',
    { ...proposal(), planId: 'model-owned' },
    {
      ...proposal(),
      steps: [{ ...proposal().steps[0], stepId: 'model-owned' }],
    },
  ]) {
    const result = await new StructuredPlanGeneratorV1(
      new FixtureModel(() => ({ output, usage: usage() })),
      {
        budget: BUDGET,
        failureMode: 'fallback',
        fallback: (objective) => offlinePlanFixtureV1('inspect', objective),
      },
    ).generate({ objective: 'Inspect safely' })
    assert.equal(result.source, 'fallback')
    assert.equal(result.fallbackFromCode, 'PLAN_GENERATOR_SCHEMA_INVALID')
    assert.equal(result.proposal.objective, 'Inspect safely')
  }

  await assert.rejects(
    new StructuredPlanGeneratorV1(
      new FixtureModel(() => ({ output: 'PLAN: do it', usage: usage() })),
      { budget: BUDGET },
    ).generate({ objective: 'No fallback' }),
    hasCode('PLAN_GENERATOR_SCHEMA_INVALID'),
  )
})

test('planning token, cost, step, dependency and deadline limits fail with stable codes', async () => {
  const cases: ReadonlyArray<
    readonly [string, PlanGeneratorModelOutputV1, Partial<typeof BUDGET>]
  > = [
    [
      'PLAN_GENERATOR_INPUT_TOKENS_EXCEEDED',
      { output: proposal(), usage: usage({ inputTokens: 1_001 }) },
      {},
    ],
    [
      'PLAN_GENERATOR_OUTPUT_TOKENS_EXCEEDED',
      { output: proposal(), usage: usage({ outputTokens: 2_001 }) },
      {},
    ],
    ['PLAN_GENERATOR_COST_EXCEEDED', { output: proposal(), usage: usage({ costUsd: 0.051 }) }, {}],
    [
      'PLAN_GENERATOR_SCHEMA_INVALID',
      {
        output: { ...proposal(), steps: [proposal().steps[0], proposal().steps[0]] },
        usage: usage(),
      },
      { maxSteps: 1 },
    ],
    [
      'PLAN_GENERATOR_SCHEMA_INVALID',
      {
        output: {
          objective: 'Two dependent steps',
          steps: [
            proposal().steps[0],
            { ...proposal().steps[0], key: 'second', dependencies: ['inspect'] },
          ],
        },
        usage: usage(),
      },
      { maxDependencies: 0 },
    ],
  ]
  for (const [code, output, override] of cases) {
    await assert.rejects(
      new StructuredPlanGeneratorV1(new FixtureModel(() => output), {
        budget: { ...BUDGET, ...override },
      }).generate({ objective: 'Bounded plan' }),
      hasCode(code),
      code,
    )
  }

  await assert.rejects(
    new StructuredPlanGeneratorV1(
      new FixtureModel(() => new Promise<PlanGeneratorModelOutputV1>(() => undefined)),
      { budget: { ...BUDGET, deadlineMs: 5 } },
    ).generate({ objective: 'Deadline' }),
    hasCode('PLAN_GENERATOR_DEADLINE_EXCEEDED'),
  )
})

test('caller cancellation does not execute a fallback', async () => {
  let fallbackCalls = 0
  const controller = new AbortController()
  const generator = new StructuredPlanGeneratorV1(
    new FixtureModel(
      (input) =>
        new Promise<PlanGeneratorModelOutputV1>((_resolve, reject) => {
          input.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        }),
    ),
    {
      budget: BUDGET,
      failureMode: 'fallback',
      fallback: (objective) => {
        fallbackCalls += 1
        return offlinePlanFixtureV1('inspect', objective)
      },
    },
  )
  const pending = generator.generate({ objective: 'Cancel me', signal: controller.signal })
  controller.abort()
  await assert.rejects(pending, hasCode('PLAN_GENERATOR_CANCELLED'))
  assert.equal(fallbackCalls, 0)
})

test('offline common-task fixtures are strict proposals admitted only under Runtime grants', () => {
  const grants = {
    inspect: {
      mode: 'read_only' as const,
      capabilities: ['builtin.read'],
    },
    change: {
      mode: 'workspace_write' as const,
      capabilities: ['builtin.read', 'builtin.write'],
    },
    verify: {
      mode: 'read_only' as const,
      capabilities: ['builtin.read', 'builtin.command'],
    },
  }
  for (const kind of ['inspect', 'change', 'verify'] as const) {
    const proposal = offlinePlanFixtureV1(kind, `${kind} fixture`)
    const graph = new PlanValidator({
      parentBudget: {
        maxTurns: 8,
        maxToolCalls: 8,
        maxTokens: 8_000,
        maxChildRuns: 4,
        maxParallelChildren: 2,
        maxDepth: 1,
      },
      defaultStepBudget: { maxTurns: 2, maxToolCalls: 2, maxTokens: 1_000 },
      accessGrant: { mode: grants[kind].mode, paths: ['.'] },
      allowedCapabilities: grants[kind].capabilities,
    }).validate(proposal)
    assert.equal(graph.objective, `${kind} fixture`)
    assert.ok(graph.steps.length >= 1)
  }
})

class FixtureModel implements PlanGeneratorModelPortV1 {
  readonly identity = { kind: 'model' as const, id: 'fixture-planner' }
  input?: PlanGeneratorModelInputV1

  constructor(
    private readonly handler: (
      input: PlanGeneratorModelInputV1,
    ) => PlanGeneratorModelOutputV1 | Promise<PlanGeneratorModelOutputV1>,
  ) {}

  async generate(input: PlanGeneratorModelInputV1): Promise<PlanGeneratorModelOutputV1> {
    this.input = input
    return this.handler(input)
  }
}

function proposal() {
  return {
    objective: 'Inspect the repository',
    steps: [
      {
        key: 'inspect',
        title: 'Inspect files',
        access: { mode: 'read_only' as const, paths: ['.'] },
        capabilities: ['builtin.read'],
        criteria: [{ kind: 'rule' as const, description: 'Relevant files were inspected.' }],
      },
    ],
  }
}

function usage(override: Partial<PlanGeneratorModelOutputV1['usage']> = {}) {
  return { inputTokens: 20, outputTokens: 40, costUsd: 0.001, ...override }
}

function hasCode(code: string) {
  return (error: unknown): boolean =>
    typeof error === 'object' && error !== null && Reflect.get(error, 'code') === code
}
