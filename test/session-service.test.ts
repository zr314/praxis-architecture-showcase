import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import test from 'node:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  ProviderMessage,
  RuntimeError,
  SessionRecord,
  SessionRepository,
} from '@praxis/core-sdk'
import { SessionService } from '../apps/runtime/src/session/index.js'
import { JsonlRepository } from '../apps/runtime/src/session-db/index.js'

type TestRun = { id: string }

test('SessionService owns active run state, message commits, and completed-request idempotency', async () => {
  const repository = new MemorySessionRepository()
  const service = new SessionService<TestRun>(repository)
  await service.initialize()
  const session = await service.createSession({
    sessionId: 's-1',
    cwd: 'D:/workspace',
    provider: 'mock',
    model: 'mock-coder',
    createdAt: '2026-01-01T00:00:00.000Z',
  })

  const started = await service.beginRun(
    session,
    'request-1',
    { id: 'r-1' },
    {
      role: 'user',
      content: 'first turn',
    },
  )
  assert.equal(started.duplicate, false)
  assert.equal(session.state, 'running')
  assert.equal(session.activeRun?.id, 'r-1')
  assert.deepEqual(session.messages, [{ role: 'user', content: 'first turn' }])

  await service.commitMessage(session, { role: 'assistant', content: 'answer' })
  await service.finalizeRun(session, 'r-1', {
    memory: session.memory,
    terminal: 'completed',
  })
  assert.equal(session.state, 'idle')
  assert.equal(session.activeRun, undefined)

  const duplicate = await service.beginRun(
    session,
    'request-1',
    { id: 'r-2' },
    {
      role: 'user',
      content: 'must not be appended',
    },
  )
  assert.equal(duplicate.duplicate, true)
  if (duplicate.duplicate) assert.equal(duplicate.runId, 'r-1')
  assert.equal(repository.messages.get('s-1')?.length, 2)
})

test('SessionService returns bounded transcript pages from an exclusive message cursor', async () => {
  const repository = new MemorySessionRepository()
  const service = new SessionService<TestRun>(repository)
  await service.initialize()
  await service.createSession({
    sessionId: 's-transcript',
    cwd: 'D:/workspace',
    provider: 'mock',
    model: 'mock-coder',
  })
  repository.messages.set(
    's-transcript',
    Array.from({ length: 5 }, (_, index) => ({
      role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: `message-${index}`,
    })),
  )

  assert.deepEqual(await service.transcriptSession('s-transcript', { before: 4, limit: 2 }), {
    sessionId: 's-transcript',
    start: 2,
    end: 4,
    totalMessages: 5,
    hasMore: true,
    messages: [
      { role: 'user', content: 'message-2' },
      { role: 'assistant', content: 'message-3' },
    ],
  })
  assert.deepEqual(await service.transcriptSession('s-transcript', { limit: 2 }), {
    sessionId: 's-transcript',
    start: 3,
    end: 5,
    totalMessages: 5,
    hasMore: true,
    messages: [
      { role: 'assistant', content: 'message-3' },
      { role: 'user', content: 'message-4' },
    ],
  })
})

test('SessionService redacts repository failures and leaves in-memory state unchanged', async () => {
  const repository = new MemorySessionRepository()
  const service = new SessionService<TestRun>(repository)
  const session = await service.createSession({
    sessionId: 's-fail',
    cwd: 'D:/workspace',
    provider: 'mock',
    model: 'mock-coder',
  })
  repository.failAppend = true

  await assert.rejects(
    service.beginRun(
      session,
      'request-fail',
      { id: 'r-fail' },
      { role: 'user', content: 'persist me' },
    ),
    (error) => {
      assertRuntimeError(error, 'PERSISTENCE_OPERATION_FAILED', 'persistence')
      assert.deepEqual(error.data, { operation: 'append_message' })
      assert.doesNotMatch(JSON.stringify(error), /append failed|secret/i)
      return true
    },
  )
  assert.equal(session.state, 'idle')
  assert.equal(session.activeRun, undefined)
  assert.deepEqual(session.messages, [])

  repository.failAppend = false
  const recovered = await service.beginRun(
    session,
    'request-fail',
    { id: 'r-recovered' },
    {
      role: 'user',
      content: 'retry after persistence failure',
    },
  )
  assert.equal(recovered.duplicate, false)
  if (!recovered.duplicate) assert.equal(recovered.run.id, 'r-recovered')
})

test('SessionService serializes concurrent beginRun calls and returns SESSION_BUSY to the loser', async () => {
  const repository = new MemorySessionRepository()
  const service = new SessionService<TestRun>(repository)
  const session = await service.createSession({
    sessionId: 's-concurrent',
    cwd: 'D:/workspace',
    provider: 'mock',
    model: 'mock-coder',
  })
  repository.appendStarted = deferred<void>()
  repository.appendGate = deferred<void>()

  const first = service.beginRun(
    session,
    'request-1',
    { id: 'r-1' },
    {
      role: 'user',
      content: 'first',
    },
  )
  await repository.appendStarted.promise
  const second = service.beginRun(
    session,
    'request-2',
    { id: 'r-2' },
    {
      role: 'user',
      content: 'second',
    },
  )
  repository.appendGate.resolve()

  assert.equal((await first).duplicate, false)
  await assert.rejects(second, (error) => {
    assertRuntimeError(error, 'SESSION_BUSY', 'protocol')
    return true
  })
  assert.equal(session.activeRun?.id, 'r-1')
  assert.deepEqual(repository.messages.get(session.sessionId), [{ role: 'user', content: 'first' }])
})

test('SessionService keeps a run active until final memory and terminal state are durable', async () => {
  const repository = new MemorySessionRepository()
  const service = new SessionService<TestRun>(repository)
  const session = await service.createSession({
    sessionId: 's-finalize',
    cwd: 'D:/workspace',
    provider: 'mock',
    model: 'mock-coder',
  })
  await service.beginRun(session, 'request-1', { id: 'r-1' }, { role: 'user', content: 'first' })
  repository.memoryStarted = deferred<void>()
  repository.memoryGate = deferred<void>()

  const finalization = service.finalizeRun(session, 'r-1', {
    memory: {
      sessionId: session.sessionId,
      plan: {
        objective: 'first',
        steps: [{ id: 'execute', title: 'Execute', state: 'completed' }],
        revision: 2,
        updatedAt: '2026-01-01T00:00:02.000Z',
      },
    },
    terminal: 'completed',
    usage: { inputTokens: 3, outputTokens: 2 },
  })
  await repository.memoryStarted.promise

  let followUpSettled = false
  const followUp = service
    .beginRun(session, 'request-2', { id: 'r-2' }, { role: 'user', content: 'second' })
    .finally(() => {
      followUpSettled = true
    })
  await Promise.resolve()

  assert.equal(followUpSettled, false)
  assert.equal(session.state, 'running')
  assert.equal(session.activeRun?.id, 'r-1')

  repository.memoryGate.resolve()
  await finalization
  const started = await followUp
  assert.equal(started.duplicate, false)
  assert.equal(session.activeRun?.id, 'r-2')
  assert.equal(session.memory.plan?.revision, 2)
  assert.deepEqual(session.usage, { inputTokens: 3, outputTokens: 2 })
})

test('closeSession waits for a pending beginRun and rechecks the active run under the same lock', async () => {
  const repository = new MemorySessionRepository()
  const service = new SessionService<TestRun>(repository)
  const session = await service.createSession({
    sessionId: 's-close-race',
    cwd: 'D:/workspace',
    provider: 'mock',
    model: 'mock-coder',
  })
  repository.appendStarted = deferred<void>()
  repository.appendGate = deferred<void>()

  const begin = service.beginRun(
    session,
    'request-1',
    { id: 'r-1' },
    {
      role: 'user',
      content: 'race with close',
    },
  )
  await repository.appendStarted.promise
  let closeSettled = false
  const close = service.closeSession(session).then(
    () => {
      closeSettled = true
      return { kind: 'success' as const }
    },
    (error) => {
      closeSettled = true
      return { kind: 'failure' as const, error }
    },
  )
  await Promise.resolve()
  assert.equal(closeSettled, false)

  repository.appendGate.resolve()
  assert.equal((await begin).duplicate, false)
  const outcome = await close
  assert.equal(outcome.kind, 'failure')
  if (outcome.kind === 'failure') assertRuntimeError(outcome.error, 'SESSION_BUSY', 'protocol')
  assert.equal(session.state, 'running')
  assert.equal(session.activeRun?.id, 'r-1')
  assert.equal(repository.sessions.get(session.sessionId)?.state, 'idle')
})

test('SessionService only closes an in-memory session after the repository accepts the state change', async () => {
  const repository = new MemorySessionRepository()
  const service = new SessionService<TestRun>(repository)
  const session = await service.createSession({
    sessionId: 's-close',
    cwd: 'D:/workspace',
    provider: 'mock',
    model: 'mock-coder',
  })
  repository.failUpdate = true

  await assert.rejects(service.closeSession(session), (error) => {
    assertRuntimeError(error, 'PERSISTENCE_OPERATION_FAILED', 'persistence')
    assert.deepEqual(error.data, { operation: 'close' })
    return true
  })
  assert.equal(session.state, 'idle')
})

test('SessionService changes model in place, persists it, and preserves conversation history', async () => {
  const repository = new MemorySessionRepository()
  const service = new SessionService<TestRun>(repository)
  const session = await service.createSession({
    sessionId: 's-model',
    cwd: 'D:/workspace',
    provider: 'mock',
    model: 'mock-v1',
  })
  await service.commitMessage(session, { role: 'user', content: 'keep this turn' })

  const configured = await service.configureSession('s-model', 'anthropic', 'claude-sonnet-4-6')

  assert.equal(configured.sessionId, session.sessionId)
  assert.equal(session.provider, 'anthropic')
  assert.equal(session.model, 'claude-sonnet-4-6')
  assert.equal(repository.sessions.get('s-model')?.model, 'claude-sonnet-4-6')
  assert.deepEqual(session.messages, [{ role: 'user', content: 'keep this turn' }])

  const started = await service.beginRun(
    session,
    'request-model-busy',
    { id: 'run-model-busy' },
    { role: 'user', content: 'active' },
  )
  assert.equal(started.duplicate, false)
  await assert.rejects(service.configureSession('s-model', 'mock', 'mock-v1'), (error) => {
    assertRuntimeError(error, 'SESSION_BUSY', 'protocol')
    return true
  })
})

test('SessionService restores persisted history and reopens a closed session', async () => {
  const repository = new MemorySessionRepository()
  repository.sessions.set('s-restore', {
    sessionId: 's-restore',
    state: 'closed',
    cwd: 'D:/workspace',
    provider: 'mock',
    model: 'mock-coder',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  })
  repository.messages.set('s-restore', [
    { role: 'user', content: 'saved prompt' },
    { role: 'assistant', content: 'saved answer' },
  ])
  const service = new SessionService<TestRun>(repository)

  const session = await service.resumeSession('s-restore')
  assert.equal(session.state, 'idle')
  assert.deepEqual(session.messages, repository.messages.get('s-restore'))
  assert.equal(repository.sessions.get('s-restore')?.state, 'idle')
})

test('SessionService reopens a cached closed session before it begins another prompt', async () => {
  const repository = new MemorySessionRepository()
  const service = new SessionService<TestRun>(repository)
  const session = await service.createSession({
    sessionId: 's-cached-close',
    cwd: 'D:/workspace',
    provider: 'mock',
    model: 'mock-coder',
  })

  await service.closeSession(session)
  assert.equal(session.state, 'closed')
  const resumed = await service.resumeSession(session.sessionId)
  assert.equal(resumed, session)
  assert.equal(resumed.state, 'idle')
  assert.equal(repository.sessions.get(session.sessionId)?.state, 'idle')

  const started = await service.beginRun(
    resumed,
    'request-after-resume',
    { id: 'r-resumed' },
    {
      role: 'user',
      content: 'resume and prompt',
    },
  )
  assert.equal(started.duplicate, false)
  assert.equal(resumed.activeRun?.id, 'r-resumed')
})

test('JsonlRepository converts invalid session history to a redacted persistence RuntimeError', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-invalid-session-'))
  try {
    const repository = new JsonlRepository(root)
    await repository.initialize()
    await repository.create({
      sessionId: 'invalid-history',
      state: 'idle',
      cwd: root,
      provider: 'mock',
      model: 'mock-v1',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
    await writeFile(
      join(root, 'history', 'invalid-history.jsonl'),
      '{ this is not valid JSON and has a secret: value\n',
      'utf8',
    )
    await assert.rejects(repository.loadMessages('invalid-history'), (error) => {
      assertRuntimeError(error, 'PERSISTENCE_INVALID_DATA', 'persistence')
      assert.deepEqual(error.data, { operation: 'load_messages' })
      assert.doesNotMatch(JSON.stringify(error), /secret|valid JSON/i)
      return true
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

class MemorySessionRepository implements SessionRepository {
  readonly sessions = new Map<string, SessionRecord>()
  readonly messages = new Map<string, ProviderMessage[]>()
  failAppend = false
  failUpdate = false
  appendStarted?: Deferred<void>
  appendGate?: Deferred<void>
  memoryStarted?: Deferred<void>
  memoryGate?: Deferred<void>
  memory = new Map<string, Awaited<ReturnType<SessionRepository['loadMemory']>>>()

  async initialize(): Promise<void> {}

  async list(): Promise<SessionRecord[]> {
    return [...this.sessions.values()].map(cloneRecord)
  }

  async get(sessionId: string): Promise<SessionRecord | undefined> {
    const session = this.sessions.get(sessionId)
    return session ? cloneRecord(session) : undefined
  }

  async create(session: SessionRecord): Promise<void> {
    this.sessions.set(session.sessionId, cloneRecord(session))
  }

  async update(session: SessionRecord): Promise<void> {
    if (this.failUpdate) throw new Error('update failed')
    this.sessions.set(session.sessionId, cloneRecord(session))
  }

  async appendMessage(sessionId: string, message: ProviderMessage): Promise<void> {
    this.appendStarted?.resolve()
    if (this.appendGate) await this.appendGate.promise
    if (this.failAppend) throw new Error('append failed with secret payload')
    const messages = this.messages.get(sessionId) ?? []
    messages.push(message)
    this.messages.set(sessionId, messages)
  }

  async loadMessages(sessionId: string): Promise<ProviderMessage[]> {
    return [...(this.messages.get(sessionId) ?? [])]
  }

  async loadMemory(sessionId: string) {
    return this.memory.get(sessionId) ?? { sessionId }
  }

  async saveMemory(memory: Awaited<ReturnType<SessionRepository['loadMemory']>>): Promise<void> {
    this.memoryStarted?.resolve()
    if (this.memoryGate) await this.memoryGate.promise
    this.memory.set(memory.sessionId, structuredClone(memory))
  }
}

function cloneRecord(session: SessionRecord): SessionRecord {
  return { ...session }
}

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function assertRuntimeError(
  error: unknown,
  code: string,
  category: RuntimeError['category'],
): asserts error is RuntimeError {
  assert.ok(error && typeof error === 'object')
  const runtime = error as RuntimeError
  assert.equal(runtime.code, code)
  assert.equal(runtime.category, category)
}
