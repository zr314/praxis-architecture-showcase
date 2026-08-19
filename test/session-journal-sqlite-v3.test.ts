import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import {
  createSessionCommitV3,
  ReducingSessionJournalV3,
  validateSessionEntryV3,
  type SessionCommitV3,
  type SessionEntryV3,
} from '@praxis/core-sdk'
import { createSessionJournalCompositionV3 } from '../apps/runtime/src/session-db/sessionJournalComposition.js'
import {
  SqliteSessionJournalV3,
  sqliteSessionJournalFactoryV3,
  type SqliteSessionJournalFaultPointV3,
} from '../apps/runtime/src/session-db/sqliteSessionJournalV3.js'

const STEP_DEFINITION = {
  dependencies: [] as string[],
  access: { mode: 'read_only' as const, paths: ['.'] },
  capabilities: [],
  conflictKeys: [],
  criteria: [{ criterionId: 'criterion-1', kind: 'rule' as const, description: 'Fixture passes.' }],
  budget: {
    maxTurns: 1,
    maxToolCalls: 1,
    maxChildRuns: 0,
    maxParallelChildren: 0,
    maxDepth: 0,
  },
  maxAttempts: 1,
}

test('SQLite V3 verifies WAL, FULL sync, busy timeout, foreign keys, and schema migration', async () => {
  const root = await temporaryRoot('profile')
  try {
    const store = new SqliteSessionJournalV3(root)
    await store.initialize()
    assert.deepEqual(store.profile(), {
      schemaVersion: 1,
      journalMode: 'wal',
      synchronous: 2,
      busyTimeoutMs: 5_000,
      foreignKeys: true,
    })
    const database = new DatabaseSync(databasePath(root))
    try {
      const tables = database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all() as Array<{ name: string }>
      assert.deepEqual(
        tables.map((row) => row.name),
        ['commits', 'entries', 'metadata', 'sessions'],
      )
      assert.equal(
        (database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
        1,
      )
    } finally {
      database.close()
      store.close()
    }
  } finally {
    await cleanup(root)
  }
})

test('SQLite V3 commits entries, idempotency identity, and projection in one transaction', async () => {
  const root = await temporaryRoot('atomic')
  try {
    const store = new SqliteSessionJournalV3(root)
    await store.initialize()
    const journal = new ReducingSessionJournalV3(store)
    const commit = baseCommit()
    assert.equal((await journal.appendCommit(commit)).duplicate, false)
    assert.equal((await journal.appendCommit(commit)).duplicate, true)

    const database = new DatabaseSync(databasePath(root), { readOnly: true })
    try {
      assert.equal(count(database, 'commits'), 1)
      assert.equal(count(database, 'entries'), 5)
      assert.equal(count(database, 'sessions'), 1)
      const row = database
        .prepare('SELECT revision, sequence, projection_json FROM sessions WHERE session_id = ?')
        .get('session-root') as { revision: number; sequence: number; projection_json: string }
      assert.equal(row.revision, 1)
      assert.equal(row.sequence, 5)
      assert.equal(JSON.parse(row.projection_json).planGraph.planId, 'plan-1')
    } finally {
      database.close()
      store.close()
    }
  } finally {
    await cleanup(root)
  }
})

test('SQLite V3 restart preserves exclusive cursor reads, snapshots, and mandatory idempotency', async () => {
  const root = await temporaryRoot('restart')
  try {
    const first = new SqliteSessionJournalV3(root)
    await first.initialize()
    await first.appendCommit(baseCommit())
    first.close()

    const restartedStore = new SqliteSessionJournalV3(root)
    await restartedStore.initialize()
    assert.equal((await restartedStore.appendCommit(baseCommit())).duplicate, true)
    const firstPage = await restartedStore.readEntries({
      sessionId: 'session-root',
      afterSequence: 1,
      limit: 2,
    })
    assert.deepEqual(
      firstPage.entries.map((entry) => entry.sequence),
      [2, 3],
    )
    assert.equal(firstPage.hasMore, true)
    const journal = new ReducingSessionJournalV3(restartedStore)
    assert.equal((await journal.loadSnapshot('session-root')).revision, 1)
    assert.equal(
      (
        await journal.querySession({
          sessionId: 'session-root',
          kind: 'attempt',
          planId: 'plan-1',
          stepId: 'step-1',
          attemptId: 'attempt-1',
        })
      ).kind,
      'attempt',
    )
    restartedStore.close()
  } finally {
    await cleanup(root)
  }
})

test('SQLite V3 expectedRevision CAS serializes cross-instance contenders', async () => {
  const root = await temporaryRoot('cas')
  try {
    const first = new SqliteSessionJournalV3(root)
    const second = new SqliteSessionJournalV3(root)
    await Promise.all([first.initialize(), second.initialize()])
    await first.appendCommit(creationCommit())
    const results = await Promise.allSettled([
      first.appendCommit(metadataCommit('left', 'Left')),
      second.appendCommit(metadataCommit('right', 'Right')),
    ])
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
    const rejected = results.find((result) => result.status === 'rejected')
    assert.equal(rejected?.status, 'rejected')
    if (rejected?.status === 'rejected') {
      assert.equal(rejected.reason.code, 'SESSION_COMMIT_REVISION_CONFLICT')
    }
    const snapshot = await new ReducingSessionJournalV3(first).loadSnapshot('session-root')
    assert.equal(snapshot.revision, 2)
    assert.ok(['Left', 'Right'].includes(snapshot.name))
    first.close()
    second.close()
  } finally {
    await cleanup(root)
  }
})

test('every SQLite write fault rolls back commit, entries, idempotency, and projection together', async (context) => {
  const points: readonly SqliteSessionJournalFaultPointV3[] = [
    'after_commit_row',
    'after_entries',
    'after_projection',
    'before_transaction_commit',
  ]
  for (const point of points) {
    await context.test(point, async () => {
      const root = await temporaryRoot(`rollback-${point}`)
      try {
        const faulted = new SqliteSessionJournalV3(root, {
          faultInjector(candidate) {
            if (candidate === point) throw new Error(`fault:${point}`)
          },
        })
        await faulted.initialize()
        await assert.rejects(
          faulted.appendCommit(creationCommit()),
          hasCode('PERSISTENCE_IO_ERROR'),
        )
        faulted.close()

        const database = new DatabaseSync(databasePath(root), { readOnly: true })
        try {
          assert.equal(count(database, 'commits'), 0)
          assert.equal(count(database, 'entries'), 0)
          assert.equal(count(database, 'sessions'), 0)
        } finally {
          database.close()
        }
        const recovered = new SqliteSessionJournalV3(root)
        await recovered.initialize()
        assert.equal((await recovered.appendCommit(creationCommit())).duplicate, false)
        recovered.close()
      } finally {
        await cleanup(root)
      }
    })
  }
})

test('SQLite V3 fails closed for future schemas and deep scrub detects corrupted entries', async () => {
  const futureRoot = await temporaryRoot('future')
  const corruptRoot = await temporaryRoot('corrupt')
  try {
    const future = new DatabaseSync(databasePath(futureRoot))
    future.exec('PRAGMA user_version=99')
    future.close()
    await assert.rejects(
      new SqliteSessionJournalV3(futureRoot).initialize(),
      hasCode('SESSION_STORE_VERSION_UNSUPPORTED'),
    )

    const store = new SqliteSessionJournalV3(corruptRoot)
    await store.initialize()
    await store.appendCommit(creationCommit())
    store.close()
    const corrupt = new DatabaseSync(databasePath(corruptRoot))
    corrupt.prepare('UPDATE entries SET entry_json = ? WHERE sequence = 1').run('{"corrupt":true}')
    corrupt.close()
    const restarted = new SqliteSessionJournalV3(corruptRoot)
    await restarted.initialize()
    assert.equal(
      (await new ReducingSessionJournalV3(restarted).loadSnapshot('session-root')).sessionId,
      'session-root',
    )
    await assert.rejects(restarted.deepScrub(), hasCode('PERSISTENCE_INVALID_DATA'))
    restarted.close()
  } finally {
    await Promise.all([cleanup(futureRoot), cleanup(corruptRoot)])
  }
})

test('SQLite registers explicitly while the composition default remains JSONL', async () => {
  const sqliteRoot = await temporaryRoot('composition-sqlite')
  const defaultRoot = await temporaryRoot('composition-default')
  try {
    const sqlite = await createSessionJournalCompositionV3({
      root: sqliteRoot,
      configuration: { session: { store: 'sqlite' } },
      factories: [sqliteSessionJournalFactoryV3()],
    })
    assert.equal(sqlite.storeKind, 'sqlite')
    await sqlite.journal.appendCommit(creationCommit())
    assert.equal((await sqlite.journal.loadSnapshot('session-root')).sessionId, 'session-root')

    const jsonl = await createSessionJournalCompositionV3({ root: defaultRoot })
    assert.equal(jsonl.storeKind, 'jsonl')
    await Promise.all([sqlite.close(), jsonl.close()])
  } finally {
    await Promise.all([cleanup(sqliteRoot), cleanup(defaultRoot)])
  }
})

function baseCommit(): SessionCommitV3 {
  return createSessionCommitV3({
    sessionId: 'session-root',
    commitId: 'commit-base',
    expectedRevision: 0,
    idempotencyKey: 'idem-base',
    entries: [
      entry(1, 1, 'session.created', {
        cwd: 'D:/workspace',
        provider: 'fixture',
        model: 'fixture-model',
        name: 'SQLite V3',
        labels: [],
      }),
      entry(2, 1, 'plan.created', {
        planId: 'plan-1',
        planRevision: 1,
        objective: 'SQLite fixture',
        state: 'running',
      }),
      entry(3, 1, 'step.created', {
        planId: 'plan-1',
        planRevision: 1,
        stepId: 'step-1',
        title: 'Execute',
        order: 0,
        state: 'running',
        ...STEP_DEFINITION,
      }),
      entry(4, 1, 'attempt.created', {
        planId: 'plan-1',
        planRevision: 1,
        stepId: 'step-1',
        attemptId: 'attempt-1',
        ordinal: 1,
        state: 'running',
      }),
      entry(5, 1, 'run.started', { clientRequestId: 'request-1' }, { runId: 'run-1' }),
    ],
  })
}

function creationCommit(): SessionCommitV3 {
  return createSessionCommitV3({
    sessionId: 'session-root',
    commitId: 'commit-create',
    expectedRevision: 0,
    idempotencyKey: 'idem-create',
    entries: [
      entry(1, 1, 'session.created', {
        cwd: 'D:/workspace',
        provider: 'fixture',
        model: 'fixture-model',
        name: 'SQLite V3',
        labels: [],
      }),
    ],
  })
}

function metadataCommit(suffix: string, name: string): SessionCommitV3 {
  return createSessionCommitV3({
    sessionId: 'session-root',
    commitId: `commit-${suffix}`,
    expectedRevision: 1,
    idempotencyKey: `idem-${suffix}`,
    entries: [entry(2, 2, 'session.metadata_updated', { name }, { entryId: `entry-${suffix}` })],
  })
}

function entry(
  sequence: number,
  revision: number,
  type: string,
  data: Record<string, unknown>,
  options: { runId?: string; entryId?: string } = {},
): SessionEntryV3 {
  return validateSessionEntryV3({
    schemaVersion: 3,
    entryId: options.entryId ?? `entry-${sequence}`,
    sessionId: 'session-root',
    sequence,
    revision,
    timestamp: new Date(Date.UTC(2026, 0, 5, 0, 0, sequence)).toISOString(),
    type,
    ...(options.runId === undefined ? {} : { runId: options.runId }),
    data,
  })
}

function count(database: DatabaseSync, table: string): number {
  const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }
  return Number(row.count)
}

function databasePath(root: string): string {
  return join(root, 'session-journal-v3.sqlite')
}

async function temporaryRoot(name: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `praxis-journal-sqlite-${name}-`))
}

async function cleanup(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

function hasCode(code: string) {
  return (error: unknown) =>
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code
}
