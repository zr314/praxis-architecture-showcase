import type {
  CreateSessionInput,
  EventNotification,
  InitializeParams,
  InitializeResult,
  JsonRpcRequest,
  PermissionDecision,
  PromptInput,
  RuntimeMethod,
  SessionEvent,
  SessionInfo,
  SessionTranscriptResult,
} from '@praxis/protocol'
import {
  assertProtocolMessage,
  assertProtocolResult,
  PRAXIS_PRODUCT_VERSION,
  PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
} from '@praxis/protocol'

export type ProtocolConnection = {
  request<T>(request: JsonRpcRequest): Promise<T>
  notifications(): AsyncIterable<EventNotification>
  close(): Promise<void>
}

export type ConnectionFactory = () => Promise<ProtocolConnection>

export type PraxisClientOptions = {
  reconnectAttempts?: number
  eventBufferCapacity?: number
  client?: { name: string; version: string }
  onRuntimeEpoch?: (transition: RuntimeEpochTransition) => void | Promise<void>
}

export type RuntimeEpochTransition = {
  previousRuntimeId?: string
  runtimeId: string
  epoch: number
}

class EventSequenceError extends Error {
  override readonly name = 'EventSequenceError'
}

export class EventBufferOverflowError extends Error {
  override readonly name = 'EventBufferOverflowError'
}

export class RunEventStreamEndedError extends Error {
  override readonly name = 'RunEventStreamEndedError'
}

/** Typed protocol client with event sequence validation and bounded reconnection. */
export class PraxisClient {
  readonly supportsConcurrentRuns = true as const
  readonly #factory: ConnectionFactory
  readonly #reconnectAttempts: number
  readonly #eventBufferCapacity: number
  readonly #client: { name: string; version: string }
  readonly #onRuntimeEpoch?: PraxisClientOptions['onRuntimeEpoch']
  #connection?: ProtocolConnection
  #initialized?: InitializeResult
  #subscriptionId?: string
  #nextRequestId = 1
  #lastSequence = 0
  #runtimeId = ''
  #runtimeEpoch = 0
  #closed = false
  #connecting?: Promise<InitializeResult>
  #reconnecting?: Promise<void>
  #eventPump?: Promise<void>
  #eventStreamEnded = false
  #eventFailure?: unknown
  #pendingRunRequests = 0
  readonly #eventSubscribers = new Set<AsyncEventChannel<SessionEvent>>()
  readonly #runSubscribers = new Map<string, Set<AsyncEventChannel<SessionEvent>>>()
  readonly #pendingRunEvents = new Map<string, SessionEvent[]>()
  readonly #pendingRunFailures = new Map<string, unknown>()
  readonly #ignoredRunIds = new Set<string>()

  constructor(factory: ConnectionFactory, options: PraxisClientOptions = {}) {
    this.#factory = factory
    this.#reconnectAttempts = Math.max(0, Math.floor(options.reconnectAttempts ?? 1))
    this.#eventBufferCapacity = positiveInteger(
      options.eventBufferCapacity ?? 4_096,
      'eventBufferCapacity',
    )
    this.#client = options.client ?? {
      name: '@praxis/client',
      version: PRAXIS_PRODUCT_VERSION,
    }
    this.#onRuntimeEpoch = options.onRuntimeEpoch
  }

  get runtimeId(): string {
    return this.#runtimeId
  }

  get runtimeEpoch(): number {
    return this.#runtimeEpoch
  }

  async connect(): Promise<InitializeResult> {
    if (this.#closed) throw new Error('Praxis client is closed.')
    if (this.#connection && this.#initialized) return this.#initialized
    this.#connecting ??= this.openConnection().finally(() => {
      this.#connecting = undefined
    })
    return this.#connecting
  }

  private async openConnection(): Promise<InitializeResult> {
    const connection = await this.#factory()
    try {
      const initializeParams: InitializeParams = {
        protocolVersion: PROTOCOL_VERSION,
        supportedProtocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
        client: this.#client,
        capabilities: {
          interactivePermissions: true,
          outputFormats: ['text', 'json', 'stream-json'],
        },
      }
      const initializeRequest = this.envelope('initialize', initializeParams)
      const initialized = await this.validatedRequest<InitializeResult>(
        connection,
        initializeRequest,
      )
      if (initialized.protocolVersion !== PROTOCOL_VERSION) {
        throw new Error(`Unsupported Runtime protocol ${initialized.protocolVersion}.`)
      }
      const previousRuntimeId = this.#runtimeId || undefined
      const nextRuntimeId = initialized.runtime.runtimeId
      const newEpoch = previousRuntimeId !== nextRuntimeId
      const replayFrom =
        previousRuntimeId !== undefined && !newEpoch ? this.#lastSequence + 1 : null
      const subscriptionRequest = this.envelope('events.subscribe', {
        sessionId: null,
        fromSequence: replayFrom,
      })
      const subscription = await this.validatedRequest<{
        subscriptionId: string
        nextSequence: number
        replaySupported: boolean
      }>(connection, subscriptionRequest)
      if (replayFrom !== null && !subscription.replaySupported) {
        throw new Error('Runtime does not support replay required for reconnection.')
      }
      this.#connection = connection
      this.#initialized = initialized
      this.#subscriptionId = subscription.subscriptionId
      this.#lastSequence = subscription.nextSequence - 1
      if (newEpoch) {
        this.#runtimeId = nextRuntimeId
        this.#runtimeEpoch += 1
        await this.#onRuntimeEpoch?.({
          ...(previousRuntimeId ? { previousRuntimeId } : {}),
          runtimeId: nextRuntimeId,
          epoch: this.#runtimeEpoch,
        })
      }
      return initialized
    } catch (error) {
      await connection.close()
      throw error
    }
  }

  async manageMemory(input: import('@praxis/core-sdk').MemoryManageRequestV1): Promise<unknown> {
    return this.request('memory.manage', { ...input })
  }

  async request<T>(method: RuntimeMethod, params: Record<string, unknown>): Promise<T> {
    let failure: unknown
    for (let attempt = 0; attempt <= this.#reconnectAttempts; attempt += 1) {
      try {
        const connection = await this.connection()
        return await this.validatedRequest<T>(connection, this.envelope(method, params))
      } catch (error) {
        failure = error
        if (attempt === this.#reconnectAttempts || !isReadOnlyMethod(method)) break
        await this.reconnect()
      }
    }
    throw failure
  }

  async *events(): AsyncIterable<SessionEvent> {
    const channel = this.createEventChannel()
    this.#eventSubscribers.add(channel)
    this.startEventPump()
    try {
      yield* channel
    } finally {
      this.#eventSubscribers.delete(channel)
      channel.complete()
    }
  }

  private async pumpEvents(): Promise<void> {
    let reconnects = 0
    while (!this.#closed) {
      try {
        const connection = await this.connection()
        for await (const notification of connection.notifications()) {
          assertProtocolMessage(notification)
          if (notification.params.subscriptionId !== this.#subscriptionId) continue
          if (notification.params.sequence !== this.#lastSequence + 1) {
            throw new EventSequenceError(
              `Runtime event sequence gap: expected ${this.#lastSequence + 1}, got ${notification.params.sequence}.`,
            )
          }
          this.#lastSequence = notification.params.sequence
          reconnects = 0
          this.publishEvent(notification.params.event)
        }
        this.#eventStreamEnded = true
        this.completeEventSubscribers()
        return
      } catch (error) {
        if (this.#closed) return
        if (error instanceof EventSequenceError) throw error
        if (reconnects >= this.#reconnectAttempts) throw error
        reconnects += 1
        await this.reconnect()
      }
    }
  }

  async createSession(input: CreateSessionInput): Promise<SessionInfo> {
    return this.request('session.create', input)
  }

  async resumeSession(sessionId: string): Promise<SessionInfo> {
    return this.request('session.resume', { sessionId })
  }

  async listSessions(): Promise<SessionInfo[]> {
    return this.request('session.list', {})
  }

  async transcriptSession(
    sessionId: string,
    before?: number,
    limit = 200,
  ): Promise<SessionTranscriptResult> {
    return this.request('session.transcript', {
      sessionId,
      ...(before === undefined ? {} : { before }),
      limit,
    })
  }

  async *prompt(input: PromptInput): AsyncIterable<SessionEvent> {
    yield* this.runPrompt('session.prompt', input)
  }

  async *followUp(input: PromptInput): AsyncIterable<SessionEvent> {
    yield* this.runPrompt('session.follow_up', input)
  }

  async steer(
    sessionId: string,
    runId: string,
    text: string,
  ): Promise<{ accepted: boolean; applyAt: 'next_safe_boundary' }> {
    return this.request('session.steer', { sessionId, runId, text })
  }

  async abort(runId: string): Promise<void> {
    await this.request('session.abort', { runId })
  }

  private async *runPrompt(
    method: 'session.prompt' | 'session.follow_up',
    input: PromptInput,
  ): AsyncIterable<SessionEvent> {
    this.#pendingRunRequests += 1
    let runId = ''
    let channel: AsyncEventChannel<SessionEvent> | undefined
    try {
      const result = await this.request<{ runId: string; accepted: true }>(method, {
        ...input,
        clientRequestId:
          input.clientRequestId ?? `client-${Date.now().toString(36)}-${this.#nextRequestId}`,
      })
      runId = result.runId
      channel = this.subscribeRun(runId)
    } finally {
      this.#pendingRunRequests -= 1
      if (this.#pendingRunRequests === 0) this.discardUnclaimedRunEvents()
    }

    let terminalSeen = false
    try {
      for await (const event of channel!) {
        if (isTerminal(event)) terminalSeen = true
        yield event
        if (terminalSeen) return
      }
      throw new RunEventStreamEndedError(
        `Praxis event stream ended before Run ${runId} produced a terminal event.`,
      )
    } finally {
      this.unsubscribeRun(runId, channel!, terminalSeen)
    }
  }

  async decidePermission(requestId: string, decision: PermissionDecision): Promise<void> {
    await this.request('permission.decide', { requestId, decision })
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    await this.#connecting?.catch(() => undefined)
    await this.#connection?.close().catch(() => undefined)
    this.completeEventSubscribers()
    this.#connection = undefined
    this.#initialized = undefined
    this.#subscriptionId = undefined
  }

  private createEventChannel(): AsyncEventChannel<SessionEvent> {
    const channel = new AsyncEventChannel<SessionEvent>(this.#eventBufferCapacity)
    if (this.#eventFailure !== undefined) channel.fail(this.#eventFailure)
    else if (this.#eventStreamEnded || this.#closed) channel.complete()
    return channel
  }

  private subscribeRun(runId: string): AsyncEventChannel<SessionEvent> {
    const channel = this.createEventChannel()
    const pending = this.#pendingRunEvents.get(runId) ?? []
    const pendingFailure = this.#pendingRunFailures.get(runId)
    this.#pendingRunEvents.delete(runId)
    this.#pendingRunFailures.delete(runId)
    this.#ignoredRunIds.delete(runId)
    let terminalSeen = false
    for (const event of pending) {
      channel.push(event)
      if (isTerminal(event)) terminalSeen = true
    }
    if (pendingFailure !== undefined) channel.fail(pendingFailure)
    else if (terminalSeen) channel.complete()
    else if (!channel.closed) {
      const subscribers = this.#runSubscribers.get(runId) ?? new Set()
      subscribers.add(channel)
      this.#runSubscribers.set(runId, subscribers)
    }
    this.startEventPump()
    return channel
  }

  private unsubscribeRun(
    runId: string,
    channel: AsyncEventChannel<SessionEvent>,
    terminalSeen: boolean,
  ): void {
    const subscribers = this.#runSubscribers.get(runId)
    subscribers?.delete(channel)
    if (subscribers?.size === 0) this.#runSubscribers.delete(runId)
    channel.complete()
    if (
      !terminalSeen &&
      this.#eventFailure === undefined &&
      !this.#eventStreamEnded &&
      !this.#closed
    ) {
      this.#ignoredRunIds.add(runId)
    }
  }

  private startEventPump(): void {
    if (
      this.#eventPump !== undefined ||
      this.#eventStreamEnded ||
      this.#eventFailure !== undefined
    ) {
      return
    }
    this.#eventPump = this.pumpEvents()
      .catch((error: unknown) => {
        this.#eventFailure = error
        this.failEventSubscribers(error)
      })
      .finally(() => {
        this.#eventPump = undefined
      })
  }

  private publishEvent(event: SessionEvent): void {
    for (const channel of this.#eventSubscribers) {
      channel.push(event)
      if (channel.closed) this.#eventSubscribers.delete(channel)
    }
    const runId = eventRunId(event)
    if (runId === undefined) return
    if (this.#ignoredRunIds.has(runId)) {
      if (isTerminal(event)) this.#ignoredRunIds.delete(runId)
      return
    }
    const subscribers = this.#runSubscribers.get(runId)
    if (subscribers !== undefined) {
      for (const channel of subscribers) {
        channel.push(event)
        if (channel.closed) subscribers.delete(channel)
      }
      if (isTerminal(event)) {
        for (const channel of subscribers) channel.complete()
        this.#runSubscribers.delete(runId)
      } else if (subscribers.size === 0) {
        this.#runSubscribers.delete(runId)
        this.#ignoredRunIds.add(runId)
      }
      return
    }
    if (this.#pendingRunRequests > 0) {
      const pending = this.#pendingRunEvents.get(runId) ?? []
      if (pending.length >= this.#eventBufferCapacity) {
        this.#pendingRunEvents.delete(runId)
        this.#pendingRunFailures.set(
          runId,
          new EventBufferOverflowError(
            `Run ${runId} emitted more than ${this.#eventBufferCapacity} events before its request completed.`,
          ),
        )
        return
      }
      pending.push(event)
      this.#pendingRunEvents.set(runId, pending)
    }
  }

  private discardUnclaimedRunEvents(): void {
    this.#pendingRunEvents.clear()
    this.#pendingRunFailures.clear()
  }

  private completeEventSubscribers(): void {
    for (const channel of this.#eventSubscribers) channel.complete()
    for (const subscribers of this.#runSubscribers.values()) {
      for (const channel of subscribers) channel.complete()
    }
    this.#eventSubscribers.clear()
    this.#runSubscribers.clear()
    this.#pendingRunEvents.clear()
    this.#pendingRunFailures.clear()
    this.#ignoredRunIds.clear()
  }

  private failEventSubscribers(error: unknown): void {
    for (const channel of this.#eventSubscribers) channel.fail(error)
    for (const subscribers of this.#runSubscribers.values()) {
      for (const channel of subscribers) channel.fail(error)
    }
    this.#eventSubscribers.clear()
    this.#runSubscribers.clear()
    this.#pendingRunEvents.clear()
    this.#pendingRunFailures.clear()
    this.#ignoredRunIds.clear()
  }

  private async connection(): Promise<ProtocolConnection> {
    if (!this.#connection) await this.connect()
    return this.#connection!
  }

  private async reconnect(): Promise<void> {
    this.#reconnecting ??= (async () => {
      await this.#connection?.close().catch(() => {})
      this.#connection = undefined
      this.#initialized = undefined
      this.#subscriptionId = undefined
      await this.connect()
    })().finally(() => {
      this.#reconnecting = undefined
    })
    await this.#reconnecting
  }

  private envelope(method: RuntimeMethod, params: unknown): JsonRpcRequest {
    return {
      jsonrpc: '2.0',
      id: String(this.#nextRequestId++),
      method,
      params,
    }
  }

  private async validatedRequest<T>(
    connection: ProtocolConnection,
    request: JsonRpcRequest,
  ): Promise<T> {
    const result = await connection.request<unknown>(request)
    assertProtocolResult(request.method as RuntimeMethod, request.id, result)
    return result as T
  }
}

class AsyncEventChannel<T> implements AsyncIterable<T>, AsyncIterator<T> {
  readonly #capacity: number
  readonly #values: T[] = []
  readonly #waiters: Array<{
    resolve: (result: IteratorResult<T>) => void
    reject: (error: unknown) => void
  }> = []
  #closed = false
  #failure?: unknown

  constructor(capacity: number) {
    this.#capacity = capacity
  }

  get closed(): boolean {
    return this.#closed
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this
  }

  next(): Promise<IteratorResult<T>> {
    if (this.#values.length > 0) {
      return Promise.resolve({ done: false, value: this.#values.shift()! })
    }
    if (this.#failure !== undefined) return Promise.reject(this.#failure)
    if (this.#closed) return Promise.resolve({ done: true, value: undefined })
    return new Promise<IteratorResult<T>>((resolve, reject) => {
      this.#waiters.push({ resolve, reject })
    })
  }

  push(value: T): void {
    if (this.#closed) return
    const waiter = this.#waiters.shift()
    if (waiter !== undefined) {
      waiter.resolve({ done: false, value })
      return
    }
    if (this.#values.length >= this.#capacity) {
      this.fail(
        new EventBufferOverflowError(
          `Praxis event consumer exceeded its ${this.#capacity}-event buffer capacity.`,
        ),
      )
      return
    }
    this.#values.push(value)
  }

  complete(): void {
    if (this.#closed) return
    this.#closed = true
    for (const waiter of this.#waiters.splice(0)) {
      waiter.resolve({ done: true, value: undefined })
    }
  }

  fail(error: unknown): void {
    if (this.#closed) return
    this.#closed = true
    this.#failure = error
    this.#values.length = 0
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error)
  }
}

function isTerminal(event: SessionEvent): boolean {
  return (
    event.type === 'prompt_completed' ||
    event.type === 'prompt_failed' ||
    event.type === 'prompt_blocked' ||
    event.type === 'prompt_aborted'
  )
}

function eventRunId(event: SessionEvent): string | undefined {
  return 'runId' in event && typeof event.runId === 'string' && event.runId.length > 0
    ? event.runId
    : undefined
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${field} must be a positive integer.`)
  }
  return value
}

function isReadOnlyMethod(method: RuntimeMethod): boolean {
  return [
    'auth.status',
    'models.list',
    'settings.get',
    'runtime.doctor',
    'plugin.list',
    'plugin.inspect',
    'plugin.permissions',
    'plugin.doctor',
    'session.list',
    'session.search',
    'session.inspect',
    'session.resume',
    'session.export',
    'session.transcript',
    'session.branch',
    'session.plan',
    'artifacts.list',
    'trace.export',
  ].includes(method)
}

export * from './agent.js'
