import type {
  ProviderRequest,
  ProviderToolCall,
  ProviderTurnResult,
  ToolExecutionDescriptor,
  ToolResult,
  TraceContext,
} from '@praxis/core-sdk'
import { runtimeError } from '@praxis/core-sdk'

type MaybePromise<T> = T | Promise<T>
export type RuntimeMiddlewareHook = 'beforeModel' | 'afterModel' | 'beforeTool' | 'afterTool'

const MIDDLEWARE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const DEFAULT_POLICY = Object.freeze({
  hookTimeoutMs: 30_000,
  consecutiveFailureThreshold: 3,
  circuitCooldownMs: 30_000,
})
const MAX_HOOK_TIMEOUT_MS = 300_000
const MAX_FAILURE_THRESHOLD = 100
const MAX_CIRCUIT_COOLDOWN_MS = 3_600_000

export type RuntimeMiddlewarePolicy = Readonly<{
  hookTimeoutMs: number
  consecutiveFailureThreshold: number
  circuitCooldownMs: number
}>

export type RuntimeMiddlewarePolicyOptions = Partial<RuntimeMiddlewarePolicy>

type RuntimeMiddlewarePipelineOptions = RuntimeMiddlewarePolicyOptions &
  Readonly<{ now?: () => number }>

type RuntimeModelInvocationContext = Readonly<{
  sessionId: string
  runId: string
  turnId: string
  workspace: string
  provider: string
  model: string
  trace: Readonly<TraceContext>
  signal: AbortSignal
}>

type RuntimeToolInvocationContext = Readonly<{
  sessionId: string
  runId: string
  turnId: string
  workspace: string
  toolCallId: string
  toolName: string
  input: unknown
  descriptor?: Readonly<ToolExecutionDescriptor>
  trace: Readonly<TraceContext>
  signal: AbortSignal
}>

export type RuntimeModelMiddlewareContext = RuntimeModelInvocationContext &
  Readonly<{
    /** Aborted when this individual hook exceeds its configured deadline. */
    hookSignal: AbortSignal
  }>

export type RuntimeToolMiddlewareContext = RuntimeToolInvocationContext &
  Readonly<{
    /** Aborted when this individual hook exceeds its configured deadline. */
    hookSignal: AbortSignal
  }>

export type RuntimeToolCallUpdate = Readonly<{
  name?: string
  input?: Readonly<Record<string, unknown>>
}>

/** Trusted, in-process interception surface owned by the Runtime host. */
export type RuntimeMiddleware = Readonly<{
  name?: string
  /** Stable registry key required before this middleware may be inherited by a Child Runtime. */
  childId?: string
  beforeModel?(
    context: RuntimeModelMiddlewareContext,
    request: Readonly<ProviderRequest>,
  ): MaybePromise<undefined | ProviderRequest>
  afterModel?(
    context: RuntimeModelMiddlewareContext,
    result: Readonly<ProviderTurnResult>,
  ): MaybePromise<void>
  beforeTool?(
    context: RuntimeToolMiddlewareContext,
  ): MaybePromise<undefined | RuntimeToolCallUpdate>
  afterTool?(
    context: RuntimeToolMiddlewareContext,
    result: Readonly<ToolResult>,
  ): MaybePromise<undefined | ToolResult>
}>

/** Factories are evaluated independently in the authenticated Child process. */
export type RuntimeMiddlewareRegistry = Readonly<Record<string, () => RuntimeMiddleware>>

export type RuntimeMiddlewareHookHealth = Readonly<{
  calls: number
  successes: number
  failures: number
  timeouts: number
  circuitRejections: number
  totalDurationMs: number
  maxDurationMs: number
}>

export type RuntimeMiddlewareHealth = Readonly<{
  id: string
  name: string
  state: 'closed' | 'open' | 'half_open'
  consecutiveFailures: number
  openedAt?: string
  hooks: Readonly<Record<RuntimeMiddlewareHook, RuntimeMiddlewareHookHealth>>
}>

export type RuntimeMiddlewareHealthSnapshot = Readonly<{
  schemaVersion: 1
  active: boolean
  policy: RuntimeMiddlewarePolicy
  middleware: readonly RuntimeMiddlewareHealth[]
}>

export type ChildRuntimeMiddlewareProfile = Readonly<{
  ids: readonly string[]
  policy: RuntimeMiddlewarePolicy
}>

type MutableHookHealth = {
  calls: number
  successes: number
  failures: number
  timeouts: number
  circuitRejections: number
  totalDurationMs: number
  maxDurationMs: number
}

type MiddlewareEntry = {
  middleware: RuntimeMiddleware
  id: string
  name: string
  consecutiveFailures: number
  openedAt?: number
  halfOpen: boolean
  hooks: Record<RuntimeMiddlewareHook, MutableHookHealth>
}

const HOOKS = ['beforeModel', 'afterModel', 'beforeTool', 'afterTool'] as const
const DEADLINE_EXCEEDED = Symbol('runtime-middleware-deadline')

export class RuntimeMiddlewarePipeline {
  readonly #entries: readonly MiddlewareEntry[]
  readonly #policy: RuntimeMiddlewarePolicy
  readonly #now: () => number

  constructor(
    middleware: readonly RuntimeMiddleware[] = [],
    options: RuntimeMiddlewarePipelineOptions = {},
  ) {
    if (middleware.length > 128) {
      throw new TypeError('Runtime middleware is limited to 128 registrations.')
    }
    this.#policy = normalizeRuntimeMiddlewarePolicy(options)
    this.#now = options.now ?? Date.now
    const entries = middleware.map((item, index) => createMiddlewareEntry(item, index))
    if (new Set(entries.map(({ id }) => id)).size !== entries.length) {
      throw new TypeError('Runtime middleware IDs must be unique.')
    }
    this.#entries = Object.freeze(entries)
  }

  get active(): boolean {
    return this.#entries.length > 0
  }

  portableProfile(): ChildRuntimeMiddlewareProfile | undefined {
    const ids = this.#entries.flatMap(({ middleware }) =>
      middleware.childId === undefined ? [] : [middleware.childId],
    )
    if (ids.length === 0) return undefined
    if (ids.length > 32 || new Set(ids).size !== ids.length) {
      throw new TypeError('Child Runtime middleware IDs must be unique and limited to 32.')
    }
    return Object.freeze({ ids: Object.freeze(ids), policy: this.#policy })
  }

  snapshot(): RuntimeMiddlewareHealthSnapshot {
    const middleware = this.#entries.map((entry) => {
      const hooks = Object.fromEntries(
        HOOKS.map((hook) => [hook, Object.freeze({ ...entry.hooks[hook] })]),
      ) as Record<RuntimeMiddlewareHook, RuntimeMiddlewareHookHealth>
      return Object.freeze({
        id: entry.id,
        name: entry.name,
        state: circuitState(entry),
        consecutiveFailures: entry.consecutiveFailures,
        ...(entry.openedAt === undefined
          ? {}
          : { openedAt: new Date(entry.openedAt).toISOString() }),
        hooks: Object.freeze(hooks),
      })
    })
    return Object.freeze({
      schemaVersion: 1,
      active: this.active,
      policy: this.#policy,
      middleware: Object.freeze(middleware),
    })
  }

  async beforeModel(
    context: RuntimeModelInvocationContext,
    request: ProviderRequest,
  ): Promise<ProviderRequest> {
    let current = cloneProviderRequest(request)
    for (const entry of this.#entries) {
      if (entry.middleware.beforeModel === undefined) continue
      current = await this.#invoke(entry, 'beforeModel', async (hookSignal) => {
        const update = await entry.middleware.beforeModel!(
          readonlyModelContext(context, hookSignal),
          readonlyProviderRequest(current),
        )
        return update === undefined ? current : validateProviderRequest(update, request)
      })
    }
    return current
  }

  async afterModel(
    context: RuntimeModelInvocationContext,
    result: ProviderTurnResult,
  ): Promise<void> {
    const snapshot = readonlyProviderTurn(result)
    for (const entry of [...this.#entries].reverse()) {
      if (entry.middleware.afterModel === undefined) continue
      await this.#invoke(entry, 'afterModel', (hookSignal) =>
        entry.middleware.afterModel!(readonlyModelContext(context, hookSignal), snapshot),
      )
    }
  }

  async beforeTool(
    context: RuntimeToolInvocationContext,
    toolCall: ProviderToolCall,
  ): Promise<ProviderToolCall> {
    let current = cloneToolCall(toolCall)
    for (const entry of this.#entries) {
      if (entry.middleware.beforeTool === undefined) continue
      current = await this.#invoke(entry, 'beforeTool', async (hookSignal) => {
        const currentContext = readonlyToolContext(
          {
            ...context,
            toolName: current.name,
            input: readonlyValue(current.input),
          },
          hookSignal,
        )
        const update = await entry.middleware.beforeTool!(currentContext)
        if (update === undefined) return current
        return {
          ...current,
          ...(update.name === undefined ? {} : { name: requiredToolName(update.name) }),
          ...(update.input === undefined ? {} : { input: requiredToolInput(update.input) }),
        }
      })
    }
    return current
  }

  async afterTool(context: RuntimeToolInvocationContext, result: ToolResult): Promise<ToolResult> {
    let current = validateToolResult(result)
    for (const entry of [...this.#entries].reverse()) {
      if (entry.middleware.afterTool === undefined) continue
      current = await this.#invoke(entry, 'afterTool', async (hookSignal) => {
        const update = await entry.middleware.afterTool!(
          readonlyToolContext(context, hookSignal),
          readonlyToolResult(current),
        )
        return update === undefined ? current : validateToolResult(update)
      })
    }
    return current
  }

  async #invoke<T>(
    entry: MiddlewareEntry,
    hook: RuntimeMiddlewareHook,
    invoke: (hookSignal: AbortSignal) => MaybePromise<T>,
  ): Promise<T> {
    const now = this.#now()
    if (entry.openedAt !== undefined) {
      if (now - entry.openedAt < this.#policy.circuitCooldownMs || entry.halfOpen) {
        increment(entry.hooks[hook], 'circuitRejections')
        throw middlewareError(
          'RUNTIME_MIDDLEWARE_CIRCUIT_OPEN',
          entry,
          hook,
          'Runtime middleware circuit is open.',
        )
      }
      entry.halfOpen = true
    }

    const health = entry.hooks[hook]
    increment(health, 'calls')
    const startedAt = this.#now()
    const controller = new AbortController()
    let timer: NodeJS.Timeout | undefined
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort('runtime_middleware_timeout')
        reject(DEADLINE_EXCEEDED)
      }, this.#policy.hookTimeoutMs)
    })

    try {
      const result = await Promise.race([
        Promise.resolve().then(() => invoke(controller.signal)),
        deadline,
      ])
      increment(health, 'successes')
      entry.consecutiveFailures = 0
      entry.openedAt = undefined
      entry.halfOpen = false
      return result
    } catch (error) {
      increment(health, 'failures')
      const timedOut = error === DEADLINE_EXCEEDED
      if (timedOut) increment(health, 'timeouts')
      entry.consecutiveFailures = saturatingAdd(entry.consecutiveFailures, 1)
      if (entry.halfOpen || entry.consecutiveFailures >= this.#policy.consecutiveFailureThreshold) {
        entry.openedAt = this.#now()
      }
      entry.halfOpen = false
      if (timedOut) {
        throw middlewareError(
          'RUNTIME_MIDDLEWARE_TIMEOUT',
          entry,
          hook,
          'Runtime middleware exceeded its hook deadline.',
        )
      }
      throw middlewareError(
        'RUNTIME_MIDDLEWARE_FAILED',
        entry,
        hook,
        `Runtime middleware failed during ${hook}.`,
      )
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      const duration = Math.min(
        Number.MAX_SAFE_INTEGER,
        Math.max(0, Math.floor(this.#now() - startedAt)),
      )
      health.totalDurationMs = saturatingAdd(health.totalDurationMs, duration)
      health.maxDurationMs = Math.max(health.maxDurationMs, duration)
    }
  }
}

export function normalizeRuntimeMiddlewarePolicy(
  value: Partial<RuntimeMiddlewarePolicy> = {},
): RuntimeMiddlewarePolicy {
  return Object.freeze({
    hookTimeoutMs: boundedInteger(
      value.hookTimeoutMs,
      DEFAULT_POLICY.hookTimeoutMs,
      1,
      MAX_HOOK_TIMEOUT_MS,
      'hookTimeoutMs',
    ),
    consecutiveFailureThreshold: boundedInteger(
      value.consecutiveFailureThreshold,
      DEFAULT_POLICY.consecutiveFailureThreshold,
      1,
      MAX_FAILURE_THRESHOLD,
      'consecutiveFailureThreshold',
    ),
    circuitCooldownMs: boundedInteger(
      value.circuitCooldownMs,
      DEFAULT_POLICY.circuitCooldownMs,
      1,
      MAX_CIRCUIT_COOLDOWN_MS,
      'circuitCooldownMs',
    ),
  })
}

export function resolveRegisteredRuntimeMiddleware(
  ids: readonly string[],
  registry: RuntimeMiddlewareRegistry | undefined,
): readonly RuntimeMiddleware[] {
  if (registry === undefined) {
    throw new TypeError('Child Runtime middleware registry is unavailable.')
  }
  return Object.freeze(
    ids.map((id) => {
      const factory = Object.hasOwn(registry, id) ? registry[id] : undefined
      if (typeof factory !== 'function') {
        throw new TypeError(`Child Runtime middleware is not registered: ${id}.`)
      }
      const middleware = factory()
      validateMiddleware(middleware, id)
      if (middleware.childId !== undefined && middleware.childId !== id) {
        throw new TypeError(`Child Runtime middleware factory ID does not match: ${id}.`)
      }
      return middleware
    }),
  )
}

function createMiddlewareEntry(middleware: RuntimeMiddleware, index: number): MiddlewareEntry {
  validateMiddleware(middleware, `middleware-${index + 1}`)
  const id = middleware.childId ?? `middleware-${index + 1}`
  const name = boundedName(middleware.name ?? id)
  return {
    middleware: Object.freeze({ ...middleware }),
    id,
    name,
    consecutiveFailures: 0,
    halfOpen: false,
    hooks: Object.fromEntries(HOOKS.map((hook) => [hook, emptyHookHealth()])) as Record<
      RuntimeMiddlewareHook,
      MutableHookHealth
    >,
  }
}

function validateMiddleware(value: RuntimeMiddleware, fallbackId: string): void {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError(`Runtime middleware ${fallbackId} must be an object.`)
  }
  if (value.name !== undefined && (typeof value.name !== 'string' || value.name.length === 0)) {
    throw new TypeError(`Runtime middleware ${fallbackId} name must be a non-empty string.`)
  }
  if (value.childId !== undefined && !MIDDLEWARE_ID.test(value.childId)) {
    throw new TypeError(`Runtime middleware ${fallbackId} childId is invalid.`)
  }
  for (const hook of HOOKS) {
    if (value[hook] !== undefined && typeof value[hook] !== 'function') {
      throw new TypeError(`Runtime middleware ${fallbackId} ${hook} must be a function.`)
    }
  }
}

function emptyHookHealth(): MutableHookHealth {
  return {
    calls: 0,
    successes: 0,
    failures: 0,
    timeouts: 0,
    circuitRejections: 0,
    totalDurationMs: 0,
    maxDurationMs: 0,
  }
}

function circuitState(entry: MiddlewareEntry): RuntimeMiddlewareHealth['state'] {
  if (entry.halfOpen) return 'half_open'
  return entry.openedAt === undefined ? 'closed' : 'open'
}

function middlewareError(
  code:
    | 'RUNTIME_MIDDLEWARE_FAILED'
    | 'RUNTIME_MIDDLEWARE_TIMEOUT'
    | 'RUNTIME_MIDDLEWARE_CIRCUIT_OPEN',
  entry: MiddlewareEntry,
  hook: RuntimeMiddlewareHook,
  message: string,
): ReturnType<typeof runtimeError> {
  return runtimeError(code, 'configuration', message, {
    middleware: entry.name,
    middlewareId: entry.id,
    hook,
  })
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`Runtime middleware ${name} must be between ${minimum} and ${maximum}.`)
  }
  return value
}

function increment<T extends MutableHookHealth>(value: T, field: keyof T): void {
  if (typeof value[field] !== 'number') return
  ;(value[field] as number) = saturatingAdd(value[field] as number, 1)
}

function saturatingAdd(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right)
}

function validateProviderRequest(
  update: ProviderRequest,
  original: ProviderRequest,
): ProviderRequest {
  if (typeof update !== 'object' || update === null) {
    throw new TypeError('beforeModel must return a ProviderRequest object.')
  }
  if (update.signal !== original.signal) {
    throw new TypeError('beforeModel cannot replace the Runtime cancellation signal.')
  }
  if (update.model !== original.model) {
    throw new TypeError('beforeModel cannot replace the Runtime-selected model.')
  }
  if (!Array.isArray(update.messages) || !Array.isArray(update.tools)) {
    throw new TypeError('beforeModel must preserve Provider messages and Tool definitions.')
  }
  if (
    update.maxOutputTokens !== undefined &&
    (!Number.isSafeInteger(update.maxOutputTokens) || update.maxOutputTokens < 1)
  ) {
    throw new TypeError('beforeModel maxOutputTokens must be a positive integer.')
  }
  return cloneProviderRequest(update)
}

function cloneProviderRequest(request: ProviderRequest): ProviderRequest {
  return {
    ...request,
    messages: request.messages.map((message) => structuredClone(message)),
    ...(request.contextMessages === undefined
      ? {}
      : { contextMessages: request.contextMessages.map((message) => structuredClone(message)) }),
    tools: request.tools.map((tool) => structuredClone(tool)),
  }
}

function readonlyProviderRequest(request: ProviderRequest): Readonly<ProviderRequest> {
  return Object.freeze(cloneProviderRequest(request))
}

function readonlyModelContext(
  context: RuntimeModelInvocationContext,
  hookSignal: AbortSignal,
): RuntimeModelMiddlewareContext {
  return Object.freeze({
    ...context,
    trace: Object.freeze({ ...context.trace }),
    hookSignal,
  })
}

function readonlyToolContext(
  context: RuntimeToolInvocationContext,
  hookSignal: AbortSignal,
): RuntimeToolMiddlewareContext {
  return Object.freeze({
    ...context,
    input: readonlyValue(context.input),
    ...(context.descriptor === undefined
      ? {}
      : { descriptor: Object.freeze({ ...context.descriptor }) }),
    trace: Object.freeze({ ...context.trace }),
    hookSignal,
  })
}

function readonlyProviderTurn(result: ProviderTurnResult): Readonly<ProviderTurnResult> {
  return Object.freeze({
    ...result,
    content: Object.freeze(result.content.map((block) => Object.freeze(structuredClone(block)))),
    toolCalls: Object.freeze(result.toolCalls.map((call) => Object.freeze(cloneToolCall(call)))),
    ...(result.usage === undefined ? {} : { usage: Object.freeze({ ...result.usage }) }),
  }) as unknown as Readonly<ProviderTurnResult>
}

function cloneToolCall(toolCall: ProviderToolCall): ProviderToolCall {
  return { ...toolCall, input: structuredClone(toolCall.input) }
}

function requiredToolName(value: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 256) {
    throw new TypeError('beforeTool name must contain between 1 and 256 characters.')
  }
  return value
}

function requiredToolInput(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('beforeTool input must be a JSON object.')
  }
  return structuredClone(value) as Record<string, unknown>
}

function validateToolResult(result: ToolResult): ToolResult {
  if (
    typeof result !== 'object' ||
    result === null ||
    typeof result.ok !== 'boolean' ||
    typeof result.summary !== 'string'
  ) {
    throw new TypeError('afterTool must preserve the ToolResult envelope.')
  }
  if (
    result.error !== undefined &&
    (typeof result.error !== 'object' ||
      typeof result.error.code !== 'string' ||
      !['validation', 'permission', 'not_found', 'execution', 'truncated'].includes(
        result.error.category,
      ) ||
      typeof result.error.retryable !== 'boolean')
  ) {
    throw new TypeError('afterTool must preserve the ToolResult error envelope.')
  }
  return structuredClone(result)
}

function readonlyToolResult(result: ToolResult): Readonly<ToolResult> {
  return Object.freeze(validateToolResult(result))
}

function readonlyValue(value: unknown): unknown {
  const snapshot = structuredClone(value)
  return typeof snapshot === 'object' && snapshot !== null ? Object.freeze(snapshot) : snapshot
}

function boundedName(value: string): string {
  return value.slice(0, 128)
}
