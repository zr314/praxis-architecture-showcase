import { contentText, providerToolCalls, runtimeError } from '@praxis/core-sdk'
import type {
  ChatProvider,
  ProviderCapabilities,
  ProviderChunk,
  ProviderMessage,
  ProviderNativeCompactionResult,
  ProviderRequest,
  ProviderUsage,
} from './types.js'
import { jsonServerEvents, type FetchLike } from './sse.js'
import { providerContentText } from './contentConversion.js'

export type OpenAIResponsesProviderOptions = {
  apiKey?: string
  baseURL?: string
  defaultModel?: string
  fetch?: FetchLike
}

export const OPENAI_RESPONSES_CAPABILITIES: ProviderCapabilities = {
  streaming: { text: true, reasoning: true, usage: true },
  tools: { mode: 'native', parallelCalls: true },
  modalities: { text: true, vision: false, audio: false },
  output: { jsonSchema: true, citations: false },
  limits: { maxContextTokens: 400_000, maxOutputTokens: 128_000 },
}

/** OpenAI Responses SSE adapter normalized to the Provider v2 stream contract. */
export class OpenAIResponsesProvider implements ChatProvider {
  readonly id = 'openai'
  readonly contractVersion = 2 as const
  readonly defaultModel: string
  readonly capabilities = OPENAI_RESPONSES_CAPABILITIES
  #apiKey?: string
  readonly #baseURL: string
  readonly #fetch: FetchLike

  constructor(options: OpenAIResponsesProviderOptions = {}) {
    this.#apiKey = options.apiKey ?? process.env.OPENAI_API_KEY
    this.#baseURL = options.baseURL ?? 'https://api.openai.com'
    this.defaultModel = options.defaultModel ?? 'gpt-5.2'
    this.#fetch = options.fetch ?? fetch
  }

  authState() {
    return this.#apiKey
      ? { status: 'authenticated' as const, accountLabel: 'OPENAI_API_KEY' }
      : { status: 'unauthenticated' as const }
  }

  configureCredential(name: string, value: string | undefined): void {
    if (name === 'apiKey') this.#apiKey = value
  }

  async compact(request: ProviderRequest): Promise<ProviderNativeCompactionResult> {
    if (!this.#apiKey) throw new Error('OPENAI_API_KEY is not configured.')
    const response = await this.#fetch(`${this.#baseURL}/v1/responses/compact`, {
      method: 'POST',
      signal: request.signal,
      headers: {
        authorization: `Bearer ${this.#apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: request.model,
        ...(request.instructions ? { instructions: request.instructions } : {}),
        input: responseInputItems(request, this.id),
      }),
    })
    if (!response.ok) {
      throw runtimeError(
        response.status === 429 ? 'PROVIDER_RATE_LIMITED' : 'PROVIDER_HTTP_ERROR',
        'provider',
        'OpenAI Responses compaction request failed.',
        { status: response.status },
        response.status === 408 ||
          response.status === 409 ||
          response.status === 429 ||
          response.status >= 500,
      )
    }
    let payload: Record<string, unknown>
    try {
      payload = objectValue(await response.json())
    } catch {
      throw runtimeError(
        'PROVIDER_COMPACTION_INVALID',
        'provider',
        'OpenAI Responses compaction returned invalid JSON.',
      )
    }
    const output = payload.output
    if (
      !Array.isArray(output) ||
      output.length === 0 ||
      output.length > 2_048 ||
      !output.every((item) => isRecord(item)) ||
      !output.some((item) => item.type === 'compaction')
    ) {
      throw runtimeError(
        'PROVIDER_COMPACTION_INVALID',
        'provider',
        'OpenAI Responses compaction returned an invalid context window.',
      )
    }
    const usage = providerUsage(payload.usage)
    return {
      format: 'openai.responses.compact.v1',
      items: structuredClone(output as Record<string, unknown>[]),
      ...(usage === undefined ? {} : { usage }),
    }
  }

  async *stream(request: ProviderRequest): AsyncIterable<ProviderChunk> {
    if (!this.#apiKey) throw new Error('OPENAI_API_KEY is not configured.')
    const response = await this.#fetch(`${this.#baseURL}/v1/responses`, {
      method: 'POST',
      signal: request.signal,
      headers: {
        authorization: `Bearer ${this.#apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: request.model,
        stream: true,
        ...(request.maxOutputTokens ? { max_output_tokens: request.maxOutputTokens } : {}),
        ...(request.reasoning?.effort === undefined || request.reasoning.effort === 'none'
          ? {}
          : { reasoning: { effort: request.reasoning.effort } }),
        ...(request.responseFormat
          ? {
              text: {
                format: {
                  type: 'json_schema',
                  name: request.responseFormat.name,
                  schema: request.responseFormat.schema,
                  strict: request.responseFormat.strict ?? true,
                },
              },
            }
          : {}),
        ...(request.instructions ? { instructions: request.instructions } : {}),
        input: responseInputItems(request, this.id),
        tools: request.tools.map((tool) => ({
          type: 'function',
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          strict: false,
        })),
        ...(request.toolChoice === undefined
          ? {}
          : {
              tool_choice:
                typeof request.toolChoice === 'string'
                  ? request.toolChoice
                  : { type: 'function', name: request.toolChoice.name },
            }),
      }),
    })

    yield { type: 'message_start' }
    const textIndexes = new Set<number>()
    const reasoningIndexes = new Set<number>()
    const tools = new Set<number>()
    let usage:
      | {
          inputTokens?: number
          outputTokens?: number
          cacheReadTokens?: number
        }
      | undefined
    let stopReason = 'end_turn'
    for await (const event of jsonServerEvents(response)) {
      const type = stringField(event, 'type')
      const outputIndex = numberField(event, 'output_index') ?? 0
      if (type === 'response.output_text.delta') {
        if (!textIndexes.has(outputIndex)) {
          textIndexes.add(outputIndex)
          yield { type: 'text_start', contentIndex: outputIndex }
        }
        yield {
          type: 'text_delta',
          contentIndex: outputIndex,
          text: stringField(event, 'delta') ?? '',
        }
      } else if (
        type === 'response.reasoning_summary_text.delta' ||
        type === 'response.reasoning_text.delta'
      ) {
        const index = outputIndex + 10_000
        if (!reasoningIndexes.has(index)) {
          reasoningIndexes.add(index)
          yield { type: 'reasoning_start', contentIndex: index }
        }
        yield {
          type: 'reasoning_delta',
          contentIndex: index,
          text: stringField(event, 'delta') ?? '',
        }
      } else if (type === 'response.output_item.added') {
        const item = objectField(event, 'item')
        if (stringField(item, 'type') === 'function_call') {
          tools.add(outputIndex)
          yield {
            type: 'tool_call_start',
            index: outputIndex,
            id:
              stringField(item, 'call_id') ??
              stringField(item, 'id') ??
              `openai-tool-${outputIndex}`,
            name: stringField(item, 'name') ?? 'unknown',
          }
        }
      } else if (type === 'response.function_call_arguments.delta') {
        yield {
          type: 'tool_call_delta',
          index: outputIndex,
          argumentsDelta: stringField(event, 'delta') ?? '',
        }
      } else if (type === 'response.completed') {
        const completed = objectField(event, 'response')
        const rawUsage = objectField(completed, 'usage')
        usage = {
          inputTokens: numberField(rawUsage, 'input_tokens'),
          outputTokens: numberField(rawUsage, 'output_tokens'),
          cacheReadTokens: numberField(
            objectField(rawUsage, 'input_tokens_details'),
            'cached_tokens',
          ),
        }
      } else if (type === 'response.incomplete') {
        stopReason = 'max_output_tokens'
      } else if (type === 'error' || type === 'response.failed') {
        throw runtimeError('PROVIDER_ERROR', 'provider', 'OpenAI Responses stream failed.')
      }
    }
    for (const index of textIndexes) yield { type: 'text_end', contentIndex: index }
    for (const index of reasoningIndexes) yield { type: 'reasoning_end', contentIndex: index }
    for (const index of [...tools].sort((left, right) => left - right)) {
      yield { type: 'tool_call_end', index }
    }
    yield { type: 'completed', stopReason: tools.size > 0 ? 'tool_calls' : stopReason, usage }
  }
}

function responseInputItems(
  request: ProviderRequest,
  providerId: string,
): Array<Record<string, unknown>> {
  const native = request.nativeContext
  if (
    native !== undefined &&
    (native.provider !== providerId ||
      native.model !== request.model ||
      native.format !== 'openai.responses.compact.v1')
  ) {
    throw runtimeError(
      'PROVIDER_NATIVE_CONTEXT_MISMATCH',
      'provider',
      'Provider-native context does not match the OpenAI request target.',
    )
  }
  return [
    ...(native?.items.map((item) => structuredClone(item)) ?? []),
    ...[...(request.contextMessages ?? []), ...request.messages].flatMap(toResponseItems),
  ]
}

function toResponseItems(message: ProviderMessage): Array<Record<string, unknown>> {
  if (message.role === 'tool') {
    return [
      {
        type: 'function_call_output',
        call_id: message.toolCallId,
        output: providerContentText(message.content),
      },
    ]
  }
  const items: Array<Record<string, unknown>> = []
  // A rendered reasoning summary is not an encrypted Responses reasoning item.
  // Keep it in the durable transcript/UI, but never replay it as assistant text.
  const text = contentText(message.content)
  if (text) {
    items.push({
      role: message.role,
      content: [{ type: message.role === 'assistant' ? 'output_text' : 'input_text', text }],
    })
  }
  for (const call of providerToolCalls(message)) {
    items.push({
      type: 'function_call',
      call_id: call.id,
      name: call.name,
      arguments: JSON.stringify(call.input),
    })
  }
  return items
}

function objectField(value: unknown, key?: string): Record<string, unknown> {
  const candidate =
    key && value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : value
  return candidate && typeof candidate === 'object' && !Array.isArray(candidate)
    ? (candidate as Record<string, unknown>)
    : {}
}

function objectValue(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError('PROVIDER_OBJECT_INVALID')
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function providerUsage(value: unknown): ProviderUsage | undefined {
  if (!isRecord(value)) return undefined
  const usage: ProviderUsage = {
    inputTokens: numberField(value, 'input_tokens'),
    outputTokens: numberField(value, 'output_tokens'),
    cacheReadTokens: numberField(objectField(value, 'input_tokens_details'), 'cached_tokens'),
  }
  return Object.values(usage).every((item) => item === undefined) ? undefined : usage
}

function stringField(value: unknown, key: string): string | undefined {
  const candidate = objectField(value)[key]
  return typeof candidate === 'string' ? candidate : undefined
}

function numberField(value: unknown, key: string): number | undefined {
  const candidate = objectField(value)[key]
  return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : undefined
}
