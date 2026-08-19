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
  type SessionJournalArchiveStoreV3,
  type SubagentExecutionRequestV1,
  validateSessionEntryV3,
} from '@praxis/core-sdk'
import {
  DagRecoveryCoordinatorV1,
  type RecoveryDependencyResolverV1,
} from '../apps/runtime/src/planner/dagRecovery.js'
import { DagSchedulerV1 } from '../apps/runtime/src/planner/dagScheduler.js'
import {
  initialPlanJournalPayloadsV3,
  PlanValidator,
} from '../apps/runtime/src/planner/planValidator.js'
import { JsonlSessionJournalV3 } from '../apps/runtime/src/session-db/jsonlSessionJournalV3.js'
import { SqliteSessionJournalV3 } from '../apps/runtime/src/session-db/sqliteSessionJournalV3.js'

const SESSION_ID = 'session-recovery'
const RUN_ID = 'run-parent'
const NOW = '2026-08-03T00:00:00.000Z'
const DIGEST = `sha256:${'d'.repeat(64)}` as `sha256:${string}`
const PARENT_BUDGET: Readonly<ExecutionBudget> = Object.freeze({
  maxTurns: 12,
  maxToolCalls: 12,
  maxTokens: 12_000,
  maxChildRuns: 4,
  maxParallelChildren: 2,
  maxDepth: 1,
})

test('Dag recovery rebuilds exact durable refs and has JSONL/SQLite parity', async () => {
  const results = []
  for (const backend of ['jsonl', 'sqlite'] as const) {
    const harness = await createHarness(backend, 'read_only_idempotent')
    try {
      let observed: SubagentExecutionRequestV1 | undefined
      const coordinator = recoveryCoordinator(harness, {
        rebuild: async ({ persistedRequest, parentRunId, newChildRunId }) => {
          observed = persistedRequest
          return {
            status: 'compatible',
            request: { ...persistedRequest, parentRunId, childRunId: newChildRunId },
          }
        },
      })
      const decision = await coordinator.recover(harness.recoveryInput)
      const projection = await harness.journal.loadProjection(SESSION_ID)
      const step = projection.planGraph!.steps[0]!
      const [oldAttempt, newAttempt] = step.attempts

      assert.deepEqual(observed, harness.persistedRequest)
      assert.equal(decision.state, 'rescheduled')
      assert.equal(decision.rescheduled.length, 1)
      assert.equal(decision.blocked.length, 0)
      assert.deepEqual(decision.unknownUsage, [
        {
          attemptId: harness.claim.attemptId,
          usage: { turns: 2, toolCalls: 2, inputTokens: 1_000, subagents: 0 },
        },
      ])
      assert.equal(step.state, 'running')
      assert.equal(oldAttempt?.state, 'interrupted')
      assert.equal(oldAttempt?.errorCode, 'RECOVERY_PROCESS_LOST')
      assert.equal(newAttempt?.state, 'running')
      assert.deepEqual(newAttempt?.execution, {
        request: decision.rescheduled[0]!.request,
        retrySafety: 'read_only_idempotent',
      })
      assert.deepEqual(projection.snapshot.usage, {
        turns: 2,
        toolCalls: 2,
        inputTokens: 1_000,
        subagents: 0,
      })

      const recoveryEntries = (
        await harness.journal.readEntries({ sessionId: SESSION_ID })
      ).entries.filter((entry) => entry.revision === decision.revision)
      const rebuiltBinding = recoveryEntries.find(
        (entry) => entry.type === 'subagent.execution_bound',
      )
      assert.ok(rebuiltBinding !== undefined)
      assert.deepEqual(Object.keys(rebuiltBinding.data.request).sort(), [
        'budgetRef',
        'bundleRef',
        'childRunId',
        'packetRef',
        'parentRunId',
        'profileRef',
        'schemaVersion',
      ])

      results.push({
        decision,
        planGraph: projection.planGraph,
        usage: projection.snapshot.usage,
        entries: recoveryEntries.map(({ entryId: _entryId, ...entry }) => entry),
      })
    } finally {
      await harness.cleanup()
    }
  }
  assert.deepEqual(results[0], results[1])
})

test('Dag recovery blocks unsafe attempts and records conservative unknown usage', async (context) => {
  for (const retrySafety of ['non_idempotent', 'unknown'] as const) {
    await context.test(retrySafety, async () => {
      const harness = await createHarness('jsonl', retrySafety)
      let resolverCalls = 0
      try {
        const decision = await recoveryCoordinator(harness, {
          rebuild: async () => {
            resolverCalls += 1
            throw new Error('must not rebuild an unsafe attempt')
          },
        }).recover(harness.recoveryInput)
        assert.equal(resolverCalls, 0)
        assert.deepEqual(decision.blocked, [
          {
            stepId: harness.stepId,
            attemptId: harness.claim.attemptId,
            code: 'RECOVERY_RETRY_NOT_SAFE',
          },
        ])
        assert.equal(decision.unknownUsage.length, 1)

        const projection = await harness.journal.loadProjection(SESSION_ID)
        assert.equal(projection.planGraph!.steps[0]!.state, 'blocked')
        assert.equal(projection.planGraph!.steps[0]!.errorCode, 'RECOVERY_RETRY_NOT_SAFE')
        assert.equal(projection.planGraph!.steps[0]!.attempts[0]!.state, 'interrupted')
      } finally {
        await harness.cleanup()
      }
    })
  }
})

test('Dag recovery exposes dependency and capability incompatibility reasons', async (context) => {
  for (const code of [
    'RECOVERY_DEPENDENCY_VERSION_MISMATCH',
    'RECOVERY_DEPENDENCY_DIGEST_MISMATCH',
    'RECOVERY_CAPABILITY_DRIFT',
    'RECOVERY_PROFILE_INCOMPATIBLE',
  ] as const) {
    await context.test(code, async () => {
      const harness = await createHarness('jsonl', 'read_only_idempotent')
      try {
        const decision = await recoveryCoordinator(harness, {
          rebuild: async ({ persistedRequest }) => {
            assert.equal(persistedRequest.profileRef.version, 3)
            assert.equal(persistedRequest.bundleRef.digest, DIGEST)
            return { status: 'incompatible', code }
          },
        }).recover(harness.recoveryInput)
        assert.equal(decision.state, 'blocked')
        assert.equal(decision.blocked[0]!.code, code)
        const projection = await harness.journal.loadProjection(SESSION_ID)
        assert.equal(projection.planGraph!.steps[0]!.errorCode, code)
      } finally {
        await harness.cleanup()
      }
    })
  }
})

test('Dag recovery does not charge or rebuild an attempt without a durable binding', async () => {
  const harness = await createHarness('jsonl')
  try {
    const decision = await recoveryCoordinator(harness, rejectingResolver()).recover(
      harness.recoveryInput,
    )
    assert.equal(decision.state, 'blocked')
    assert.equal(decision.blocked[0]!.code, 'RECOVERY_DEPENDENCY_BINDING_MISSING')
    assert.deepEqual(decision.unknownUsage, [])
    assert.deepEqual((await harness.journal.loadSnapshot(SESSION_ID)).usage, {
      turns: 0,
      toolCalls: 0,
      subagents: 0,
    })
  } finally {
    await harness.cleanup()
  }
})

test('Dag recovery rejects rebuilt requests that widen parent or child authority', async () => {
  const harness = await createHarness('jsonl', 'read_only_idempotent')
  try {
    const decision = await recoveryCoordinator(harness, {
      rebuild: async ({ persistedRequest }) => ({
        status: 'compatible',
        request: { ...persistedRequest, parentRunId: 'wrong-parent', childRunId: 'wrong-child' },
      }),
    }).recover(harness.recoveryInput)
    assert.equal(decision.blocked[0]!.code, 'RECOVERY_DEPENDENCY_REBUILD_INVALID')
  } finally {
    await harness.cleanup()
  }
})

type Backend = 'jsonl' | 'sqlite'
type Harness = Awaited<ReturnType<typeof createHarness>>
type HarnessStore = SessionJournalArchiveStoreV3 & { initialize(): Promise<void>; close?(): void }

async function createHarness(
  backend: Backend,
  retrySafety?: 'read_only_idempotent' | 'non_idempotent' | 'unknown',
) {
  const root = await mkdtemp(join(tmpdir(), `praxis-dag-recovery-${backend}-`))
  const store: HarnessStore =
    backend === 'jsonl' ? new JsonlSessionJournalV3(root) : new SqliteSessionJournalV3(root)
  await store.initialize()
  const journal = new ReducingSessionJournalV3(store)
  const graph = new PlanValidator({
    parentBudget: PARENT_BUDGET,
    defaultStepBudget: { maxTurns: 2, maxToolCalls: 2, maxTokens: 1_000 },
    accessGrant: { mode: 'read_only', paths: ['.'] },
    allowedCapabilities: ['builtin.read'],
    createId: (kind, source) => `${kind}-${source.replaceAll(':', '-')}`,
  }).validate({
    objective: 'Recover one bounded read.',
    steps: [
      {
        key: 'read',
        title: 'Read evidence',
        access: { mode: 'read_only', paths: ['src'] },
        capabilities: ['builtin.read'],
        criteria: [{ kind: 'rule', description: 'The child result is verified.' }],
        maxAttempts: 2,
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
          name: 'DAG Recovery',
          labels: [],
        }),
        entry(2, 1, 'run.started', { clientRequestId: 'request-parent' }, RUN_ID),
        ...payloads.map((payload, index) => {
          const data = structuredClone(payload.data) as Record<string, unknown>
          if (payload.type === 'plan.created') data.state = 'running'
          return entry(index + 3, 1, payload.type, data, RUN_ID)
        }),
      ],
    }),
  )

  let schedulerId = 0
  const claim = (
    await new DagSchedulerV1(journal, undefined, {
      createId: (kind) => `${kind}-schedule-${++schedulerId}`,
      now: () => NOW,
    }).schedule({
      sessionId: SESSION_ID,
      parentRunId: RUN_ID,
      planId: graph.planId,
      parentBudget: PARENT_BUDGET,
      failureMode: 'collect_partial',
    })
  ).claims[0]!
  const persistedRequest = request(RUN_ID, claim.childRunId)
  if (retrySafety !== undefined) {
    const projection = await journal.loadProjection(SESSION_ID)
    await journal.appendCommit(
      createSessionCommitV3({
        sessionId: SESSION_ID,
        commitId: 'commit-bind-old-attempt',
        expectedRevision: projection.snapshot.revision,
        idempotencyKey: 'idem-bind-old-attempt',
        entries: [
          entry(
            projection.snapshot.sequence + 1,
            projection.snapshot.revision + 1,
            'subagent.execution_bound',
            {
              planId: graph.planId,
              planRevision: graph.revision,
              stepId: graph.steps[0]!.stepId,
              attemptId: claim.attemptId,
              childRunId: claim.childRunId,
              request: persistedRequest,
              retrySafety,
            },
            RUN_ID,
            {
              parentRunId: RUN_ID,
              childRunId: claim.childRunId,
              planId: graph.planId,
              stepId: graph.steps[0]!.stepId,
              attemptId: claim.attemptId,
            },
          ),
        ],
      }),
    )
  }
  return {
    root,
    store,
    journal,
    claim,
    persistedRequest,
    planId: graph.planId,
    stepId: graph.steps[0]!.stepId,
    recoveryInput: {
      sessionId: SESSION_ID,
      parentRunId: RUN_ID,
      planId: graph.planId,
      parentBudget: PARENT_BUDGET,
    },
    cleanup: async () => {
      store.close?.()
      await rm(root, { recursive: true, force: true })
    },
  }
}

function recoveryCoordinator(harness: Harness, resolver: RecoveryDependencyResolverV1) {
  let nextId = 0
  return new DagRecoveryCoordinatorV1(harness.journal, resolver, undefined, {
    createId: (kind) => `${kind}-recovery-${++nextId}`,
    now: () => NOW,
  })
}

function rejectingResolver(): RecoveryDependencyResolverV1 {
  return {
    rebuild: async () => {
      throw new Error('resolver must not be called')
    },
  }
}

function request(parentRunId: string, childRunId: string): SubagentExecutionRequestV1 {
  return {
    schemaVersion: 1,
    parentRunId,
    childRunId,
    packetRef: ref('context_packet', 'packet', 1),
    profileRef: ref('bootstrap_profile', 'profile', 3),
    bundleRef: ref('capability_bundle', 'bundle', 1),
    budgetRef: ref('execution_budget', 'budget', 1),
  }
}

function ref(
  kind: 'context_packet' | 'bootstrap_profile' | 'capability_bundle' | 'execution_budget',
  id: string,
  version: number,
) {
  return { schemaVersion: 1 as const, kind, id, version, digest: DIGEST }
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
