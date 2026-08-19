import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  AgentRun,
  ProviderMessage,
  SessionMemory,
  SessionRecord,
  SessionRepository,
} from '@praxis/core-sdk'
import { RunCoordinator, SessionService } from '../apps/runtime/src/session/index.js'

test('RunCoordinator maps final persistence failure to one closed-session terminal failure', async () => {
  const repository = new CoordinatorRepository()
  const sessions = new SessionService<AgentRun>(repository)
  const session = await sessions.createSession({
    sessionId: 's-finalization-failure',
    cwd: 'D:/workspace',
    provider: 'mock',
    model: 'mock-v1',
  })
  const run = createRun(session.sessionId)
  await sessions.beginRun(session, 'request-1', run, { role: 'user', content: 'persist this run' })
  await sessions.saveMemory(session, {
    sessionId: session.sessionId,
    plan: {
      objective: 'persist this run',
      steps: [{ id: 'execute', title: 'Execute', state: 'in_progress' }],
      revision: 1,
      updatedAt: '2026-01-01T00:00:01.000Z',
    },
  })
  repository.failMemory = true

  const terminal = await new RunCoordinator(sessions).finalize(session, run, {
    type: 'prompt_completed',
    runId: run.id,
    stopReason: 'end_turn',
    usage: { inputTokens: 2, outputTokens: 1 },
  })

  assert.deepEqual(terminal, {
    type: 'prompt_failed',
    runId: run.id,
    code: 'PERSISTENCE_OPERATION_FAILED',
    category: 'persistence',
    error: 'Session finalization failed; resume the session before continuing.',
  })
  assert.equal(session.state, 'closed')
  assert.equal(session.activeRun, undefined)
  assert.equal(session.memory.plan?.steps[0]?.state, 'in_progress')
})

test('RunCoordinator reloads durable memory after terminal metadata persistence fails', async () => {
  const repository = new CoordinatorRepository()
  const sessions = new SessionService<AgentRun>(repository)
  const session = await sessions.createSession({
    sessionId: 's-partial-finalization',
    cwd: 'D:/workspace',
    provider: 'mock',
    model: 'mock-v1',
  })
  const run = createRun(session.sessionId)
  await sessions.beginRun(session, 'request-1', run, { role: 'user', content: 'persist this run' })
  await sessions.saveMemory(session, {
    sessionId: session.sessionId,
    plan: {
      objective: 'persist this run',
      steps: [{ id: 'execute', title: 'Execute', state: 'in_progress' }],
      revision: 1,
      updatedAt: '2026-01-01T00:00:01.000Z',
    },
  })
  repository.failTerminal = true

  const terminal = await new RunCoordinator(sessions).finalize(session, run, {
    type: 'prompt_completed',
    runId: run.id,
    stopReason: 'end_turn',
  })

  assert.equal(terminal.type, 'prompt_failed')
  assert.equal(repository.memories.get(session.sessionId)?.plan?.revision, 2)
  repository.failTerminal = false
  const resumed = await sessions.resumeSession(session.sessionId)
  assert.notEqual(resumed, session)
  assert.equal(resumed.state, 'idle')
  assert.equal(resumed.memory.plan?.revision, 2)
  assert.equal(resumed.memory.plan?.steps[0]?.state, 'completed')
})

class CoordinatorRepository implements SessionRepository {
  readonly sessions = new Map<string, SessionRecord>()
  readonly messages = new Map<string, ProviderMessage[]>()
  readonly memories = new Map<string, SessionMemory>()
  failMemory = false
  failTerminal = false
  terminalErrorCode?: string

  async initialize(): Promise<void> {}

  async list(): Promise<SessionRecord[]> {
    return [...this.sessions.values()]
  }

  async get(sessionId: string): Promise<SessionRecord | undefined> {
    return this.sessions.get(sessionId)
  }

  async create(session: SessionRecord): Promise<void> {
    this.sessions.set(session.sessionId, structuredClone(session))
  }

  async update(session: SessionRecord): Promise<void> {
    this.sessions.set(session.sessionId, structuredClone(session))
  }

  async appendMessage(sessionId: string, message: ProviderMessage): Promise<void> {
    this.messages.set(sessionId, [
      ...(this.messages.get(sessionId) ?? []),
      structuredClone(message),
    ])
  }

  async loadMessages(sessionId: string): Promise<ProviderMessage[]> {
    return structuredClone(this.messages.get(sessionId) ?? [])
  }

  async loadMemory(sessionId: string): Promise<SessionMemory> {
    return structuredClone(this.memories.get(sessionId) ?? { sessionId })
  }

  async saveMemory(memory: SessionMemory): Promise<void> {
    if (this.failMemory) throw new Error('private persistence failure')
    this.memories.set(memory.sessionId, structuredClone(memory))
  }

  async updateTerminal(
    sessionId: string,
    terminal: NonNullable<SessionRecord['lastTerminalState']>,
    usage: NonNullable<SessionRecord['usage']>,
    messageCount: number,
    errorCode?: string,
  ): Promise<SessionRecord> {
    if (this.failTerminal) throw new Error('private terminal failure')
    this.terminalErrorCode = errorCode
    const current = this.sessions.get(sessionId)!
    const updated = {
      ...current,
      state: 'idle' as const,
      lastTerminalState: terminal,
      usage: structuredClone(usage),
      messageCount,
    }
    this.sessions.set(sessionId, updated)
    return structuredClone(updated)
  }
}

test('RunCoordinator preserves a real failure code in terminal persistence', async () => {
  const repository = new CoordinatorRepository()
  const sessions = new SessionService<AgentRun>(repository)
  const session = await sessions.createSession({
    sessionId: 's-coded-failure',
    cwd: 'D:/workspace',
    provider: 'mock',
    model: 'mock-v1',
  })
  const run = createRun(session.sessionId)
  await sessions.beginRun(session, 'request-coded', run, { role: 'user', content: 'fail safely' })

  await new RunCoordinator(sessions).finalize(session, run, {
    type: 'prompt_failed',
    runId: run.id,
    code: 'PROVIDER_OUTPUT_TRUNCATED',
    category: 'provider',
    error: 'Bounded failure.',
  })

  assert.equal(repository.terminalErrorCode, 'PROVIDER_OUTPUT_TRUNCATED')
})

function createRun(sessionId: string): AgentRun {
  return {
    id: 'r-finalization-failure',
    sessionId,
    trace: { traceId: 'trace-1', runtimeId: 'rt-1', sessionId, runId: 'r-finalization-failure' },
    promptKind: 'prompt',
    text: 'persist this run',
    aborted: false,
    terminal: false,
    controller: new AbortController(),
    steerQueue: [],
    usage: {
      turns: 1,
      toolCalls: 0,
      subagents: 0,
      inputTokens: 2,
      outputTokens: 1,
    },
  }
}
