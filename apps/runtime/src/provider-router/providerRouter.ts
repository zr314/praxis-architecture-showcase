import {
  type ChatProvider,
  isRuntimeError,
  type ProviderCapabilities,
  type ProviderChunk,
  type ProviderRequest,
  type ProviderTarget,
  type ProviderUsage,
  runtimeError,
  type TraceAttributes,
  type TraceContext,
  type TraceRecord,
} from '@praxis/core-sdk'
import { tokenizerForProvider } from '../memory/tokenizer.js'

export type ProviderLookup = (id: string) => Promise<ChatProvider | undefined>

export type ProviderRouterOptions = {
  modelCapabilities?: (providerId: string, modelId: string) => ProviderCapabilities | undefined
  fallbacks?: Record<string, ProviderTarget[]>
  retryAttempts?: number
  backoffBaseMs?: number
  backoffMaxMs?: number
  circuitFailureThreshold?: number
  circuitCooldownMs?: number
  random?: () => number
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>
  clock?: () => number
}

export type ProviderHealthSnapshot = {
  state: 'healthy' | 'degraded' | 'unhealthy' | 'circuit_open'
  consecutiveFailures: number
  circuitOpenedAt?: string
  rateLimit?: {
    remaining?: number
    resetMs?: number
    retryAfterMs?: number
  }
}

export type ProviderTraceBoundary = {
  context: TraceContext
  trace(record: Omit<TraceRecord, 'schemaVersion' | 'timestamp'>): Promise<void>
}

export type ProviderCandidate = {
  target: ProviderTarget
  provider: ChatProvider
  capabilities?: ProviderCapabilities
  candidateIndex: number
}

export type ProviderRequestPreparer = (
  candidate: ProviderCandidate,
  baseRequest: ProviderRequest,
) => ProviderRequest | Promise<ProviderRequest>

/** Selects provider candidates, enforces declared context limits, and owns bounded retry/fallback. */
export class ProviderRouter {
  private readonly fallbacks: Record<string, ProviderTarget[]>
  private readonly modelCapabilities?: ProviderRouterOptions['modelCapabilities']
  private readonly retryAttempts: number
  private readonly backoffBaseMs: number
  private readonly backoffMaxMs: number
  private readonly circuitFailureThreshold: number
  private readonly circuitCooldownMs: number
  private readonly random: () => number
  private readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>
  private readonly clock: () => number
  private readonly healthByProvider = new Map<
    string,
    {
      state: ProviderHealthSnapshot['state']
      consecutiveFailures: number
      circuitOpenedAt?: number
      rateLimit?: ProviderHealthSnapshot['rateLimit']
    }
  >()

  constructor(
    private readonly lookup: ProviderLookup,
    options: ProviderRouterOptions = {},
  ) {
    this.fallbacks = options.fallbacks ?? {}
    this.modelCapabilities = options.modelCapabilities
    this.retryAttempts = Math.max(0, Math.floor(options.retryAttempts ?? 1))
    this.backoffBaseMs = boundedInteger(options.backoffBaseMs ?? 25, 0, 60_000)
    this.backoffMaxMs = boundedInteger(options.backoffMaxMs ?? 2_000, this.backoffBaseMs, 120_000)
    this.circuitFailureThreshold = boundedInteger(options.circuitFailureThreshold ?? 3, 1, 100)
    this.circuitCooldownMs = boundedInteger(options.circuitCooldownMs ?? 30_000, 1, 3_600_000)
    this.random = options.random ?? Math.random
    this.sleep = options.sleep ?? abortableDelay
    this.clock = options.clock ?? Date.now
  }

  health(providerId: string): ProviderHealthSnapshot {
    const health = this.currentHealth(providerId)
    return {
      state: health.state,
      consecutiveFailures: health.consecutiveFailures,
      ...(health.circuitOpenedAt === undefined
        ? {}
        : { circuitOpenedAt: new Date(health.circuitOpenedAt).toISOString() }),
      ...(health.rateLimit ? { rateLimit: { ...health.rateLimit } } : {}),
    }
  }

  async *stream(
    primaryId: string,
    request: ProviderRequest,
    trace?: ProviderTraceBoundary,
    prepareRequest?: ProviderRequestPreparer,
    lookup: ProviderLookup = this.lookup,
  ): AsyncIterable<ProviderChunk> {
    const candidates: ProviderTarget[] = [
      { provider: primaryId, model: request.model },
      ...(this.fallbacks[primaryId] ?? []),
    ]
    let lastError: unknown
    let fallbackHealth: NonNullable<TraceAttributes['health']> = 'healthy'
    for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
      const target = candidates[candidateIndex]
      const candidateId = target.provider
      if (candidateIndex > 0) {
        await safeTrace(trace, {
          kind: 'provider.fallback',
          context: trace?.context,
          attributes: {
            providerId: candidateId,
            model: target.model,
            ...providerFailureAttributes(lastError),
            health: fallbackHealth,
          },
          metrics: { candidateIndex, attemptIndex: 0 },
        })
      }
      if (this.isCircuitOpen(candidateId)) {
        lastError = runtimeError(
          'PROVIDER_CIRCUIT_OPEN',
          'provider',
          'Provider circuit is temporarily open.',
          { providerId: candidateId },
          true,
        )
        fallbackHealth = 'unhealthy'
        continue
      }
      const provider = await lookup(candidateId)
      if (!provider) {
        lastError = runtimeError(
          'PROVIDER_UNAVAILABLE',
          'provider',
          'Configured provider is unavailable.',
          { providerId: candidateId },
        )
        fallbackHealth = 'unhealthy'
        continue
      }
      const capabilities = effectiveProviderCapabilities(
        provider.capabilities,
        this.modelCapabilities?.(candidateId, target.model),
      )
      const candidate: ProviderCandidate = {
        target,
        provider,
        capabilities,
        candidateIndex,
      }
      let candidateRequest: ProviderRequest | undefined
      for (let attempt = 0; attempt <= this.retryAttempts; attempt += 1) {
        let emitted = false
        let firstOutputTraced = false
        let completedChunkSeen = false
        let terminal = false
        let startedTrace = false
        let stopReason: string | undefined
        let usage: ProviderUsage | undefined
        const startedAt = Date.now()
        const traceCompleted = async () => {
          if (terminal) return
          terminal = true
          await safeTrace(trace, {
            kind: 'provider.completed',
            context: trace?.context,
            attributes: {
              providerId: candidateId,
              health: 'healthy',
              ...(stopReason === undefined ? {} : { stopReason }),
            },
            metrics: {
              durationMs: elapsed(startedAt),
              candidateIndex,
              attemptIndex: attempt,
              ...(usage?.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
              ...(usage?.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
              ...(usage?.cacheReadTokens === undefined
                ? {}
                : { cacheReadTokens: usage.cacheReadTokens }),
              ...(usage?.cacheWriteTokens === undefined
                ? {}
                : { cacheWriteTokens: usage.cacheWriteTokens }),
              ...(usage?.costUsd === undefined ? {} : { costUsd: usage.costUsd }),
            },
          })
        }
        const traceFailed = async (
          failure: ReturnType<typeof normalizeProviderError>,
          failureStopReason?: string,
          health: NonNullable<TraceAttributes['health']> = failure.retryable
            ? 'degraded'
            : 'unhealthy',
        ) => {
          if (terminal) return
          terminal = true
          await safeTrace(trace, {
            kind: 'provider.failed',
            context: trace?.context,
            attributes: {
              providerId: candidateId,
              errorCode: boundedErrorCode(failure.code),
              errorCategory: failure.category,
              health,
              ...(failureStopReason === undefined ? {} : { stopReason: failureStopReason }),
            },
            metrics: {
              durationMs: elapsed(startedAt),
              candidateIndex,
              attemptIndex: attempt,
            },
          })
        }
        try {
          if (!candidateRequest) {
            const prepared = prepareRequest ? await prepareRequest(candidate, request) : request
            candidateRequest = { ...prepared, model: target.model }
          }
          await safeTrace(trace, {
            kind: 'provider.started',
            context: trace?.context,
            attributes: { providerId: candidateId, model: target.model },
            metrics: { candidateIndex, attemptIndex: attempt },
          })
          startedTrace = true
          this.assertSupported(candidate, candidateRequest)
          for await (const chunk of provider.stream(candidateRequest)) {
            if (!firstOutputTraced && isProviderOutputChunk(chunk)) {
              await safeTrace(trace, {
                kind: 'provider.first_token',
                context: trace?.context,
                attributes: { providerId: candidateId, model: target.model },
                metrics: {
                  durationMs: elapsed(startedAt),
                  candidateIndex,
                  attemptIndex: attempt,
                },
              })
              firstOutputTraced = true
            }
            emitted = true
            if (chunk.type === 'completed') {
              completedChunkSeen = true
              stopReason = chunk.stopReason
              usage = chunk.usage
            }
            yield chunk
          }
          await traceCompleted()
          this.noteSuccess(candidateId)
          return
        } catch (error) {
          const failure = normalizeProviderError(
            error,
            candidateId,
            target.model,
            candidateRequest?.signal ?? request.signal,
          )
          lastError = failure
          if (affectsProviderHealth(failure)) this.noteFailure(candidateId, failure)
          fallbackHealth = traceHealth(this.health(candidateId).state)
          if (!startedTrace) {
            await safeTrace(trace, {
              kind: 'provider.started',
              context: trace?.context,
              attributes: { providerId: candidateId, model: target.model },
              metrics: { candidateIndex, attemptIndex: attempt },
            })
          }
          await traceFailed(failure, undefined, fallbackHealth)
          if (emitted) throw failure
          if (!failure.retryable || attempt === this.retryAttempts) break
          await safeTrace(trace, {
            kind: 'provider.retry',
            context: trace?.context,
            attributes: {
              providerId: candidateId,
              errorCode: boundedErrorCode(failure.code),
              errorCategory: failure.category,
              health: 'degraded',
            },
            metrics: { candidateIndex, attemptIndex: attempt + 1 },
          })
          await this.sleep(
            this.retryDelay(attempt, failure),
            candidateRequest?.signal ?? request.signal,
          )
        } finally {
          if (!terminal) {
            if (completedChunkSeen) {
              await traceCompleted()
            } else {
              const cancelled = request.signal.aborted
              await traceFailed(
                runtimeError(
                  cancelled ? 'PROVIDER_CANCELLED' : 'PROVIDER_CONSUMER_CLOSED',
                  'cancelled',
                  cancelled
                    ? 'The provider request was cancelled.'
                    : 'The provider stream consumer closed the active request.',
                  undefined,
                  false,
                ),
                cancelled ? 'cancelled' : 'consumer_closed',
                traceHealth(this.health(candidateId).state),
              )
            }
          }
        }
      }
      if (
        candidateIndex === candidates.length - 1 ||
        (isRuntimeError(lastError) && lastError.category === 'cancelled')
      ) {
        throw lastError
      }
    }
    throw (
      lastError ??
      runtimeError('PROVIDER_UNAVAILABLE', 'provider', 'No provider candidate is available.')
    )
  }

  private retryDelay(attempt: number, failure: ReturnType<typeof normalizeProviderError>): number {
    const retryAfter = numericData(failure.data, 'retryAfterMs')
    if (retryAfter !== undefined) return Math.min(retryAfter, this.backoffMaxMs)
    const exponential = Math.min(this.backoffMaxMs, this.backoffBaseMs * 2 ** attempt)
    const jitter = 0.5 + Math.min(1, Math.max(0, this.random())) * 0.5
    return Math.round(exponential * jitter)
  }

  private currentHealth(providerId: string) {
    const health = this.healthByProvider.get(providerId) ?? {
      state: 'healthy' as const,
      consecutiveFailures: 0,
    }
    if (
      health.state === 'circuit_open' &&
      health.circuitOpenedAt !== undefined &&
      this.clock() - health.circuitOpenedAt >= this.circuitCooldownMs
    ) {
      health.state = 'degraded'
      health.circuitOpenedAt = undefined
      this.healthByProvider.set(providerId, health)
    }
    return health
  }

  private isCircuitOpen(providerId: string): boolean {
    return this.currentHealth(providerId).state === 'circuit_open'
  }

  private noteSuccess(providerId: string): void {
    this.healthByProvider.set(providerId, { state: 'healthy', consecutiveFailures: 0 })
  }

  private noteFailure(
    providerId: string,
    failure: ReturnType<typeof normalizeProviderError>,
  ): void {
    const previous = this.currentHealth(providerId)
    const consecutiveFailures = previous.consecutiveFailures + 1
    const circuitOpen = failure.retryable && consecutiveFailures >= this.circuitFailureThreshold
    this.healthByProvider.set(providerId, {
      state: circuitOpen ? 'circuit_open' : failure.retryable ? 'degraded' : 'unhealthy',
      consecutiveFailures,
      ...(circuitOpen ? { circuitOpenedAt: this.clock() } : {}),
      rateLimit: {
        remaining: numericData(failure.data, 'rateLimitRemaining'),
        resetMs: numericData(failure.data, 'rateLimitResetMs'),
        retryAfterMs: numericData(failure.data, 'retryAfterMs'),
      },
    })
  }

  private assertSupported(candidate: ProviderCandidate, request: ProviderRequest): void {
    const capabilities = candidate.capabilities
    const providerId = candidate.target.provider
    const auth = candidate.provider.authState()
    if (auth.status === 'unauthenticated' || auth.status === 'expired') {
      throw runtimeError(
        'PROVIDER_AUTH_REQUIRED',
        'provider',
        'The Provider requires a valid credential. Reconnect the Provider and try again.',
        { providerId },
      )
    }
    if (auth.status === 'unavailable') {
      throw runtimeError(
        'PROVIDER_UNAVAILABLE',
        'provider',
        'The Provider credential service is temporarily unavailable.',
        { providerId },
        true,
      )
    }
    if (request.tools.length > 0 && capabilities?.tools.mode === 'none') {
      throw runtimeError(
        'PROVIDER_CAPABILITY_UNSUPPORTED',
        'provider',
        'The selected provider does not support tools.',
        {
          providerId,
        },
      )
    }
    if (request.responseFormat && capabilities?.output.jsonSchema === false) {
      throw runtimeError(
        'PROVIDER_CAPABILITY_UNSUPPORTED',
        'provider',
        'The selected provider-model candidate does not support JSON Schema output.',
        { providerId, model: candidate.target.model, unsupportedFeatures: ['json_schema'] },
      )
    }
    const unsupportedBlocks = unsupportedContentBlocks(request, capabilities)
    if (unsupportedBlocks.length > 0) {
      throw runtimeError(
        'PROVIDER_CAPABILITY_UNSUPPORTED',
        'provider',
        `The selected provider-model candidate cannot preserve these content blocks: ${unsupportedBlocks.join(', ')}.`,
        {
          providerId,
          model: candidate.target.model,
          unsupportedBlocks,
        },
      )
    }
    const maximum = capabilities?.limits.maxContextTokens
    if (maximum !== undefined) {
      const tokens = estimateRequestTokens(request, providerId)
      if (tokens > maximum) {
        throw runtimeError(
          'PROVIDER_CONTEXT_LIMIT',
          'provider',
          'The selected provider context limit would be exceeded.',
          {
            providerId,
            maximum,
            tokens,
          },
        )
      }
    }
  }
}

function isProviderOutputChunk(chunk: ProviderChunk): boolean {
  return (
    chunk.type === 'text_delta' ||
    chunk.type === 'reasoning_delta' ||
    chunk.type === 'tool_call_start' ||
    chunk.type === 'tool_call_delta' ||
    chunk.type === 'tool_call_end' ||
    chunk.type === 'tool_calls'
  )
}

function estimateRequestTokens(request: ProviderRequest, providerId: string): number {
  const tokenizer = tokenizerForProvider(providerId)
  return (
    tokenizer.countText(request.instructions ?? '') +
    tokenizer.countText(JSON.stringify(request.tools)) +
    (request.contextMessages ?? []).reduce(
      (total, message) => total + tokenizer.countMessage(message),
      0,
    ) +
    request.messages.reduce((total, message) => total + tokenizer.countMessage(message), 0)
  )
}

export function effectiveProviderCapabilities(
  adapter: ProviderCapabilities | undefined,
  model: ProviderCapabilities | undefined,
): ProviderCapabilities | undefined {
  if (!adapter) return model
  if (!model) return adapter
  return {
    streaming: {
      text: adapter.streaming.text && model.streaming.text,
      reasoning: adapter.streaming.reasoning && model.streaming.reasoning,
      usage: adapter.streaming.usage && model.streaming.usage,
    },
    tools: {
      mode: intersectToolMode(adapter.tools.mode, model.tools.mode),
      parallelCalls: adapter.tools.parallelCalls && model.tools.parallelCalls,
    },
    modalities: {
      text: adapter.modalities.text && model.modalities.text,
      vision: adapter.modalities.vision && model.modalities.vision,
      audio: adapter.modalities.audio && model.modalities.audio,
    },
    output: {
      jsonSchema: adapter.output.jsonSchema && model.output.jsonSchema,
      citations: adapter.output.citations && model.output.citations,
    },
    limits: {
      maxContextTokens: intersectLimit(
        adapter.limits.maxContextTokens,
        model.limits.maxContextTokens,
      ),
      maxOutputTokens: intersectLimit(adapter.limits.maxOutputTokens, model.limits.maxOutputTokens),
    },
  }
}

function intersectToolMode(
  left: ProviderCapabilities['tools']['mode'],
  right: ProviderCapabilities['tools']['mode'],
): ProviderCapabilities['tools']['mode'] {
  if (left === 'none' || right === 'none') return 'none'
  if (left === 'emulated' || right === 'emulated') return 'emulated'
  return 'native'
}

function intersectLimit(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) return right
  if (right === undefined) return left
  return Math.min(left, right)
}

function unsupportedContentBlocks(
  request: ProviderRequest,
  capabilities: ProviderCapabilities | undefined,
): string[] {
  if (!capabilities) return []
  const unsupported = new Set<string>()
  for (const message of [...(request.contextMessages ?? []), ...request.messages]) {
    if (typeof message.content === 'string') continue
    for (const block of message.content) {
      if (block.type === 'image_ref' && !capabilities.modalities.vision) {
        unsupported.add(block.type)
      }
      if (block.type === 'audio_ref' && !capabilities.modalities.audio) {
        unsupported.add(block.type)
      }
    }
  }
  return [...unsupported].sort()
}

function normalizeProviderError(
  error: unknown,
  providerId?: string,
  model?: string,
  signal?: AbortSignal,
) {
  if (signal?.aborted || isAbortError(error)) {
    return runtimeError(
      'PROVIDER_CANCELLED',
      'cancelled',
      'The provider request was cancelled.',
      providerDiagnosticData(providerId, model),
    )
  }
  const status = providerStatus(error)
  const vendorCode = providerCode(error)
  if (isRuntimeError(error) && error.code !== 'PROVIDER_HTTP_ERROR' && status === undefined) {
    return error
  }
  const diagnostic = {
    ...providerDiagnosticData(providerId, model),
    ...(status === undefined ? {} : { status }),
    ...providerRateLimitData(error),
  }
  if (status === 401 || /auth|unauthorized|invalid[_ -]?key/i.test(vendorCode)) {
    return runtimeError(
      'PROVIDER_AUTH_REQUIRED',
      'provider',
      'The Provider rejected its credential. Reconnect the Provider and try again.',
      diagnostic,
    )
  }
  if (status === 429 || /rate[_ -]?limit|too[_ -]?many/i.test(vendorCode)) {
    return runtimeError(
      'PROVIDER_RATE_LIMITED',
      'provider',
      'The Provider rate limit was reached.',
      diagnostic,
      true,
    )
  }
  if (
    status === 402 ||
    /account|billing|payment|quota[_ -]?(exceeded|exhausted)|insufficient[_ -]?(credit|fund)/i.test(
      vendorCode,
    )
  ) {
    return runtimeError(
      'PROVIDER_ACCOUNT_UNAVAILABLE',
      'provider',
      'The Provider account cannot serve this request. Verify billing, quota, and account access.',
      diagnostic,
    )
  }
  if (
    status === 403 ||
    status === 404 ||
    /model|not[_ -]?found|model[_ -]?access|permission/i.test(vendorCode)
  ) {
    return runtimeError(
      'PROVIDER_MODEL_UNAVAILABLE',
      'provider',
      'The selected model is unavailable to this Provider account. Choose another model or verify account access.',
      diagnostic,
    )
  }
  if (
    /context|maximum[_ -]?context|context[_ -]?length|too[_ -]?many[_ -]?tokens/i.test(vendorCode)
  ) {
    return runtimeError(
      'PROVIDER_CONTEXT_LIMIT',
      'provider',
      'The selected provider context limit would be exceeded.',
      diagnostic,
    )
  }
  if (status !== undefined && status >= 400 && status < 500) {
    return runtimeError(
      'PROVIDER_REQUEST_INVALID',
      'provider',
      'The Provider rejected the request. Check model and Tool compatibility.',
      { ...diagnostic, ...(vendorCode === '' ? {} : { vendorCode }) },
    )
  }
  if (isTransportError(error)) {
    return runtimeError(
      'PROVIDER_TRANSPORT_ERROR',
      'provider',
      'The Provider connection failed before the response completed.',
      diagnostic,
      true,
    )
  }
  if (status !== undefined && status >= 500) {
    return runtimeError(
      'PROVIDER_UNAVAILABLE',
      'provider',
      'The Provider is temporarily unavailable.',
      diagnostic,
      true,
    )
  }
  if (isRuntimeError(error)) return error
  return runtimeError(
    'PROVIDER_ERROR',
    'provider',
    'The provider request failed.',
    providerDiagnosticData(providerId, model),
  )
}

function providerStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined
  const direct = 'status' in error ? error.status : undefined
  if (typeof direct === 'number' && Number.isInteger(direct)) return direct
  const data = 'data' in error ? error.data : undefined
  if (data && typeof data === 'object' && 'status' in data) {
    const nested = data.status
    if (typeof nested === 'number' && Number.isInteger(nested)) return nested
  }
  const response = 'response' in error ? error.response : undefined
  if (response && typeof response === 'object' && 'status' in response) {
    const nested = response.status
    if (typeof nested === 'number' && Number.isInteger(nested)) return nested
  }
  return undefined
}

function providerDiagnosticData(
  providerId: string | undefined,
  model: string | undefined,
): Record<string, unknown> {
  return {
    ...(providerId ? { providerId } : {}),
    ...(model ? { model } : {}),
  }
}

function providerRateLimitData(error: unknown): Record<string, number> {
  if (!error || typeof error !== 'object') return {}
  const data =
    'data' in error && error.data && typeof error.data === 'object'
      ? (error.data as Record<string, unknown>)
      : {}
  const result: Record<string, number> = {}
  for (const key of ['retryAfterMs', 'rateLimitRemaining', 'rateLimitResetMs'] as const) {
    const value = data[key]
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) result[key] = value
  }
  return result
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const record = error as Record<string, unknown>
  return (
    record.name === 'AbortError' ||
    record.code === 'ABORT_ERR' ||
    record.code === 'ERR_ABORTED' ||
    record.code === 'PROVIDER_CANCELLED'
  )
}

function isTransportError(error: unknown): boolean {
  return /^(ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|EPIPE|EHOSTUNREACH|UND_ERR_(?:CONNECT_TIMEOUT|HEADERS_TIMEOUT|BODY_TIMEOUT|SOCKET|ABORTED|DESTROYED|CLOSED))$/.test(
    providerCode(error),
  )
}

function affectsProviderHealth(failure: ReturnType<typeof normalizeProviderError>): boolean {
  if (failure.category === 'cancelled') return false
  return ![
    'PROVIDER_AUTH_REQUIRED',
    'PROVIDER_ACCOUNT_UNAVAILABLE',
    'PROVIDER_MODEL_UNAVAILABLE',
    'PROVIDER_CONTEXT_LIMIT',
    'PROVIDER_CAPABILITY_UNSUPPORTED',
  ].includes(failure.code)
}

function traceHealth(
  health: ProviderHealthSnapshot['state'],
): NonNullable<TraceAttributes['health']> {
  return health === 'circuit_open' ? 'unhealthy' : health
}

function providerCode(error: unknown): string {
  let current = error
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth += 1) {
    const record = current as Record<string, unknown>
    for (const key of ['code', 'type'] as const) {
      const value = record[key]
      if (typeof value === 'string') return value.slice(0, 128)
    }
    current = record.cause
  }
  return ''
}

type TraceInput = Omit<TraceRecord, 'schemaVersion' | 'timestamp'>

async function safeTrace(
  boundary: ProviderTraceBoundary | undefined,
  input: Omit<TraceInput, 'context'> & { context?: TraceContext },
): Promise<void> {
  if (!boundary) return
  try {
    await boundary.trace({ ...input, context: boundary.context })
  } catch {
    // Tracing is diagnostic-only and cannot change Provider routing.
  }
}

function providerFailureAttributes(error: unknown): {
  errorCode: string
  errorCategory: string
} {
  const failure = normalizeProviderError(error)
  return {
    errorCode: boundedErrorCode(failure.code),
    errorCategory: failure.category,
  }
}

function boundedErrorCode(code: string): string {
  return /^[A-Z0-9_]{1,64}$/.test(code) ? code : 'PROVIDER_ERROR'
}

function elapsed(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt)
}

function numericData(data: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = data?.[key]
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function boundedInteger(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.floor(value)))
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(runtimeError('PROVIDER_CANCELLED', 'cancelled', 'Provider request was cancelled.'))
      return
    }
    const timeout = setTimeout(resolve, milliseconds)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout)
        reject(runtimeError('PROVIDER_CANCELLED', 'cancelled', 'Provider request was cancelled.'))
      },
      { once: true },
    )
  })
}
