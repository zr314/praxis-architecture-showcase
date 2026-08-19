import assert from 'node:assert/strict'
import test from 'node:test'
import {
  type SessionStepProjectionV3,
  type SubagentResultV1,
  validatePlanGraphV1,
} from '@praxis/core-sdk'
import { PlanValidator } from '../apps/runtime/src/planner/planValidator.js'
import {
  MechanicalVerifierV1,
  SEMANTIC_VERIFICATION_JSON_SCHEMA_V1,
  SemanticModelVerifierV1,
  type SemanticVerifierModelInputV1,
  type SemanticVerifierModelOutputV1,
  type SemanticVerifierModelPortV1,
} from '../apps/runtime/src/planner/verifier.js'

const DIGEST = `sha256:${'a'.repeat(64)}` as `sha256:${string}`
const BUDGET = {
  maxInputTokens: 10_000,
  maxOutputTokens: 1_000,
  maxCostUsd: 0.02,
  deadlineMs: 100,
}

test('semantic verifier uses a separate fresh identity and validates evidence-bound criteria', async () => {
  const model = new FixtureSemanticModel(() => ({
    output: {
      criteria: [
        { criterionId: 'criterion-semantic', status: 'passed', evidenceRefs: ['artifact://proof'] },
      ],
    },
    usage: usage(),
  }))
  const verifier = new SemanticModelVerifierV1(model, {
    budget: BUDGET,
    failureStrategy: 'fail_closed',
    createId: () => 'verifier-run-1',
  })
  const result = await verifier.verify({ step: semanticStep(), result: workerResult() })

  assert.deepEqual(result, {
    verifier: 'model',
    status: 'passed',
    evidenceRefs: ['artifact://proof'],
    code: 'SEMANTIC_VERIFICATION_PASSED',
    retryable: false,
  })
  assert.equal(model.input?.identity.role, 'semantic_verifier')
  assert.equal(model.input?.identity.verifierRunId, 'verifier-run-1')
  assert.equal(model.input?.context.mode, 'fresh')
  assert.equal(model.input?.responseFormat.schema, SEMANTIC_VERIFICATION_JSON_SCHEMA_V1)
  assert.equal(Object.hasOwn(model.input?.result ?? {}, 'childRunId'), false)
  assert.equal(JSON.stringify(model.input).includes('child-worker'), false)
})

test('non-semantic criteria never call the model and mechanical checks remain parent-owned', async () => {
  const model = new FixtureSemanticModel(() => {
    throw new Error('must not be called')
  })
  const verifier = new SemanticModelVerifierV1(model, {
    budget: BUDGET,
    failureStrategy: 'fail_closed',
  })
  const step = {
    ...semanticStep(),
    criteria: [{ ...semanticStep().criteria[0]!, kind: 'rule' as const }],
  }
  assert.equal(
    (await verifier.verify({ step, result: workerResult() })).code,
    'SEMANTIC_VERIFICATION_NOT_REQUIRED',
  )
  assert.equal(model.calls, 0)

  const environment = {
    fileDigest: async () => DIGEST,
    runCheck: async () => ({ passed: true, evidenceRefs: [] }),
    validateSchema: async () => ({ passed: true, evidenceRefs: [] }),
  }
  const mixed = {
    ...semanticStep(),
    criteria: [
      ...semanticStep().criteria,
      {
        criterionId: 'criterion-file',
        kind: 'file' as const,
        description: 'File digest matches.',
        ref: 'src/input.ts',
        expectedDigest: DIGEST,
      },
    ],
  }
  assert.equal(
    (await new MechanicalVerifierV1(environment).verify({ step: mixed, result: workerResult() }))
      .status,
    'failed',
  )
  assert.equal(model.calls, 0)
})

test('mechanical verification owns schema criteria instead of trusting child self-attestation', async () => {
  let schemaCalls = 0
  const verifier = new MechanicalVerifierV1({
    fileDigest: async () => DIGEST,
    runCheck: async () => ({ passed: true, evidenceRefs: [] }),
    validateSchema: async () => {
      schemaCalls += 1
      return { passed: true, evidenceRefs: ['schema://subagent-result-v1'] }
    },
  })
  const step = {
    ...semanticStep(),
    criteria: [
      {
        criterionId: 'criterion-schema',
        kind: 'schema' as const,
        description: 'Child result is valid and complete.',
      },
    ],
  }
  for (const checks of [
    [],
    [
      {
        id: 'criterion-schema',
        status: 'failed' as const,
        summary: 'The requested command could not run.',
      },
    ],
  ]) {
    const result = await verifier.verify({ step, result: { ...workerResult(), checks } })
    assert.equal(result.status, 'passed')
    assert.equal(result.code, 'MECHANICAL_VERIFICATION_PASSED')
  }
  assert.equal(schemaCalls, 2)

  const passed = await verifier.verify({
    step,
    result: {
      ...workerResult(),
      checks: [{ id: 'criterion-schema', status: 'passed', summary: 'Complete.' }],
    },
  })
  assert.equal(passed.status, 'passed')
  assert.equal(schemaCalls, 3)
})

test('semantic output tolerates harmless explanations but rejects missing or invented evidence', async () => {
  const outputs = [
    '```json\n{"criteria":[]}\n```',
    { criteria: [] },
    {
      criteria: [
        { criterionId: 'criterion-semantic', status: 'passed', evidenceRefs: ['artifact://fake'] },
      ],
    },
    {
      criteria: [{ criterionId: 'unknown', status: 'passed', evidenceRefs: ['artifact://proof'] }],
    },
  ]
  for (const output of outputs) {
    const decision = await new SemanticModelVerifierV1(
      new FixtureSemanticModel(() => ({ output, usage: usage() })),
      { budget: BUDGET, failureStrategy: 'fail_closed' },
    ).verify({ step: semanticStep(), result: workerResult() })
    assert.equal(decision.status, 'failed')
    assert.equal(decision.code, 'SEMANTIC_VERIFIER_SCHEMA_INVALID')
  }

  const explained = await new SemanticModelVerifierV1(
    new FixtureSemanticModel(() => ({
      output: {
        criteria: [
          {
            criterionId: 'criterion-semantic',
            status: 'passed',
            evidenceRefs: ['artifact://proof'],
            explanation: 'The supplied evidence supports the criterion.',
          },
        ],
        summary: 'Verification complete.',
      },
      usage: usage(),
    })),
    { budget: BUDGET, failureStrategy: 'fail_closed' },
  ).verify({ step: semanticStep(), result: workerResult() })
  assert.equal(explained.status, 'passed')

  const askUser = await new SemanticModelVerifierV1(
    new FixtureSemanticModel(() => ({ output: { criteria: [] }, usage: usage() })),
    { budget: BUDGET, failureStrategy: 'ask_user' },
  ).verify({ step: semanticStep(), result: workerResult() })
  assert.equal(askUser.status, 'blocked')
  assert.equal(askUser.code, 'SEMANTIC_VERIFIER_SCHEMA_INVALID_ASK_USER')
  assert.equal(askUser.retryable, true)
})

test('semantic verifier enforces independent usage, deadline, and caller cancellation', async () => {
  for (const [override, code] of [
    [{ inputTokens: 10_001 }, 'SEMANTIC_VERIFIER_INPUT_TOKENS_EXCEEDED'],
    [{ outputTokens: 1_001 }, 'SEMANTIC_VERIFIER_OUTPUT_TOKENS_EXCEEDED'],
    [{ costUsd: 0.021 }, 'SEMANTIC_VERIFIER_COST_EXCEEDED'],
  ] as const) {
    const verifier = new SemanticModelVerifierV1(
      new FixtureSemanticModel(() => ({
        output: validOutput(),
        usage: usage(override),
      })),
      { budget: BUDGET, failureStrategy: 'fail_closed' },
    )
    assert.equal(
      (await verifier.verify({ step: semanticStep(), result: workerResult() })).code,
      code,
    )
  }

  const deadline = new SemanticModelVerifierV1(
    new FixtureSemanticModel(() => new Promise<SemanticVerifierModelOutputV1>(() => undefined)),
    { budget: { ...BUDGET, deadlineMs: 5 }, failureStrategy: 'ask_user' },
  )
  const deadlineDecision = await deadline.verify({ step: semanticStep(), result: workerResult() })
  assert.equal(deadlineDecision.status, 'blocked')
  assert.equal(deadlineDecision.code, 'SEMANTIC_VERIFIER_DEADLINE_EXCEEDED_ASK_USER')

  const controller = new AbortController()
  const cancellable = new SemanticModelVerifierV1(
    new FixtureSemanticModel(
      (input) =>
        new Promise<SemanticVerifierModelOutputV1>((_resolve, reject) => {
          input.signal.addEventListener('abort', () => reject(new Error('cancelled')), {
            once: true,
          })
        }),
    ),
    { budget: BUDGET, failureStrategy: 'fail_closed' },
  )
  const pending = cancellable.verify({
    step: semanticStep(),
    result: workerResult(),
    signal: controller.signal,
  })
  controller.abort()
  assert.equal((await pending).code, 'SEMANTIC_VERIFIER_CANCELLED')
})

test('semantic criterion has an additive replay fixture while unknown future kinds fail closed', () => {
  const graph = new PlanValidator({
    parentBudget: {
      maxTurns: 2,
      maxToolCalls: 2,
      maxTokens: 2_000,
      maxChildRuns: 1,
      maxParallelChildren: 1,
      maxDepth: 1,
    },
    defaultStepBudget: { maxTurns: 1, maxToolCalls: 1, maxTokens: 1_000 },
    accessGrant: { mode: 'read_only', paths: ['.'] },
    allowedCapabilities: ['builtin.read'],
  }).validate({
    objective: 'Semantic replay fixture',
    steps: [
      {
        key: 'semantic',
        title: 'Judge groundedness',
        capabilities: ['builtin.read'],
        criteria: [
          { kind: 'semantic', description: 'Summary is grounded.', ref: 'artifact://proof' },
        ],
      },
    ],
  })
  assert.equal(
    validatePlanGraphV1(JSON.parse(JSON.stringify(graph))).steps[0]?.criteria[0]?.kind,
    'semantic',
  )
  const future = structuredClone(graph) as unknown as {
    steps: Array<{ criteria: Array<{ kind: string }> }>
  }
  future.steps[0]!.criteria[0]!.kind = 'future-model-judge'
  assert.throws(() => validatePlanGraphV1(future), hasCode('PLAN_GRAPH_INVALID'))
})

class FixtureSemanticModel implements SemanticVerifierModelPortV1 {
  readonly identity = { kind: 'model' as const, id: 'semantic-model-fixture' }
  calls = 0
  input?: SemanticVerifierModelInputV1

  constructor(
    private readonly handler: (
      input: SemanticVerifierModelInputV1,
    ) => SemanticVerifierModelOutputV1 | Promise<SemanticVerifierModelOutputV1>,
  ) {}

  async verify(input: SemanticVerifierModelInputV1): Promise<SemanticVerifierModelOutputV1> {
    this.calls += 1
    this.input = input
    return this.handler(input)
  }
}

function semanticStep(): SessionStepProjectionV3 {
  return {
    stepId: 'step-semantic',
    title: 'Judge groundedness',
    order: 0,
    state: 'verifying',
    dependencies: [],
    access: { mode: 'read_only', paths: ['.'] },
    capabilities: ['builtin.read'],
    conflictKeys: [],
    criteria: [
      {
        criterionId: 'criterion-semantic',
        kind: 'semantic',
        description: 'Summary is grounded in the evidence.',
        ref: 'artifact://proof',
      },
    ],
    budget: {
      maxTurns: 1,
      maxToolCalls: 1,
      maxTokens: 1_000,
      maxChildRuns: 0,
      maxParallelChildren: 0,
      maxDepth: 0,
    },
    maxAttempts: 1,
    attemptIds: ['attempt-1'],
    attempts: [],
  }
}

function workerResult(): SubagentResultV1 {
  return {
    schemaVersion: 1,
    childRunId: 'child-worker',
    status: 'succeeded',
    summary: 'Grounded summary.',
    evidenceRefs: [{ kind: 'artifact', ref: 'artifact://proof', digest: DIGEST }],
    changedFiles: [],
    checks: [],
    usage: { turns: 1, toolCalls: 0, subagents: 0 },
    retryable: false,
  }
}

function validOutput() {
  return {
    criteria: [
      { criterionId: 'criterion-semantic', status: 'passed', evidenceRefs: ['artifact://proof'] },
    ],
  }
}

function usage(override: Partial<SemanticVerifierModelOutputV1['usage']> = {}) {
  return { inputTokens: 100, outputTokens: 50, costUsd: 0.001, ...override }
}

function hasCode(code: string) {
  return (error: unknown): boolean =>
    typeof error === 'object' && error !== null && Reflect.get(error, 'code') === code
}
