import {
  runtimeError,
  type ProviderMessage,
  type RuntimeError,
  type SessionMemory,
  type SessionRecord,
  type SessionRepository,
} from '@praxis/core-sdk'
import type {
  SessionExport,
  SessionIndexEntry,
  SessionManagementRepository,
  SessionRetentionPolicy,
} from '../session-db/sessionV2.js'

export type IdentifiedRun = { id: string }

export type ManagedSession<TRun extends IdentifiedRun> = SessionRecord & {
  clientRequests: Map<string, string>
  messages: ProviderMessage[]
  memory: SessionMemory
  activeRun?: TRun
}

export type CreateSessionInput = Pick<SessionRecord, 'sessionId' | 'cwd' | 'provider' | 'model'> & {
  createdAt?: string
  name?: string
  parentSessionId?: string
  labels?: string[]
  contextLimitTokens?: number
  plannerMode?: NonNullable<SessionRecord['plannerMode']>
}

export type BeginRunResult<TRun extends IdentifiedRun> =
  | { accepted: true; duplicate: false; session: ManagedSession<TRun>; run: TRun }
  | { accepted: true; duplicate: true; session: ManagedSession<TRun>; runId: string }

export type SessionTranscriptPage = {
  sessionId: string
  start: number
  end: number
  totalMessages: number
  hasMore: boolean
  messages: ProviderMessage[]
}

/** Owns loaded session state; persistence mechanics stay behind SessionRepository. */
export class SessionService<TRun extends IdentifiedRun> {
  private readonly sessions = new Map<string, ManagedSession<TRun>>()
  private readonly sessionLocks = new Map<string, Promise<void>>()
  private readonly runtimeOnlyMessageProjections = new Map<
    string,
    Map<string, Array<{ index: number; durableMessage: ProviderMessage }>>
  >()

  constructor(private readonly repository: SessionRepository) {}

  async initialize(): Promise<void> {
    await this.repositoryCall('initialize', () => this.repository.initialize())
  }

  async createSession(input: CreateSessionInput): Promise<ManagedSession<TRun>> {
    const now = input.createdAt ?? new Date().toISOString()
    const session: ManagedSession<TRun> = {
      sessionId: input.sessionId,
      state: 'idle',
      cwd: input.cwd,
      provider: input.provider,
      model: input.model,
      plannerMode: input.plannerMode ?? 'auto',
      ...(input.contextLimitTokens === undefined
        ? {}
        : { contextLimitTokens: input.contextLimitTokens }),
      createdAt: now,
      updatedAt: now,
      recordVersion: 2,
      name: input.name ?? input.sessionId,
      activeLeafId: input.sessionId,
      ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
      labels: [...(input.labels ?? [])],
      messageCount: 0,
      usage: {},
      clientRequests: new Map(),
      messages: [],
      memory: { sessionId: input.sessionId },
    }
    await this.repositoryCall('create', () => this.repository.create(toRecord(session)))
    this.sessions.set(session.sessionId, session)
    return session
  }

  async listSessions(): Promise<SessionRecord[]> {
    return this.repositoryCall('list', () => this.repository.list())
  }

  async inspectSession(sessionId: string): Promise<SessionRecord> {
    const stored = await this.repositoryCall('get', () => this.repository.get(sessionId))
    if (!stored) throw sessionError('SESSION_NOT_FOUND', 'Session not found.', { sessionId })
    return stored
  }

  async resumeSession(sessionId: string): Promise<ManagedSession<TRun>> {
    return this.withSessionLock(sessionId, async () => {
      const loaded = this.sessions.get(sessionId)
      if (loaded) {
        await this.reopenClosedSession(loaded)
        return loaded
      }

      const stored = await this.repositoryCall('get', () => this.repository.get(sessionId))
      if (!stored) throw sessionError('SESSION_NOT_FOUND', 'Session not found.', { sessionId })

      const restored: ManagedSession<TRun> = {
        ...stored,
        clientRequests: new Map(
          Object.entries(
            this.repository.loadClientRequests
              ? await this.repositoryCall('load_client_requests', () =>
                  this.repository.loadClientRequests!(stored.sessionId),
                )
              : {},
          ),
        ),
        messages: await this.repositoryCall('load_messages', () =>
          this.repository.loadMessages(stored.sessionId),
        ),
        memory: await this.repositoryCall('load_memory', () =>
          this.repository.loadMemory(stored.sessionId),
        ),
      }
      await this.reopenClosedSession(restored)
      this.sessions.set(restored.sessionId, restored)
      return restored
    })
  }

  requireSession(sessionId: string): ManagedSession<TRun> {
    const session = this.sessions.get(sessionId)
    if (!session) throw sessionError('SESSION_NOT_FOUND', 'Session not found.', { sessionId })
    return session
  }

  activeSessions(): Iterable<ManagedSession<TRun>> {
    return this.sessions.values()
  }

  async closeSession(session: ManagedSession<TRun>): Promise<void> {
    await this.withSessionLock(session.sessionId, async () => {
      if (session.activeRun) {
        throw sessionError('SESSION_BUSY', 'Cannot close a session with an active run.', {
          runId: session.activeRun.id,
        })
      }
      const record = toRecord(session, 'closed')
      await this.repositoryCall('close', () => this.repository.update(record))
      session.state = 'closed'
      session.updatedAt = record.updatedAt
    })
  }

  async beginRun(
    session: ManagedSession<TRun>,
    clientRequestId: string,
    run: TRun,
    message: ProviderMessage,
    options: { durableMessage?: ProviderMessage } = {},
  ): Promise<BeginRunResult<TRun>> {
    return this.withSessionLock(session.sessionId, async () => {
      if (session.state === 'closed') {
        throw sessionError('SESSION_NOT_FOUND', 'Session is closed.', {
          sessionId: session.sessionId,
        })
      }
      if (session.activeRun) {
        throw sessionError('SESSION_BUSY', 'Session already has an active run.', {
          runId: session.activeRun.id,
        })
      }
      const existing = session.clientRequests.get(clientRequestId)
      if (existing) return { accepted: true, duplicate: true, session, runId: existing }
      const durableMessage = options.durableMessage ?? message

      if (this.repository.appendRequestMessage) {
        const persisted = await this.repositoryCall('append_request_message', () =>
          this.repository.appendRequestMessage!(
            session.sessionId,
            clientRequestId,
            run.id,
            durableMessage,
          ),
        )
        if (persisted.duplicateRunId) {
          session.clientRequests.set(clientRequestId, persisted.duplicateRunId)
          return {
            accepted: true,
            duplicate: true,
            session,
            runId: persisted.duplicateRunId,
          }
        }
      } else {
        await this.repositoryCall('append_message', () =>
          this.repository.appendMessage(session.sessionId, durableMessage),
        )
      }
      const messageIndex = session.messages.length
      session.messages.push(message)
      if (options.durableMessage !== undefined) {
        this.recordRuntimeOnlyProjection(session.sessionId, run.id, messageIndex, durableMessage)
      }
      session.messageCount = (session.messageCount ?? 0) + 1
      session.activeRun = run
      session.state = 'running'
      session.clientRequests.set(clientRequestId, run.id)
      return { accepted: true, duplicate: false, session, run }
    })
  }

  async commitMessage(
    session: ManagedSession<TRun>,
    message: ProviderMessage,
    options: { durableMessage?: ProviderMessage } = {},
  ): Promise<void> {
    await this.withSessionLock(session.sessionId, async () => {
      await this.repositoryCall('append_message', () =>
        this.repository.appendMessage(session.sessionId, options.durableMessage ?? message),
      )
      const messageIndex = session.messages.length
      session.messages.push(message)
      if (options.durableMessage !== undefined && session.activeRun !== undefined) {
        this.recordRuntimeOnlyProjection(
          session.sessionId,
          session.activeRun.id,
          messageIndex,
          options.durableMessage,
        )
      }
      session.messageCount = (session.messageCount ?? 0) + 1
    })
  }

  async saveMemory(session: ManagedSession<TRun>, memory: SessionMemory): Promise<void> {
    await this.withSessionLock(session.sessionId, async () => {
      this.assertMemoryOwner(session, memory)
      await this.repositoryCall('save_memory', () => this.repository.saveMemory(memory))
      session.memory = cloneMemory(memory)
    })
  }

  async finalizeRun(
    session: ManagedSession<TRun>,
    runId: string,
    input: {
      memory: SessionMemory
      terminal: 'completed' | 'failed' | 'aborted'
      usage?: SessionRecord['usage']
      errorCode?: string
    },
  ): Promise<void> {
    await this.withSessionLock(session.sessionId, async () => {
      if (session.activeRun?.id !== runId) {
        throw sessionError('RUN_NOT_ACTIVE', 'Run is no longer active.', {
          sessionId: session.sessionId,
          runId,
        })
      }
      this.assertMemoryOwner(session, input.memory)
      const usage = mergeUsage(session.usage, input.usage)
      await this.repositoryCall('save_memory', () => this.repository.saveMemory(input.memory))
      const record = this.repository.updateTerminal
        ? await this.repositoryCall('record_terminal', () =>
            this.repository.updateTerminal!(
              session.sessionId,
              input.terminal,
              usage,
              session.messageCount ?? session.messages.length,
              input.errorCode,
            ),
          )
        : {
            ...toRecord(session, 'idle'),
            usage,
            lastTerminalState: input.terminal,
          }
      if (!this.repository.updateTerminal) {
        await this.repositoryCall('record_terminal', () => this.repository.update(record))
      }
      session.memory = cloneMemory(input.memory)
      session.lastTerminalState = input.terminal
      session.usage = usage
      session.name = record.name
      session.activeLeafId = record.activeLeafId
      session.updatedAt = record.updatedAt
      this.applyRuntimeOnlyProjections(session, runId)
      session.activeRun = undefined
      session.state = 'idle'
    })
  }

  failFinalization(session: ManagedSession<TRun>, runId: string): void {
    if (session.activeRun?.id !== runId) return
    this.discardRuntimeOnlyProjections(session.sessionId, runId)
    session.activeRun = undefined
    session.state = 'closed'
    this.sessions.delete(session.sessionId)
  }

  private recordRuntimeOnlyProjection(
    sessionId: string,
    runId: string,
    index: number,
    durableMessage: ProviderMessage,
  ): void {
    const byRun = this.runtimeOnlyMessageProjections.get(sessionId) ?? new Map()
    const projections = byRun.get(runId) ?? []
    projections.push({ index, durableMessage: structuredClone(durableMessage) })
    byRun.set(runId, projections)
    this.runtimeOnlyMessageProjections.set(sessionId, byRun)
  }

  private applyRuntimeOnlyProjections(session: ManagedSession<TRun>, runId: string): void {
    const projections = this.runtimeOnlyMessageProjections.get(session.sessionId)?.get(runId) ?? []
    for (const projection of projections) {
      session.messages[projection.index] = structuredClone(projection.durableMessage)
    }
    this.discardRuntimeOnlyProjections(session.sessionId, runId)
  }

  private discardRuntimeOnlyProjections(sessionId: string, runId: string): void {
    const byRun = this.runtimeOnlyMessageProjections.get(sessionId)
    if (byRun === undefined) return
    byRun.delete(runId)
    if (byRun.size === 0) this.runtimeOnlyMessageProjections.delete(sessionId)
  }

  async renameSession(sessionId: string, name: string): Promise<SessionRecord> {
    const repository = this.managementRepository()
    const record = await this.repositoryCall('rename', () => repository.rename(sessionId, name))
    const loaded = this.sessions.get(sessionId)
    if (loaded) {
      loaded.name = record.name
      loaded.updatedAt = record.updatedAt
    }
    return record
  }

  async configureSession(
    sessionId: string,
    provider: string,
    model: string,
  ): Promise<SessionRecord> {
    const session = await this.resumeSession(sessionId)
    return this.withSessionLock(sessionId, async () => {
      if (session.activeRun) {
        throw sessionError('SESSION_BUSY', 'Cannot change model during an active run.', {
          sessionId,
          runId: session.activeRun.id,
        })
      }
      const record = { ...toRecord(session), provider, model }
      await this.repositoryCall('configure', () => this.repository.update(record))
      session.provider = provider
      session.model = model
      session.updatedAt = record.updatedAt
      return record
    })
  }

  async configurePlanner(
    sessionId: string,
    plannerMode: NonNullable<SessionRecord['plannerMode']>,
  ): Promise<SessionRecord> {
    const session = await this.resumeSession(sessionId)
    return this.withSessionLock(sessionId, async () => {
      if (session.activeRun) {
        throw sessionError('SESSION_BUSY', 'Cannot change planner during an active run.', {
          sessionId,
          runId: session.activeRun.id,
        })
      }
      const record = { ...toRecord(session), plannerMode }
      await this.repositoryCall('configure_planner', () => this.repository.update(record))
      session.plannerMode = plannerMode
      session.updatedAt = record.updatedAt
      return record
    })
  }

  async searchSessions(query: string): Promise<SessionIndexEntry[]> {
    return this.repositoryCall('search', () => this.managementRepository().search(query))
  }

  async exportSession(sessionId: string): Promise<SessionExport> {
    return this.repositoryCall('export', () => this.managementRepository().exportSession(sessionId))
  }

  async transcriptSession(
    sessionId: string,
    options: { before?: number; limit: number },
  ): Promise<SessionTranscriptPage> {
    const record = await this.repositoryCall('get', () => this.repository.get(sessionId))
    if (!record) throw sessionError('SESSION_NOT_FOUND', 'Session not found.', { sessionId })
    const messages = await this.repositoryCall('load_messages', () =>
      this.repository.loadMessages(sessionId),
    )
    const totalMessages = messages.length
    const end = Math.min(totalMessages, options.before ?? totalMessages)
    const start = Math.max(0, end - options.limit)
    return {
      sessionId,
      start,
      end,
      totalMessages,
      hasMore: start > 0,
      messages: structuredClone(messages.slice(start, end)),
    }
  }

  async deleteSession(sessionId: string): Promise<{ trashPath: string }> {
    const loaded = this.sessions.get(sessionId)
    if (loaded?.activeRun) {
      throw sessionError('SESSION_BUSY', 'Cannot delete a session with an active run.', {
        sessionId,
      })
    }
    const result = await this.repositoryCall('delete_to_trash', () =>
      this.managementRepository().deleteToTrash(sessionId),
    )
    this.sessions.delete(sessionId)
    return result
  }

  async applyRetention(policy: SessionRetentionPolicy): Promise<string[]> {
    const deleted = await this.repositoryCall('retention', () =>
      this.managementRepository().applyRetention(policy),
    )
    for (const sessionId of deleted) this.sessions.delete(sessionId)
    return deleted
  }

  async forkSession(
    sourceSessionId: string,
    input: CreateSessionInput,
    throughMessage?: number,
  ): Promise<ManagedSession<TRun>> {
    const source = await this.resumeSession(sourceSessionId)
    const now = input.createdAt ?? new Date().toISOString()
    const target: SessionRecord = {
      recordVersion: 2,
      sessionId: input.sessionId,
      state: 'idle',
      cwd: input.cwd,
      provider: input.provider,
      model: input.model,
      plannerMode: input.plannerMode ?? source.plannerMode ?? 'auto',
      ...(input.contextLimitTokens === undefined
        ? {}
        : { contextLimitTokens: input.contextLimitTokens }),
      createdAt: now,
      updatedAt: now,
      name: input.name ?? input.sessionId,
      parentSessionId: sourceSessionId,
      activeLeafId: input.sessionId,
      labels: [...(input.labels ?? [])],
      messageCount: Math.min(throughMessage ?? source.messages.length, source.messages.length),
      usage: {},
    }
    await this.repositoryCall('fork', () =>
      this.managementRepository().forkSession(sourceSessionId, target, throughMessage),
    )
    return this.resumeSession(input.sessionId)
  }

  async navigateBranch(sessionId: string): Promise<ManagedSession<TRun>> {
    const record = await this.repositoryCall('get', () => this.repository.get(sessionId))
    if (!record) throw sessionError('SESSION_NOT_FOUND', 'Session not found.', { sessionId })
    return this.resumeSession(record.activeLeafId ?? sessionId)
  }

  private async reopenClosedSession(session: ManagedSession<TRun>): Promise<void> {
    if (session.state !== 'closed') return
    const record = toRecord(session, 'idle')
    await this.repositoryCall('resume_closed', () => this.repository.update(record))
    session.state = 'idle'
    session.updatedAt = record.updatedAt
  }

  private assertMemoryOwner(session: ManagedSession<TRun>, memory: SessionMemory): void {
    if (memory.sessionId !== session.sessionId) {
      throw sessionError(
        'SESSION_MEMORY_MISMATCH',
        'Session memory belongs to a different session.',
        {
          sessionId: session.sessionId,
        },
      )
    }
  }

  private async withSessionLock<T>(sessionId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.sessionLocks.get(sessionId) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = previous.then(() => gate)
    this.sessionLocks.set(sessionId, tail)
    await previous
    try {
      return await action()
    } finally {
      release()
      if (this.sessionLocks.get(sessionId) === tail) this.sessionLocks.delete(sessionId)
    }
  }

  private async repositoryCall<T>(operation: string, action: () => Promise<T>): Promise<T> {
    try {
      return await action()
    } catch (error) {
      if (isRuntimeError(error)) throw error
      throw runtimeError(
        'PERSISTENCE_OPERATION_FAILED',
        'persistence',
        'Session persistence operation failed.',
        { operation },
        true,
      )
    }
  }

  private managementRepository(): SessionManagementRepository {
    const repository = this.repository as SessionRepository & Partial<SessionManagementRepository>
    if (
      !repository.rename ||
      !repository.search ||
      !repository.exportSession ||
      !repository.deleteToTrash ||
      !repository.applyRetention ||
      !repository.forkSession ||
      !repository.setActiveLeaf
    ) {
      throw runtimeError(
        'SESSION_MANAGEMENT_UNSUPPORTED',
        'persistence',
        'Session repository does not support v2 management.',
      )
    }
    return repository as SessionRepository & SessionManagementRepository
  }
}

function cloneMemory(memory: SessionMemory): SessionMemory {
  return {
    sessionId: memory.sessionId,
    ...(memory.checkpoint === undefined
      ? {}
      : {
          checkpoint: {
            ...memory.checkpoint,
            ...(memory.checkpoint.skillInvocations === undefined
              ? {}
              : {
                  skillInvocations: memory.checkpoint.skillInvocations.map((invocation) => ({
                    ...invocation,
                  })),
                }),
            ...(memory.checkpoint.summary === undefined
              ? {}
              : {
                  summary: {
                    ...memory.checkpoint.summary,
                    ...(memory.checkpoint.summary.relevantRefs === undefined
                      ? {}
                      : { relevantRefs: [...memory.checkpoint.summary.relevantRefs] }),
                    decisions: [...memory.checkpoint.summary.decisions],
                    constraints: [...memory.checkpoint.summary.constraints],
                    readFiles: [...memory.checkpoint.summary.readFiles],
                    modifiedFiles: [...memory.checkpoint.summary.modifiedFiles],
                    unresolved: [...memory.checkpoint.summary.unresolved],
                    activePlan: [...memory.checkpoint.summary.activePlan],
                  },
                }),
          },
        }),
    ...(memory.plan === undefined
      ? {}
      : {
          plan: { ...memory.plan, steps: memory.plan.steps.map((step) => ({ ...step })) },
        }),
  }
}

function toRecord<TRun extends IdentifiedRun>(
  session: ManagedSession<TRun>,
  state = session.state,
): SessionRecord {
  const now = new Date().toISOString()
  return {
    sessionId: session.sessionId,
    state: state === 'running' ? 'idle' : state,
    cwd: session.cwd,
    provider: session.provider,
    model: session.model,
    plannerMode: session.plannerMode ?? 'auto',
    ...(session.contextLimitTokens === undefined
      ? {}
      : { contextLimitTokens: session.contextLimitTokens }),
    createdAt: session.createdAt,
    updatedAt: now,
    recordVersion: 2,
    name: session.name ?? session.sessionId,
    activeLeafId: session.activeLeafId ?? session.sessionId,
    ...(session.parentSessionId ? { parentSessionId: session.parentSessionId } : {}),
    labels: [...(session.labels ?? [])],
    messageCount: session.messageCount ?? session.messages.length,
    usage: { ...(session.usage ?? {}) },
    ...(session.lastTerminalState ? { lastTerminalState: session.lastTerminalState } : {}),
  }
}

function sessionError(code: string, message: string, data: Record<string, unknown>) {
  return runtimeError(code, 'protocol', message, data)
}

function mergeUsage(
  current: SessionRecord['usage'],
  update: SessionRecord['usage'],
): NonNullable<SessionRecord['usage']> {
  const merged: NonNullable<SessionRecord['usage']> = {}
  for (const key of [
    'inputTokens',
    'outputTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
    'costUsd',
  ] as const) {
    const left = current?.[key]
    const right = update?.[key]
    if (left !== undefined || right !== undefined) merged[key] = (left ?? 0) + (right ?? 0)
  }
  return merged
}

function isRuntimeError(value: unknown): value is RuntimeError {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as RuntimeError).code === 'string' &&
    typeof (value as RuntimeError).category === 'string' &&
    typeof (value as RuntimeError).message === 'string' &&
    typeof (value as RuntimeError).retryable === 'boolean'
  )
}
