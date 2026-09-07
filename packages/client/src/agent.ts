import type {
  CreateSessionInput,
  PermissionDecision,
  PromptInput,
  SessionEvent,
  SessionInfo,
  UsageSummary,
} from '@praxis/protocol'

type MaybePromise<T> = T | Promise<T>
const activeAgentClients = new WeakSet<object>()

export class AgentClientBusyError extends Error {
  override readonly name = 'AgentClientBusyError'
}

export type AgentClient = {
  readonly supportsConcurrentRuns?: boolean
  createSession(input: CreateSessionInput): Promise<SessionInfo>
  resumeSession(sessionId: string): Promise<SessionInfo>
  prompt(input: PromptInput): AsyncIterable<SessionEvent>
  followUp(input: PromptInput): AsyncIterable<SessionEvent>
  decidePermission(requestId: string, decision: PermissionDecision): Promise<void>
  abort(runId: string): Promise<void>
}

export type AgentRunStatus = 'completed' | 'failed' | 'blocked' | 'aborted'

export type AgentRunRequest<TState> = {
  input: string
  sessionId?: string
  state?: TState
  metadata?: Readonly<Record<string, unknown>>
  clientRequestId?: string
  budget?: PromptInput['budget']
  planPolicy?: PromptInput['planPolicy']
  timeoutMs?: number
  signal?: AbortSignal
}

export type AgentRunContext<TState> = Readonly<{
  agentName: string
  instructions?: string
  input: string
  sessionId?: string
  state: TState
  metadata: Readonly<Record<string, unknown>>
}>

export type AgentBeforeRunUpdate<TState> = Readonly<{
  input?: string
  instructions?: string
  state?: TState
  metadata?: Readonly<Record<string, unknown>>
}>

export type AgentRunResult<TOutput, TState> = Readonly<{
  sessionId: string
  runId: string
  status: AgentRunStatus
  text: string
  output?: TOutput
  state: TState
  metadata: Readonly<Record<string, unknown>>
  usage?: UsageSummary
  stopReason?: string
  error?: Readonly<{ message: string; code?: string }>
}>

export type AgentMiddleware<TState, TOutput> = Readonly<{
  name?: string
  beforeRun?(
    context: AgentRunContext<TState>,
  ): MaybePromise<undefined | AgentBeforeRunUpdate<TState>>
  onEvent?(context: AgentRunContext<TState>, event: SessionEvent): MaybePromise<void>
  onPermissionRequest?(
    context: AgentRunContext<TState>,
    event: Extract<SessionEvent, { type: 'permission_request' }>,
  ): MaybePromise<undefined | PermissionDecision>
  afterRun?(
    context: AgentRunContext<TState>,
    result: AgentRunResult<TOutput, TState>,
  ): MaybePromise<undefined | AgentRunResult<TOutput, TState>>
  onError?(context: AgentRunContext<TState>, error: unknown): MaybePromise<void>
}>

export type AgentDefinition<TState = undefined, TOutput = string> = Readonly<{
  client: AgentClient
  name?: string
  instructions?: string
  cwd?: string
  provider?: string
  model?: string
  plannerMode?: CreateSessionInput['plannerMode']
  contextLimitTokens?: number
  labels?: readonly string[]
  permissionMode?: CreateSessionInput['permissionMode']
  initialState?: TState | (() => TState)
  metadata?: Readonly<Record<string, unknown>>
  middleware?: readonly AgentMiddleware<TState, TOutput>[]
  parseOutput?: (text: string) => MaybePromise<TOutput>
}>

export type AgentRunStream<TOutput, TState> = AsyncGenerator<
  SessionEvent,
  AgentRunResult<TOutput, TState>,
  void
>

/** Defines an embeddable Agent backed by an existing Praxis Runtime client. */
export function defineAgent<TState = undefined, TOutput = string>(
  definition: AgentDefinition<TState, TOutput>,
): PraxisAgent<TState, TOutput> {
  return new PraxisAgent(definition)
}

export class PraxisAgent<TState = undefined, TOutput = string> {
  readonly #definition: AgentDefinition<TState, TOutput>
  readonly #middleware: readonly AgentMiddleware<TState, TOutput>[]

  constructor(definition: AgentDefinition<TState, TOutput>) {
    validateDefinition(definition)
    this.#definition = Object.freeze({
      ...definition,
      labels: definition.labels === undefined ? undefined : Object.freeze([...definition.labels]),
      middleware:
        definition.middleware === undefined ? undefined : Object.freeze([...definition.middleware]),
      metadata:
        definition.metadata === undefined ? undefined : Object.freeze({ ...definition.metadata }),
    })
    this.#middleware = this.#definition.middleware ?? []
  }

  get name(): string {
    return this.#definition.name ?? 'Praxis Agent'
  }

  async run(request: string | AgentRunRequest<TState>): Promise<AgentRunResult<TOutput, TState>> {
    const stream = this.stream(request)
    while (true) {
      const item = await stream.next()
      if (item.done) return item.value
    }
  }

  async *stream(request: string | AgentRunRequest<TState>): AgentRunStream<TOutput, TState> {
    const normalized = normalizeRequest(request)
    let context: AgentRunContext<TState> = Object.freeze({
      agentName: this.name,
      ...(this.#definition.instructions === undefined
        ? {}
        : { instructions: this.#definition.instructions }),
      input: normalized.input,
      ...(normalized.sessionId === undefined ? {} : { sessionId: normalized.sessionId }),
      state: normalized.state ?? this.initialState(),
      metadata: Object.freeze({
        ...(this.#definition.metadata ?? {}),
        ...(normalized.metadata ?? {}),
      }),
    })

    let clientAcquired = false
    try {
      if (!this.#definition.client.supportsConcurrentRuns) {
        if (activeAgentClients.has(this.#definition.client)) {
          throw new AgentClientBusyError(
            'This Agent client does not declare concurrent Run support. Use PraxisClient or separate client connections.',
          )
        }
        activeAgentClients.add(this.#definition.client)
        clientAcquired = true
      }
      context = await this.beforeRun(context)
      const existingSession = context.sessionId !== undefined
      const session = existingSession
        ? await this.#definition.client.resumeSession(context.sessionId!)
        : await this.#definition.client.createSession(this.createSessionInput())
      context = Object.freeze({ ...context, sessionId: session.sessionId })

      let runId = ''
      let text = ''
      let terminal: Extract<
        SessionEvent,
        { type: 'prompt_completed' | 'prompt_failed' | 'prompt_blocked' | 'prompt_aborted' }
      > | null = null
      let abortRequested = normalized.signal?.aborted ?? false
      let abortFailure: unknown
      let abortPromise: Promise<void> | undefined
      const sendAbort = () => {
        abortRequested = true
        if (runId.length === 0 || abortPromise !== undefined) return
        abortPromise = this.#definition.client.abort(runId).catch((error: unknown) => {
          abortFailure = error
        })
      }
      normalized.signal?.addEventListener('abort', sendAbort, { once: true })

      try {
        const promptInput: PromptInput = {
          sessionId: session.sessionId,
          text: context.input,
          ...(normalized.clientRequestId === undefined
            ? {}
            : { clientRequestId: normalized.clientRequestId }),
          ...(context.instructions === undefined
            ? {}
            : {
                agent: {
                  name: context.agentName,
                  instructions: context.instructions,
                },
              }),
          ...(normalized.budget === undefined ? {} : { budget: normalized.budget }),
          ...(normalized.planPolicy === undefined ? {} : { planPolicy: normalized.planPolicy }),
          ...(normalized.timeoutMs === undefined ? {} : { timeoutMs: normalized.timeoutMs }),
        }
        const events = existingSession
          ? this.#definition.client.followUp(promptInput)
          : this.#definition.client.prompt(promptInput)
        for await (const event of events) {
          if ('runId' in event && typeof event.runId === 'string' && event.runId.length > 0) {
            runId = event.runId
          }
          if (abortRequested) sendAbort()
          for (const middleware of this.#middleware) await middleware.onEvent?.(context, event)
          if (event.type === 'permission_request') {
            await this.decidePermission(context, event)
          }
          if (event.type === 'text_delta') text += event.text
          if (isTerminal(event)) terminal = event
          yield event
        }
        await abortPromise
        if (abortFailure !== undefined) throw abortFailure
      } finally {
        normalized.signal?.removeEventListener('abort', sendAbort)
      }

      if (terminal === null || runId.length === 0) {
        throw new Error('Praxis Runtime event stream ended without a terminal Run event.')
      }
      let result = await this.result(context, terminal, text)
      for (const middleware of [...this.#middleware].reverse()) {
        result = (await middleware.afterRun?.(context, result)) ?? result
      }
      return result
    } catch (error) {
      for (const middleware of [...this.#middleware].reverse()) {
        await middleware.onError?.(context, error)
      }
      throw error
    } finally {
      if (clientAcquired) activeAgentClients.delete(this.#definition.client)
    }
  }

  async resume(sessionId: string): Promise<PraxisAgentSession<TState, TOutput>> {
    const session = await this.#definition.client.resumeSession(sessionId)
    return new PraxisAgentSession(this, session)
  }

  async abort(runId: string): Promise<void> {
    await this.#definition.client.abort(runId)
  }

  private createSessionInput(): CreateSessionInput {
    return {
      cwd: this.#definition.cwd ?? process.cwd(),
      ...(this.#definition.provider === undefined ? {} : { provider: this.#definition.provider }),
      ...(this.#definition.model === undefined ? {} : { model: this.#definition.model }),
      ...(this.#definition.plannerMode === undefined
        ? {}
        : { plannerMode: this.#definition.plannerMode }),
      ...(this.#definition.contextLimitTokens === undefined
        ? {}
        : { contextLimitTokens: this.#definition.contextLimitTokens }),
      ...(this.#definition.name === undefined ? {} : { name: this.#definition.name }),
      ...(this.#definition.labels === undefined ? {} : { labels: [...this.#definition.labels] }),
      ...(this.#definition.permissionMode === undefined
        ? {}
        : { permissionMode: this.#definition.permissionMode }),
    }
  }

  private initialState(): TState {
    const initial = this.#definition.initialState
    return typeof initial === 'function' ? (initial as () => TState)() : (initial as TState)
  }

  private async beforeRun(context: AgentRunContext<TState>): Promise<AgentRunContext<TState>> {
    let current = context
    for (const middleware of this.#middleware) {
      const update = await middleware.beforeRun?.(current)
      if (update === undefined) continue
      current = Object.freeze({
        ...current,
        ...(update.input === undefined ? {} : { input: requiredText(update.input, 'input') }),
        ...(update.instructions === undefined
          ? {}
          : { instructions: boundedText(update.instructions, 'instructions', 16_384) }),
        ...(update.state === undefined ? {} : { state: update.state }),
        ...(update.metadata === undefined
          ? {}
          : { metadata: Object.freeze({ ...current.metadata, ...update.metadata }) }),
      })
    }
    return current
  }

  private async decidePermission(
    context: AgentRunContext<TState>,
    event: Extract<SessionEvent, { type: 'permission_request' }>,
  ): Promise<void> {
    for (const middleware of this.#middleware) {
      const decision = await middleware.onPermissionRequest?.(context, event)
      if (decision === undefined) continue
      await this.#definition.client.decidePermission(event.requestId, decision)
      return
    }
  }

  private async result(
    context: AgentRunContext<TState>,
    terminal: Extract<
      SessionEvent,
      { type: 'prompt_completed' | 'prompt_failed' | 'prompt_blocked' | 'prompt_aborted' }
    >,
    text: string,
  ): Promise<AgentRunResult<TOutput, TState>> {
    const status: AgentRunStatus =
      terminal.type === 'prompt_completed'
        ? 'completed'
        : terminal.type === 'prompt_failed'
          ? 'failed'
          : terminal.type === 'prompt_blocked'
            ? 'blocked'
            : 'aborted'
    const output =
      status !== 'completed'
        ? undefined
        : this.#definition.parseOutput === undefined
          ? (text as TOutput)
          : await this.#definition.parseOutput(text)
    return Object.freeze({
      sessionId: context.sessionId!,
      runId: terminal.runId,
      status,
      text,
      ...(output === undefined ? {} : { output }),
      state: context.state,
      metadata: context.metadata,
      ...(terminal.usage === undefined ? {} : { usage: terminal.usage }),
      ...(terminal.type !== 'prompt_completed' || terminal.stopReason === undefined
        ? {}
        : { stopReason: terminal.stopReason }),
      ...(terminal.type !== 'prompt_failed' && terminal.type !== 'prompt_blocked'
        ? {}
        : {
            error: {
              message: terminal.type === 'prompt_failed' ? terminal.error : terminal.reason,
              ...(terminal.code === undefined ? {} : { code: terminal.code }),
            },
          }),
    })
  }
}

export class PraxisAgentSession<TState = undefined, TOutput = string> {
  constructor(
    private readonly agent: PraxisAgent<TState, TOutput>,
    readonly info: SessionInfo,
  ) {}

  get sessionId(): string {
    return this.info.sessionId
  }

  run(
    request: string | Omit<AgentRunRequest<TState>, 'sessionId'>,
  ): Promise<AgentRunResult<TOutput, TState>> {
    return this.agent.run(withSession(request, this.sessionId))
  }

  stream(
    request: string | Omit<AgentRunRequest<TState>, 'sessionId'>,
  ): AgentRunStream<TOutput, TState> {
    return this.agent.stream(withSession(request, this.sessionId))
  }
}

function normalizeRequest<TState>(
  request: string | AgentRunRequest<TState>,
): AgentRunRequest<TState> {
  if (typeof request === 'string') return { input: requiredText(request, 'input') }
  return { ...request, input: requiredText(request.input, 'input') }
}

function withSession<TState>(
  request: string | Omit<AgentRunRequest<TState>, 'sessionId'>,
  sessionId: string,
): AgentRunRequest<TState> {
  return typeof request === 'string' ? { input: request, sessionId } : { ...request, sessionId }
}

function isTerminal(
  event: SessionEvent,
): event is Extract<
  SessionEvent,
  { type: 'prompt_completed' | 'prompt_failed' | 'prompt_blocked' | 'prompt_aborted' }
> {
  return (
    event.type === 'prompt_completed' ||
    event.type === 'prompt_failed' ||
    event.type === 'prompt_blocked' ||
    event.type === 'prompt_aborted'
  )
}

function validateDefinition<TState, TOutput>(definition: AgentDefinition<TState, TOutput>): void {
  if (definition === null || typeof definition !== 'object') {
    throw new TypeError('Agent definition must be an object.')
  }
  if (definition.client === undefined) throw new TypeError('Agent client is required.')
  if (definition.name !== undefined) boundedText(definition.name, 'name', 128)
  if (definition.instructions !== undefined) {
    boundedText(definition.instructions, 'instructions', 16_384)
  }
}

function requiredText(value: string, field: string): string {
  return boundedText(value, field, 32_768)
}

function boundedText(value: string, field: string, maximumBytes: number): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    Buffer.byteLength(value, 'utf8') > maximumBytes
  ) {
    throw new TypeError(`${field} must contain between 1 and ${maximumBytes} UTF-8 bytes.`)
  }
  return value
}
