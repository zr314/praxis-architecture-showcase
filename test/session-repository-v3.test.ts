import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SessionRepositoryV3 } from '../apps/runtime/src/session-db/sessionRepositoryV3.js'
import { migrateSessionStorageV3 } from '../apps/runtime/src/session-db/sessionStorageMigration.js'

test('product V3 repository persists planner, transcript, exact checkpoint, and terminal usage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-product-v3-'))
  const content = 'Decision: keep one V3 authority.'
  const repository = new SessionRepositoryV3({ root, store: 'jsonl' })
  try {
    await repository.initialize()
    await repository.create({
      recordVersion: 2,
      sessionId: 'session-product',
      state: 'idle',
      plannerMode: 'supervisor',
      cwd: process.cwd(),
      provider: 'mock',
      model: 'mock-v1',
      contextLimitTokens: 16_384,
      createdAt: '2026-08-04T00:00:00.000Z',
      updatedAt: '2026-08-04T00:00:00.000Z',
      name: 'Product V3',
      activeLeafId: 'session-product',
      labels: ['v3'],
    })
    await repository.appendRequestMessage('session-product', 'request-1', 'run-1', {
      role: 'user',
      content: 'hello',
    })
    await repository.appendMessage('session-product', { role: 'assistant', content: 'world' })
    await repository.saveMemory({
      sessionId: 'session-product',
      checkpoint: {
        id: 'checkpoint-product',
        trust: 'low',
        scope: { kind: 'parent', sessionId: 'session-product' },
        messageStart: 0,
        messageEnd: 2,
        content,
        digest: `sha256:${createHash('sha256').update(content).digest('hex')}`,
        estimatedTokens: 12,
        estimatedGainTokens: 30,
        createdAt: '2026-08-04T00:00:01.000Z',
        summary: {
          decisions: ['keep one V3 authority'],
          constraints: [],
          readFiles: [],
          modifiedFiles: [],
          unresolved: [],
          activePlan: [],
        },
        provenance: {
          schemaVersion: 1,
          generator: { kind: 'deterministic', id: 'test' },
        },
        nativeContext: {
          schemaVersion: 1,
          provider: 'openai',
          model: 'gpt-5.2',
          format: 'openai.responses.compact.v1',
          items: [{ type: 'compaction', encrypted_content: 'opaque-state' }],
          messageStart: 0,
          messageEnd: 2,
          sourceDigest: `sha256:${'a'.repeat(64)}`,
          instructionsDigest: `sha256:${'b'.repeat(64)}`,
          estimatedTokens: 10,
          createdAt: '2026-08-04T00:00:01.000Z',
        },
      },
    })
    await repository.updateTerminal('session-product', 'completed', { inputTokens: 3 }, 2)
    assert.deepEqual(await repository.loadMessages('session-product'), [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
    ])
    assert.equal((await repository.get('session-product'))?.plannerMode, 'supervisor')
    assert.equal((await repository.get('session-product'))?.lastTerminalState, 'completed')
    assert.equal((await repository.loadMemory('session-product')).checkpoint?.content, content)
    assert.equal(
      (await repository.loadMemory('session-product')).checkpoint?.nativeContext?.items[0]?.type,
      'compaction',
    )
    assert.deepEqual(await repository.loadClientRequests('session-product'), {
      'request-1': 'run-1',
    })
  } finally {
    await repository.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('product V3 repository persists the real terminal failure code', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-product-v3-failure-code-'))
  const repository = new SessionRepositoryV3({ root, store: 'jsonl' })
  try {
    await repository.initialize()
    await repository.create({
      sessionId: 'session-coded-failure',
      state: 'idle',
      cwd: process.cwd(),
      provider: 'mock',
      model: 'mock-v1',
      createdAt: '2026-08-05T00:00:00.000Z',
      updatedAt: '2026-08-05T00:00:00.000Z',
    })
    await repository.appendRequestMessage(
      'session-coded-failure',
      'request-coded-failure',
      'run-coded-failure',
      { role: 'user', content: 'bounded failure' },
    )
    await repository.updateTerminal(
      'session-coded-failure',
      'failed',
      { outputTokens: 8_192 },
      1,
      'PROVIDER_OUTPUT_TRUNCATED',
    )

    assert.deepEqual(
      (await repository.journal().loadProjection('session-coded-failure')).snapshot.runs[0],
      {
        runId: 'run-coded-failure',
        clientRequestId: 'request-coded-failure',
        state: 'failed',
        usage: { outputTokens: 8_192 },
        errorCode: 'PROVIDER_OUTPUT_TRUNCATED',
      },
    )
  } finally {
    await repository.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('offline storage migration verifies JSONL to SQLite and back without dual authority', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-storage-migrate-'))
  const repository = new SessionRepositoryV3({ root, store: 'jsonl' })
  try {
    await repository.initialize()
    await repository.create({
      sessionId: 'session-migrate',
      state: 'idle',
      cwd: process.cwd(),
      provider: 'mock',
      model: 'mock-v1',
      createdAt: '2026-08-04T00:00:00.000Z',
      updatedAt: '2026-08-04T00:00:00.000Z',
    })
    await repository.close()

    const sqlite = await migrateSessionStorageV3('sqlite', { root })
    assert.equal(sqlite.changed, true)
    assert.equal(sqlite.sessionCount, 1)
    const sqliteRepository = new SessionRepositoryV3({ root, store: 'sqlite' })
    await sqliteRepository.initialize()
    assert.equal((await sqliteRepository.get('session-migrate'))?.sessionId, 'session-migrate')
    await sqliteRepository.close()

    const jsonl = await migrateSessionStorageV3('jsonl', { root })
    assert.equal(jsonl.changed, true)
    assert.equal(jsonl.sessionCount, sqlite.sessionCount)
    assert.equal(jsonl.commitCount, sqlite.commitCount)
    assert.equal(jsonl.entryCount, sqlite.entryCount)
    const jsonlRepository = new SessionRepositoryV3({ root, store: 'jsonl' })
    await jsonlRepository.initialize()
    assert.equal((await jsonlRepository.get('session-migrate'))?.sessionId, 'session-migrate')
    await jsonlRepository.close()
  } finally {
    await repository.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('offline migration rejects a live Runtime lease and removes a stale lease', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-storage-lease-'))
  const repository = new SessionRepositoryV3({ root, store: 'jsonl' })
  try {
    await repository.initialize()
    await assert.rejects(migrateSessionStorageV3('sqlite', { root }), {
      code: 'SESSION_STORE_MIGRATION_RUNTIME_ACTIVE',
    })
    await repository.close()

    const locks = join(root, 'locks')
    await mkdir(locks, { recursive: true })
    await writeFile(
      join(locks, 'session-runtime-2147483647-00000000-0000-0000-0000-000000000000.lock'),
      JSON.stringify({ version: 1, pid: 2_147_483_647 }),
      'utf8',
    )
    const migrated = await migrateSessionStorageV3('sqlite', { root })
    assert.equal(migrated.changed, true)
  } finally {
    await repository.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('a concurrent Runtime never recovers a live peer run as restarted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-concurrent-runtime-recovery-'))
  const owner = new SessionRepositoryV3({ root, store: 'jsonl' })
  const peer = new SessionRepositoryV3({ root, store: 'jsonl' })
  try {
    await owner.initialize()
    await owner.create({
      sessionId: 'session-live-owner',
      state: 'idle',
      cwd: process.cwd(),
      provider: 'mock',
      model: 'mock-v1',
      createdAt: '2026-08-05T00:00:00.000Z',
      updatedAt: '2026-08-05T00:00:00.000Z',
    })
    await owner.appendRequestMessage('session-live-owner', 'request-live', 'run-live', {
      role: 'user',
      content: 'keep running while a peer starts',
    })

    await peer.initialize()
    assert.equal(
      (await owner.journal().loadProjection('session-live-owner')).snapshot.runs[0]?.state,
      'running',
    )
    await peer.close()
    await owner.close()

    const restarted = new SessionRepositoryV3({ root, store: 'jsonl' })
    await restarted.initialize()
    assert.deepEqual(
      (await restarted.journal().loadProjection('session-live-owner')).snapshot.runs[0],
      {
        runId: 'run-live',
        clientRequestId: 'request-live',
        state: 'interrupted',
        usage: {},
        errorCode: 'RUNTIME_RESTARTED',
      },
    )
    await restarted.close()
  } finally {
    await peer.close()
    await owner.close()
    await rm(root, { recursive: true, force: true })
  }
})
