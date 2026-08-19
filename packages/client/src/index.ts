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

/** Typed protocol client with event sequence validation and bounded reconnection. */
export class PraxisClient {
  readonly #factory: ConnectionFactory
  readonly #reconnectAttempts: number
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

  constructor(factory: ConnectionFactory, options: PraxisClientOptions = {}) {
    this.#factory = factory
    this.#reconnectAttempts = Math.max(0, Math.floor(options.reconnectAttempts ?? 1))
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
          yield notification.params.event
        }
        return
      } catch (error) {
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
    const result = await this.request<{ runId: string; accepted: true }>('session.prompt', {
      ...input,
      clientRequestId:
        input.clientRequestId ?? `client-${Date.now().toString(36)}-${this.#nextRequestId}`,
    })
    for await (const event of this.events()) {
      if (!('runId' in event) || event.runId !== result.runId) continue
      yield event
      if (isTerminal(event)) return
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
    this.#connection = undefined
    this.#initialized = undefined
    this.#subscriptionId = undefined
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

function isTerminal(event: SessionEvent): boolean {
  return (
    event.type === 'prompt_completed' ||
    event.type === 'prompt_failed' ||
    event.type === 'prompt_aborted'
  )
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
