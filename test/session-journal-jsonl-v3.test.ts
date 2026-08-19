import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFile, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  createSessionCommitV3,
  ReducingSessionJournalV3,
  validateSessionEntryV3,
  type SessionCommitV3,
  type SessionEntryV3,
  type SessionRecord,
} from '@praxis/core-sdk'
import {
  JsonlSessionJournalV3,
  type JsonlSessionJournalFaultPointV3,
} from '../apps/runtime/src/session-db/jsonlSessionJournalV3.js'
import { JsonlRepository } from '../apps/runtime/src/session-db/jsonlRepository.js'

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

test('JSONL V3 persists one checksummed logical commit line and rebuilds domain projections', async () => {
  const root = await temporaryRoot('basic')
  try {
    const store = new JsonlSessionJournalV3(root)
    await store.initialize()
    const journal = new ReducingSessionJournalV3(store)
    await journal.appendCommit(baseCommit())

    const lines = (await readFile(commitPath(root), 'utf8')).trimEnd().split('\n')
    assert.equal(lines.length, 1)
    const record = JSON.parse(lines[0]!) as Record<string, unknown>
    assert.equal(record.formatVersion, 3)
    assert.match(String(record.recordChecksum), /^sha256:[a-f0-9]{64}$/)
    assert.equal((record.commit as { entries: unknown[] }).entries.length, 5)

    const restartedStore = new JsonlSessionJournalV3(root)
    await restartedStore.initialize()
    const restarted = new ReducingSessionJournalV3(restartedStore)
    const snapshot = await restarted.loadSnapshot('session-root')
    assert.equal(snapshot.sequence, 5)
    assert.equal(snapshot.revision, 1)
    assert.equal(snapshot.runs[0]?.state, 'running')
    assert.equal((await restartedStore.listCatalog())[0]?.sessionId, 'session-root')
    assert.equal((await restartedStore.listCatalog())[0]?.messageCount, 0)
  } finally {
    await cleanup(root)
  }
})

test('JSONL V3 rejects a whole reducer-invalid commit without appending a partial record', async () => {
  const root = await temporaryRoot('atomic-reject')
  try {
    const store = new JsonlSessionJournalV3(root)
    await store.initialize()
    const journal = new ReducingSessionJournalV3(store)
    await journal.appendCommit(creationCommit())
    const before = await readFile(commitPath(root), 'utf8')

    const invalid = createSessionCommitV3({
      sessionId: 'session-root',
      commitId: 'commit-invalid',
      expectedRevision: 1,
      idempotencyKey: 'idem-invalid',
      entries: [
        entry(2, 2, 'message.committed', messageData('message-reused', 'first')),
        entry(3, 2, 'message.committed', messageData('message-reused', 'second')),
      ],
    })
    await assert.rejects(journal.appendCommit(invalid), hasCode('SESSION_REDUCER_ID_REUSED'))
    assert.equal(await readFile(commitPath(root), 'utf8'), before)
    assert.equal((await journal.loadSnapshot('session-root')).sequence, 1)
  } finally {
    await cleanup(root)
  }
})

test('JSONL V3 repairs a truncated tail before the next append and deep scrub rejects complete corruption', async () => {
  const root = await temporaryRoot('tail')
  try {
    const first = new JsonlSessionJournalV3(root)
    await first.initialize()
    await first.appendCommit(creationCommit())
    await appendFile(commitPath(root), '{"formatVersion":3,"partial"', 'utf8')

    const restarted = new JsonlSessionJournalV3(root)
    await restarted.initialize()
    await restarted.appendCommit(metadataCommit())
    const page = await restarted.readEntries({ sessionId: 'session-root' })
    assert.deepEqual(
      page.entries.map((candidate) => candidate.sequence),
      [1, 2],
    )
    assert.equal((await readFile(commitPath(root), 'utf8')).trimEnd().split('\n').length, 2)

    await appendFile(commitPath(root), '{"formatVersion":3}\n', 'utf8')
    const corrupt = new JsonlSessionJournalV3(root)
    await corrupt.initialize()
    assert.equal(
      (await new ReducingSessionJournalV3(corrupt).loadSnapshot('session-root')).name,
      'Renamed',
    )
    await assert.rejects(corrupt.deepScrub(), hasCode('PERSISTENCE_INVALID_DATA'))
  } finally {
    await cleanup(root)
  }
})

test('invalid fast-path caches fail closed and an explicit deep scrub rebuilds them', async () => {
  const root = await temporaryRoot('cache-rebuild')
  try {
    const store = new JsonlSessionJournalV3(root)
    await store.initialize()
    await store.appendCommit(creationCommit())
    await writeFile(join(root, 'session-journal-v3', 'catalog.json'), '{"corrupt":true}\n', 'utf8')
    await writeFile(projectionPath(root), '{"corrupt":true}\n', 'utf8')

    const restartedStore = new JsonlSessionJournalV3(root)
    await assert.rejects(restartedStore.initialize(), hasCode('PERSISTENCE_INVALID_DATA'))
    const scrubbedStore = new JsonlSessionJournalV3(root, { deepScrubOnInitialize: true })
    await scrubbedStore.initialize()
    const restarted = new ReducingSessionJournalV3(scrubbedStore)
    assert.equal((await restarted.loadSnapshot('session-root')).name, 'JSONL V3')
    assert.equal((await scrubbedStore.listCatalog()).length, 1)
    assert.equal(
      (JSON.parse(await readFile(projectionPath(root), 'utf8')) as { formatVersion: number })
        .formatVersion,
      3,
    )
  } finally {
    await cleanup(root)
  }
})

test('validated startup reuses projections and commits append only a catalog delta', async () => {
  const root = await temporaryRoot('fast-path')
  try {
    const store = new JsonlSessionJournalV3(root)
    await store.initialize()
    await store.appendCommit(creationCommit())
    const catalogPath = join(root, 'session-journal-v3', 'catalog.json')
    const deltaPath = join(root, 'session-journal-v3', 'catalog-delta.jsonl')
    const catalogBefore = await digestFile(catalogPath)
    const projectionBefore = await digestFile(projectionPath(root))

    await store.appendCommit(metadataCommit())
    assert.equal(await digestFile(catalogPath), catalogBefore)
    assert.equal((await readFile(deltaPath, 'utf8')).trimEnd().split('\n').length, 2)

    const projectionAfterCommit = await digestFile(projectionPath(root))
    assert.notEqual(projectionAfterCommit, projectionBefore)
    const restarted = new JsonlSessionJournalV3(root)
    await restarted.initialize()
    assert.equal(await digestFile(catalogPath), catalogBefore)
    assert.equal(await digestFile(projectionPath(root)), projectionAfterCommit)
    assert.equal((await restarted.listCatalog())[0]?.name, 'Renamed')
  } finally {
    await cleanup(root)
  }
})

test('incremental catalog upgrades legacy caches once and fails closed when its delta disappears', async () => {
  const root = await temporaryRoot('incremental-upgrade')
  try {
    const store = new JsonlSessionJournalV3(root)
    await store.initialize()
    await store.appendCommit(creationCommit())
    const journalRoot = join(root, 'session-journal-v3')
    const statePath = join(journalRoot, 'catalog-state.json')
    const deltaPath = join(journalRoot, 'catalog-delta.jsonl')

    await writeFile(
      join(journalRoot, 'catalog.json'),
      `${JSON.stringify({ formatVersion: 3, sessions: [], checksum: 'legacy-cache' })}\n`,
      'utf8',
    )
    await rm(statePath)

    const upgraded = new JsonlSessionJournalV3(root)
    await upgraded.initialize()
    assert.equal((await upgraded.listCatalog())[0]?.sessionId, 'session-root')
    assert.equal(
      (JSON.parse(await readFile(statePath, 'utf8')) as { strategy: string }).strategy,
      'incremental-v1',
    )

    await rm(deltaPath)
    await assert.rejects(
      new JsonlSessionJournalV3(root).initialize(),
      hasCode('PERSISTENCE_IO_ERROR'),
    )
    const scrubbed = new JsonlSessionJournalV3(root, { deepScrubOnInitialize: true })
    await scrubbed.initialize()
    assert.equal((await scrubbed.listCatalog()).length, 1)
  } finally {
    await cleanup(root)
  }
})

test('idempotency and expectedRevision CAS survive restart and cross-instance contention', async () => {
  const root = await temporaryRoot('concurrency')
  try {
    const first = new JsonlSessionJournalV3(root)
    const second = new JsonlSessionJournalV3(root)
    await Promise.all([first.initialize(), second.initialize()])
    assert.equal((await first.appendCommit(creationCommit())).duplicate, false)
    assert.equal((await second.appendCommit(creationCommit())).duplicate, true)

    const left = metadataCommit('left', 'Left')
    const right = metadataCommit('right', 'Right')
    const results = await Promise.allSettled([first.appendCommit(left), second.appendCommit(right)])
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
    const rejected = results.find((result) => result.status === 'rejected')
    assert.equal(rejected?.status, 'rejected')
    if (rejected?.status === 'rejected') {
      assert.equal(rejected.reason.code, 'SESSION_COMMIT_REVISION_CONFLICT')
    }

    const restartStore = new JsonlSessionJournalV3(root)
    await restartStore.initialize()
    const snapshot = await new ReducingSessionJournalV3(restartStore).loadSnapshot('session-root')
    assert.equal(snapshot.revision, 2)
    assert.ok(['Left', 'Right'].includes(snapshot.name))
  } finally {
    await cleanup(root)
  }
})

test('commit crash points recover from the journal without phantom accepted events', async (context) => {
  const cases: readonly JsonlSessionJournalFaultPointV3[] = [
    'before_append',
    'after_append_fsync',
    'before_projection_write',
    'before_catalog_write',
  ]
  for (const point of cases) {
    await context.test(point, async () => {
      const root = await temporaryRoot(`fault-${point}`)
      try {
        let armed = true
        const faultedStore = new JsonlSessionJournalV3(root, {
          faultInjector(candidate) {
            if (armed && candidate === point) {
              armed = false
              throw new Error(`fault:${point}`)
            }
          },
        })
        await faultedStore.initialize()
        const faulted = new ReducingSessionJournalV3(faultedStore)
        let events = 0
        faulted.subscribe(() => {
          events += 1
        })
        await assert.rejects(
          faulted.appendCommit(creationCommit()),
          hasCode('PERSISTENCE_IO_ERROR'),
        )
        assert.equal(events, 0)

        const recoveredStore = new JsonlSessionJournalV3(root)
        await recoveredStore.initialize()
        const recovered = new ReducingSessionJournalV3(recoveredStore)
        let replayEvents = 0
        recovered.subscribe(() => {
          replayEvents += 1
        })
        const receipt = await recovered.appendCommit(creationCommit())
        assert.equal(receipt.duplicate, point !== 'before_append')
        assert.equal(replayEvents, point === 'before_append' ? 1 : 0)
        assert.equal((await recovered.loadSnapshot('session-root')).sequence, 1)
      } finally {
        await cleanup(root)
      }
    })
  }
})

test('V2 migration validates first, then backs up and preserves messages/memory as V3 entries and artifacts', async () => {
  const root = await temporaryRoot('migration')
  try {
    const legacy = new JsonlRepository(root)
    await legacy.initialize()
    const record = legacyRecord('legacy')
    await legacy.create(record)
    await legacy.appendRequestMessage('legacy', 'request-1', 'run-legacy', {
      role: 'user',
      content: 'legacy prompt',
    })
    await legacy.appendMessage('legacy', { role: 'assistant', content: 'legacy answer' })
    await legacy.saveMemory({
      sessionId: 'legacy',
      checkpoint: {
        id: 'checkpoint-legacy',
        messageStart: 0,
        messageEnd: 2,
        content: 'legacy summary',
        // Early V2 stores accepted provider/tokenizer-owned digest strings.
        digest: 'utf8-bytes:14',
        estimatedTokens: 12,
        createdAt: '2026-01-03T00:00:03.000Z',
      },
      plan: {
        objective: 'Legacy objective',
        steps: [{ id: 'legacy-step', title: 'Legacy step', state: 'completed' }],
        revision: 1,
        updatedAt: '2026-01-03T00:00:04.000Z',
      },
    })
    await legacy.updateTerminal('legacy', 'completed', { inputTokens: 4, outputTokens: 2 }, 2)
    const terminal = await legacy.get('legacy')
    await legacy.update({ ...terminal!, state: 'closed' })

    const originalCatalog = await digestFile(join(root, 'sessions.json'))
    const originalHistory = await digestFile(join(root, 'history', 'legacy.jsonl'))
    const originalMemory = await digestFile(join(root, 'memory', 'legacy.json'))

    const migratedStore = new JsonlSessionJournalV3(root)
    await migratedStore.initialize()
    const report = await migratedStore.migrationReport()
    assert.equal(report?.sessionCount, 1)
    assert.equal(report?.messageCount, 2)
    assert.equal(report?.artifactCount, 1)
    assert.equal(report?.warnings.length, 0)
    assert.equal((await stat(report!.backupDirectory)).isDirectory(), true)

    const migrated = new ReducingSessionJournalV3(migratedStore)
    const snapshot = await migrated.loadSnapshot('legacy')
    assert.equal(snapshot.lifecycle, 'closed')
    assert.equal(snapshot.messages.length, 2)
    assert.deepEqual(snapshot.runs, [
      {
        runId: 'run-legacy',
        clientRequestId: 'request-1',
        state: 'completed',
        usage: { inputTokens: 4, outputTokens: 2 },
      },
    ])
    assert.equal(snapshot.checkpointId, 'checkpoint-legacy')
    const checkpoint = (await migratedStore.readEntries({ sessionId: 'legacy' })).entries.find(
      (candidate) => candidate.type === 'compaction.created',
    )
    assert.match(String(checkpoint?.data.checkpoint?.digest), /^sha256:[a-f0-9]{64}$/)
    assert.deepEqual(snapshot.usage, {
      turns: 0,
      toolCalls: 0,
      inputTokens: 4,
      outputTokens: 2,
      subagents: 0,
    })
    const projection = await migrated.loadProjection('legacy')
    assert.equal(projection.compactPlan, undefined)
    assert.equal(projection.planGraph, undefined)

    assert.equal(await digestFile(join(root, 'sessions.json')), originalCatalog)
    assert.equal(await digestFile(join(root, 'history', 'legacy.jsonl')), originalHistory)
    assert.equal(await digestFile(join(root, 'memory', 'legacy.json')), originalMemory)
    const backupsBefore = await readdir(join(root, 'migration-backups'))
    const restarted = new JsonlSessionJournalV3(root)
    await restarted.initialize()
    assert.deepEqual(await readdir(join(root, 'migration-backups')), backupsBefore)
  } finally {
    await cleanup(root)
  }
})

test('invalid V2 input leaves the source untouched without installing authority or duplicate backups', async () => {
  const root = await temporaryRoot('migration-invalid')
  try {
    const legacy = new JsonlRepository(root)
    await legacy.initialize()
    await legacy.create(legacyRecord('legacy'))
    await legacy.appendMessage('legacy', { role: 'user', content: 'valid before corruption' })
    await appendFile(
      join(root, 'history', 'legacy.jsonl'),
      `${JSON.stringify({
        version: 2,
        sequence: 2,
        committedAt: '2026-01-03T00:00:05.000Z',
        message: { role: 'assistant', content: 'bad checksum' },
        checksum: `sha256:${'0'.repeat(64)}`,
      })}\n`,
      'utf8',
    )
    const original = await digestFile(join(root, 'history', 'legacy.jsonl'))

    const migrated = new JsonlSessionJournalV3(root)
    await assert.rejects(migrated.initialize(), hasCode('PERSISTENCE_INVALID_DATA'))
    await assert.rejects(migrated.initialize(), hasCode('PERSISTENCE_INVALID_DATA'))
    assert.equal(await digestFile(join(root, 'history', 'legacy.jsonl')), original)
    await assert.rejects(stat(join(root, 'session-journal-v3')), hasFsCode('ENOENT'))
    await assert.rejects(stat(join(root, 'migration-backups')), hasFsCode('ENOENT'))
  } finally {
    await cleanup(root)
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
        name: 'JSONL V3',
        labels: [],
      }),
      entry(2, 1, 'plan.created', {
        planId: 'plan-1',
        planRevision: 1,
        objective: 'JSONL fixture',
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
        name: 'JSONL V3',
        labels: [],
      }),
    ],
  })
}

function metadataCommit(suffix = 'metadata', name = 'Renamed'): SessionCommitV3 {
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
    timestamp: new Date(Date.UTC(2026, 0, 3, 0, 0, sequence)).toISOString(),
    type,
    ...(options.runId === undefined ? {} : { runId: options.runId }),
    data,
  })
}

function messageData(messageId: string, content: string): Record<string, unknown> {
  return { messageId, message: { role: 'user', content } }
}

function legacyRecord(sessionId: string): SessionRecord {
  return {
    recordVersion: 2,
    sessionId,
    state: 'idle',
    cwd: 'D:/legacy',
    provider: 'fixture',
    model: 'fixture-model',
    createdAt: '2026-01-03T00:00:00.000Z',
    updatedAt: '2026-01-03T00:00:00.000Z',
    name: 'Legacy session',
    activeLeafId: sessionId,
    labels: ['legacy'],
    messageCount: 0,
    usage: {},
  }
}

function commitPath(root: string, sessionId = 'session-root'): string {
  return join(
    root,
    'session-journal-v3',
    'commits',
    `${Buffer.from(sessionId).toString('base64url')}.jsonl`,
  )
}

function projectionPath(root: string, sessionId = 'session-root'): string {
  return join(
    root,
    'session-journal-v3',
    'projections',
    `${Buffer.from(sessionId).toString('base64url')}.json`,
  )
}

async function temporaryRoot(name: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `praxis-journal-v3-${name}-`))
}

async function cleanup(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

async function digestFile(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}

function hasCode(code: string) {
  return (error: unknown) =>
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code
}

function hasFsCode(code: string) {
  return (error: unknown) =>
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code
}
