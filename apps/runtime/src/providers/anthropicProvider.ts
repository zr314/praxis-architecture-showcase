import { contentText, providerToolCalls, runtimeError } from '@praxis/core-sdk'
import type {
  ChatProvider,
  ProviderCapabilities,
  ProviderChunk,
  ProviderMessage,
  ProviderRequest,
} from './types.js'
import { jsonServerEvents, type FetchLike } from './sse.js'
import { providerContentText } from './contentConversion.js'

export type AnthropicProviderOptions = {
  id?: string
  apiKey?: string
  baseURL?: string
  defaultModel?: string
  accountLabel?: string
  capabilities?: ProviderCapabilities
  fetch?: FetchLike
}

const defaultCapabilities: ProviderCapabilities = {
  streaming: { text: true, reasoning: true, usage: true },
  tools: { mode: 'native', parallelCalls: true },
  modalities: { text: true, vision: false, audio: false },
  output: { jsonSchema: false, citations: false },
  limits: { maxContextTokens: 200_000, maxOutputTokens: 64_000 },
}

/** Anthropic Messages SSE adapter normalized to the Provider v2 stream contract. */
export class AnthropicProvider implements ChatProvider {
  readonly id: string
  readonly contractVersion = 2 as const
  readonly defaultModel: string
  readonly capabilities: ProviderCapabilities
  #apiKey?: string
  readonly #baseURL: string
  readonly #fetch: FetchLike
  readonly #accountLabel: string

  constructor(options: AnthropicProviderOptions = {}) {
    this.id = options.id ?? 'anthropic'
    this.capabilities = options.capabilities ?? defaultCapabilities
    this.#accountLabel = options.accountLabel ?? 'ANTHROPIC_API_KEY'
    this.#apiKey =
      options.apiKey ?? (this.id === 'anthropic' ? process.env.ANTHROPIC_API_KEY : undefined)
    this.#baseURL = options.baseURL ?? 'https://api.anthropic.com'
    this.defaultModel = options.defaultModel ?? 'claude-sonnet-4-6'
    this.#fetch = options.fetch ?? fetch
  }

  authState() {
    return this.#apiKey
      ? { status: 'authenticated' as const, accountLabel: this.#accountLabel }
      : { status: 'unauthenticated' as const }
  }

  configureCredential(name: string, value: string | undefined): void {
    if (name === 'apiKey') this.#apiKey = value
  }

  async *stream(request: ProviderRequest): AsyncIterable<ProviderChunk> {
    if (!this.#apiKey) throw new Error(`${this.#accountLabel} is not configured.`)
    const response = await this.#fetch(`${this.#baseURL}/v1/messages`, {
      method: 'POST',
      signal: request.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.#apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: request.model,
        max_tokens: request.maxOutputTokens ?? this.capabilities.limits.maxOutputTokens ?? 8192,
        stream: true,
        ...(request.instructions ? { system: request.instructions } : {}),
        messages: [...(request.contextMessages ?? []), ...request.messages].map(toAnthropicMessage),
        ...(request.tools.length === 0
          ? {}
          : {
              tools: request.tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                input_schema: tool.parameters,
              })),
              ...(request.toolChoice === undefined
                ? {}
                : {
                    tool_choice:
                      request.toolChoice === 'auto'
                        ? { type: 'auto' }
                        : request.toolChoice === 'required'
                          ? { type: 'any' }
                          : { type: 'tool', name: request.toolChoice.name },
                  }),
            }),
      }),
    })

    const started = new Map<number, 'text' | 'reasoning' | 'tool'>()
    let inputTokens: number | undefined
    let outputTokens: number | undefined
    let cacheReadTokens: number | undefined
    let cacheWriteTokens: number | undefined
    let stopReason: string | undefined
    for await (const event of jsonServerEvents(response)) {
      const type = stringField(event, 'type')
      if (type === 'message_start') {
        yield { type: 'message_start' }
        const usage = objectField(objectField(event, 'message'), 'usage')
        inputTokens = maximumUsage(inputTokens, numberField(usage, 'input_tokens'))
        outputTokens = maximumUsage(outputTokens, numberField(usage, 'output_tokens'))
        cacheReadTokens = maximumUsage(
          cacheReadTokens,
          numberField(usage, 'cache_read_input_tokens'),
        )
        cacheWriteTokens = maximumUsage(
          cacheWriteTokens,
          numberField(usage, 'cache_creation_input_tokens'),
        )
      } else if (type === 'content_block_start') {
        const index = numberField(event, 'index') ?? 0
        const block = objectField(event, 'content_block')
        const blockType = stringField(block, 'type')
        if (blockType === 'text') {
          started.set(index, 'text')
          yield { type: 'text_start', contentIndex: index }
        } else if (blockType === 'thinking') {
          started.set(index, 'reasoning')
          yield { type: 'reasoning_start', contentIndex: index }
        } else if (blockType === 'tool_use') {
          started.set(index, 'tool')
          yield {
            type: 'tool_call_start',
            index,
            id: stringField(block, 'id') ?? `anthropic-tool-${index}`,
            name: stringField(block, 'name') ?? 'unknown',
          }
        }
      } else if (type === 'content_block_delta') {
        const index = numberField(event, 'index') ?? 0
        const delta = objectField(event, 'delta')
        const deltaType = stringField(delta, 'type')
        if (deltaType === 'text_delta') {
          yield { type: 'text_delta', contentIndex: index, text: stringField(delta, 'text') ?? '' }
        } else if (deltaType === 'thinking_delta') {
          yield {
            type: 'reasoning_delta',
            contentIndex: index,
            text: stringField(delta, 'thinking') ?? '',
          }
        } else if (deltaType === 'input_json_delta') {
          yield {
            type: 'tool_call_delta',
            index,
            argumentsDelta: stringField(delta, 'partial_json') ?? '',
          }
        }
      } else if (type === 'content_block_stop') {
        const index = numberField(event, 'index') ?? 0
        const kind = started.get(index)
        if (kind === 'text') yield { type: 'text_end', contentIndex: index }
        if (kind === 'reasoning') yield { type: 'reasoning_end', contentIndex: index }
        if (kind === 'tool') yield { type: 'tool_call_end', index }
      } else if (type === 'message_delta') {
        const delta = objectField(event, 'delta')
        stopReason = stringField(delta, 'stop_reason')
        const usage = objectField(event, 'usage')
        inputTokens = maximumUsage(inputTokens, numberField(usage, 'input_tokens'))
        outputTokens = maximumUsage(outputTokens, numberField(usage, 'output_tokens'))
        cacheReadTokens = maximumUsage(
          cacheReadTokens,
          numberField(usage, 'cache_read_input_tokens'),
        )
        cacheWriteTokens = maximumUsage(
          cacheWriteTokens,
          numberField(usage, 'cache_creation_input_tokens'),
        )
      } else if (type === 'error') {
        throw runtimeError('PROVIDER_ERROR', 'provider', 'Anthropic stream reported an error.')
      }
    }
    yield {
      type: 'completed',
      stopReason,
      usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens },
    }
  }
}

function toAnthropicMessage(message: ProviderMessage): Record<string, unknown> {
  if (message.role === 'tool') {
    return {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: message.toolCallId,
          content: providerContentText(message.content),
        },
      ],
    }
  }
  const blocks: Array<Record<string, unknown>> = []
  // Anthropic thinking replay requires the Provider signature. Praxis stores
  // display reasoning separately, so it must not be forged into ordinary text.
  const text = contentText(message.content)
  if (text) blocks.push({ type: 'text', text })
  for (const call of providerToolCalls(message)) {
    if (blocks.some((block) => block.type === 'tool_use' && block.id === call.id)) continue
    blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input })
  }
  return { role: message.role, content: blocks }
}

function objectField(value: unknown, key?: string): Record<string, unknown> {
  const candidate =
    key && value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : value
  return candidate && typeof candidate === 'object' && !Array.isArray(candidate)
    ? (candidate as Record<string, unknown>)
    : {}
}

function stringField(value: unknown, key: string): string | undefined {
  const candidate = objectField(value)[key]
  return typeof candidate === 'string' ? candidate : undefined
}

function numberField(value: unknown, key: string): number | undefined {
  const candidate = objectField(value)[key]
  return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : undefined
}

function maximumUsage(
  current: number | undefined,
  candidate: number | undefined,
): number | undefined {
  if (current === undefined) return candidate
  if (candidate === undefined) return current
  return Math.max(current, candidate)
}
