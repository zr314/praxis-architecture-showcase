import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  type ArtifactReference,
  createSessionCommitV3,
  type ExecutionBudget,
  ReducingSessionJournalV3,
  type SessionCommitV3,
  type SessionEntryV3,
  type SessionJournalV3,
  type SessionStepProjectionV3,
  type SubagentCancellationRequestV1,
  type SubagentExecutionRequestV1,
  type SubagentExecutor,
  type SubagentResultV1,
  validateSessionEntryV3,
} from '@praxis/core-sdk'
import { DagRecoveryCoordinatorV1 } from '../apps/runtime/src/planner/dagRecovery.js'
import { DagSchedulerV1 } from '../apps/runtime/src/planner/dagScheduler.js'
import {
  type DagSupervisorInputV1,
  DagSupervisorV1,
} from '../apps/runtime/src/planner/dagSupervisor.js'
import {
  type FixedPlanProposalV1,
  initialPlanJournalPayloadsV3,
  PlanValidator,
} from '../apps/runtime/src/planner/planValidator.js'
import type { SupervisorVerifierV1 } from '../apps/runtime/src/planner/verifier.js'
import { JsonlSessionJournalV3 } from '../apps/runtime/src/session-db/jsonlSessionJournalV3.js'

const SESSION_ID = 'session-dag-supervisor'
const RUN_ID = 'run-parent'
const NOW = '2026-08-03T00:00:00.000Z'
const DIGEST = `sha256:${'d'.repeat(64)}` as `sha256:${string}`

test('DagSupervisor runs two verified branches concurrently and emits one ordered terminal', async () => {
  const barrier = createBarrier(2)
  const harness = await createHarness(twoIndependentSteps(), async (request) => {
    await barrier()
    return succeeded(request.childRunId)
  })
  try {
    const result = await harness.supervisor.execute(harness.input)
    assert.equal(result.state, 'succeeded')
    assert.equal(harness.executor.maxActive, 2)
    assert.deepEqual(
      result.stepStates.map((step) => step.state),
      ['succeeded', 'succeeded'],
    )
    assert.equal((await harness.journal.loadProjection(SESSION_ID)).snapshot.usage.subagents, 2)

    const entries = await readAll(harness.journal)
    assertSingleTerminal(entries)
    for (const attempt of entries.filter((entry) => entry.type === 'attempt.created')) {
      const attemptId = attempt.data.attemptId
      const index = (type: SessionEntryV3['type']) =>
        entries.findIndex(
          (entry) => entry.type === type && entry.correlation?.attemptId === attemptId,
        )
      assert.ok(index('attempt.created') < index('subagent.execution_bound'))
      assert.ok(index('subagent.execution_bound') < index('subagent.result_recorded'))
      assert.ok(index('subagent.result_recorded') < index('attempt.execution_completed'))
      assert.ok(index('attempt.execution_completed') < index('verification.recorded'))
      assert.ok(
        index('verification.recorded') <
          entries.findIndex((entry) => entry.type === 'run.terminal'),
      )
    }
  } finally {
    await harness.cleanup()
  }
})

test('DagSupervisor collect_partial preserves success and fails once after the other branch fails', async () => {
  const harness = await createHarness(twoIndependentSteps(), async (request, stepId) =>
    stepId.endsWith('beta') ? failed(request.childRunId) : succeeded(request.childRunId),
  )
  try {
    const result = await harness.supervisor.execute(harness.input)
    assert.equal(result.state, 'failed')
    assert.deepEqual(
      result.stepStates.map((step) => step.state),
      ['succeeded', 'failed'],
    )
    assertSingleTerminal(await readAll(harness.journal))
  } finally {
    await harness.cleanup()
  }
})

test('DagSupervisor preserves a timed-out partial artifact and retries read-only work within budget', async () => {
  let executions = 0
  const harness = await createHarness(
    oneStep({ maxAttempts: 2 }),
    async (request) => {
      executions += 1
      return executions === 1 ? timedOut(request.childRunId) : succeeded(request.childRunId)
    },
    { parentBudget: parentBudget({ maxChildRuns: 2, maxParallelChildren: 1 }) },
  )
  try {
    const result = await harness.supervisor.execute(harness.input)
    assert.equal(result.state, 'succeeded')
    assert.equal(harness.executor.started, 2)
    const projection = await harness.journal.loadProjection(SESSION_ID)
    assert.equal(projection.planGraph?.steps[0]?.attempts.length, 2)
    assert.equal(
      projection.planGraph?.steps[0]?.attempts.filter((attempt) => attempt.resultRef).length,
      2,
    )
    const entries = await readAll(harness.journal)
    assert.ok(
      entries.some(
        (entryValue) =>
          entryValue.type === 'step.state_changed' &&
          entryValue.data.errorCode === 'CHILD_DEADLINE_EXCEEDED',
      ),
    )
  } finally {
    await harness.cleanup()
  }
})

test('DagSupervisor retries a retryable verification failure within the Step budget', async () => {
  let verifications = 0
  const harness = await createHarness(
    oneStep({ maxAttempts: 2 }),
    async (request) => succeeded(request.childRunId),
    {
      mechanicalVerifier: {
        verify: async () => {
          verifications += 1
          return verifications === 1
            ? {
                verifier: 'mechanical' as const,
                status: 'failed' as const,
                evidenceRefs: [],
                code: 'MECHANICAL_RESULT_RETRYABLE',
                retryable: true,
              }
            : verification('mechanical', 'passed')
        },
      },
      parentBudget: parentBudget({ maxChildRuns: 2, maxParallelChildren: 1 }),
    },
  )
  try {
    const result = await harness.supervisor.execute(harness.input)
    assert.equal(result.state, 'succeeded')
    assert.equal(harness.executor.started, 2)
    const projection = await harness.journal.loadProjection(SESSION_ID)
    assert.equal(projection.planGraph?.steps[0]?.attempts.length, 2)
    assert.deepEqual(
      projection.planGraph?.steps[0]?.attempts.map((attempt) => attempt.state),
      ['rejected', 'verified'],
    )
  } finally {
    await harness.cleanup()
  }
})

test('DagSupervisor fail_fast cancels the sibling but preserves the causal failure', async () => {
  const barrier = createBarrier(2)
  const harness = await createHarness(twoIndependentSteps(), async (request, stepId) => {
    await barrier()
    if (stepId.endsWith('alpha')) return failed(request.childRunId)
    return new Promise<SubagentResultV1>(() => undefined)
  })
  try {
    const result = await harness.supervisor.execute({ ...harness.input, failureMode: 'fail_fast' })
    assert.equal(result.state, 'failed')
    assert.deepEqual(
      result.stepStates.map((step) => step.state),
      ['failed', 'cancelled'],
    )
    assert.equal(harness.executor.cancelled.size, 1)
    assertSingleTerminal(await readAll(harness.journal))
  } finally {
    await harness.cleanup()
  }
})

test('DagSupervisor cancels simultaneous children and writes one parent terminal', async () => {
  const harness = await createHarness(
    twoIndependentSteps(),
    () => new Promise<SubagentResultV1>(() => undefined),
  )
  const controller = new AbortController()
  try {
    const running = harness.supervisor.execute({ ...harness.input, signal: controller.signal })
    await harness.executor.waitForActive(2)
    controller.abort('test cancellation')
    const result = await running
    assert.equal(result.state, 'cancelled')
    assert.equal(harness.executor.cancelled.size, 2)
    assert.ok(result.stepStates.every((step) => step.state === 'cancelled'))
    assertSingleTerminal(await readAll(harness.journal))
  } finally {
    await harness.cleanup()
  }
})

test('DagSupervisor fails closed when either parent verifier crashes', async () => {
  const harness = await createHarness(
    twoIndependentSteps(),
    async (request) => succeeded(request.childRunId),
    {
      mechanicalVerifier: {
        verify: async ({ step }) => {
          if (step.stepId.endsWith('beta')) throw new Error('verifier crashed')
          return verification('mechanical', 'passed')
        },
      },
    },
  )
  try {
    const result = await harness.supervisor.execute(harness.input)
    assert.equal(result.state, 'blocked')
    assert.deepEqual(
      result.stepStates.map((step) => step.state),
      ['succeeded', 'blocked'],
    )
    const projection = await harness.journal.loadProjection(SESSION_ID)
    assert.equal(projection.planGraph?.steps[1]?.errorCode, 'VERIFIER_FAILED')
    assertSingleTerminal(await readAll(harness.journal))
  } finally {
    await harness.cleanup()
  }
})

test('DagSupervisor records a semantic gate after mechanical and rule verification', async () => {
  let semanticCalls = 0
  const proposal: FixedPlanProposalV1 = {
    objective: 'Run one semantic verification.',
    steps: [
      {
        ...step('only'),
        criteria: [
          { kind: 'semantic', description: 'The result is grounded in the supplied evidence.' },
        ],
      },
    ],
  }
  const harness = await createHarness(proposal, async (request) => succeeded(request.childRunId), {
    semanticVerifier: {
      verify: async () => {
        semanticCalls += 1
        return verification('model', 'passed')
      },
    },
  })
  try {
    assert.equal((await harness.supervisor.execute(harness.input)).state, 'succeeded')
    assert.equal(semanticCalls, 1)
    const projection = await harness.journal.loadProjection(SESSION_ID)
    assert.deepEqual(
      projection.planGraph?.steps[0]?.attempts[0]?.verifications.map((value) => value.verifier),
      ['mechanical', 'rule', 'model'],
    )
    assert.deepEqual(
      projection.planGraph?.steps[0]?.attempts[0]?.verifications.map((value) => value.code),
      ['MECHANICAL_PASSED', 'RULE_PASSED', 'MODEL_PASSED'],
    )
  } finally {
    await harness.cleanup()
  }
})

test('DagScheduler leases ancestor execution budget without serializing independent Steps', async () => {
  const budget = parentBudget({ maxTurns: 3, maxParallelChildren: 2 })
  const barrier = createBarrier(2)
  const harness = await createHarness(
    twoIndependentSteps({ maxTurns: 2 }),
    async (request) => {
      await barrier()
      return succeeded(request.childRunId)
    },
    { parentBudget: budget },
  )
  try {
    const result = await harness.supervisor.execute(harness.input)
    assert.equal(result.state, 'succeeded')
    assert.equal(harness.executor.maxActive, 2)
    const projection = await harness.journal.loadProjection(SESSION_ID)
    assert.equal(projection.snapshot.usage.turns, 2)
    assert.ok(projection.snapshot.usage.turns <= budget.maxTurns)
    assert.equal(projection.planGraph?.steps.length, 2)
  } finally {
    await harness.cleanup()
  }
})

test('DagScheduler fairly leases broad Step ceilings from actual parent budget', async () => {
  const budget = parentBudget({ maxTurns: 3, maxParallelChildren: 2 })
  const barrier = createBarrier(2)
  const harness = await createHarness(
    twoIndependentSteps({ maxTurns: 3 }),
    async (request) => {
      await barrier()
      return succeeded(request.childRunId)
    },
    { parentBudget: budget },
  )
  try {
    const result = await harness.supervisor.execute(harness.input)
    assert.equal(result.state, 'succeeded')
    assert.equal(harness.executor.maxActive, 2)
    const projection = await harness.journal.loadProjection(SESSION_ID)
    assert.equal(projection.snapshot.usage.turns, 2)
    assert.ok(projection.snapshot.usage.turns <= budget.maxTurns)
  } finally {
    await harness.cleanup()
  }
})

test('DagSupervisor converts crash, oversized output, and protocol pollution to bounded failures', async (context) => {
  const cases: readonly Readonly<{
    name: string
    expected: string
    behavior: Behavior
  }>[] = [
    {
      name: 'child crash',
      expected: 'DAG_SUBAGENT_CRASHED',
      behavior: async () => {
        throw new Error('raw child diagnostics must not escape')
      },
    },
    {
      name: 'oversized output',
      expected: 'DAG_SUBAGENT_RESULT_INVALID',
      behavior: async (request) => ({
        ...succeeded(request.childRunId),
        summary: 'x'.repeat(80 * 1024),
      }),
    },
    {
      name: 'protocol pollution',
      expected: 'DAG_SUBAGENT_RESULT_INVALID',
      behavior: async (request) => ({
        ...succeeded(request.childRunId),
        rawProviderStream: 'forbidden',
      }),
    },
  ]
  for (const fixture of cases) {
    await context.test(fixture.name, async () => {
      const harness = await createHarness(oneStep(), fixture.behavior)
      try {
        const result = await harness.supervisor.execute(harness.input)
        assert.equal(result.state, 'failed')
        assert.equal(result.stepStates[0]!.errorCode, fixture.expected)
        const projection = await harness.journal.loadProjection(SESSION_ID)
        assert.deepEqual(projection.snapshot.usage, {
          turns: 2,
          toolCalls: 2,
          inputTokens: 1_000,
          subagents: 1,
        })
        assertSingleTerminal(await readAll(harness.journal))
      } finally {
        await harness.cleanup()
      }
    })
  }
})

test('DagSupervisor preserves a stable child request admission failure code', async () => {
  const harness = await createHarness(oneStep(), async () => assert.fail('executor not reached'), {
    requestFailureCode: 'SUPERVISOR_STEP_CAPABILITY_UNAVAILABLE',
  })
  try {
    const result = await harness.supervisor.execute(harness.input)
    assert.equal(result.state, 'failed')
    assert.equal(result.stepStates[0]?.errorCode, 'SUPERVISOR_STEP_CAPABILITY_UNAVAILABLE')
  } finally {
    await harness.cleanup()
  }
})

test('DagSupervisor executes a recovery-created claim after parent restart', async () => {
  const budget = parentBudget({ maxChildRuns: 2 })
  const harness = await createHarness(
    oneStep({ maxAttempts: 2 }),
    async (request) => succeeded(request.childRunId),
    {
      parentBudget: budget,
      initialPlanState: 'running',
    },
  )
  try {
    const scheduled = await harness.scheduler.schedule({
      ...harness.input,
      failureMode: 'collect_partial',
    })
    const oldClaim = scheduled.claims[0]!
    const oldRequest = requestFor(harness.step(oldClaim.stepId), oldClaim.childRunId)
    await appendBinding(harness.journal, harness.planId, oldClaim, oldRequest)

    let recoveryId = 0
    const recovery = await new DagRecoveryCoordinatorV1(
      harness.journal,
      {
        rebuild: async ({ persistedRequest, parentRunId, newChildRunId }) => ({
          status: 'compatible',
          request: { ...persistedRequest, parentRunId, childRunId: newChildRunId },
        }),
      },
      undefined,
      { createId: (kind) => `${kind}-restart-${++recoveryId}`, now: () => NOW },
    ).recover({
      sessionId: SESSION_ID,
      parentRunId: RUN_ID,
      planId: harness.planId,
      parentBudget: budget,
    })
    assert.equal(recovery.state, 'rescheduled')

    const result = await harness.supervisor.execute({
      ...harness.input,
      resumedClaims: recovery.rescheduled,
    })
    assert.equal(result.state, 'succeeded')
    const attempts = (await harness.journal.loadProjection(SESSION_ID)).planGraph!.steps[0]!
      .attempts
    assert.equal(attempts[0]!.state, 'interrupted')
    assert.equal(attempts[1]!.state, 'verified')
    assertSingleTerminal(await readAll(harness.journal))
  } finally {
    await harness.cleanup()
  }
})

test('DagSupervisor retries a real scheduler CAS conflict without duplicate claims', async () => {
  const harness = await createHarness(oneStep(), async (request) => succeeded(request.childRunId), {
    injectClaimConflict: true,
  })
  try {
    const result = await harness.supervisor.execute(harness.input)
    assert.equal(result.state, 'succeeded')
    assert.equal(harness.conflictJournal?.injected, 1)
    const entries = await readAll(harness.journal)
    assert.equal(entries.filter((entry) => entry.type === 'attempt.created').length, 1)
    assertSingleTerminal(entries)
  } finally {
    await harness.cleanup()
  }
})

test('DagSupervisor reports structural deadlock without guessing or duplicate terminal', async () => {
  const harness = await createHarness(
    {
      objective: 'Keep a blocked prerequisite explicit.',
      steps: [step('root'), step('dependent', { dependencies: ['root'] })],
    },
    async (request) => succeeded(request.childRunId),
    { initialPlanState: 'running', initialStepStates: ['blocked', 'pending'] },
  )
  try {
    const result = await harness.supervisor.execute(harness.input)
    assert.equal(result.state, 'blocked')
    assert.deepEqual(
      result.stepStates.map((candidate) => candidate.state),
      ['blocked', 'cancelled'],
    )
    assert.equal(harness.executor.started, 0)
    assertSingleTerminal(await readAll(harness.journal))
  } finally {
    await harness.cleanup()
  }
})

type Behavior = (request: SubagentExecutionRequestV1, stepId: string) => unknown | Promise<unknown>

type HarnessOptions = Readonly<{
  parentBudget?: Readonly<ExecutionBudget>
  mechanicalVerifier?: SupervisorVerifierV1
  ruleVerifier?: SupervisorVerifierV1
  semanticVerifier?: SupervisorVerifierV1
  initialPlanState?: 'draft' | 'running'
  initialStepStates?: readonly ('pending' | 'blocked')[]
  injectClaimConflict?: boolean
  requestFailureCode?: string
}>

async function createHarness(
  proposal: FixedPlanProposalV1,
  behavior: Behavior,
  options: HarnessOptions = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'praxis-dag-supervisor-'))
  const store = new JsonlSessionJournalV3(root)
  await store.initialize()
  const baseJournal = new ReducingSessionJournalV3(store)
  const budget =
    options.parentBudget ??
    parentBudget({
      maxChildRuns: proposal.steps.length,
      maxParallelChildren: Math.min(2, proposal.steps.length),
    })
  const graph = new PlanValidator({
    parentBudget: budget,
    defaultStepBudget: { maxTurns: 2, maxToolCalls: 2, maxTokens: 1_000 },
    accessGrant: { mode: 'read_only', paths: ['.'] },
    allowedCapabilities: ['builtin.read'],
    createId: (kind, source) => `${kind}-${source.replaceAll(':', '-')}`,
  }).validate(proposal)
  const payloads = initialPlanJournalPayloadsV3(graph)
  let stepIndex = 0
  await baseJournal.appendCommit(
    createSessionCommitV3({
      sessionId: SESSION_ID,
      commitId: 'commit-initial',
      expectedRevision: 0,
      idempotencyKey: 'idem-initial',
      entries: [
        entry(1, 1, 'session.created', {
          cwd: 'D:/workspace',
          provider: 'fixture',
          model: 'fixture-model',
          name: 'DAG Supervisor',
          labels: [],
        }),
        entry(2, 1, 'run.started', { clientRequestId: 'request-parent' }, RUN_ID),
        ...payloads.map((payload, index) => {
          const data = structuredClone(payload.data) as Record<string, unknown>
          if (payload.type === 'plan.created') {
            data.state = options.initialPlanState ?? 'draft'
          }
          if (payload.type === 'step.created' && options.initialStepStates !== undefined) {
            data.state = options.initialStepStates[stepIndex++]
          }
          return entry(index + 3, 1, payload.type, data, RUN_ID)
        }),
      ],
    }),
  )

  const conflictJournal = options.injectClaimConflict
    ? new ClaimConflictJournal(baseJournal)
    : undefined
  const journal: SessionJournalV3 = conflictJournal ?? baseJournal
  let schedulerId = 0
  const scheduler = new DagSchedulerV1(
    journal,
    { maxParallelSteps: 2 },
    {
      createId: (kind) => `${kind}-schedule-${++schedulerId}`,
      now: () => NOW,
    },
  )
  const executor = new FixtureExecutor(behavior)
  let supervisorId = 0
  const supervisor = new DagSupervisorV1({
    journal,
    scheduler,
    executor,
    requestFactory: {
      create: async ({ step: stepProjection, childRunId }) => {
        if (options.requestFailureCode !== undefined) {
          throw Object.assign(new Error(options.requestFailureCode), {
            code: options.requestFailureCode,
          })
        }
        return requestFor(stepProjection, childRunId)
      },
    },
    artifactStore: new FixtureArtifactStore(),
    mechanicalVerifier: options.mechanicalVerifier ?? passedVerifier('mechanical'),
    ruleVerifier: options.ruleVerifier ?? passedVerifier('rule'),
    ...(options.semanticVerifier === undefined
      ? {}
      : { semanticVerifier: options.semanticVerifier }),
    retrySafety: () => 'read_only_idempotent',
    createId: (kind) => `${kind}-supervisor-${++supervisorId}`,
    now: () => NOW,
  })
  const input: DagSupervisorInputV1 = {
    sessionId: SESSION_ID,
    parentRunId: RUN_ID,
    planId: graph.planId,
    parentBudget: budget,
    failureMode: 'collect_partial',
  }
  return {
    root,
    store,
    journal,
    scheduler,
    supervisor,
    executor,
    conflictJournal,
    input,
    planId: graph.planId,
    step: (stepId: string) => graph.steps.find((candidate) => candidate.stepId === stepId)!,
    cleanup: () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  }
}

class FixtureExecutor implements SubagentExecutor {
  active = 0
  maxActive = 0
  started = 0
  readonly cancelled = new Set<string>()
  readonly #pending = new Map<string, (result: SubagentResultV1) => void>()
  readonly #waiters: Array<Readonly<{ count: number; resolve: () => void }>> = []

  constructor(private readonly behavior: Behavior) {}

  async execute(request: SubagentExecutionRequestV1): Promise<SubagentResultV1> {
    this.active += 1
    this.started += 1
    this.maxActive = Math.max(this.maxActive, this.active)
    this.flushWaiters()
    try {
      const behavior = this.behavior(request, request.packetRef.id.replace(/^packet-/u, ''))
      if (behavior instanceof Promise) {
        const settled = await Promise.race([
          behavior,
          new Promise<SubagentResultV1>((resolve) =>
            this.#pending.set(request.childRunId, resolve),
          ),
        ])
        return settled as SubagentResultV1
      }
      return behavior as SubagentResultV1
    } finally {
      this.#pending.delete(request.childRunId)
      this.active -= 1
    }
  }

  async cancel(request: SubagentCancellationRequestV1): Promise<boolean> {
    this.cancelled.add(request.childRunId)
    const resolve = this.#pending.get(request.childRunId)
    resolve?.(cancelled(request.childRunId))
    return resolve !== undefined
  }

  waitForActive(count: number): Promise<void> {
    if (this.active >= count) return Promise.resolve()
    return new Promise((resolve) => this.#waiters.push({ count, resolve }))
  }

  private flushWaiters(): void {
    for (let index = this.#waiters.length - 1; index >= 0; index -= 1) {
      const waiter = this.#waiters[index]!
      if (this.active >= waiter.count) {
        this.#waiters.splice(index, 1)
        waiter.resolve()
      }
    }
  }
}

class FixtureArtifactStore {
  async put(value: unknown, mimeType = 'application/json'): Promise<ArtifactReference> {
    const content = JSON.stringify(value)
    const hex = createHash('sha256').update(content).digest('hex')
    return {
      artifactId: `artifact-${hex}`,
      digest: `sha256:${hex}`,
      mimeType,
      bytes: Buffer.byteLength(content),
    }
  }
}

class ClaimConflictJournal implements SessionJournalV3 {
  injected = 0

  constructor(private readonly base: SessionJournalV3) {}

  async appendCommit(commit: SessionCommitV3) {
    if (
      this.injected === 0 &&
      commit.entries.some((entryValue) => entryValue.type === 'attempt.created')
    ) {
      this.injected += 1
      const projection = await this.base.loadProjection(commit.sessionId)
      await this.base.appendCommit(
        createSessionCommitV3({
          sessionId: commit.sessionId,
          commitId: 'commit-injected-conflict',
          expectedRevision: projection.snapshot.revision,
          idempotencyKey: 'idem-injected-conflict',
          entries: [
            entry(
              projection.snapshot.sequence + 1,
              projection.snapshot.revision + 1,
              'session.metadata_updated',
              { labels: ['cas-conflict-observed'] },
            ),
          ],
        }),
      )
    }
    return this.base.appendCommit(commit)
  }

  readEntries: SessionJournalV3['readEntries'] = (input) => this.base.readEntries(input)
  loadProjection: SessionJournalV3['loadProjection'] = (sessionId) =>
    this.base.loadProjection(sessionId)
  loadSnapshot: SessionJournalV3['loadSnapshot'] = (sessionId) => this.base.loadSnapshot(sessionId)
  querySession: SessionJournalV3['querySession'] = (input) => this.base.querySession(input)
  subscribe: SessionJournalV3['subscribe'] = (listener) => this.base.subscribe(listener)
}

function twoIndependentSteps(budget: Readonly<{ maxTurns?: number }> = {}): FixedPlanProposalV1 {
  return {
    objective: 'Run two independent reads.',
    steps: [step('alpha', { budget }), step('beta', { budget })],
  }
}

function oneStep(options: Readonly<{ maxAttempts?: number }> = {}): FixedPlanProposalV1 {
  return {
    objective: 'Run one read.',
    steps: [step('only', options)],
  }
}

function step(
  key: string,
  options: Readonly<{
    dependencies?: readonly string[]
    budget?: Readonly<{ maxTurns?: number }>
    maxAttempts?: number
  }> = {},
): FixedPlanProposalV1['steps'][number] {
  return {
    key,
    title: `Run ${key}`,
    dependencies: options.dependencies,
    access: { mode: 'read_only', paths: ['src'] },
    capabilities: ['builtin.read'],
    criteria: [{ kind: 'rule', description: `${key} result is accepted.` }],
    budget: options.budget,
    maxAttempts: options.maxAttempts,
  }
}

function parentBudget(overrides: Partial<ExecutionBudget> = {}): Readonly<ExecutionBudget> {
  return Object.freeze({
    maxTurns: 8,
    maxToolCalls: 8,
    maxTokens: 8_000,
    maxChildRuns: 2,
    maxParallelChildren: 2,
    maxDepth: 1,
    ...overrides,
  })
}

function succeeded(childRunId: string): SubagentResultV1 {
  return {
    schemaVersion: 1,
    childRunId,
    status: 'succeeded',
    summary: 'bounded success',
    evidenceRefs: [],
    changedFiles: [],
    checks: [],
    usage: { turns: 1, toolCalls: 0, inputTokens: 10, outputTokens: 5, subagents: 0 },
    retryable: false,
  }
}

function failed(childRunId: string): SubagentResultV1 {
  return {
    schemaVersion: 1,
    childRunId,
    status: 'failed',
    summary: 'bounded failure',
    evidenceRefs: [],
    changedFiles: [],
    checks: [],
    usage: { turns: 1, toolCalls: 0, inputTokens: 10, outputTokens: 5, subagents: 0 },
    retryable: false,
    error: {
      code: 'CHILD_FAILED',
      category: 'execution',
      message: 'The fixture child failed.',
      retryable: false,
    },
  }
}

function cancelled(childRunId: string): SubagentResultV1 {
  return {
    schemaVersion: 1,
    childRunId,
    status: 'cancelled',
    summary: 'cancelled',
    evidenceRefs: [],
    changedFiles: [],
    checks: [],
    usage: { turns: 0, toolCalls: 0, subagents: 0 },
    retryable: false,
    error: {
      code: 'CHILD_CANCELLED',
      category: 'cancellation',
      message: 'The fixture child was cancelled.',
      retryable: false,
    },
  }
}

function timedOut(childRunId: string): SubagentResultV1 {
  return {
    schemaVersion: 1,
    childRunId,
    status: 'cancelled',
    summary: 'Partial read evidence preserved.',
    evidenceRefs: [
      {
        kind: 'result',
        ref: `tool-result:read:${childRunId}`,
        digest: DIGEST,
      },
    ],
    changedFiles: [],
    checks: [],
    usage: { turns: 1, toolCalls: 1, subagents: 0 },
    retryable: true,
    error: {
      code: 'CHILD_DEADLINE_EXCEEDED',
      category: 'cancellation',
      message: 'The child exceeded its deadline.',
      retryable: true,
    },
  }
}

function passedVerifier(kind: 'mechanical' | 'rule'): SupervisorVerifierV1 {
  return { verify: async () => verification(kind, 'passed') }
}

function verification(
  verifier: 'mechanical' | 'rule' | 'model',
  status: 'passed' | 'failed' | 'blocked',
) {
  return {
    verifier,
    status,
    evidenceRefs: [],
    code: `${verifier.toUpperCase()}_${status.toUpperCase()}`,
    retryable: false,
  } as const
}

function requestFor(
  stepProjection: Pick<SessionStepProjectionV3, 'stepId'>,
  childRunId: string,
): SubagentExecutionRequestV1 {
  return {
    schemaVersion: 1,
    parentRunId: RUN_ID,
    childRunId,
    packetRef: ref('context_packet', `packet-${stepProjection.stepId}`, 1),
    profileRef: ref('bootstrap_profile', `profile-${childRunId}`, 3),
    bundleRef: ref('capability_bundle', `bundle-${stepProjection.stepId}`, 1),
    budgetRef: ref('execution_budget', `budget-${childRunId}`, 1),
  }
}

function ref(
  kind: 'context_packet' | 'bootstrap_profile' | 'capability_bundle' | 'execution_budget',
  id: string,
  version: number,
) {
  return { schemaVersion: 1 as const, kind, id, version, digest: DIGEST }
}

async function appendBinding(
  journal: SessionJournalV3,
  planId: string,
  claim: Readonly<{ stepId: string; attemptId: string; childRunId: string }>,
  request: SubagentExecutionRequestV1,
): Promise<void> {
  const projection = await journal.loadProjection(SESSION_ID)
  const plan = projection.planGraph!
  await journal.appendCommit(
    createSessionCommitV3({
      sessionId: SESSION_ID,
      commitId: 'commit-old-binding',
      expectedRevision: projection.snapshot.revision,
      idempotencyKey: 'idem-old-binding',
      entries: [
        entry(
          projection.snapshot.sequence + 1,
          projection.snapshot.revision + 1,
          'subagent.execution_bound',
          {
            planId,
            planRevision: plan.revision,
            stepId: claim.stepId,
            attemptId: claim.attemptId,
            childRunId: claim.childRunId,
            request,
            retrySafety: 'read_only_idempotent',
          },
          RUN_ID,
          {
            parentRunId: RUN_ID,
            childRunId: claim.childRunId,
            planId,
            stepId: claim.stepId,
            attemptId: claim.attemptId,
          },
        ),
      ],
    }),
  )
}

function assertSingleTerminal(entries: readonly SessionEntryV3[]): void {
  assert.equal(entries.filter((entryValue) => entryValue.type === 'run.terminal').length, 1)
  assert.equal(
    entries.filter(
      (entryValue) =>
        entryValue.type === 'plan.state_changed' &&
        ['succeeded', 'failed', 'blocked', 'cancelled'].includes(entryValue.data.state as string),
    ).length,
    1,
  )
}

async function readAll(journal: SessionJournalV3): Promise<readonly SessionEntryV3[]> {
  return (await journal.readEntries({ sessionId: SESSION_ID })).entries
}

function entry(
  sequence: number,
  revision: number,
  type: string,
  data: Record<string, unknown>,
  runId?: string,
  correlation?: Record<string, string>,
): SessionEntryV3 {
  return validateSessionEntryV3({
    schemaVersion: 3,
    entryId: `entry-${revision}-${sequence}-${type.replaceAll('.', '-')}`,
    sessionId: SESSION_ID,
    sequence,
    revision,
    timestamp: NOW,
    type,
    ...(runId === undefined ? {} : { runId }),
    ...(correlation === undefined ? {} : { correlation }),
    data,
  })
}

function createBarrier(parties: number): () => Promise<void> {
  let arrived = 0
  let release: (() => void) | undefined
  const ready = new Promise<void>((resolve) => {
    release = resolve
  })
  return async () => {
    arrived += 1
    if (arrived === parties) release?.()
    await ready
  }
}
