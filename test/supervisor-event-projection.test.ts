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
import { assertProtocolMessage, type SessionEvent, type SupervisorUpdateV1 } from '@praxis/protocol'
import { DagSchedulerV1 } from '../apps/runtime/src/planner/dagScheduler.js'
import {
  initialPlanJournalPayloadsV3,
  PlanValidator,
} from '../apps/runtime/src/planner/planValidator.js'
import { SupervisorEventProjectionV1 } from '../apps/runtime/src/planner/supervisorEventProjection.js'
import { JsonlSessionJournalV3 } from '../apps/runtime/src/session-db/jsonlSessionJournalV3.js'
import type { ChildRuntimeProgressPortV1 } from '../apps/runtime/src/subagent/childRuntimeHost.js'

const SESSION_ID = 'session-events'
const RUN_ID = 'run-parent'
const NOW = '2026-08-03T00:00:00.000Z'
const DIGEST = `sha256:${'d'.repeat(64)}` as `sha256:${string}`
const BUDGET: Readonly<ExecutionBudget> = Object.freeze({
  maxTurns: 8,
  maxToolCalls: 8,
  maxTokens: 8_000,
  maxChildRuns: 2,
  maxParallelChildren: 2,
  maxDepth: 1,
})

test('Supervisor event projection publishes complete ordered durable correlations', async () => {
  const harness = await createHarness()
  const protocolEvents: SessionEvent[] = []
  const projector = new SupervisorEventProjectionV1(harness.journal, {
    epochId: 'epoch-one',
    createId: () => 'snapshot-one',
    emit: (event) => protocolEvents.push(event),
  })
  try {
    const snapshot = await projector.snapshot({
      sessionId: SESSION_ID,
      parentRunId: RUN_ID,
      planId: harness.planId,
    })
    const projected: SupervisorUpdateV1[] = []
    const unsubscribe = projector.subscribe(
      {
        epochId: snapshot.epochId,
        sessionId: SESSION_ID,
        parentRunId: RUN_ID,
        afterParentSequence: snapshot.parentSequence,
        snapshotId: snapshot.snapshotId,
      },
      (event) => projected.push(event),
    )

    await startPlan(harness)
    const claim = await harness.scheduler.schedule(harness.scheduleInput)
    assert.equal(claim.state, 'claimed')
    const projection = await harness.journal.loadProjection(SESSION_ID)
    await appendSucceeded(
      harness,
      projection.planGraph!,
      projection.planGraph!.steps[0]!,
      claim.claims[0]!,
    )
    unsubscribe()

    assert.deepEqual(
      projected.map((event) => event.parentSequence),
      projected.map((_, index) => index + 1),
    )
    assert.ok(projected.every((event) => event.correlation.parentRunId === RUN_ID))
    assert.ok(projected.every((event) => event.correlation.planId === harness.planId))

    const plan = durable(projected, 'plan')
    assert.equal(plan.source.update.event, 'plan.state_changed')
    const attempt = durable(projected, 'attempt', 'attempt.created')
    assert.deepEqual(attempt.correlation, {
      parentRunId: RUN_ID,
      planId: harness.planId,
      stepId: 'step-read',
      attemptId: claim.claims[0]!.attemptId,
      childRunId: claim.claims[0]!.childRunId,
    })
    const binding = durable(projected, 'subagent', 'subagent.execution_bound')
    assert.deepEqual(binding.source.update, {
      kind: 'subagent',
      event: 'subagent.execution_bound',
      status: 'bound',
    })
    const subagent = durable(projected, 'subagent', 'subagent.result_recorded')
    assert.equal(subagent.correlation.childRunId, claim.claims[0]!.childRunId)
    const execution = durable(projected, 'execution_completed')
    const verification = durable(projected, 'verification_completed')
    assert.equal(execution.source.update.event, 'attempt.execution_completed')
    assert.equal(verification.source.update.event, 'verification.recorded')
    assert.equal(
      verification.correlation.verificationId,
      `verification-${claim.claims[0]!.attemptId}`,
    )
    assert.ok(execution.parentSequence < verification.parentSequence)

    for (const [index, event] of protocolEvents.entries()) {
      assertProtocolMessage({
        jsonrpc: '2.0',
        method: 'event',
        params: {
          subscriptionId: 'subscription-one',
          sequence: index + 1,
          timestamp: NOW,
          sessionId: SESSION_ID,
          runId: RUN_ID,
          event,
        },
      })
    }
  } finally {
    projector.close()
    await harness.cleanup()
  }
})

test('Supervisor child progress is bounded and cannot become parent assistant output', async () => {
  const harness = await createHarness('running')
  const emitted: SessionEvent[] = []
  const projector = new SupervisorEventProjectionV1(harness.journal, {
    epochId: 'epoch-progress',
    maxProgressBytes: 64,
    createId: () => 'snapshot-progress',
    emit: (event) => emitted.push(event),
  })
  try {
    const snapshot = await projector.snapshot({
      sessionId: SESSION_ID,
      parentRunId: RUN_ID,
      planId: harness.planId,
    })
    projector.subscribe(
      {
        epochId: snapshot.epochId,
        sessionId: SESSION_ID,
        parentRunId: RUN_ID,
        afterParentSequence: snapshot.parentSequence,
        snapshotId: snapshot.snapshotId,
      },
      () => undefined,
    )
    const claim = await harness.scheduler.schedule(harness.scheduleInput)
    const correlation = {
      parentRunId: RUN_ID,
      childRunId: claim.claims[0]!.childRunId,
      stepId: 'step-read',
    }
    const progressPort: ChildRuntimeProgressPortV1 = {
      publish: (event) => {
        projector.projectChildProgress(event)
      },
    }

    const thinking = projector.projectChildProgress({
      ...correlation,
      event: { type: 'thinking_delta', runId: 'inner-run', text: '思'.repeat(100) },
    })
    const toolStart = projector.projectChildProgress({
      ...correlation,
      event: {
        type: 'tool_start',
        runId: 'inner-run',
        toolCallId: 'tool-call-one',
        name: 'read',
        input: { secret: 'not-projected' },
      },
    })
    const toolUpdate = projector.projectChildProgress({
      ...correlation,
      event: {
        type: 'tool_update',
        runId: 'inner-run',
        toolCallId: 'tool-call-one',
        message: 'x'.repeat(200),
        stream: 'stdout',
        bytes: 200,
      },
    })
    const toolEnd = projector.projectChildProgress({
      ...correlation,
      event: {
        type: 'tool_end',
        runId: 'inner-run',
        toolCallId: 'tool-call-one',
        ok: true,
        output: { secret: 'not-projected' },
      },
    })
    progressPort.publish({
      ...correlation,
      event: { type: 'thinking_delta', runId: 'inner-run', text: 'through-host-port' },
    })

    assert.equal(thinking.source.kind, 'child_progress')
    if (thinking.source.kind === 'child_progress') {
      assert.equal(thinking.source.progress.kind, 'thinking')
      if (thinking.source.progress.kind === 'thinking') {
        assert.equal(thinking.source.progress.truncated, true)
        assert.ok(Buffer.byteLength(thinking.source.progress.text, 'utf8') <= 64)
      }
    }
    for (const event of [toolStart, toolUpdate, toolEnd]) {
      assert.equal(JSON.stringify(event).includes('not-projected'), false)
    }
    assert.ok(emitted.every((event) => event.type === 'supervisor_update'))
    assert.deepEqual([...new Set(emitted.map((event) => event.type))], ['supervisor_update'])
    assert.throws(
      () =>
        projector.projectChildProgress({
          ...correlation,
          stepId: 'step-other',
          event: { type: 'thinking_delta', runId: 'inner-run', text: 'mismatch' },
        }),
      hasCode('SUPERVISOR_CHILD_CORRELATION_MISMATCH'),
    )
  } finally {
    projector.close()
    await harness.cleanup()
  }
})

test('Supervisor event subscriptions replay only inside one epoch and require a new snapshot', async () => {
  const harness = await createHarness('running')
  const firstEpoch = new SupervisorEventProjectionV1(harness.journal, {
    epochId: 'epoch-first',
    createId: () => 'snapshot-first',
  })
  try {
    const snapshot = await firstEpoch.snapshot({
      sessionId: SESSION_ID,
      parentRunId: RUN_ID,
      planId: harness.planId,
    })
    const live: SupervisorUpdateV1[] = []
    const unsubscribe = firstEpoch.subscribe(
      {
        epochId: snapshot.epochId,
        sessionId: SESSION_ID,
        parentRunId: RUN_ID,
        afterParentSequence: snapshot.parentSequence,
        snapshotId: snapshot.snapshotId,
      },
      (event) => live.push(event),
    )
    const claim = await harness.scheduler.schedule(harness.scheduleInput)
    unsubscribe()
    const cursor = live.at(-1)!.parentSequence
    const projection = await harness.journal.loadProjection(SESSION_ID)
    await appendSucceeded(
      harness,
      projection.planGraph!,
      projection.planGraph!.steps[0]!,
      claim.claims[0]!,
    )
    const replay: SupervisorUpdateV1[] = []
    firstEpoch.subscribe(
      {
        epochId: 'epoch-first',
        sessionId: SESSION_ID,
        parentRunId: RUN_ID,
        afterParentSequence: cursor,
      },
      (event) => replay.push(event),
    )
    assert.ok(replay.length > 0)
    assert.equal(replay[0]!.parentSequence, cursor + 1)

    firstEpoch.close()
    const secondEpoch = new SupervisorEventProjectionV1(harness.journal, {
      epochId: 'epoch-second',
      createId: () => 'snapshot-second',
    })
    try {
      assert.throws(
        () =>
          secondEpoch.subscribe(
            {
              epochId: 'epoch-first',
              sessionId: SESSION_ID,
              parentRunId: RUN_ID,
              afterParentSequence: cursor,
            },
            () => undefined,
          ),
        hasCode('SUPERVISOR_EVENT_SNAPSHOT_REQUIRED'),
      )
      assert.throws(
        () =>
          secondEpoch.subscribe(
            {
              epochId: 'epoch-second',
              sessionId: SESSION_ID,
              parentRunId: RUN_ID,
              afterParentSequence: 0,
            },
            () => undefined,
          ),
        hasCode('SUPERVISOR_EVENT_SNAPSHOT_REQUIRED'),
      )
      const resumed = await secondEpoch.snapshot({
        sessionId: SESSION_ID,
        parentRunId: RUN_ID,
        planId: harness.planId,
      })
      assert.equal(resumed.plan.steps[0]!.state, 'succeeded')
      secondEpoch.subscribe(
        {
          epochId: resumed.epochId,
          sessionId: SESSION_ID,
          parentRunId: RUN_ID,
          afterParentSequence: resumed.parentSequence,
          snapshotId: resumed.snapshotId,
        },
        () => undefined,
      )
    } finally {
      secondEpoch.close()
    }
  } finally {
    firstEpoch.close()
    await harness.cleanup()
  }
})

test('Supervisor replay fails closed when the bounded parent buffer no longer covers a cursor', async () => {
  const harness = await createHarness('running')
  const projector = new SupervisorEventProjectionV1(harness.journal, {
    epochId: 'epoch-small-buffer',
    maxReplayEvents: 2,
    createId: () => 'snapshot-small-buffer',
  })
  try {
    const snapshot = await projector.snapshot({
      sessionId: SESSION_ID,
      parentRunId: RUN_ID,
      planId: harness.planId,
    })
    const unsubscribe = projector.subscribe(
      {
        epochId: snapshot.epochId,
        sessionId: SESSION_ID,
        parentRunId: RUN_ID,
        afterParentSequence: snapshot.parentSequence,
        snapshotId: snapshot.snapshotId,
      },
      () => undefined,
    )
    unsubscribe()
    await harness.scheduler.schedule(harness.scheduleInput)
    assert.throws(
      () =>
        projector.subscribe(
          {
            epochId: snapshot.epochId,
            sessionId: SESSION_ID,
            parentRunId: RUN_ID,
            afterParentSequence: 0,
          },
          () => undefined,
        ),
      hasCode('SUPERVISOR_EVENT_REPLAY_EXPIRED'),
    )
  } finally {
    projector.close()
    await harness.cleanup()
  }
})

type Harness = Awaited<ReturnType<typeof createHarness>>

async function createHarness(initialPlanState: 'draft' | 'running' = 'draft') {
  const root = await mkdtemp(join(tmpdir(), 'praxis-supervisor-events-'))
  const store = new JsonlSessionJournalV3(root)
  await store.initialize()
  const journal = new ReducingSessionJournalV3(store)
  const graph = new PlanValidator({
    parentBudget: BUDGET,
    defaultStepBudget: { maxTurns: 2, maxToolCalls: 2, maxTokens: 1_000 },
    accessGrant: { mode: 'read_only', paths: ['.'] },
    allowedCapabilities: ['builtin.read'],
    createId: (kind, source) => `${kind}-${source.replaceAll(':', '-')}`,
  }).validate({
    objective: 'Project one bounded child.',
    steps: [
      {
        key: 'read',
        title: 'Read evidence',
        access: { mode: 'read_only', paths: ['src'] },
        capabilities: ['builtin.read'],
        criteria: [{ kind: 'rule', description: 'The child result is verified.' }],
      },
    ],
  })
  const payloads = initialPlanJournalPayloadsV3(graph)
  await journal.appendCommit(
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
          name: 'Supervisor Events',
          labels: [],
        }),
        entry(2, 1, 'run.started', { clientRequestId: 'request-parent' }, RUN_ID),
        ...payloads.map((payload, index) => {
          const data = structuredClone(payload.data) as Record<string, unknown>
          if (payload.type === 'plan.created') data.state = initialPlanState
          return entry(index + 3, 1, payload.type, data, RUN_ID)
        }),
      ],
    }),
  )
  let nextId = 0
  const scheduler = new DagSchedulerV1(journal, undefined, {
    createId: (kind) => `${kind}-${++nextId}`,
    now: () => NOW,
  })
  return {
    root,
    journal,
    scheduler,
    planId: graph.planId,
    scheduleInput: {
      sessionId: SESSION_ID,
      parentRunId: RUN_ID,
      planId: graph.planId,
      parentBudget: BUDGET,
      failureMode: 'fail_fast' as const,
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  }
}

async function startPlan(harness: Harness): Promise<void> {
  const projection = await harness.journal.loadProjection(SESSION_ID)
  const plan = projection.planGraph!
  await append(
    harness,
    [
      {
        type: 'plan.state_changed',
        data: { planId: plan.planId, planRevision: plan.revision, state: 'running' },
        correlation: { parentRunId: RUN_ID, planId: plan.planId },
      },
    ],
    'start-plan',
  )
}

async function appendSucceeded(
  harness: Harness,
  plan: SessionPlanGraphProjectionV3,
  step: SessionStepProjectionV3,
  claim: Readonly<{ attemptId: string; childRunId: string }>,
): Promise<void> {
  const authority = {
    planId: plan.planId,
    planRevision: plan.revision,
    stepId: step.stepId,
  }
  const correlation = {
    parentRunId: RUN_ID,
    childRunId: claim.childRunId,
    planId: plan.planId,
    stepId: step.stepId,
    attemptId: claim.attemptId,
  }
  await append(
    harness,
    [
      {
        type: 'subagent.execution_bound',
        correlation,
        data: {
          ...authority,
          attemptId: claim.attemptId,
          childRunId: claim.childRunId,
          request: {
            schemaVersion: 1,
            parentRunId: RUN_ID,
            childRunId: claim.childRunId,
            packetRef: versionedRef('context_packet', 'packet', 1),
            profileRef: versionedRef('bootstrap_profile', 'profile', 3),
            bundleRef: versionedRef('capability_bundle', 'bundle', 1),
            budgetRef: versionedRef('execution_budget', 'budget', 1),
          },
          retrySafety: 'read_only_idempotent',
        },
      },
      {
        type: 'subagent.result_recorded',
        correlation,
        data: {
          ...authority,
          attemptId: claim.attemptId,
          childRunId: claim.childRunId,
          resultRef: `artifact://result-${claim.attemptId}`,
          resultDigest: DIGEST,
          status: 'succeeded',
        },
      },
      {
        type: 'attempt.execution_completed',
        correlation,
        data: { ...authority, attemptId: claim.attemptId, status: 'succeeded' },
      },
      {
        type: 'attempt.state_changed',
        correlation,
        data: { ...authority, attemptId: claim.attemptId, state: 'verifying' },
      },
      { type: 'step.state_changed', correlation, data: { ...authority, state: 'verifying' } },
      {
        type: 'verification.recorded',
        correlation,
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
        correlation,
        data: { ...authority, attemptId: claim.attemptId, state: 'verified' },
      },
      { type: 'step.state_changed', correlation, data: { ...authority, state: 'succeeded' } },
    ],
    `succeed-${claim.attemptId}`,
  )
}

function versionedRef(
  kind: 'context_packet' | 'bootstrap_profile' | 'capability_bundle' | 'execution_budget',
  id: string,
  version: number,
) {
  return { schemaVersion: 1, kind, id, version, digest: DIGEST }
}

async function append(
  harness: Harness,
  events: readonly {
    type: string
    data: Record<string, unknown>
    correlation?: Record<string, string>
  }[],
  label: string,
): Promise<void> {
  const projection = await harness.journal.loadProjection(SESSION_ID)
  const revision = projection.snapshot.revision + 1
  await harness.journal.appendCommit(
    createSessionCommitV3({
      sessionId: SESSION_ID,
      commitId: `commit-${label}`,
      expectedRevision: projection.snapshot.revision,
      idempotencyKey: `idem-${label}`,
      entries: events.map((event, index) =>
        entry(
          projection.snapshot.sequence + index + 1,
          revision,
          event.type,
          event.data,
          RUN_ID,
          event.correlation,
        ),
      ),
    }),
  )
}

function durable(
  events: readonly SupervisorUpdateV1[],
  kind: string,
  journalEvent?: string,
): DurableSupervisorUpdate {
  const event = events.find(
    (candidate) =>
      candidate.source.kind === 'journal' &&
      candidate.source.update.kind === kind &&
      (journalEvent === undefined || candidate.source.update.event === journalEvent),
  )
  assert.ok(event?.source.kind === 'journal')
  return event as DurableSupervisorUpdate
}

type DurableSupervisorUpdate = SupervisorUpdateV1 & {
  source: Extract<SupervisorUpdateV1['source'], { kind: 'journal' }>
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

function hasCode(code: string): (error: unknown) => boolean {
  return (error) =>
    typeof error === 'object' && error !== null && 'code' in error && error.code === code
}
