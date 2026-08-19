import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  ProviderMessage,
  SessionMemory,
  SessionRecord,
  SessionRepository,
} from '@praxis/core-sdk'
import { SessionService } from '../../apps/runtime/src/session/sessionService.js'
import type { SessionManagementRepository } from '../../apps/runtime/src/session-db/sessionV2.js'

type TestRun = { id: string }

export type ConformanceRepository = SessionRepository & SessionManagementRepository

export type SessionBackendConformanceHarness = Readonly<{
  repository: ConformanceRepository
  openPeer(): Promise<ConformanceRepository>
  injectTruncatedTail(sessionId: string): Promise<void>
  injectInvalidCompleteEntry(sessionId: string): Promise<void>
  corruptCatalog(): Promise<void>
  replaceCatalogWithUnsupportedVersion(): Promise<void>
  cleanup(): Promise<void>
}>

export type SessionBackendConformanceFactory = () => Promise<SessionBackendConformanceHarness>

/** Registers domain-level fixtures shared by every durable Session backend. */
export function registerSessionBackendConformance(
  backendName: string,
  createHarness: SessionBackendConformanceFactory,
): void {
  test(`${backendName} conforms for lifecycle, ordering, cursors, and stable errors`, async () => {
    const harness = await createHarness()
    try {
      const service = new SessionService<TestRun>(harness.repository)
      await service.initialize()
      const empty = await service.createSession(sessionInput('empty', '2026-01-01T00:00:00.000Z'))
      const primary = await service.createSession(
        sessionInput('primary', '2026-01-01T00:00:01.000Z'),
      )

      assert.deepEqual(
        (await service.listSessions()).map((session) => session.sessionId),
        ['empty', 'primary'],
      )
      assert.deepEqual(await service.transcriptSession('empty', { limit: 10 }), {
        sessionId: 'empty',
        start: 0,
        end: 0,
        totalMessages: 0,
        hasMore: false,
        messages: [],
      })

      const started = await service.beginRun(
        primary,
        'request-primary',
        { id: 'run-primary' },
        { role: 'user', content: 'question' },
      )
      assert.equal(started.duplicate, false)
      await service.commitMessage(primary, { role: 'assistant', content: 'answer' })
      await service.commitMessage(primary, { role: 'user', content: 'follow-up' })
      await service.finalizeRun(primary, 'run-primary', {
        memory: memory('primary', 1),
        terminal: 'completed',
        usage: { inputTokens: 3, outputTokens: 2 },
      })

      const duplicate = await service.beginRun(
        primary,
        'request-primary',
        { id: 'run-duplicate' },
        { role: 'user', content: 'must not append' },
      )
      assert.equal(duplicate.duplicate, true)
      if (duplicate.duplicate) assert.equal(duplicate.runId, 'run-primary')
      assert.deepEqual(
        (await service.transcriptSession('primary', { before: 3, limit: 2 })).messages,
        [
          { role: 'assistant', content: 'answer' },
          { role: 'user', content: 'follow-up' },
        ],
      )
      assert.deepEqual(await service.transcriptSession('primary', { before: 1, limit: 5 }), {
        sessionId: 'primary',
        start: 0,
        end: 1,
        totalMessages: 3,
        hasMore: false,
        messages: [{ role: 'user', content: 'question' }],
      })

      await service.closeSession(primary)
      assert.equal((await service.inspectSession('primary')).state, 'closed')
      assert.equal((await service.resumeSession('primary')).state, 'idle')
      assert.equal(
        (await service.renameSession('primary', 'Primary branch')).name,
        'Primary branch',
      )
      assert.equal((await service.searchSessions('primary'))[0]?.sessionId, 'primary')
      assert.deepEqual((await service.exportSession('primary')).messages, [
        { role: 'user', content: 'question' },
        { role: 'assistant', content: 'answer' },
        { role: 'user', content: 'follow-up' },
      ])

      const child = await service.forkSession(
        'primary',
        sessionInput('child', '2026-01-01T00:00:02.000Z'),
        2,
      )
      assert.equal(child.parentSessionId, 'primary')
      assert.deepEqual(child.messages, [
        { role: 'user', content: 'question' },
        { role: 'assistant', content: 'answer' },
      ])
      assert.equal((await service.inspectSession('primary')).activeLeafId, 'child')
      await service.deleteSession('child')
      assert.equal((await service.inspectSession('primary')).activeLeafId, 'primary')
      await service.deleteSession(empty.sessionId)
      assert.deepEqual(
        (await service.listSessions()).map((session) => session.sessionId),
        ['primary'],
      )

      await assert.rejects(service.inspectSession('missing'), hasCode('SESSION_NOT_FOUND'))
      await assert.rejects(service.renameSession('primary', '   '), hasCode('SESSION_NAME_INVALID'))
      await assert.rejects(
        service.createSession(sessionInput('primary', '2026-01-01T00:00:03.000Z')),
        hasCode('SESSION_ALREADY_EXISTS'),
      )
      await assert.rejects(service.deleteSession('missing'), hasCode('SESSION_NOT_FOUND'))
    } finally {
      await harness.cleanup()
    }
  })

  test(`${backendName} serializes concurrent append and preserves durable idempotency`, async () => {
    const harness = await createHarness()
    try {
      await harness.repository.initialize()
      await harness.repository.create(record('concurrent'))
      const peer = await harness.openPeer()
      const outcomes = await Promise.all([
        harness.repository.appendRequestMessage!('concurrent', 'same-request', 'run-a', {
          role: 'user',
          content: 'from-a',
        }),
        peer.appendRequestMessage!('concurrent', 'same-request', 'run-b', {
          role: 'user',
          content: 'from-b',
        }),
      ])

      assert.equal(outcomes.filter((outcome) => outcome.duplicateRunId === undefined).length, 1)
      assert.equal(outcomes.filter((outcome) => outcome.duplicateRunId !== undefined).length, 1)
      const requests = await harness.repository.loadClientRequests!('concurrent')
      assert.ok(requests['same-request'] === 'run-a' || requests['same-request'] === 'run-b')
      assert.equal((await harness.repository.loadMessages('concurrent')).length, 1)

      await Promise.all([
        harness.repository.appendMessage('concurrent', { role: 'assistant', content: 'first' }),
        peer.appendMessage('concurrent', { role: 'assistant', content: 'second' }),
      ])
      const restarted = await harness.openPeer()
      const messages = await restarted.loadMessages('concurrent')
      assert.equal(messages.length, 3)
      assert.deepEqual(
        new Set(messages.slice(1).map((message) => messageContent(message))),
        new Set(['first', 'second']),
      )
      assert.deepEqual(await restarted.loadClientRequests!('concurrent'), requests)
    } finally {
      await harness.cleanup()
    }
  })

  test(`${backendName} recovers tail, catalog, and unsupported catalog versions by domain result`, async () => {
    const harness = await createHarness()
    try {
      await harness.repository.initialize()
      await harness.repository.create(record('recover'))
      await harness.repository.appendMessage('recover', { role: 'user', content: 'first' })

      await harness.injectTruncatedTail('recover')
      assert.deepEqual(await harness.repository.loadMessages('recover'), [
        { role: 'user', content: 'first' },
      ])
      await harness.repository.appendMessage('recover', {
        role: 'assistant',
        content: 'after-tail-repair',
      })
      await harness.corruptCatalog()
      const catalogRecovered = await harness.openPeer()
      assert.deepEqual(
        (await catalogRecovered.list()).map((session) => session.sessionId),
        ['recover'],
      )
      assert.deepEqual(await catalogRecovered.loadMessages('recover'), [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'after-tail-repair' },
      ])

      await harness.replaceCatalogWithUnsupportedVersion()
      const versionRecovered = await harness.openPeer()
      assert.equal((await versionRecovered.get('recover'))?.messageCount, 2)
      await harness.injectInvalidCompleteEntry('recover')
      await assert.rejects(
        versionRecovered.loadMessages('recover'),
        hasCode('PERSISTENCE_INVALID_DATA'),
      )
    } finally {
      await harness.cleanup()
    }
  })

  test(`${backendName} exposes the current finalize memory-before-terminal crash window`, async () => {
    const harness = await createHarness()
    try {
      await harness.repository.initialize()
      const faulted = new TerminalFailingRepository(harness.repository)
      const service = new SessionService<TestRun>(faulted)
      const session = await service.createSession(sessionInput('crash-window'))
      await service.beginRun(
        session,
        'request-crash',
        { id: 'run-crash' },
        { role: 'user', content: 'persisted before crash' },
      )

      await assert.rejects(
        service.finalizeRun(session, 'run-crash', {
          memory: memory('crash-window', 7),
          terminal: 'completed',
          usage: { inputTokens: 5, outputTokens: 3 },
        }),
        hasCode('PERSISTENCE_OPERATION_FAILED'),
      )
      assert.equal(session.activeRun?.id, 'run-crash')
      assert.equal(session.state, 'running')

      const restarted = await harness.openPeer()
      assert.equal((await restarted.loadMemory('crash-window')).plan?.revision, 7)
      const recordAfterCrash = await restarted.get('crash-window')
      assert.equal(recordAfterCrash?.lastTerminalState, undefined)
      assert.deepEqual(recordAfterCrash?.usage, {})
      assert.equal(recordAfterCrash?.messageCount, 1)
      assert.deepEqual(await restarted.loadClientRequests!('crash-window'), {
        'request-crash': 'run-crash',
      })
    } finally {
      await harness.cleanup()
    }
  })
}

class TerminalFailingRepository implements SessionRepository {
  constructor(private readonly delegate: SessionRepository) {}

  initialize(): Promise<void> {
    return this.delegate.initialize()
  }

  list(): Promise<SessionRecord[]> {
    return this.delegate.list()
  }

  get(sessionId: string): Promise<SessionRecord | undefined> {
    return this.delegate.get(sessionId)
  }

  create(session: SessionRecord): Promise<void> {
    return this.delegate.create(session)
  }

  update(session: SessionRecord): Promise<void> {
    return this.delegate.update(session)
  }

  appendMessage(sessionId: string, message: ProviderMessage): Promise<void> {
    return this.delegate.appendMessage(sessionId, message)
  }

  loadMessages(sessionId: string): Promise<ProviderMessage[]> {
    return this.delegate.loadMessages(sessionId)
  }

  loadMemory(sessionId: string): Promise<SessionMemory> {
    return this.delegate.loadMemory(sessionId)
  }

  saveMemory(memoryValue: SessionMemory): Promise<void> {
    return this.delegate.saveMemory(memoryValue)
  }

  appendRequestMessage(
    sessionId: string,
    clientRequestId: string,
    runId: string,
    message: ProviderMessage,
  ): Promise<{ duplicateRunId?: string }> {
    return this.delegate.appendRequestMessage!(sessionId, clientRequestId, runId, message)
  }

  loadClientRequests(sessionId: string): Promise<Record<string, string>> {
    return this.delegate.loadClientRequests!(sessionId)
  }

  async updateTerminal(): Promise<SessionRecord> {
    throw new Error('Injected crash after memory persistence and before terminal persistence.')
  }
}

function sessionInput(sessionId: string, createdAt?: string) {
  return {
    sessionId,
    cwd: 'D:/workspace',
    provider: 'mock',
    model: 'mock-v1',
    ...(createdAt === undefined ? {} : { createdAt }),
  }
}

function record(sessionId: string): SessionRecord {
  return {
    recordVersion: 2,
    sessionId,
    state: 'idle',
    cwd: 'D:/workspace',
    provider: 'mock',
    model: 'mock-v1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    name: sessionId,
    activeLeafId: sessionId,
    labels: [],
    messageCount: 0,
    usage: {},
  }
}

function memory(sessionId: string, revision: number): SessionMemory {
  return {
    sessionId,
    plan: {
      objective: 'Conformance fixture',
      steps: [{ id: 'execute', title: 'Execute', state: 'completed' }],
      revision,
      updatedAt: '2026-01-01T00:00:10.000Z',
    },
  }
}

function messageContent(message: ProviderMessage): string {
  return typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
}

function hasCode(code: string) {
  return (error: unknown) =>
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code
}
