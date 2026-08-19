import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFile, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { SessionRecord } from '@praxis/core-sdk'
import { JsonlRepository } from '../apps/runtime/src/session-db/jsonlRepository.js'

test('Session v1 catalog migrates forward once with a backup and checksummed v2 records', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-session-migration-'))
  try {
    await writeFile(
      join(root, 'sessions.json'),
      JSON.stringify({ version: 1, sessions: [record('legacy')] }),
      'utf8',
    )
    const repository = new JsonlRepository(root)
    await repository.initialize()

    const catalog = JSON.parse(await readFile(join(root, 'sessions.json'), 'utf8')) as {
      version: number
      checksum: string
      sessions: SessionRecord[]
    }
    assert.equal(catalog.version, 2)
    assert.match(catalog.checksum, /^sha256:[a-f0-9]{64}$/)
    assert.equal(catalog.sessions[0]?.recordVersion, 2)
    assert.equal(catalog.sessions[0]?.activeLeafId, 'legacy')
    assert.ok((await readdir(root)).some((name) => /^sessions\.json\.v1\..+\.bak$/.test(name)))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('durable request idempotency and truncated-tail recovery survive repository restarts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-session-recovery-'))
  try {
    const first = new JsonlRepository(root)
    await first.initialize()
    await first.create(record('recover'))
    assert.deepEqual(
      await first.appendRequestMessage('recover', 'request-1', 'run-1', {
        role: 'user',
        content: 'once',
      }),
      {},
    )

    const restarted = new JsonlRepository(root)
    assert.deepEqual(
      await restarted.appendRequestMessage('recover', 'request-1', 'run-2', {
        role: 'user',
        content: 'duplicate',
      }),
      { duplicateRunId: 'run-1' },
    )
    assert.deepEqual(await restarted.loadClientRequests('recover'), { 'request-1': 'run-1' })

    await appendFile(join(root, 'history', 'recover.jsonl'), '{"version":2,"partial"', 'utf8')
    assert.deepEqual(await restarted.loadMessages('recover'), [{ role: 'user', content: 'once' }])
    await restarted.appendMessage('recover', { role: 'assistant', content: 'recovered' })
    assert.deepEqual(await restarted.loadMessages('recover'), [
      { role: 'user', content: 'once' },
      { role: 'assistant', content: 'recovered' },
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('normal transcript persistence appends without replacing the existing history file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-session-append-'))
  try {
    const repository = new JsonlRepository(root)
    await repository.initialize()
    await repository.create(record('append-only'))
    await repository.appendMessage('append-only', { role: 'user', content: 'first' })

    const path = join(root, 'history', 'append-only.jsonl')
    const before = await stat(path)
    const existingHandle = await open(path, 'r')
    try {
      await repository.appendMessage('append-only', { role: 'assistant', content: 'second' })
      const after = await stat(path)
      const visibleThroughExistingHandle = await existingHandle.readFile('utf8')

      assert.equal(after.ino, before.ino)
      assert.match(visibleThroughExistingHandle, /"content":"second"/)
    } finally {
      await existingHandle.close()
    }

    const lines = (await readFile(path, 'utf8')).trim().split(/\r?\n/)
    assert.equal(lines.length, 2)
    assert.deepEqual(
      lines.map((line) => (JSON.parse(line) as { sequence: number }).sequence),
      [1, 2],
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('concurrent healthy repository startup validates without rewriting the shared catalog', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-session-startup-'))
  try {
    const initial = new JsonlRepository(root)
    await initial.initialize()
    await initial.create(record('healthy'))
    await initial.appendMessage('healthy', { role: 'user', content: 'preserved' })

    const path = join(root, 'sessions.json')
    const before = await stat(path)
    await Promise.all(
      Array.from({ length: 8 }, async () => {
        const repository = new JsonlRepository(root)
        await repository.initialize()
        assert.equal((await repository.get('healthy'))?.messageCount, 1)
      }),
    )
    const after = await stat(path)

    assert.equal(after.ino, before.ino)
    assert.equal(after.mtimeMs, before.mtimeMs)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('two repository instances serialize cross-process-style history writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-session-lock-'))
  try {
    const first = new JsonlRepository(root)
    const second = new JsonlRepository(root)
    await first.initialize()
    await first.create(record('locked'))

    await Promise.all([
      first.appendMessage('locked', { role: 'user', content: 'first' }),
      second.appendMessage('locked', { role: 'assistant', content: 'second' }),
    ])
    const messages = await first.loadMessages('locked')
    assert.equal(messages.length, 2)
    assert.deepEqual(
      new Set(messages.map((message) => message.role)),
      new Set(['user', 'assistant']),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('session index supports rename, search, export, fork navigation, and delete-to-trash', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-session-management-'))
  try {
    const repository = new JsonlRepository(root)
    await repository.initialize()
    await repository.create(record('parent'))
    await repository.appendMessage('parent', { role: 'user', content: 'question' })
    await repository.appendMessage('parent', { role: 'assistant', content: 'answer' })
    await repository.saveMemory({
      sessionId: 'parent',
      checkpoint: {
        id: 'checkpoint-parent',
        trust: 'low',
        scope: { kind: 'parent', sessionId: 'parent' },
        messageStart: 0,
        messageEnd: 1,
        content: 'parent-only summary',
        digest: `sha256:${'a'.repeat(64)}`,
        estimatedTokens: 4,
        estimatedGainTokens: 2,
        createdAt: '2026-01-01T00:00:01.000Z',
      },
      plan: {
        objective: 'Shared fork objective',
        steps: [],
        revision: 1,
        updatedAt: '2026-01-01T00:00:01.000Z',
      },
    })

    assert.equal((await repository.rename('parent', 'Research branch')).name, 'Research branch')
    assert.equal((await repository.search('research'))[0]?.messageCount, 2)
    assert.equal((await repository.exportSession('parent')).messages.length, 2)

    await repository.forkSession(
      'parent',
      {
        ...record('child'),
        name: 'Alternative',
        parentSessionId: 'parent',
      },
      1,
    )
    assert.equal((await repository.get('parent'))?.activeLeafId, 'child')
    assert.equal((await repository.get('child'))?.parentSessionId, 'parent')
    assert.deepEqual(await repository.loadMessages('child'), [
      { role: 'user', content: 'question' },
    ])
    assert.equal((await repository.loadMemory('child')).checkpoint, undefined)
    assert.equal((await repository.loadMemory('child')).plan?.objective, 'Shared fork objective')

    const deleted = await repository.deleteToTrash('child')
    assert.match(deleted.trashPath, /trash[\\/]sessions/)
    assert.equal(await repository.get('child'), undefined)
    assert.equal((await repository.get('parent'))?.activeLeafId, 'parent')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('catalog checksum corruption self-heals from independent session metadata and history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-session-checksum-'))
  try {
    const repository = new JsonlRepository(root)
    await repository.initialize()
    await repository.create(record('checksum'))
    await repository.appendMessage('checksum', { role: 'user', content: 'preserved' })
    const path = join(root, 'sessions.json')
    const catalog = JSON.parse(await readFile(path, 'utf8')) as {
      sessions: Array<{ model: string; messageCount: number }>
    }
    catalog.sessions[0]!.model = 'tampered'
    catalog.sessions[0]!.messageCount = 999
    await writeFile(path, JSON.stringify(catalog), 'utf8')

    const restarted = new JsonlRepository(root)
    await restarted.initialize()
    const recovered = await restarted.list()
    assert.equal(recovered[0]?.model, 'mock-v1')
    assert.equal(recovered[0]?.messageCount, 1)
    assert.deepEqual(await restarted.loadMessages('checksum'), [
      { role: 'user', content: 'preserved' },
    ])

    const repaired = JSON.parse(await readFile(path, 'utf8')) as {
      checksum?: string
      sessions: Array<{ model: string; messageCount: number }>
    }
    assert.match(repaired.checksum ?? '', /^sha256:[a-f0-9]{64}$/)
    assert.equal(repaired.sessions[0]?.model, 'mock-v1')
    assert.equal(repaired.sessions[0]?.messageCount, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('startup rebuilds valid catalog count drift from the sequenced session log', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-session-index-drift-'))
  try {
    const repository = new JsonlRepository(root)
    await repository.initialize()
    await repository.create(record('drift'))
    await repository.appendMessage('drift', { role: 'user', content: 'first' })

    const payload = {
      version: 2 as const,
      sequence: 2,
      committedAt: '2026-01-01T00:00:01.000Z',
      message: { role: 'assistant' as const, content: 'recovered' },
    }
    await appendFile(
      join(root, 'history', 'drift.jsonl'),
      `${JSON.stringify({ ...payload, checksum: checksum(payload) })}\n`,
      'utf8',
    )

    const restarted = new JsonlRepository(root)
    await restarted.initialize()
    assert.equal((await restarted.get('drift'))?.messageCount, 2)
    assert.deepEqual(await restarted.loadMessages('drift'), [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'recovered' },
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

function record(sessionId: string): SessionRecord {
  return {
    sessionId,
    state: 'idle',
    cwd: 'D:/workspace',
    provider: 'mock',
    model: 'mock-v1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

function checksum(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`
}
