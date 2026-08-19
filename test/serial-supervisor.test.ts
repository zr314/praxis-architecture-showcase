import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  createSessionCommitV3,
  ReducingSessionJournalV3,
  type SessionEntryV3,
  type SessionStepProjectionV3,
  type SubagentCancellationRequestV1,
  type SubagentEvidenceRefV1,
  type SubagentExecutionRequestV1,
  type SubagentExecutor,
  type SubagentResultV1,
  validateSessionEntryV3,
} from '@praxis/core-sdk'
import { ArtifactStore } from '../apps/runtime/src/artifacts/artifactStore.js'
import {
  type FixedPlanProposalV1,
  initialPlanJournalPayloadsV3,
  PlanValidator,
} from '../apps/runtime/src/planner/planValidator.js'
import {
  type FixedPlanSubagentRequestFactoryV1,
  SerialSupervisor,
} from '../apps/runtime/src/planner/serialSupervisor.js'
import {
  type MechanicalVerificationEnvironmentV1,
  MechanicalVerifierV1,
  RuleVerifierV1,
  type SupervisorVerifierV1,
} from '../apps/runtime/src/planner/verifier.js'
import { JsonlSessionJournalV3 } from '../apps/runtime/src/session-db/jsonlSessionJournalV3.js'
import { createSubagentResultV1 } from '../apps/runtime/src/subagent/contextPacket.js'

const DIGEST = `sha256:${'d'.repeat(64)}` as `sha256:${string}`

test('SerialSupervisor executes fixed dependencies one at a time and releases only verified success', async () => {
  const harness = await createHarness(twoStepProposal(), (step, childRunId) =>
    succeededResult(step, childRunId),
  )
  try {
    const result = await harness.supervisor.execute(harness.input)
    assert.deepEqual(result, { planId: harness.planId, state: 'succeeded' })
    assert.deepEqual(harness.executor.stepOrder, ['step-read', 'step-summarize'])
    assert.equal(harness.executor.maxActive, 1)

    const projection = await harness.journal.loadProjection('session-supervisor')
    assert.equal(projection.planGraph?.state, 'succeeded')
    assert.deepEqual(projection.planGraph?.readyStepIds, [])
    assert.equal(projection.snapshot.runs[0]?.state, 'completed')
    for (const step of projection.planGraph?.steps ?? []) {
      assert.equal(step.state, 'succeeded')
      assert.equal(step.attempts.length, 1)
      assert.equal(step.attempts[0]?.state, 'verified')
      assert.equal(step.attempts[0]?.verifications.length, 2)
      assert.match(step.attempts[0]?.resultRef ?? '', /^artifact:\/\/artifact-/)
      assert.match(step.attempts[0]?.resultDigest ?? '', /^sha256:[a-f0-9]{64}$/)
    }

    const entries = await readAll(harness.journal)
    for (const attemptId of projection.planGraph?.steps.flatMap((step) => step.attemptIds) ?? []) {
      const binding = entries.find(
        (entry) => entry.type === 'subagent.execution_bound' && entry.data.attemptId === attemptId,
      )
      const executionRevision = entries.find(
        (entry) =>
          entry.type === 'attempt.execution_completed' && entry.data.attemptId === attemptId,
      )?.revision
      assert.equal(binding?.type, 'subagent.execution_bound')
      if (binding?.type !== 'subagent.execution_bound') assert.fail('execution binding missing')
      assert.equal(binding.data.retrySafety, 'unknown')
      assert.ok(executionRevision !== undefined)
      assert.ok(binding !== undefined && binding.revision < executionRevision)
      assert.equal(
        entries.find(
          (entry) =>
            entry.type === 'subagent.result_recorded' && entry.data.attemptId === attemptId,
        )?.revision,
        executionRevision,
      )
      assert.equal(
        entries.find(
          (entry) =>
            entry.type === 'step.state_changed' &&
            entry.data.stepId ===
              projection.planGraph?.steps.find((step) => step.attemptIds.includes(attemptId))
                ?.stepId &&
            entry.data.state === 'verifying',
        )?.revision,
        executionRevision,
      )
    }
    const terminal = entries.filter((entry) => entry.type === 'run.terminal')
    assert.equal(terminal.length, 1)
    const finalStep = [...entries]
      .reverse()
      .find((entry) => entry.type === 'step.state_changed' && entry.data.state === 'succeeded')
    const finalPlan = entries.find(
      (entry) => entry.type === 'plan.state_changed' && entry.data.state === 'succeeded',
    )
    assert.equal(finalStep?.revision, finalPlan?.revision)
    assert.equal(finalPlan?.revision, terminal[0]?.revision)
  } finally {
    await harness.cleanup()
  }
})

test('SerialSupervisor retries with a new immutable attempt and then succeeds', async () => {
  let executions = 0
  const harness = await createHarness(singleStepProposal(2), (step, childRunId) => {
    executions += 1
    return executions === 1
      ? failedResult(childRunId, true, 'CHILD_RETRYABLE')
      : succeededResult(step, childRunId)
  })
  try {
    assert.deepEqual(await harness.supervisor.execute(harness.input), {
      planId: harness.planId,
      state: 'succeeded',
    })
    const step = (await harness.journal.loadProjection('session-supervisor')).planGraph?.steps[0]
    assert.equal(step?.attempts.length, 2)
    assert.notEqual(step?.attemptIds[0], step?.attemptIds[1])
    assert.equal(step?.attempts[0]?.state, 'execution_failed')
    assert.equal(step?.attempts[1]?.state, 'verified')
    assert.equal(harness.executor.maxActive, 1)
  } finally {
    await harness.cleanup()
  }
})

test('verification scope violation blocks the plan and never releases its dependency', async () => {
  const harness = await createHarness(twoStepProposal(), (step, childRunId) => ({
    ...succeededResult(step, childRunId),
    changedFiles: [{ path: 'src/forbidden.ts', change: 'modified', digest: DIGEST }],
  }))
  try {
    assert.deepEqual(await harness.supervisor.execute(harness.input), {
      planId: harness.planId,
      state: 'blocked',
    })
    const projection = await harness.journal.loadProjection('session-supervisor')
    assert.equal(projection.planGraph?.steps[0]?.state, 'blocked')
    assert.equal(projection.planGraph?.steps[1]?.state, 'pending')
    assert.equal(harness.executor.stepOrder.length, 1)
    assert.equal(projection.snapshot.runs[0]?.state, 'failed')
    assert.equal(projection.snapshot.runs[0]?.errorCode, 'SUPERVISOR_VERIFICATION_BLOCKED')
  } finally {
    await harness.cleanup()
  }
})

test('mechanical digest mismatch fails before dependency release even when child reports success', async () => {
  const harness = await createHarness(
    twoStepProposal(),
    (step, childRunId) => succeededResult(step, childRunId),
    false,
    {
      fileDigest: async () => `sha256:${'e'.repeat(64)}`,
      runCheck: async (checkId) => ({ passed: true, evidenceRefs: [`check://${checkId}`] }),
      validateSchema: async (schemaRef) => ({
        passed: true,
        evidenceRefs: [`schema://${schemaRef}`],
      }),
    },
  )
  try {
    assert.equal((await harness.supervisor.execute(harness.input)).state, 'failed')
    const projection = await harness.journal.loadProjection('session-supervisor')
    assert.deepEqual(
      projection.planGraph?.steps.map((step) => step.state),
      ['failed', 'cancelled'],
    )
    assert.deepEqual(
      projection.planGraph?.steps[0]?.attempts[0]?.verifications.map(
        (verification) => verification.status,
      ),
      ['failed', 'passed'],
    )
    assert.equal(harness.executor.stepOrder.length, 1)
  } finally {
    await harness.cleanup()
  }
})

test('semantic model verification runs only after mechanical and rule gates pass', async () => {
  let modelCalls = 0
  const semanticVerifier: SupervisorVerifierV1 = {
    verify: async () => {
      modelCalls += 1
      return {
        verifier: 'model',
        status: 'passed',
        evidenceRefs: ['artifact://proof'],
        code: 'SEMANTIC_VERIFICATION_PASSED',
        retryable: false,
      }
    },
  }
  const proposal: FixedPlanProposalV1 = {
    objective: 'Verify semantics after mechanics.',
    steps: [
      {
        key: 'read',
        title: 'Verify result',
        access: { mode: 'read_only', paths: ['src'] },
        capabilities: ['builtin.read'],
        criteria: [
          {
            kind: 'file',
            description: 'Input digest matches.',
            ref: 'src/input.ts',
            expectedDigest: DIGEST,
          },
          { kind: 'semantic', description: 'Summary is grounded.' },
        ],
      },
    ],
  }

  const failedMechanical = await createHarness(
    proposal,
    (step, childRunId) => succeededResult(step, childRunId),
    false,
    {
      fileDigest: async () => `sha256:${'e'.repeat(64)}`,
      runCheck: async () => ({ passed: true, evidenceRefs: [] }),
      validateSchema: async () => ({ passed: true, evidenceRefs: [] }),
    },
    undefined,
    semanticVerifier,
  )
  try {
    assert.equal(
      (await failedMechanical.supervisor.execute(failedMechanical.input)).state,
      'failed',
    )
    assert.equal(modelCalls, 0)
    assert.deepEqual(
      (
        await failedMechanical.journal.loadProjection('session-supervisor')
      ).planGraph?.steps[0]?.attempts[0]?.verifications.map((value) => value.verifier),
      ['mechanical', 'rule'],
    )
  } finally {
    await failedMechanical.cleanup()
  }

  const passedMechanical = await createHarness(
    proposal,
    (step, childRunId) => succeededResult(step, childRunId),
    false,
    undefined,
    undefined,
    semanticVerifier,
  )
  try {
    assert.equal(
      (await passedMechanical.supervisor.execute(passedMechanical.input)).state,
      'succeeded',
    )
    assert.equal(modelCalls, 1)
    assert.deepEqual(
      (
        await passedMechanical.journal.loadProjection('session-supervisor')
      ).planGraph?.steps[0]?.attempts[0]?.verifications.map((value) => value.verifier),
      ['mechanical', 'rule', 'model'],
    )
  } finally {
    await passedMechanical.cleanup()
  }
})

test('non-retryable execution failure cancels downstream and finalizes step, plan, and run atomically', async () => {
  const harness = await createHarness(twoStepProposal(), (_step, childRunId) =>
    failedResult(childRunId, false, 'CHILD_FATAL'),
  )
  try {
    assert.deepEqual(await harness.supervisor.execute(harness.input), {
      planId: harness.planId,
      state: 'failed',
    })
    const projection = await harness.journal.loadProjection('session-supervisor')
    assert.deepEqual(
      projection.planGraph?.steps.map((step) => step.state),
      ['failed', 'cancelled'],
    )
    const entries = await readAll(harness.journal)
    const failureRevision = entries.find(
      (entry) => entry.type === 'attempt.execution_completed' && entry.data.status === 'failed',
    )?.revision
    assert.ok(failureRevision !== undefined)
    assert.equal(
      entries.find((entry) => entry.type === 'plan.state_changed' && entry.data.state === 'failed')
        ?.revision,
      failureRevision,
    )
    assert.equal(entries.find((entry) => entry.type === 'run.terminal')?.revision, failureRevision)
  } finally {
    await harness.cleanup()
  }
})

test('structural no-ready state reports a deterministic blocked outcome without model guessing', async () => {
  const harness = await createHarness(
    twoStepProposal(),
    (step, childRunId) => succeededResult(step, childRunId),
    false,
    undefined,
    { plan: 'running', steps: ['blocked', 'pending'] },
  )
  try {
    assert.equal((await harness.supervisor.execute(harness.input)).state, 'blocked')
    assert.equal(harness.executor.stepOrder.length, 0)
    const projection = await harness.journal.loadProjection('session-supervisor')
    assert.equal(projection.snapshot.runs[0]?.errorCode, 'SUPERVISOR_BLOCKED')
  } finally {
    await harness.cleanup()
  }
})

test('deadline prevents child execution, cancellation reaches the active executor, and restart never retries', async (context) => {
  await context.test('deadline', async () => {
    const proposal = singleStepProposal(1)
    proposal.steps[0]!.budget = { deadlineAt: '2026-08-02T00:00:00.000Z' }
    const harness = await createHarness(proposal, (step, childRunId) =>
      succeededResult(step, childRunId),
    )
    try {
      assert.equal((await harness.supervisor.execute(harness.input)).state, 'failed')
      assert.equal(harness.executor.stepOrder.length, 0)
    } finally {
      await harness.cleanup()
    }
  })

  await context.test('active cancellation', async () => {
    const controller = new AbortController()
    const harness = await createHarness(singleStepProposal(1), undefined, true)
    try {
      const running = harness.supervisor.execute({ ...harness.input, signal: controller.signal })
      await harness.executor.started
      controller.abort()
      assert.equal((await running).state, 'cancelled')
      assert.equal(harness.executor.cancelCalls, 1)
      assert.equal(
        (await harness.journal.loadProjection('session-supervisor')).snapshot.runs[0]?.state,
        'aborted',
      )
    } finally {
      await harness.cleanup()
    }
  })

  await context.test('late child success cannot override cancellation', async () => {
    const controller = new AbortController()
    const harness = await createHarness(singleStepProposal(1), (step, childRunId) => {
      controller.abort()
      return succeededResult(step, childRunId)
    })
    try {
      assert.equal(
        (
          await harness.supervisor.execute({
            ...harness.input,
            signal: controller.signal,
          })
        ).state,
        'cancelled',
      )
      assert.equal(harness.executor.cancelCalls, 1)
      assert.equal(
        (await harness.journal.loadProjection('session-supervisor')).planGraph?.state,
        'cancelled',
      )
    } finally {
      await harness.cleanup()
    }
  })

  await context.test('cancellation during parent verification wins', async () => {
    const controller = new AbortController()
    const harness = await createHarness(
      twoStepProposal(),
      (step, childRunId) => succeededResult(step, childRunId),
      false,
      {
        fileDigest: async () => DIGEST,
        runCheck: async (checkId) => ({ passed: true, evidenceRefs: [`check://${checkId}`] }),
        validateSchema: async () => {
          controller.abort()
          return { passed: true, evidenceRefs: ['schema://result'] }
        },
      },
    )
    try {
      assert.equal(
        (
          await harness.supervisor.execute({
            ...harness.input,
            signal: controller.signal,
          })
        ).state,
        'cancelled',
      )
      const projection = await harness.journal.loadProjection('session-supervisor')
      assert.equal(projection.planGraph?.steps[0]?.state, 'cancelled')
      assert.equal(projection.planGraph?.steps[0]?.attempts[0]?.state, 'cancelled')
    } finally {
      await harness.cleanup()
    }
  })

  await context.test('restart recovery', async () => {
    const harness = await createHarness(singleStepProposal(1), (step, childRunId) =>
      succeededResult(step, childRunId),
    )
    try {
      const projection = await harness.journal.loadProjection('session-supervisor')
      const plan = projection.planGraph!
      const step = plan.steps[0]!
      await appendEvents(harness.journal, projection, [
        planEvent(plan.planId, plan.revision, 'running'),
        attemptCreated(plan, step),
        stepState(plan, step, 'running'),
        attemptState(plan, step, 'attempt-restart', 'running'),
      ])
      assert.equal(
        (await harness.supervisor.recoverInterrupted(harness.input)).state,
        'interrupted',
      )
      const recovered = await harness.journal.loadProjection('session-supervisor')
      assert.equal(recovered.planGraph?.state, 'interrupted')
      assert.equal(recovered.planGraph?.steps[0]?.state, 'interrupted')
      assert.equal(recovered.planGraph?.steps[0]?.attempts[0]?.state, 'interrupted')
      const before = recovered.snapshot.sequence
      assert.equal(
        (await harness.supervisor.recoverInterrupted(harness.input)).state,
        'interrupted',
      )
      assert.equal((await harness.journal.loadSnapshot('session-supervisor')).sequence, before)
      assert.equal(harness.executor.stepOrder.length, 0)
    } finally {
      await harness.cleanup()
    }
  })
})

type ResultFactory = (
  step: SessionStepProjectionV3,
  childRunId: string,
) => SubagentResultV1 | Promise<SubagentResultV1>

async function createHarness(
  proposal: FixedPlanProposalV1,
  resultFactory?: ResultFactory,
  pending = false,
  mechanicalEnvironment: MechanicalVerificationEnvironmentV1 = {
    fileDigest: async () => DIGEST,
    runCheck: async (checkId) => ({ passed: true, evidenceRefs: [`check://${checkId}`] }),
    validateSchema: async (schemaRef) => ({
      passed: true,
      evidenceRefs: [`schema://${schemaRef}`],
    }),
  },
  initialState?: Readonly<{
    plan: 'draft' | 'running'
    steps: readonly ('pending' | 'blocked')[]
  }>,
  semanticVerifier?: SupervisorVerifierV1,
) {
  const root = await mkdtemp(join(tmpdir(), 'praxis-serial-supervisor-'))
  const store = new JsonlSessionJournalV3(root)
  await store.initialize()
  const journal = new ReducingSessionJournalV3(store)
  const graph = new PlanValidator({
    parentBudget: {
      maxTurns: 8,
      maxToolCalls: 8,
      maxTokens: 8_000,
      maxChildRuns: 4,
      maxParallelChildren: 1,
      maxDepth: 1,
    },
    defaultStepBudget: { maxTurns: 2, maxToolCalls: 2, maxTokens: 1_000 },
    accessGrant: { mode: 'read_only', paths: ['.'] },
    allowedCapabilities: ['builtin.read'],
    createId: (kind, source) => `${kind}-${source.replaceAll(':', '-')}`,
  }).validate(proposal)
  const payloads = initialPlanJournalPayloadsV3(graph)
  await journal.appendCommit(
    createSessionCommitV3({
      sessionId: 'session-supervisor',
      commitId: 'commit-initial',
      expectedRevision: 0,
      idempotencyKey: 'idem-initial',
      entries: [
        entry(1, 1, 'session.created', {
          cwd: 'D:/workspace',
          provider: 'fixture',
          model: 'fixture-model',
          name: 'Serial Supervisor',
          labels: [],
        }),
        entry(2, 1, 'run.started', { clientRequestId: 'request-parent' }, 'run-parent'),
        ...payloads.map((payload, index) => {
          const data = structuredClone(payload.data) as Record<string, unknown>
          if (payload.type === 'plan.created' && initialState !== undefined) {
            data.state = initialState.plan
          }
          if (payload.type === 'step.created' && initialState !== undefined) {
            data.state = initialState.steps[index - 1]
          }
          return entry(index + 3, 1, payload.type, data, 'run-parent')
        }),
      ],
    }),
  )

  const requestFactory = new RequestFactory()
  const executor = new FixtureExecutor(
    requestFactory,
    resultFactory ?? ((step, childRunId) => succeededResult(step, childRunId)),
    pending,
  )
  let id = 0
  const supervisor = new SerialSupervisor({
    journal,
    executor,
    requestFactory,
    artifactStore: new ArtifactStore(join(root, 'artifacts')),
    mechanicalVerifier: new MechanicalVerifierV1(mechanicalEnvironment),
    ruleVerifier: new RuleVerifierV1(),
    ...(semanticVerifier === undefined ? {} : { semanticVerifier }),
    createId: (kind) => `${safePrefix(kind)}-${++id}`,
    now: () => '2026-08-03T00:00:00.000Z',
  })
  return {
    root,
    journal,
    executor,
    supervisor,
    planId: graph.planId,
    input: {
      sessionId: 'session-supervisor',
      parentRunId: 'run-parent',
      planId: graph.planId,
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  }
}

class RequestFactory implements FixedPlanSubagentRequestFactoryV1 {
  readonly steps = new Map<string, SessionStepProjectionV3>()

  create(input: {
    parentRunId: string
    step: SessionStepProjectionV3
    childRunId: string
  }): SubagentExecutionRequestV1 {
    this.steps.set(input.childRunId, input.step)
    return {
      schemaVersion: 1,
      parentRunId: input.parentRunId,
      childRunId: input.childRunId,
      packetRef: ref('context_packet', `packet-${input.childRunId}`, 1),
      profileRef: ref('bootstrap_profile', input.childRunId, 3),
      bundleRef: ref('capability_bundle', `bundle-${input.childRunId}`, 1),
      budgetRef: ref('execution_budget', `budget-${input.childRunId}`, 1),
    }
  }
}

class FixtureExecutor implements SubagentExecutor {
  readonly stepOrder: string[] = []
  maxActive = 0
  cancelCalls = 0
  active = 0
  readonly #started = deferred<void>()
  readonly #cancelled = deferred<void>()

  constructor(
    private readonly requests: RequestFactory,
    private readonly resultFactory: ResultFactory,
    private readonly pending: boolean,
  ) {}

  get started(): Promise<void> {
    return this.#started.promise
  }

  async execute(request: SubagentExecutionRequestV1): Promise<SubagentResultV1> {
    const step = this.requests.steps.get(request.childRunId)
    assert.ok(step)
    this.stepOrder.push(step.stepId)
    this.active += 1
    this.maxActive = Math.max(this.maxActive, this.active)
    this.#started.resolve()
    try {
      if (this.pending) {
        await this.#cancelled.promise
        return cancelledResult(request.childRunId)
      }
      return await this.resultFactory(step, request.childRunId)
    } finally {
      this.active -= 1
    }
  }

  async cancel(_request: SubagentCancellationRequestV1): Promise<boolean> {
    this.cancelCalls += 1
    this.#cancelled.resolve()
    return true
  }
}

function twoStepProposal(): FixedPlanProposalV1 {
  return {
    objective: 'Read and summarize.',
    steps: [
      {
        key: 'read',
        title: 'Read evidence',
        access: { mode: 'read_only', paths: ['src'] },
        capabilities: ['builtin.read'],
        criteria: [
          { kind: 'schema', description: 'Result schema is valid.', ref: 'result-schema' },
          {
            kind: 'file',
            description: 'Input file is present.',
            ref: 'src/input.ts',
            expectedDigest: DIGEST,
          },
          {
            kind: 'digest',
            description: 'Digest evidence matches.',
            ref: 'result://digest',
            expectedDigest: DIGEST,
          },
          { kind: 'command', description: 'Build command passes.', ref: 'check.build' },
          { kind: 'check', description: 'Lint check passes.', ref: 'check.lint' },
          { kind: 'rule', description: 'Child confirms the bounded objective.' },
        ],
      },
      {
        key: 'summarize',
        title: 'Summarize evidence',
        dependencies: ['read'],
        access: { mode: 'read_only', paths: ['src'] },
        capabilities: ['builtin.read'],
        criteria: [{ kind: 'rule', description: 'Summary is evidence grounded.' }],
      },
    ],
  }
}

function singleStepProposal(maxAttempts: number): FixedPlanProposalV1 & {
  steps: Array<FixedPlanProposalV1['steps'][number] & { budget?: { deadlineAt?: string } }>
} {
  return {
    objective: 'Complete one bounded step.',
    steps: [
      {
        key: 'read',
        title: 'Read evidence',
        access: { mode: 'read_only', paths: ['src'] },
        capabilities: ['builtin.read'],
        criteria: [{ kind: 'rule', description: 'Child confirms success.' }],
        maxAttempts,
      },
    ],
  }
}

function succeededResult(step: SessionStepProjectionV3, childRunId: string): SubagentResultV1 {
  const evidenceRefs: SubagentEvidenceRefV1[] = []
  for (const criterion of step.criteria) {
    if (criterion.kind === 'file' && criterion.ref !== undefined) {
      evidenceRefs.push({ kind: 'file', ref: criterion.ref, digest: DIGEST })
    }
    if (criterion.kind === 'digest') {
      evidenceRefs.push({
        kind: 'result',
        ref: criterion.ref ?? 'result://digest',
        digest: DIGEST,
      })
    }
  }
  const checks = step.criteria
    .filter((criterion) => criterion.kind !== 'semantic')
    .map((criterion) => ({
      id: criterion.criterionId,
      status: 'passed' as const,
      summary: 'passed',
      evidenceRef: `check://${criterion.criterionId}`,
    }))
  return createSubagentResultV1({
    childRunId,
    status: 'succeeded',
    summary: `completed ${step.stepId}`,
    evidenceRefs,
    changedFiles: [],
    checks,
    usage: { turns: 1, toolCalls: 1, subagents: 0 },
    retryable: false,
  })
}

function failedResult(childRunId: string, retryable: boolean, code: string): SubagentResultV1 {
  return createSubagentResultV1({
    childRunId,
    status: 'failed',
    summary: 'child failed',
    evidenceRefs: [],
    changedFiles: [],
    checks: [],
    usage: { turns: 1, toolCalls: 0, subagents: 0 },
    retryable,
    error: { code, category: 'execution', message: 'bounded failure', retryable },
  })
}

function cancelledResult(childRunId: string): SubagentResultV1 {
  return createSubagentResultV1({
    childRunId,
    status: 'cancelled',
    summary: 'cancelled',
    evidenceRefs: [],
    changedFiles: [],
    checks: [],
    usage: { turns: 0, toolCalls: 0, subagents: 0 },
    retryable: false,
    error: {
      code: 'PARENT_CANCELLED',
      category: 'cancellation',
      message: 'parent cancelled',
      retryable: false,
    },
  })
}

function ref(kind: SubagentExecutionRequestV1['packetRef']['kind'], id: string, version: number) {
  return { schemaVersion: 1 as const, kind, id, version, digest: DIGEST }
}

async function readAll(journal: ReducingSessionJournalV3): Promise<readonly SessionEntryV3[]> {
  return (await journal.readEntries({ sessionId: 'session-supervisor' })).entries
}

async function appendEvents(
  journal: ReducingSessionJournalV3,
  projection: Awaited<ReturnType<ReducingSessionJournalV3['loadProjection']>>,
  events: readonly { type: string; data: Record<string, unknown> }[],
): Promise<void> {
  await journal.appendCommit(
    createSessionCommitV3({
      sessionId: 'session-supervisor',
      commitId: 'commit-restart-active',
      expectedRevision: projection.snapshot.revision,
      idempotencyKey: 'idem-restart-active',
      entries: events.map((event, index) =>
        entry(
          projection.snapshot.sequence + index + 1,
          projection.snapshot.revision + 1,
          event.type,
          event.data,
          'run-parent',
        ),
      ),
    }),
  )
}

function planEvent(planId: string, planRevision: number, state: string) {
  return { type: 'plan.state_changed', data: { planId, planRevision, state } }
}

function attemptCreated(
  plan: NonNullable<Awaited<ReturnType<ReducingSessionJournalV3['loadProjection']>>['planGraph']>,
  step: SessionStepProjectionV3,
) {
  return {
    type: 'attempt.created',
    data: {
      planId: plan.planId,
      planRevision: plan.revision,
      stepId: step.stepId,
      attemptId: 'attempt-restart',
      ordinal: 1,
      state: 'reserved',
      childRunId: 'child-restart',
    },
  }
}

function stepState(
  plan: NonNullable<Awaited<ReturnType<ReducingSessionJournalV3['loadProjection']>>['planGraph']>,
  step: SessionStepProjectionV3,
  state: string,
) {
  return {
    type: 'step.state_changed',
    data: { planId: plan.planId, planRevision: plan.revision, stepId: step.stepId, state },
  }
}

function attemptState(
  plan: NonNullable<Awaited<ReturnType<ReducingSessionJournalV3['loadProjection']>>['planGraph']>,
  step: SessionStepProjectionV3,
  attemptId: string,
  state: string,
) {
  return {
    type: 'attempt.state_changed',
    data: {
      planId: plan.planId,
      planRevision: plan.revision,
      stepId: step.stepId,
      attemptId,
      state,
    },
  }
}

function entry(
  sequence: number,
  revision: number,
  type: string,
  data: Record<string, unknown>,
  runId?: string,
): SessionEntryV3 {
  return validateSessionEntryV3({
    schemaVersion: 3,
    entryId: `entry-${sequence}-${type.replaceAll('.', '-')}`,
    sessionId: 'session-supervisor',
    sequence,
    revision,
    timestamp: new Date(Date.UTC(2026, 7, 3, 0, 0, sequence)).toISOString(),
    type,
    ...(runId === undefined ? {} : { runId }),
    data,
  })
}

function safePrefix(value: string): string {
  return value.replaceAll(/[^A-Za-z0-9._+-]/g, '-').slice(0, 48) || 'id'
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}
