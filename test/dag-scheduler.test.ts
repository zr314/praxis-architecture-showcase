import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  createSessionCommitV3,
  ReducingSessionJournalV3,
  type ExecutionBudget,
  type SessionEntryV3,
  type SessionPlanGraphProjectionV3,
  type SessionStepProjectionV3,
  validateSessionEntryV3,
} from '@praxis/core-sdk'
import {
  DagSchedulerV1,
  type DagScheduleInputV1,
} from '../apps/runtime/src/planner/dagScheduler.js'
import { currentRunBudgetUsageV1 } from '../apps/runtime/src/planner/runBudgetUsage.js'
import {
  type FixedPlanProposalV1,
  initialPlanJournalPayloadsV3,
  PlanValidator,
} from '../apps/runtime/src/planner/planValidator.js'
import { JsonlSessionJournalV3 } from '../apps/runtime/src/session-db/jsonlSessionJournalV3.js'

const SESSION_ID = 'session-dag'
const RUN_ID = 'run-parent'
const NOW = '2026-08-03T00:00:00.000Z'
const DIGEST = `sha256:${'d'.repeat(64)}` as `sha256:${string}`
const DEFAULT_BUDGET: Readonly<ExecutionBudget> = Object.freeze({
  maxTurns: 12,
  maxToolCalls: 12,
  maxTokens: 12_000,
  maxChildRuns: 8,
  maxParallelChildren: 2,
  maxDepth: 1,
})

test('Supervisor budgets are charged to the current Run instead of the Session aggregate', () => {
  const usage = currentRunBudgetUsageV1(
    {
      snapshot: {
        usage: { turns: 100, toolCalls: 300, subagents: 20 },
        runs: [
          {
            runId: 'run-previous',
            state: 'completed',
            usage: { turns: 100, toolCalls: 300, subagents: 20 },
          },
          {
            runId: RUN_ID,
            state: 'running',
            usage: { turns: 1, toolCalls: 2, subagents: 0 },
          },
        ],
      },
    } as never,
    RUN_ID,
  )

  assert.deepEqual(usage, { turns: 1, toolCalls: 2, subagents: 0 })
})

test('DagScheduler claims a stable bounded conflict-free batch in one CAS commit', async () => {
  const harness = await createHarness({
    objective: 'Schedule independent reads.',
    steps: [step('alpha', ['shared']), step('beta', ['shared']), step('gamma', ['other'])],
  })
  try {
    const before = await harness.journal.loadProjection(SESSION_ID)
    const outcome = await harness.scheduler.schedule(harness.input)

    assert.equal(outcome.state, 'claimed')
    assert.deepEqual(
      outcome.claims.map((claim) => claim.stepId),
      ['step-alpha', 'step-gamma'],
    )
    assert.equal(outcome.revision, before.snapshot.revision + 1)
    assert.equal(outcome.cumulativeChildRuns, 2)
    assert.equal(outcome.activeChildSlots, 2)
    assert.equal(outcome.activeSteps, 2)

    const projection = await harness.journal.loadProjection(SESSION_ID)
    assert.deepEqual(
      projection.planGraph?.steps.map((candidate) => candidate.state),
      ['running', 'pending', 'running'],
    )
    const entries = await readAll(harness)
    const claimEntries = entries.filter((entry) => entry.revision === outcome.revision)
    assert.equal(claimEntries.length, 6)
    assert.ok(claimEntries.every((entry) => entry.correlation?.parentRunId === RUN_ID))
    assert.ok(claimEntries.every((entry) => entry.correlation?.planId === harness.planId))
    assert.deepEqual(
      new Set(claimEntries.map((entry) => entry.correlation?.stepId)),
      new Set(['step-alpha', 'step-gamma']),
    )
  } finally {
    await harness.cleanup()
  }
})

test('DagScheduler releases a dependency only after the prerequisite is verified', async () => {
  const harness = await createHarness({
    objective: 'Respect verified dependencies.',
    steps: [step('read'), step('summarize', [], ['read'])],
  })
  try {
    const first = await harness.scheduler.schedule(harness.input)
    assert.deepEqual(
      first.claims.map((claim) => claim.stepId),
      ['step-read'],
    )
    assert.equal((await harness.scheduler.schedule(harness.input)).state, 'waiting')

    const projection = await harness.journal.loadProjection(SESSION_ID)
    const graph = projection.planGraph!
    const read = graph.steps[0]!
    const claim = first.claims[0]!
    await appendLifecycle(harness, graph, read, claim, 'succeeded')

    const second = await harness.scheduler.schedule(harness.input)
    assert.equal(second.state, 'claimed')
    assert.deepEqual(
      second.claims.map((candidate) => candidate.stepId),
      ['step-summarize'],
    )
  } finally {
    await harness.cleanup()
  }
})

test('DagScheduler accounts cumulative child runs separately from active slots', async () => {
  const harness = await createHarness(
    {
      objective: 'Collect independent partial results.',
      steps: [step('first'), step('second')],
    },
    { maxParallelSteps: 1 },
    { maxChildRuns: 2, maxParallelChildren: 1 },
  )
  try {
    const first = await harness.scheduler.schedule(harness.input)
    assert.equal(first.activeChildSlots, 1)
    assert.equal(first.cumulativeChildRuns, 1)

    let projection = await harness.journal.loadProjection(SESSION_ID)
    await appendLifecycle(
      harness,
      projection.planGraph!,
      projection.planGraph!.steps[0]!,
      first.claims[0]!,
      'failed',
    )

    const failFast = await harness.scheduler.schedule({
      ...harness.input,
      failureMode: 'fail_fast',
    })
    assert.equal(failFast.state, 'failed')
    assert.equal(failFast.reasonCode, 'DAG_STEP_FAILED')
    assert.equal(failFast.activeChildSlots, 0)
    assert.equal(failFast.cumulativeChildRuns, 1)

    const collect = await harness.scheduler.schedule(harness.input)
    assert.equal(collect.state, 'claimed')
    assert.deepEqual(
      collect.claims.map((claim) => claim.stepId),
      ['step-second'],
    )
    assert.equal(collect.activeChildSlots, 1)
    assert.equal(collect.cumulativeChildRuns, 2)

    projection = await harness.journal.loadProjection(SESSION_ID)
    await appendLifecycle(
      harness,
      projection.planGraph!,
      projection.planGraph!.steps[1]!,
      collect.claims[0]!,
      'failed',
    )
    const exhausted = await harness.scheduler.schedule(harness.input)
    assert.equal(exhausted.state, 'budget_exhausted')
    assert.equal(exhausted.reasonCode, 'DAG_CHILD_BUDGET_EXHAUSTED')
    assert.equal(exhausted.activeChildSlots, 0)
    assert.equal(exhausted.cumulativeChildRuns, 2)
  } finally {
    await harness.cleanup()
  }
})

test('DagScheduler schedules workspace writes and reports structural no-ready states', async (context) => {
  await context.test('workspace write', async () => {
    const harness = await createHarness({
      objective: 'Do not parallelize writes.',
      steps: [
        {
          ...step('write'),
          access: { mode: 'workspace_write', paths: ['src'] },
        },
      ],
    })
    try {
      const outcome = await harness.scheduler.schedule(harness.input)
      assert.equal(outcome.state, 'claimed')
      assert.deepEqual(
        outcome.claims.map((claim) => claim.stepId),
        ['step-write'],
      )
      assert.equal(outcome.cumulativeChildRuns, 1)
    } finally {
      await harness.cleanup()
    }
  })

  await context.test('blocked prerequisite', async () => {
    const harness = await createHarness(
      {
        objective: 'Surface a structural block.',
        steps: [step('blocked'), step('dependent', [], ['blocked'])],
      },
      undefined,
      undefined,
      ['blocked', 'pending'],
    )
    try {
      const outcome = await harness.scheduler.schedule(harness.input)
      assert.equal(outcome.state, 'blocked')
      assert.equal(outcome.reasonCode, 'DAG_STEP_BLOCKED')
      assert.equal(outcome.cumulativeChildRuns, 0)
    } finally {
      await harness.cleanup()
    }
  })
})

test('DagScheduler does not require an active parent run to replay a terminal decision', async () => {
  const harness = await createHarness(
    { objective: 'Replay terminal state.', steps: [step('done')] },
    undefined,
    undefined,
    ['succeeded'],
    'succeeded',
    false,
  )
  try {
    const outcome = await harness.scheduler.schedule(harness.input)
    assert.equal(outcome.state, 'complete')
    assert.equal(outcome.revision, 1)
  } finally {
    await harness.cleanup()
  }
})

type Harness = Awaited<ReturnType<typeof createHarness>>

async function createHarness(
  proposal: FixedPlanProposalV1,
  policy?: Readonly<{ maxParallelSteps?: number }>,
  budgetOverrides: Partial<ExecutionBudget> = {},
  initialStepStates?: readonly ('pending' | 'blocked' | 'succeeded')[],
  initialPlanState: 'running' | 'succeeded' = 'running',
  parentRunning = true,
) {
  const root = await mkdtemp(join(tmpdir(), 'praxis-dag-scheduler-'))
  const store = new JsonlSessionJournalV3(root)
  await store.initialize()
  const journal = new ReducingSessionJournalV3(store)
  const graph = new PlanValidator({
    parentBudget: DEFAULT_BUDGET,
    defaultStepBudget: { maxTurns: 2, maxToolCalls: 2, maxTokens: 1_000 },
    accessGrant: { mode: 'workspace_write', paths: ['.'] },
    allowedCapabilities: ['builtin.read'],
    createId: (kind, source) => `${kind}-${source.replaceAll(':', '-')}`,
  }).validate(proposal)
  const payloads = initialPlanJournalPayloadsV3(graph)
  const runEntries = [
    entry(2, 1, 'run.started', { clientRequestId: 'request-parent' }, RUN_ID),
    ...(parentRunning
      ? []
      : [entry(3, 1, 'run.terminal', { status: 'completed', usage: {} }, RUN_ID)]),
  ]
  const payloadStart = runEntries.length + 2
  const entries = [
    entry(1, 1, 'session.created', {
      cwd: 'D:/workspace',
      provider: 'fixture',
      model: 'fixture-model',
      name: 'DAG Scheduler',
      labels: [],
    }),
    ...runEntries,
    ...payloads.map((payload, index) => {
      const data = structuredClone(payload.data) as Record<string, unknown>
      if (payload.type === 'plan.created') data.state = initialPlanState
      if (payload.type === 'step.created' && initialStepStates !== undefined) {
        data.state = initialStepStates[index - 1]
      }
      return entry(index + payloadStart, 1, payload.type, data, RUN_ID)
    }),
  ]
  await journal.appendCommit(
    createSessionCommitV3({
      sessionId: SESSION_ID,
      commitId: 'commit-initial',
      expectedRevision: 0,
      idempotencyKey: 'idem-initial',
      entries,
    }),
  )

  let nextId = 0
  const scheduler = new DagSchedulerV1(journal, policy, {
    createId: (kind) => `${kind}-${++nextId}`,
    now: () => NOW,
  })
  const budget = Object.freeze({ ...DEFAULT_BUDGET, ...budgetOverrides })
  const input: DagScheduleInputV1 = Object.freeze({
    sessionId: SESSION_ID,
    parentRunId: RUN_ID,
    planId: graph.planId,
    parentBudget: budget,
    failureMode: 'collect_partial',
  })
  return {
    root,
    journal,
    scheduler,
    planId: graph.planId,
    input,
    cleanup: () => rm(root, { recursive: true, force: true }),
  }
}

function step(
  key: string,
  conflictKeys: readonly string[] = [],
  dependencies: readonly string[] = [],
): FixedPlanProposalV1['steps'][number] {
  return {
    key,
    title: `Run ${key}`,
    dependencies,
    access: { mode: 'read_only', paths: ['src'] },
    capabilities: ['builtin.read'],
    conflictKeys,
    criteria: [{ kind: 'rule', description: `${key} result is accepted.` }],
  }
}

async function appendLifecycle(
  harness: Harness,
  plan: SessionPlanGraphProjectionV3,
  stepProjection: SessionStepProjectionV3,
  claim: Readonly<{ attemptId: string; childRunId: string }>,
  status: 'succeeded' | 'failed',
): Promise<void> {
  const projection = await harness.journal.loadProjection(SESSION_ID)
  const authority = {
    planId: plan.planId,
    planRevision: plan.revision,
    stepId: stepProjection.stepId,
  }
  const correlation = {
    parentRunId: RUN_ID,
    childRunId: claim.childRunId,
    planId: plan.planId,
    stepId: stepProjection.stepId,
    attemptId: claim.attemptId,
  }
  const events: Array<Readonly<{ type: string; data: Record<string, unknown> }>> = [
    {
      type: 'subagent.result_recorded',
      data: {
        ...authority,
        attemptId: claim.attemptId,
        childRunId: claim.childRunId,
        resultRef: `artifact://result-${claim.attemptId}`,
        resultDigest: DIGEST,
        status,
      },
    },
    {
      type: 'attempt.execution_completed',
      data: { ...authority, attemptId: claim.attemptId, status },
    },
  ]
  if (status === 'succeeded') {
    events.push(
      {
        type: 'attempt.state_changed',
        data: { ...authority, attemptId: claim.attemptId, state: 'verifying' },
      },
      { type: 'step.state_changed', data: { ...authority, state: 'verifying' } },
      {
        type: 'verification.recorded',
        data: {
          ...authority,
          attemptId: claim.attemptId,
          verificationId: `verification-${claim.attemptId}`,
          verifier: 'mechanical',
          status: 'passed',
          evidenceRefs: [`artifact://result-${claim.attemptId}`],
        },
      },
      {
        type: 'attempt.state_changed',
        data: { ...authority, attemptId: claim.attemptId, state: 'verified' },
      },
      { type: 'step.state_changed', data: { ...authority, state: 'succeeded' } },
    )
  } else {
    events.push({ type: 'step.state_changed', data: { ...authority, state: 'failed' } })
  }
  const revision = projection.snapshot.revision + 1
  await harness.journal.appendCommit(
    createSessionCommitV3({
      sessionId: SESSION_ID,
      commitId: `commit-lifecycle-${claim.attemptId}`,
      expectedRevision: projection.snapshot.revision,
      idempotencyKey: `idem-lifecycle-${claim.attemptId}`,
      entries: events.map((event, index) =>
        entry(
          projection.snapshot.sequence + index + 1,
          revision,
          event.type,
          event.data,
          RUN_ID,
          correlation,
        ),
      ),
    }),
  )
}

async function readAll(harness: Harness): Promise<readonly SessionEntryV3[]> {
  return (await harness.journal.readEntries({ sessionId: SESSION_ID })).entries
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
    entryId: `entry-${sequence}-${type.replaceAll('.', '-')}`,
    sessionId: SESSION_ID,
    sequence,
    revision,
    timestamp: new Date(Date.UTC(2026, 7, 3, 0, 0, sequence)).toISOString(),
    type,
    ...(runId === undefined ? {} : { runId }),
    ...(correlation === undefined ? {} : { correlation }),
    data,
  })
}
