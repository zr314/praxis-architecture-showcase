import { createHash } from 'node:crypto'
import { providerToolCalls, runtimeError } from '@praxis/core-sdk'
import OpenAI from 'openai'
import type {
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions'
import { type LongDurationTimer, scheduleLongDurationTimer } from '../longDurationTimer.js'
import { providerContentText } from './contentConversion.js'
import type { ChatProvider, ProviderCapabilities, ProviderChunk, ProviderRequest } from './types.js'

export type OpenAICompatibleProviderOptions = {
  id: string
  apiKey?: string
  baseURL: string
  defaultModel: string
  accountLabel?: string
  timeoutMs?: number
  noProgressTimeoutMs?: number
  capabilities?: ProviderCapabilities
  defaultHeaders?: Record<string, string>
  defaultBody?: Record<string, unknown>
}

const DEFAULT_CAPABILITIES: ProviderCapabilities = {
  streaming: { text: true, reasoning: true, usage: true },
  tools: { mode: 'native', parallelCalls: true },
  modalities: { text: true, vision: false, audio: false },
  output: { jsonSchema: true, citations: false },
  limits: {},
}

/** OpenAI Chat Completions protocol adapter used by Kimi and local endpoints. */
export class OpenAICompatibleProvider implements ChatProvider {
  readonly contractVersion = 2 as const
  readonly id: string
  readonly defaultModel: string
  readonly capabilities: ProviderCapabilities
  protected client?: OpenAI
  readonly #accountLabel?: string
  readonly #baseURL: string
  readonly #timeoutMs?: number
  readonly #noProgressTimeoutMs?: number
  readonly #defaultHeaders?: Record<string, string>
  readonly #defaultBody?: Record<string, unknown>

  constructor(options: OpenAICompatibleProviderOptions) {
    this.id = options.id
    this.defaultModel = options.defaultModel
    this.capabilities = options.capabilities ?? DEFAULT_CAPABILITIES
    this.#accountLabel = options.accountLabel
    this.#baseURL = options.baseURL
    this.#timeoutMs = options.timeoutMs
    this.#noProgressTimeoutMs = options.noProgressTimeoutMs
    this.#defaultHeaders = options.defaultHeaders
    this.#defaultBody = options.defaultBody ? { ...options.defaultBody } : undefined
    this.configureCredential('apiKey', options.apiKey)
  }

  authState() {
    return this.client
      ? {
          status: 'authenticated' as const,
          ...(this.#accountLabel ? { accountLabel: this.#accountLabel } : {}),
        }
      : { status: 'unauthenticated' as const }
  }

  configureCredential(name: string, value: string | undefined): void {
    if (name !== 'apiKey') return
    this.client = value
      ? new OpenAITransportWithoutImplicitTimeout({
          apiKey: value,
          baseURL: this.#baseURL,
          // The SDK requires a numeric value but its implicit native timer is
          // intentionally bypassed below. Praxis owns only explicitly
          // configured, overflow-safe timeout policy.
          timeout: this.#timeoutMs ?? OpenAI.DEFAULT_TIMEOUT,
          maxRetries: 0,
          defaultHeaders: this.#defaultHeaders,
        })
      : undefined
  }

  async *stream(request: ProviderRequest): AsyncIterable<ProviderChunk> {
    if (!this.client) throw new Error(`${this.id} credentials are not configured.`)
    const toolNames = openAICompatibleToolNames(request.tools.map(({ name }) => name))
    const controller = new AbortController()
    let timeoutPhase: 'total' | 'no_progress' | undefined
    let noProgressTimer: LongDurationTimer | undefined
    const abortForTimeout = (phase: 'total' | 'no_progress') => {
      if (timeoutPhase === undefined) timeoutPhase = phase
      controller.abort()
    }
    const totalTimer =
      this.#timeoutMs === undefined
        ? undefined
        : scheduleLongDurationTimer(() => abortForTimeout('total'), this.#timeoutMs)
    const armNoProgress = () => {
      noProgressTimer?.cancel()
      noProgressTimer =
        this.#noProgressTimeoutMs === undefined
          ? undefined
          : scheduleLongDurationTimer(
              () => abortForTimeout('no_progress'),
              this.#noProgressTimeoutMs,
            )
    }
    const clearNoProgress = () => {
      noProgressTimer?.cancel()
      noProgressTimer = undefined
    }
    const relayAbort = () => controller.abort(request.signal.reason)
    if (request.signal.aborted) relayAbort()
    else request.signal.addEventListener('abort', relayAbort, { once: true })

    try {
      armNoProgress()
      const stream = await this.client.chat.completions.create(
        this.requestBody(request, toolNames.toWire),
        { signal: controller.signal },
      )
      clearNoProgress()

      yield { type: 'message_start' }
      const startedText = new Set<number>()
      const startedReasoning = new Set<number>()
      const pendingTools = new Set<number>()
      let stopReason: string | undefined
      let usage: Record<string, number | undefined> = {}
      const iterator = stream[Symbol.asyncIterator]()
      while (true) {
        armNoProgress()
        const next = await iterator.next()
        clearNoProgress()
        if (next.done) break
        const chunk = next.value
        if (chunk.usage) {
          usage = {
            inputTokens: chunk.usage.prompt_tokens,
            outputTokens: chunk.usage.completion_tokens,
            cacheReadTokens: openAICompatibleCacheReadTokens(chunk.usage),
          }
        }
        const choice = chunk.choices[0]
        if (!choice) continue
        const contentIndex = choice.index
        if (choice.delta.content) {
          if (!startedText.has(contentIndex)) {
            startedText.add(contentIndex)
            yield { type: 'text_start', contentIndex }
          }
          yield { type: 'text_delta', contentIndex, text: choice.delta.content }
        }
        const reasoning = reasoningDelta(choice.delta)
        if (reasoning) {
          if (!startedReasoning.has(contentIndex)) {
            startedReasoning.add(contentIndex)
            yield { type: 'reasoning_start', contentIndex: contentIndex + 10_000 }
          }
          yield {
            type: 'reasoning_delta',
            contentIndex: contentIndex + 10_000,
            text: reasoning,
          }
        }
        for (const toolCall of choice.delta.tool_calls ?? []) {
          if (!pendingTools.has(toolCall.index)) {
            pendingTools.add(toolCall.index)
            yield {
              type: 'tool_call_start',
              index: toolCall.index,
              id: toolCall.id ?? `${this.id}-tool-${toolCall.index}`,
              name: toolNames.fromWire(toolCall.function?.name ?? 'unknown'),
            }
          }
          if (toolCall.function?.arguments) {
            yield {
              type: 'tool_call_delta',
              index: toolCall.index,
              argumentsDelta: toolCall.function.arguments,
            }
          }
        }
        if (choice.finish_reason) stopReason = choice.finish_reason
      }
      // Some OpenAI-compatible SDK transports resolve the iterator as done
      // after AbortController.abort() instead of rejecting it. Never turn that
      // clean-looking close into a truncated Tool call or a false completed
      // stream; preserve the actual timeout classification.
      if (timeoutPhase !== undefined)
        throw providerTimeout(this.id, timeoutPhase, this.#timeoutMs, this.#noProgressTimeoutMs)
      for (const index of startedText) yield { type: 'text_end', contentIndex: index }
      for (const index of startedReasoning) {
        yield { type: 'reasoning_end', contentIndex: index + 10_000 }
      }
      for (const index of [...pendingTools].sort((left, right) => left - right)) {
        yield { type: 'tool_call_end', index }
      }
      yield { type: 'completed', stopReason, usage }
    } catch (error) {
      if (timeoutPhase !== undefined) {
        throw providerTimeout(this.id, timeoutPhase, this.#timeoutMs, this.#noProgressTimeoutMs)
      }
      throw error
    } finally {
      totalTimer?.cancel()
      clearNoProgress()
      request.signal.removeEventListener('abort', relayAbort)
    }
  }

  protected requestBodyDefaults(_request: ProviderRequest): Record<string, unknown> {
    return this.#defaultBody === undefined ? {} : { ...this.#defaultBody }
  }

  /** Vendor-specific fields that must be attached to persisted message history. */
  protected messageBodyExtras(
    _message: ProviderRequest['messages'][number],
    _request: ProviderRequest,
  ): Record<string, unknown> {
    return {}
  }

  /** Final request construction hook for compatible APIs with small protocol differences. */
  protected requestBody(
    request: ProviderRequest,
    toWireToolName: (name: string) => string,
  ): ChatCompletionCreateParamsStreaming & Record<string, unknown> {
    return openAICompatibleRequestBody(
      request,
      this.requestBodyDefaults(request),
      toWireToolName,
      (message) => this.messageBodyExtras(message, request),
    )
  }
}

function providerTimeout(
  providerId: string,
  phase: 'total' | 'no_progress',
  totalTimeoutMs: number | undefined,
  noProgressTimeoutMs: number | undefined,
) {
  const timeoutMs = (phase === 'total' ? totalTimeoutMs : noProgressTimeoutMs)!
  return runtimeError(
    'PROVIDER_TIMEOUT',
    'provider',
    `${providerId} stream timed out during ${phase.replace('_', ' ')} after ${timeoutMs}ms.`,
    { phase, timeoutMs },
    true,
  )
}

/**
 * The OpenAI SDK always installs a ten-minute native timer, even when Praxis
 * does not request one. Override only that transport detail; caller abort
 * signals and explicitly configured Praxis timers remain authoritative.
 */
class OpenAITransportWithoutImplicitTimeout extends OpenAI {
  override async fetchWithTimeout(
    url: RequestInfo,
    init: RequestInit | undefined,
    _ms: number,
    controller: AbortController,
  ): Promise<Response> {
    const { signal, method, ...options } = init ?? {}
    const relayAbort = () => controller.abort(signal?.reason)
    if (signal?.aborted) relayAbort()
    else signal?.addEventListener('abort', relayAbort, { once: true })
    const isReadableBody =
      typeof ReadableStream !== 'undefined' && options.body instanceof ReadableStream
    const fetchOptions: RequestInit & { duplex?: 'half' } = {
      signal: controller.signal,
      ...(isReadableBody ? { duplex: 'half' as const } : {}),
      method: method?.toUpperCase() ?? 'GET',
      ...options,
    }
    try {
      return await globalThis.fetch(url, fetchOptions)
    } finally {
      signal?.removeEventListener('abort', relayAbort)
    }
  }
}

export function openAICompatibleRequestBody(
  request: ProviderRequest,
  defaults: Record<string, unknown> = {},
  toWireToolName: (name: string) => string = openAICompatibleToolName,
  messageBodyExtras: (
    message: ProviderRequest['messages'][number],
  ) => Record<string, unknown> = () => ({}),
): ChatCompletionCreateParamsStreaming & Record<string, unknown> {
  return {
    ...defaults,
    model: request.model,
    messages: [
      ...(request.instructions ? [{ role: 'system' as const, content: request.instructions }] : []),
      ...(request.contextMessages ?? []).map((message) =>
        toOpenAIMessage(message, toWireToolName, messageBodyExtras(message)),
      ),
      ...request.messages.map((message) =>
        toOpenAIMessage(message, toWireToolName, messageBodyExtras(message)),
      ),
    ],
    ...(request.tools.length === 0
      ? {}
      : {
          tools: request.tools.map((tool) => ({
            type: 'function' as const,
            function: {
              name: toWireToolName(tool.name),
              description: tool.description,
              parameters: openAICompatibleJsonSchema(tool.parameters),
            },
          })),
          ...(request.toolChoice === undefined
            ? {}
            : {
                tool_choice:
                  typeof request.toolChoice === 'string'
                    ? request.toolChoice
                    : {
                        type: 'function' as const,
                        function: { name: toWireToolName(request.toolChoice.name) },
                      },
              }),
        }),
    stream: true,
    stream_options: { include_usage: true },
    ...(request.maxOutputTokens ? { max_tokens: request.maxOutputTokens } : {}),
    ...(request.responseFormat
      ? {
          response_format: {
            type: 'json_schema' as const,
            json_schema: {
              name: request.responseFormat.name,
              schema: request.responseFormat.schema,
              strict: request.responseFormat.strict ?? true,
            },
          },
        }
      : {}),
  } as ChatCompletionCreateParamsStreaming & Record<string, unknown>
}

export function createLocalOpenAICompatibleProvider(
  environment: NodeJS.ProcessEnv = process.env,
): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    id: 'openai-compatible',
    apiKey: environment.PRAXIS_OPENAI_COMPATIBLE_API_KEY ?? 'local',
    baseURL:
      environment.PRAXIS_OPENAI_COMPATIBLE_URL ??
      environment.OPENAI_BASE_URL ??
      'http://127.0.0.1:11434/v1',
    defaultModel: environment.PRAXIS_OPENAI_COMPATIBLE_MODEL ?? 'local-model',
    accountLabel: 'Local OpenAI-compatible endpoint',
  })
}

function toOpenAIMessage(
  message: ProviderRequest['messages'][number],
  toWireToolName: (name: string) => string,
  extras: Record<string, unknown> = {},
): ChatCompletionMessageParam {
  if (message.role === 'tool') {
    return {
      role: 'tool',
      tool_call_id: message.toolCallId,
      content: providerContentText(message.content),
      ...extras,
    }
  }
  const toolCalls = providerToolCalls(message)
  if (message.role === 'assistant' && toolCalls.length > 0) {
    return {
      role: 'assistant',
      content: providerContentText(message.content) || null,
      tool_calls: toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: toWireToolName(call.name), arguments: JSON.stringify(call.input) },
      })),
      ...extras,
    } as ChatCompletionMessageParam
  }
  return {
    role: message.role,
    content: providerContentText(message.content),
    ...extras,
  } as ChatCompletionMessageParam
}

const OPENAI_TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/u

/**
 * OpenAI-compatible APIs reject Praxis' namespaced Tool names because dots are
 * not legal function-name characters. Keep names stable inside Runtime and use
 * a deterministic, collision-resistant wire alias at the Provider boundary.
 */
export function openAICompatibleToolName(name: string): string {
  if (OPENAI_TOOL_NAME.test(name)) return name
  const visible =
    name
      .normalize('NFKC')
      .replace(/[^A-Za-z0-9_-]+/gu, '_')
      .replace(/^_+|_+$/gu, '')
      .slice(0, 40) || 'tool'
  const digest = createHash('sha256').update(name).digest('hex').slice(0, 12)
  return `praxis_${visible}_${digest}`
}

/** Adds explicit structural/enum types required by stricter OpenAI-compatible vendors. */
export function openAICompatibleJsonSchema(
  schema: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const normalized: Record<string, unknown> = { ...schema }
  if (isRecord(schema.properties)) {
    normalized.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([key, value]) => [
        key,
        isRecord(value) ? openAICompatibleJsonSchema(value) : value,
      ]),
    )
  }
  if (isRecord(schema.items)) normalized.items = openAICompatibleJsonSchema(schema.items)
  if (isRecord(schema.additionalProperties)) {
    normalized.additionalProperties = openAICompatibleJsonSchema(schema.additionalProperties)
  }
  for (const keyword of ['allOf', 'anyOf', 'oneOf'] as const) {
    const branches = schema[keyword]
    if (Array.isArray(branches)) {
      normalized[keyword] = branches.map((branch) =>
        isRecord(branch) ? openAICompatibleJsonSchema(branch) : branch,
      )
    }
  }
  if (schema.type === undefined) {
    const inferred = inferredJsonSchemaType(schema)
    if (inferred !== undefined) normalized.type = inferred
  }
  return normalized
}

function openAICompatibleToolNames(names: readonly string[]): Readonly<{
  toWire(name: string): string
  fromWire(name: string): string
}> {
  const byInternal = new Map<string, string>()
  const byWire = new Map<string, string>()
  for (const name of names) {
    let wireName = openAICompatibleToolName(name)
    let collision = 0
    while (byWire.has(wireName) && byWire.get(wireName) !== name) {
      const digest = createHash('sha256').update(`${name}:${collision}`).digest('hex').slice(0, 55)
      wireName = `praxis_${digest}`
      collision += 1
    }
    byInternal.set(name, wireName)
    byWire.set(wireName, name)
  }
  return {
    toWire: (name) => byInternal.get(name) ?? openAICompatibleToolName(name),
    fromWire: (name) => byWire.get(name) ?? name,
  }
}

function inferredJsonSchemaType(schema: Readonly<Record<string, unknown>>): string | undefined {
  if (
    schema.properties !== undefined ||
    schema.required !== undefined ||
    schema.additionalProperties !== undefined
  ) {
    return 'object'
  }
  if (schema.items !== undefined) return 'array'
  if (!Array.isArray(schema.enum) || schema.enum.length === 0) return undefined
  const kinds = new Set(
    schema.enum.map((value) =>
      typeof value === 'number' && Number.isInteger(value) ? 'integer' : typeof value,
    ),
  )
  return kinds.size === 1 && !kinds.has('object') && !kinds.has('undefined')
    ? [...kinds][0]
    : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function reasoningDelta(delta: object): string | undefined {
  const value = delta as Record<string, unknown>
  const reasoning = value.reasoning_content ?? value.reasoning
  return typeof reasoning === 'string' ? reasoning : undefined
}

/** Normalizes cache-hit usage from OpenAI and compatible vendor dialects. */
export function openAICompatibleCacheReadTokens(usage: object): number | undefined {
  const compatible = usage as {
    prompt_tokens_details?: { cached_tokens?: number }
    prompt_cache_hit_tokens?: number
    cache_read_input_tokens?: number
  }
  const candidates = [
    compatible.prompt_tokens_details?.cached_tokens,
    compatible.prompt_cache_hit_tokens,
    compatible.cache_read_input_tokens,
  ].filter(
    (value): value is number =>
      typeof value === 'number' && Number.isSafeInteger(value) && value >= 0,
  )
  return candidates.length === 0 ? undefined : Math.max(...candidates)
}
