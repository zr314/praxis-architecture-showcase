import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  commitPreparedSessionCompactionV3,
  commitSessionCompactionV3,
  createSessionCommitV3,
  prepareSessionCompactionCommitV3,
  ReducingSessionJournalV3,
  sessionCompactionSummaryDigestV3,
  validateSessionEntryV3,
  type SessionCompactionSummaryV3,
  type SessionEntryV3,
  type SessionJournalArchiveStoreV3,
  type SessionProjectionV3,
} from '@praxis/core-sdk'
import { JsonlSessionJournalV3 } from '../apps/runtime/src/session-db/jsonlSessionJournalV3.js'
import { SqliteSessionJournalV3 } from '../apps/runtime/src/session-db/sqliteSessionJournalV3.js'

const DIGEST = `sha256:${'b'.repeat(64)}` as `sha256:${string}`
const STEP_DEFINITION = {
  dependencies: [] as string[],
  access: { mode: 'read_only' as const, paths: ['.'] },
  capabilities: [],
  conflictKeys: [],
  criteria: [
    { criterionId: 'criterion-compaction', kind: 'rule' as const, description: 'Fixture passes.' },
  ],
  budget: {
    maxTurns: 1,
    maxToolCalls: 1,
    maxChildRuns: 0,
    maxParallelChildren: 0,
    maxDepth: 0,
  },
  maxAttempts: 1,
}
const SUMMARY: SessionCompactionSummaryV3 = {
  schemaVersion: 1,
  trust: 'low',
  objective: 'Preserve durable context',
  decisions: ['Use one journal authority'],
  constraints: ['Never delete source entries'],
  readFiles: ['docs/architecture.md'],
  modifiedFiles: [],
  unresolved: ['Verify restart'],
  activePlan: ['running: durable compaction'],
}
const PROVENANCE = {
  schemaVersion: 1 as const,
  generator: { kind: 'deterministic' as const, id: 'deterministic-v1' },
  fallbackFrom: {
    kind: 'model' as const,
    id: 'summary-model-v1',
    provider: 'fixture',
    model: 'fixture-model',
  },
}

test('compaction entry validation binds the summary schema to its digest', () => {
  const valid = compactionEntry('session-schema', 6, 2, {
    checkpointId: 'checkpoint-schema',
    coveredStartSequence: 1,
    coveredEndSequence: 5,
    retainedStartSequence: 6,
    summary: SUMMARY,
    provenance: PROVENANCE,
    summaryDigest: sessionCompactionSummaryDigestV3(SUMMARY),
    summaryTokens: 41,
    reason: 'manual',
  })
  assert.equal(valid.type, 'compaction.created')
  assert.throws(
    () =>
      validateSessionEntryV3({
        ...valid,
        data: { ...valid.data, summaryDigest: `sha256:${'0'.repeat(64)}` },
      }),
    hasCode('SESSION_ENTRY_INVALID'),
  )
})

test('JSONL and SQLite share durable range, crash, retry, reason, and recovery semantics', async () => {
  const results: SessionProjectionV3[][] = []
  for (const backend of ['jsonl', 'sqlite'] as const) {
    const root = await mkdtemp(join(tmpdir(), `praxis-compaction-${backend}-`))
    const fault = { active: false }
    let store: HarnessStore | undefined
    let restarted: HarnessStore | undefined
    try {
      store = createStore(backend, root, fault)
      await store.initialize()
      const journal = new ReducingSessionJournalV3(store)
      await Promise.all([
        seedSession(journal, 'session-chain'),
        seedSession(journal, 'session-manual'),
      ])

      const before = await readAll(journal, 'session-chain')
      const accepted: string[] = []
      const observed: Array<Promise<SessionProjectionV3>> = []
      journal.subscribe((event) => {
        if (event.entries[0]?.type === 'compaction.created') {
          accepted.push(event.entries[0].data.checkpointId)
          observed.push(journal.loadProjection(event.receipt.sessionId))
        }
      })

      const threshold = await prepareSessionCompactionCommitV3(
        journal,
        compactionInput('session-chain', 'threshold', 'checkpoint-threshold', 1, 5, 20),
      )
      fault.active = true
      await assert.rejects(
        commitPreparedSessionCompactionV3(journal, threshold),
        hasCode('PERSISTENCE_IO_ERROR'),
      )
      fault.active = false
      assert.equal((await journal.loadProjection('session-chain')).checkpoint, undefined)
      assert.deepEqual(await readAll(journal, 'session-chain'), before)
      assert.deepEqual(accepted, [])

      const committed = await commitPreparedSessionCompactionV3(journal, threshold)
      assert.equal(committed.receipt.duplicate, false)
      assert.equal(committed.checkpoint.reason, 'threshold')
      assert.equal(
        (await commitPreparedSessionCompactionV3(journal, threshold)).receipt.duplicate,
        true,
      )
      assert.deepEqual(accepted, ['checkpoint-threshold'])
      assert.equal((await observed[0]!).checkpoint?.checkpointId, 'checkpoint-threshold')

      const afterThreshold = await readAll(journal, 'session-chain')
      assert.deepEqual(afterThreshold.slice(0, before.length), before)
      assert.equal(afterThreshold.length, before.length + 1)

      const overflow = await commitSessionCompactionV3(
        journal,
        compactionInput('session-chain', 'overflow', 'checkpoint-overflow', 1, 10, 21),
      )
      assert.equal(overflow.checkpoint.previousCheckpointId, 'checkpoint-threshold')
      assert.deepEqual(overflow.checkpoint.coveredRange, { startSequence: 1, endSequence: 10 })
      assert.equal(overflow.checkpoint.retainedStartSequence, 11)

      await assert.rejects(
        prepareSessionCompactionCommitV3(
          journal,
          compactionInput('session-chain', 'overflow', 'checkpoint-no-progress', 1, 10, 22),
        ),
        hasCode('SESSION_COMPACTION_RANGE_INVALID'),
      )

      const manual = await commitSessionCompactionV3(
        journal,
        compactionInput('session-manual', 'manual', 'checkpoint-manual', 1, 10, 20),
      )
      assert.equal(manual.checkpoint.reason, 'manual')
      assert.deepEqual(accepted, [
        'checkpoint-threshold',
        'checkpoint-overflow',
        'checkpoint-manual',
      ])

      const beforeRestart = await Promise.all([
        journal.loadProjection('session-chain'),
        journal.loadProjection('session-manual'),
      ])
      store.close?.()
      store = undefined
      restarted = createStore(backend, root, { active: false })
      await restarted.initialize()
      const replayed = new ReducingSessionJournalV3(restarted)
      const afterRestart = await Promise.all([
        replayed.loadProjection('session-chain'),
        replayed.loadProjection('session-manual'),
      ])
      assert.deepEqual(afterRestart, beforeRestart)
      results.push(afterRestart)
    } finally {
      store?.close?.()
      restarted?.close?.()
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }
  assert.deepEqual(results[1], results[0])
})

type HarnessStore = SessionJournalArchiveStoreV3 & {
  initialize(): Promise<void>
  close?(): void
}

function createStore(
  backend: 'jsonl' | 'sqlite',
  root: string,
  fault: { active: boolean },
): HarnessStore {
  return backend === 'jsonl'
    ? new JsonlSessionJournalV3(root, {
        faultInjector(point) {
          if (fault.active && point === 'before_append') throw new Error('fixture crash')
        },
      })
    : new SqliteSessionJournalV3(root, {
        faultInjector(point) {
          if (fault.active && point === 'before_transaction_commit')
            throw new Error('fixture crash')
        },
      })
}

async function seedSession(journal: ReducingSessionJournalV3, sessionId: string): Promise<void> {
  await journal.appendCommit(
    createSessionCommitV3({
      sessionId,
      commitId: `commit-${sessionId}-create`,
      expectedRevision: 0,
      idempotencyKey: `idem-${sessionId}-create`,
      entries: [
        entry(sessionId, 1, 1, 'session.created', {
          cwd: 'D:/workspace',
          provider: 'fixture',
          model: 'fixture-model',
          name: sessionId,
          labels: [],
        }),
        entry(sessionId, 2, 1, 'message.committed', {
          messageId: `message-${sessionId}-1`,
          message: { role: 'user', content: 'objective' },
        }),
        entry(sessionId, 3, 1, 'message.committed', {
          messageId: `message-${sessionId}-2`,
          message: { role: 'assistant', content: 'decision' },
        }),
        entry(sessionId, 4, 1, 'permission.decided', {
          requestId: `permission-${sessionId}`,
          toolCallId: `tool-${sessionId}`,
          tool: 'read',
          decision: 'allow_once',
          ruleDigest: DIGEST,
        }),
        entry(sessionId, 5, 1, 'usage.recorded', {
          source: 'provider',
          usage: { turns: 1, toolCalls: 0, subagents: 0, inputTokens: 8 },
        }),
        entry(sessionId, 6, 1, 'message.committed', {
          messageId: `message-${sessionId}-3`,
          message: {
            role: 'assistant',
            content: 'read the file',
            toolCalls: [{ id: `tool-${sessionId}`, name: 'read', input: { path: 'README.md' } }],
          },
        }),
        entry(sessionId, 7, 1, 'message.committed', {
          messageId: `message-${sessionId}-4`,
          message: {
            role: 'tool',
            toolCallId: `tool-${sessionId}`,
            name: 'read',
            content: '{"ok":true}',
          },
        }),
        entry(sessionId, 8, 1, 'plan.created', {
          planId: `plan-${sessionId}`,
          planRevision: 1,
          objective: 'Durable compaction fixture',
          state: 'running',
        }),
        entry(sessionId, 9, 1, 'step.created', {
          planId: `plan-${sessionId}`,
          planRevision: 1,
          stepId: `step-${sessionId}`,
          title: 'Keep structured state',
          order: 0,
          state: 'pending',
          ...STEP_DEFINITION,
        }),
        entry(sessionId, 10, 1, 'artifact.referenced', {
          owner: 'message',
          artifact: {
            artifactId: `artifact-${sessionId}`,
            digest: DIGEST,
            mimeType: 'text/plain',
            bytes: 12,
          },
        }),
      ],
    }),
  )
}

function compactionInput(
  sessionId: string,
  reason: 'manual' | 'threshold' | 'overflow',
  checkpointId: string,
  coveredStartSequence: number,
  coveredEndSequence: number,
  ordinal: number,
) {
  return {
    sessionId,
    commitId: `commit-${checkpointId}`,
    idempotencyKey: `idem-${checkpointId}`,
    entryId: `entry-${checkpointId}`,
    checkpointId,
    timestamp: new Date(Date.UTC(2026, 0, 7, 0, 0, ordinal)).toISOString(),
    coveredStartSequence,
    coveredEndSequence,
    summary: SUMMARY,
    provenance: PROVENANCE,
    summaryTokens: 41,
    reason,
  } as const
}

function compactionEntry(
  sessionId: string,
  sequence: number,
  revision: number,
  data: Record<string, unknown>,
): SessionEntryV3 {
  return entry(sessionId, sequence, revision, 'compaction.created', data)
}

function entry(
  sessionId: string,
  sequence: number,
  revision: number,
  type: string,
  data: Record<string, unknown>,
): SessionEntryV3 {
  return validateSessionEntryV3({
    schemaVersion: 3,
    entryId: `entry-${sessionId}-${sequence}`,
    sessionId,
    sequence,
    revision,
    timestamp: new Date(Date.UTC(2026, 0, 7, 0, 0, sequence)).toISOString(),
    type,
    data,
  })
}

async function readAll(
  journal: ReducingSessionJournalV3,
  sessionId: string,
): Promise<readonly SessionEntryV3[]> {
  return (await journal.readEntries({ sessionId })).entries
}

function hasCode(code: string) {
  return (error: unknown) =>
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code
}
