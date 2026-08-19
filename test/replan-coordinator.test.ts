import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  createSessionCommitV3,
  ReducingSessionJournalV3,
  reduceSessionEntriesV3,
  type SessionEntryV3,
  type SubagentExecutionRequestV1,
  validateSessionEntryV3,
} from '@praxis/core-sdk'
import { assertProtocolMessage, type SupervisorUpdateV1 } from '@praxis/protocol'
import {
  type FixedPlanProposalV1,
  initialPlanJournalPayloadsV3,
  PlanValidator,
} from '../apps/runtime/src/planner/planValidator.js'
import {
  ReplanCoordinatorV1,
  validatePlannerDecisionV1,
} from '../apps/runtime/src/planner/replanCoordinator.js'
import { SupervisorEventProjectionV1 } from '../apps/runtime/src/planner/supervisorEventProjection.js'
import { JsonlSessionJournalV3 } from '../apps/runtime/src/session-db/jsonlSessionJournalV3.js'
import { SqliteSessionJournalV3 } from '../apps/runtime/src/session-db/sqliteSessionJournalV3.js'

const SESSION_ID = 'session-replan'
const RUN_ID = 'run-parent'
const NOW = '2026-08-03T00:00:00.000Z'
const DIGEST = `sha256:${'d'.repeat(64)}` as `sha256:${string}`
const ADMISSION = {
  parentBudget: {
    maxTurns: 8,
    maxToolCalls: 8,
    maxTokens: 8_000,
    maxChildRuns: 4,
    maxParallelChildren: 2,
    maxDepth: 1,
  },
  defaultStepBudget: { maxTurns: 2, maxToolCalls: 2, maxTokens: 1_000 },
  accessGrant: { mode: 'read_only' as const, paths: ['.'] },
  allowedCapabilities: ['builtin.read'],
}

test('ReplanCoordinator atomically advances revision and projects explicit decision events', async () => {
  const harness = await createHarness(oneStep('old', 'Inspect old scope.'), ['blocked'])
  const updates: SupervisorUpdateV1[] = []
  const protocolEvents: Array<{
    type: 'supervisor_update'
    update: SupervisorUpdateV1
  }> = []
  const projector = new SupervisorEventProjectionV1(harness.journal, {
    epochId: 'epoch-replan',
    createId: () => 'snapshot-replan',
    emit: (event) => protocolEvents.push(event),
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
      (update) => updates.push(update),
    )
    const coordinator = harness.coordinator('apply')
    const result = await coordinator.replan({
      sessionId: SESSION_ID,
      parentRunId: RUN_ID,
      planId: harness.planId,
      expectedRevision: 1,
      expectedPlanRevision: 1,
      proposal: oneStep('new', 'Inspect revised scope.'),
    })

    assert.equal(result.status, 'applied')
    if (result.status !== 'applied') assert.fail('expected applied replan')
    assert.equal(result.previousRevision, 1)
    assert.equal(result.revision, 2)
    const projection = await harness.journal.loadProjection(SESSION_ID)
    assert.equal(projection.planGraph?.revision, 2)
    assert.equal(projection.planGraph?.state, 'running')
    assert.deepEqual(
      projection.planGraph?.steps.map((step) => step.title),
      ['Inspect revised scope.'],
    )
    assert.deepEqual(
      updates.map((update) =>
        update.source.kind === 'journal' ? update.source.update.kind : 'child_progress',
      ),
      ['planner_decision', 'plan', 'step'],
    )
    for (const [index, event] of protocolEvents.entries()) {
      assertProtocolMessage({
        jsonrpc: '2.0',
        method: 'event',
        params: {
          subscriptionId: 'subscription-replan',
          sequence: index + 1,
          timestamp: NOW,
          sessionId: SESSION_ID,
          runId: RUN_ID,
          event,
        },
      })
    }

    const history = await readAll(harness.journal)
    assert.ok(
      history.some((entry) => entry.type === 'step.created' && entry.data.stepId === 'step-old'),
    )
    assert.equal(history.filter((entry) => entry.type === 'plan.revised').length, 1)

    await assert.rejects(
      coordinator.replan({
        sessionId: SESSION_ID,
        parentRunId: RUN_ID,
        planId: harness.planId,
        expectedRevision: 2,
        expectedPlanRevision: 2,
        proposal: oneStep('third', 'Inspect a third scope.'),
      }),
      hasCode('REPLAN_LIMIT_EXCEEDED'),
    )
  } finally {
    projector.close()
    await harness.cleanup()
  }
})

test('a terminal failed plan can recover only through an admitted new revision', async () => {
  const harness = await createHarness(oneStep('old', 'Inspect the failed scope.'), ['blocked'])
  try {
    const projection = await harness.journal.loadProjection(SESSION_ID)
    const plan = projection.planGraph!
    await harness.journal.appendCommit(
      createSessionCommitV3({
        sessionId: SESSION_ID,
        commitId: 'commit-terminal-failure',
        expectedRevision: projection.snapshot.revision,
        idempotencyKey: 'idem-terminal-failure',
        entries: [
          entry(
            projection.snapshot.sequence + 1,
            projection.snapshot.revision + 1,
            'plan.state_changed',
            {
              planId: plan.planId,
              planRevision: plan.revision,
              state: 'failed',
            },
            RUN_ID,
          ),
        ],
      }),
    )

    const failed = await harness.journal.loadProjection(SESSION_ID)
    assert.equal(failed.planGraph?.state, 'failed')
    const result = await harness.coordinator('failed-recovery').replan({
      sessionId: SESSION_ID,
      parentRunId: RUN_ID,
      planId: harness.planId,
      expectedRevision: failed.snapshot.revision,
      expectedPlanRevision: 1,
      proposal: oneStep('replacement', 'Inspect the recovered scope.'),
    })

    assert.equal(result.status, 'applied')
    const recovered = await harness.journal.loadProjection(SESSION_ID)
    assert.equal(recovered.planGraph?.revision, 2)
    assert.equal(recovered.planGraph?.state, 'running')
    assert.deepEqual(
      recovered.planGraph?.steps.map((step) => step.title),
      ['Inspect the recovered scope.'],
    )
  } finally {
    await harness.cleanup()
  }
})

test('successful step reuse requires the durable execution input digest and preserves attempts', async () => {
  const initial: FixedPlanProposalV1 = {
    objective: 'Keep verified evidence and replace the blocked work.',
    steps: [step('keep', 'Keep verified evidence.'), step('replace', 'Replace blocked work.')],
  }
  const harness = await createHarness(initial, ['pending', 'pending'])
  try {
    await appendVerifiedFirstStep(harness)
    const before = await harness.journal.loadProjection(SESSION_ID)
    assert.equal(before.planGraph?.steps[0]?.state, 'succeeded')
    assert.equal(before.planGraph?.steps[0]?.attempts[0]?.state, 'verified')
    assert.equal(before.planGraph?.state, 'blocked')

    const next: FixedPlanProposalV1 = {
      objective: initial.objective,
      steps: [step('keep', 'Keep verified evidence.'), step('replacement', 'Do safer work.')],
    }
    const result = await harness.coordinator('reuse').replan({
      sessionId: SESSION_ID,
      parentRunId: RUN_ID,
      planId: harness.planId,
      expectedRevision: 2,
      expectedPlanRevision: 1,
      proposal: next,
      reuse: [
        {
          proposalKey: 'keep',
          priorStepId: 'step-keep',
          nextInputDigest: DIGEST,
        },
      ],
    })
    assert.equal(result.status, 'applied')
    const after = await harness.journal.loadProjection(SESSION_ID)
    assert.equal(after.planGraph?.revision, 2)
    assert.equal(after.planGraph?.steps[0]?.stepId, 'step-keep')
    assert.equal(after.planGraph?.steps[0]?.state, 'succeeded')
    assert.equal(after.planGraph?.steps[0]?.attempts[0]?.attemptId, 'attempt-keep')
    assert.equal(after.planGraph?.steps[1]?.state, 'pending')

    const history = await readAll(harness.journal)
    const revised = history.find((entry) => entry.type === 'plan.revised')
    assert.equal(revised?.type, 'plan.revised')
    if (revised?.type !== 'plan.revised') assert.fail('missing plan.revised')
    assert.deepEqual(revised.data.reuseProofs, [
      {
        stepId: 'step-keep',
        previousInputDigest: DIGEST,
        nextInputDigest: DIGEST,
      },
    ])

    const tampered = structuredClone(history) as unknown as Array<
      SessionEntryV3 & { data: Record<string, unknown> }
    >
    const tamperedRevision = tampered.find((entry) => entry.type === 'plan.revised')
    assert.ok(tamperedRevision)
    ;(
      tamperedRevision!.data.reuseProofs as unknown as Array<{
        nextInputDigest: `sha256:${string}`
      }>
    )[0]!.nextInputDigest = `sha256:${'e'.repeat(64)}`
    assert.throws(
      () => reduceSessionEntriesV3(tampered),
      hasCode('SESSION_REDUCER_TRANSITION_INVALID'),
    )
  } finally {
    await harness.cleanup()
  }
})

test('input invalidation prevents successful-step reuse', async () => {
  const harness = await createHarness(
    {
      objective: 'Digest mismatch fixture.',
      steps: [step('keep', 'Keep verified evidence.'), step('replace', 'Replace work.')],
    },
    ['pending', 'pending'],
  )
  try {
    await appendVerifiedFirstStep(harness)
    await assert.rejects(
      harness.coordinator('invalidated').replan({
        sessionId: SESSION_ID,
        parentRunId: RUN_ID,
        planId: harness.planId,
        expectedRevision: 2,
        expectedPlanRevision: 1,
        proposal: {
          objective: 'Digest mismatch fixture.',
          steps: [step('keep', 'Keep verified evidence.'), step('new', 'New work.')],
        },
        reuse: [
          {
            proposalKey: 'keep',
            priorStepId: 'step-keep',
            nextInputDigest: `sha256:${'e'.repeat(64)}`,
          },
        ],
      }),
      hasCode('REPLAN_REUSE_INVALID'),
    )
    assert.equal((await harness.journal.loadProjection(SESSION_ID)).planGraph?.revision, 1)
  } finally {
    await harness.cleanup()
  }
})

test('repeated structural no-progress records history once per attempt then remains blocked', async () => {
  const proposal = oneStep('same', 'Unchanged work.')
  const harness = await createHarness(proposal, ['blocked'])
  try {
    const coordinator = harness.coordinator('no-progress')
    const first = await coordinator.replan({
      sessionId: SESSION_ID,
      parentRunId: RUN_ID,
      planId: harness.planId,
      expectedRevision: 1,
      expectedPlanRevision: 1,
      proposal,
    })
    assert.deepEqual(first, {
      status: 'no_progress',
      action: 'ask_user',
      occurrences: 1,
    })
    const second = await coordinator.replan({
      sessionId: SESSION_ID,
      parentRunId: RUN_ID,
      planId: harness.planId,
      expectedRevision: 2,
      expectedPlanRevision: 1,
      proposal,
    })
    assert.deepEqual(second, {
      status: 'blocked',
      action: 'ask_user',
      occurrences: 2,
    })
    const beforeThird = (await harness.journal.loadSnapshot(SESSION_ID)).sequence
    const third = await coordinator.replan({
      sessionId: SESSION_ID,
      parentRunId: RUN_ID,
      planId: harness.planId,
      expectedRevision: 3,
      expectedPlanRevision: 1,
      proposal,
    })
    assert.deepEqual(third, {
      status: 'blocked',
      action: 'ask_user',
      occurrences: 2,
    })
    assert.equal((await harness.journal.loadSnapshot(SESSION_ID)).sequence, beforeThird)
    assert.equal((await harness.journal.loadProjection(SESSION_ID)).planGraph?.state, 'blocked')
  } finally {
    await harness.cleanup()
  }
})

test('expectedRevision CAS permits one replan contender and never overwrites the winner', async () => {
  const harness = await createHarness(oneStep('old', 'Old scope.'), ['blocked'])
  try {
    const request = {
      sessionId: SESSION_ID,
      parentRunId: RUN_ID,
      planId: harness.planId,
      expectedRevision: 1,
      expectedPlanRevision: 1,
      proposal: oneStep('new', 'New scope.'),
    }
    const results = await Promise.allSettled([
      harness.coordinator('left').replan(request),
      harness.coordinator('right').replan(request),
    ])
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
    const rejected = results.find((result) => result.status === 'rejected')
    assert.equal(rejected?.status, 'rejected')
    if (rejected?.status !== 'rejected') assert.fail('expected one rejected contender')
    assert.equal(errorCode(rejected.reason), 'REPLAN_EXPECTED_REVISION_CONFLICT')
    const history = await readAll(harness.journal)
    assert.equal(history.filter((entry) => entry.type === 'plan.revised').length, 1)
    assert.equal((await harness.journal.loadProjection(SESSION_ID)).planGraph?.revision, 2)
  } finally {
    await harness.cleanup()
  }
})

test('recovery decisions distinguish retry, continue, fresh worker, replan, and ask user', () => {
  for (const action of ['retry', 'continue', 'fresh_worker'] as const) {
    assert.deepEqual(
      validatePlannerDecisionV1({
        action,
        reasonCode: `DECISION_${action.toUpperCase()}`,
        stepId: 'step-1',
        attemptId: 'attempt-1',
      }).action,
      action,
    )
  }
  for (const action of ['replan', 'ask_user'] as const) {
    assert.equal(
      validatePlannerDecisionV1({ action, reasonCode: 'DECISION_SELECTED' }).action,
      action,
    )
  }
  assert.throws(
    () =>
      validatePlannerDecisionV1({
        action: 'continue',
        reasonCode: 'DECISION_CONTINUE',
        stepId: 'step-1',
      }),
    hasCode('PLANNER_DECISION_INVALID'),
  )
  assert.throws(
    () =>
      validatePlannerDecisionV1({
        action: 'guess',
        reasonCode: 'DECISION_GUESS',
      }),
    hasCode('PLANNER_DECISION_INVALID'),
  )

  const validUpdate = protocolUpdate('replan')
  assert.doesNotThrow(() => assertProtocolMessage(validUpdate))
  const future = structuredClone(validUpdate) as unknown as {
    params: { event: { update: { source: { update: { action: string } } } } }
  }
  future.params.event.update.source.update.action = 'future_action'
  assert.throws(() => assertProtocolMessage(future))
})

test('non-replan decisions are durably selected without changing the plan revision', async () => {
  const harness = await createHarness(oneStep('blocked', 'Await user input.'), ['blocked'])
  try {
    const decision = await harness.coordinator('ask-user').recordDecision({
      sessionId: SESSION_ID,
      parentRunId: RUN_ID,
      planId: harness.planId,
      expectedRevision: 1,
      expectedPlanRevision: 1,
      decision: { action: 'ask_user', reasonCode: 'USER_INPUT_REQUIRED' },
    })
    assert.equal(decision.action, 'ask_user')
    const projection = await harness.journal.loadProjection(SESSION_ID)
    assert.equal(projection.snapshot.revision, 2)
    assert.equal(projection.planGraph?.revision, 1)
    const history = await readAll(harness.journal)
    const recorded = history.find((entry) => entry.type === 'plan.decision_recorded')
    assert.equal(recorded?.type, 'plan.decision_recorded')
    if (recorded?.type !== 'plan.decision_recorded') assert.fail('missing decision')
    assert.deepEqual(recorded.data, {
      planId: harness.planId,
      planRevision: 1,
      action: 'ask_user',
      reasonCode: 'USER_INPUT_REQUIRED',
      outcome: 'selected',
    })
  } finally {
    await harness.cleanup()
  }
})

test('JSONL and SQLite replay the same applied replan projection', async () => {
  const projections = []
  for (const backend of ['jsonl', 'sqlite'] as const) {
    const harness = await createHarness(oneStep('old', 'Old parity scope.'), ['blocked'], backend)
    try {
      await harness.coordinator('parity').replan({
        sessionId: SESSION_ID,
        parentRunId: RUN_ID,
        planId: harness.planId,
        expectedRevision: 1,
        expectedPlanRevision: 1,
        proposal: oneStep('new', 'New parity scope.'),
      })
      projections.push((await harness.journal.loadProjection(SESSION_ID)).planGraph)
    } finally {
      await harness.cleanup()
    }
  }
  assert.deepEqual(projections[0], projections[1])
})

async function createHarness(
  proposal: FixedPlanProposalV1,
  stepStates: readonly ('pending' | 'blocked')[],
  backend: 'jsonl' | 'sqlite' = 'jsonl',
) {
  const root = await mkdtemp(join(tmpdir(), 'praxis-replan-'))
  const store =
    backend === 'jsonl' ? new JsonlSessionJournalV3(root) : new SqliteSessionJournalV3(root)
  await store.initialize()
  const journal = new ReducingSessionJournalV3(store)
  const graph = new PlanValidator({
    ...ADMISSION,
    createId: (kind, source) => `${kind}-${source.replaceAll(':', '-')}`,
  }).validate(proposal)
  const payloads = initialPlanJournalPayloadsV3(graph)
  let stepIndex = 0
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
          name: 'Replan fixture',
          labels: [],
        }),
        entry(2, 1, 'run.started', { clientRequestId: 'request-parent' }, RUN_ID),
        ...payloads.map((payload, index) => {
          const data = structuredClone(payload.data) as Record<string, unknown>
          if (payload.type === 'plan.created') data.state = 'running'
          if (payload.type === 'step.created') data.state = stepStates[stepIndex++]
          return entry(index + 3, 1, payload.type, data, RUN_ID)
        }),
      ],
    }),
  )
  return {
    root,
    journal,
    planId: graph.planId,
    coordinator: (prefix: string) => {
      let id = 0
      return new ReplanCoordinatorV1({
        journal,
        admission: ADMISSION,
        createId: (kind) => `${kind}-${prefix}-${++id}`,
        now: () => NOW,
      })
    },
    cleanup: async () => {
      if (store instanceof SqliteSessionJournalV3) store.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}

async function appendVerifiedFirstStep(
  harness: Awaited<ReturnType<typeof createHarness>>,
): Promise<void> {
  const projection = await harness.journal.loadProjection(SESSION_ID)
  const plan = projection.planGraph!
  const keep = plan.steps[0]!
  const request: SubagentExecutionRequestV1 = {
    schemaVersion: 1,
    parentRunId: RUN_ID,
    childRunId: 'child-keep',
    packetRef: ref('context_packet', 'packet-keep', 1),
    profileRef: ref('bootstrap_profile', 'profile-keep', 3),
    bundleRef: ref('capability_bundle', 'bundle-keep', 1),
    budgetRef: ref('execution_budget', 'budget-keep', 1),
  }
  const authority = {
    planId: plan.planId,
    planRevision: plan.revision,
    stepId: keep.stepId,
  }
  const correlation = {
    parentRunId: RUN_ID,
    childRunId: 'child-keep',
    planId: plan.planId,
    stepId: keep.stepId,
    attemptId: 'attempt-keep',
  }
  const drafts: Array<Readonly<{ type: string; data: Record<string, unknown> }>> = [
    {
      type: 'attempt.created',
      data: {
        ...authority,
        attemptId: 'attempt-keep',
        ordinal: 1,
        state: 'reserved',
        childRunId: 'child-keep',
      },
    },
    { type: 'step.state_changed', data: { ...authority, state: 'running' } },
    {
      type: 'attempt.state_changed',
      data: { ...authority, attemptId: 'attempt-keep', state: 'running' },
    },
    {
      type: 'subagent.execution_bound',
      data: {
        ...authority,
        attemptId: 'attempt-keep',
        childRunId: 'child-keep',
        request,
        retrySafety: 'read_only_idempotent',
      },
    },
    {
      type: 'subagent.result_recorded',
      data: {
        ...authority,
        attemptId: 'attempt-keep',
        childRunId: 'child-keep',
        resultRef: 'artifact://result-keep',
        resultDigest: DIGEST,
        status: 'succeeded',
      },
    },
    {
      type: 'attempt.execution_completed',
      data: { ...authority, attemptId: 'attempt-keep', status: 'succeeded' },
    },
    {
      type: 'attempt.state_changed',
      data: { ...authority, attemptId: 'attempt-keep', state: 'verifying' },
    },
    { type: 'step.state_changed', data: { ...authority, state: 'verifying' } },
    {
      type: 'verification.recorded',
      data: {
        ...authority,
        attemptId: 'attempt-keep',
        verificationId: 'verification-keep',
        verifier: 'mechanical',
        status: 'passed',
        evidenceRefs: ['artifact://result-keep'],
      },
    },
    {
      type: 'attempt.state_changed',
      data: { ...authority, attemptId: 'attempt-keep', state: 'verified' },
    },
    { type: 'step.state_changed', data: { ...authority, state: 'succeeded' } },
    {
      type: 'plan.state_changed',
      data: {
        planId: plan.planId,
        planRevision: plan.revision,
        state: 'blocked',
      },
    },
  ]
  await harness.journal.appendCommit(
    createSessionCommitV3({
      sessionId: SESSION_ID,
      commitId: 'commit-verified-keep',
      expectedRevision: projection.snapshot.revision,
      idempotencyKey: 'idem-verified-keep',
      entries: drafts.map((draft, index) =>
        entry(
          projection.snapshot.sequence + index + 1,
          projection.snapshot.revision + 1,
          draft.type,
          draft.data,
          RUN_ID,
          correlation,
        ),
      ),
    }),
  )
}

function oneStep(key: string, title: string): FixedPlanProposalV1 {
  return { objective: 'Bounded replan fixture.', steps: [step(key, title)] }
}

function step(key: string, title: string): FixedPlanProposalV1['steps'][number] {
  return {
    key,
    title,
    access: { mode: 'read_only', paths: ['src'] },
    capabilities: ['builtin.read'],
    criteria: [{ kind: 'rule', description: `${title} is verified.` }],
  }
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
    entryId: `entry-${sequence}`,
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

function ref(kind: SubagentExecutionRequestV1['packetRef']['kind'], id: string, version: number) {
  return { schemaVersion: 1 as const, kind, id, version, digest: DIGEST }
}

async function readAll(journal: ReducingSessionJournalV3): Promise<readonly SessionEntryV3[]> {
  const entries: SessionEntryV3[] = []
  let afterSequence = 0
  let hasMore = true
  while (hasMore) {
    const page = await journal.readEntries({
      sessionId: SESSION_ID,
      afterSequence,
      limit: 512,
    })
    entries.push(...page.entries)
    afterSequence = page.nextAfterSequence
    hasMore = page.hasMore
  }
  return entries
}

function protocolUpdate(action: 'replan') {
  return {
    jsonrpc: '2.0',
    method: 'event',
    params: {
      subscriptionId: 'subscription-replan',
      sequence: 1,
      timestamp: NOW,
      sessionId: SESSION_ID,
      runId: RUN_ID,
      event: {
        type: 'supervisor_update',
        update: {
          schemaVersion: 1,
          parentSequence: 1,
          sessionId: SESSION_ID,
          correlation: { parentRunId: RUN_ID, planId: 'plan-root' },
          source: {
            kind: 'journal',
            journalSequence: 1,
            revision: 1,
            entryId: 'entry-1',
            update: {
              kind: 'planner_decision',
              event: 'plan.decision_recorded',
              action,
              outcome: 'applied',
            },
          },
        },
      },
    },
  }
}

function errorCode(error: unknown): string {
  return typeof error === 'object' &&
    error !== null &&
    typeof Reflect.get(error, 'code') === 'string'
    ? (Reflect.get(error, 'code') as string)
    : 'UNKNOWN'
}

function hasCode(code: string) {
  return (error: unknown): boolean => errorCode(error) === code
}
