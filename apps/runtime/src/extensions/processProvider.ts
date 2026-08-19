import {
  ProviderStreamAccumulator,
  ProviderStreamProtocolError,
  isRuntimeError,
  runtimeError,
  type ChatProvider,
  type CancellationReason,
  type ProviderAuthState,
  type ProviderCapabilities,
  type ProviderChunk,
  type ProviderRequest,
} from '@praxis/core-sdk'

export type ProcessProviderClient = {
  invoke(
    capabilityId: string,
    input: unknown,
    cancellationId?: string,
    onEvent?: (event: {
      type: 'progress' | 'output' | 'diagnostic'
      payload: Record<string, unknown>
    }) => void,
  ): Promise<unknown>
  cancel(invocationOrCancellationId: string, reason: CancellationReason): Promise<void>
}

export type ProcessProviderOptions = {
  id: string
  defaultModel: string
  capabilityId: string
  capabilities: ProviderCapabilities
  client: ProcessProviderClient
  authState?: () => ProviderAuthState
  onProtocolFailure?: (error: unknown) => void | Promise<void>
}

/**
 * A transport adapter only. Retries, fallback, credentials, budget accounting,
 * and persistence intentionally remain in Runtime.
 */
export class ProcessProvider implements ChatProvider {
  readonly contractVersion = 2 as const
  readonly id: string
  readonly defaultModel: string
  readonly capabilities: ProviderCapabilities
  readonly #capabilityId: string
  readonly #client: ProcessProviderClient
  readonly #authState: () => ProviderAuthState
  readonly #onProtocolFailure?: (error: unknown) => void | Promise<void>

  constructor(options: ProcessProviderOptions) {
    this.id = options.id
    this.defaultModel = options.defaultModel
    this.capabilities = structuredClone(options.capabilities)
    this.#capabilityId = options.capabilityId
    this.#client = options.client
    this.#authState =
      options.authState ?? (() => ({ status: 'authenticated', accountLabel: options.id }))
    this.#onProtocolFailure = options.onProtocolFailure
  }

  authState(): ProviderAuthState {
    return this.#authState()
  }

  async *stream(request: ProviderRequest): AsyncIterable<ProviderChunk> {
    if (request.model !== this.defaultModel) {
      throw runtimeError(
        'PROVIDER_MODEL_UNAVAILABLE',
        'provider',
        'The Process Provider does not declare the requested model.',
        { providerId: this.id, model: request.model },
      )
    }
    const cancellationId = `provider-${crypto.randomUUID()}`
    let settled = false
    const abort = () => {
      void this.#client.cancel(cancellationId, 'user_abort').catch(() => undefined)
    }
    request.signal.addEventListener('abort', abort, { once: true })
    try {
      const accumulator = new ProviderStreamAccumulator()
      const queue = new AsyncChunkQueue()
      const invocation = this.#client
        .invoke(this.#capabilityId, serializableRequest(request), cancellationId, (event) => {
          if (event.type !== 'output' || !Object.hasOwn(event.payload, 'chunk')) return
          queue.push(event.payload.chunk)
        })
        .then(
          (output) => {
            if (request.signal.aborted) {
              queue.fail(
                runtimeError(
                  'PROCESS_PLUGIN_CANCELLED',
                  'cancelled',
                  'Process Provider invocation was cancelled.',
                ),
              )
              return
            }
            if (isRecord(output) && Array.isArray(output.chunks)) {
              for (const chunk of output.chunks) queue.push(chunk)
            } else if (!isRecord(output) || output.streamed !== true) {
              queue.fail(
                runtimeError(
                  'PROCESS_PROVIDER_PROTOCOL_INVALID',
                  'plugin',
                  'Process Provider returned an invalid stream envelope.',
                ),
              )
            }
            queue.close()
          },
          (error) => queue.fail(error),
        )
        .finally(() => {
          settled = true
        })
      for await (const candidate of queue) {
        const chunk = requireProviderChunk(candidate)
        accumulator.accept(chunk)
        yield structuredClone(chunk)
      }
      await invocation
      accumulator.finish()
    } catch (error) {
      if (error instanceof ProviderStreamProtocolError) {
        const failure = runtimeError('PROCESS_PROVIDER_PROTOCOL_INVALID', 'plugin', error.message)
        await this.#onProtocolFailure?.(failure)
        throw failure
      }
      if (isRuntimeError(error) && error.code === 'PROCESS_PROVIDER_PROTOCOL_INVALID') {
        await this.#onProtocolFailure?.(error)
      }
      throw error
    } finally {
      if (!settled) {
        void this.#client.cancel(cancellationId, 'parent_cancelled').catch(() => undefined)
      }
      request.signal.removeEventListener('abort', abort)
    }
  }
}

class AsyncChunkQueue implements AsyncIterable<unknown> {
  readonly #chunks: unknown[] = []
  #closed = false
  #error?: unknown
  #wake?: () => void

  push(chunk: unknown): void {
    if (this.#closed) return
    this.#chunks.push(chunk)
    this.#release()
  }

  close(): void {
    this.#closed = true
    this.#release()
  }

  fail(error: unknown): void {
    this.#error = error
    this.#closed = true
    this.#release()
  }

  async *[Symbol.asyncIterator](): AsyncIterator<unknown> {
    while (!this.#closed || this.#chunks.length > 0) {
      if (this.#chunks.length === 0) await new Promise<void>((resolve) => (this.#wake = resolve))
      while (this.#chunks.length > 0) yield this.#chunks.shift()
    }
    if (this.#error !== undefined) throw this.#error
  }

  #release(): void {
    const wake = this.#wake
    this.#wake = undefined
    wake?.()
  }
}

function serializableRequest(request: ProviderRequest): Omit<ProviderRequest, 'signal'> {
  const { signal: _signal, ...serializable } = request
  return structuredClone(serializable)
}

function isProviderChunk(value: unknown): value is ProviderChunk {
  if (!isRecord(value) || typeof value.type !== 'string') return false
  switch (value.type) {
    case 'message_start':
      return true
    case 'text_start':
    case 'text_end':
    case 'reasoning_start':
    case 'reasoning_end':
      return typeof value.contentIndex === 'number'
    case 'text_delta':
      return (
        typeof value.text === 'string' &&
        (value.contentIndex === undefined || typeof value.contentIndex === 'number')
      )
    case 'reasoning_delta':
      return typeof value.text === 'string' && typeof value.contentIndex === 'number'
    case 'tool_call_start':
      return (
        typeof value.index === 'number' &&
        typeof value.id === 'string' &&
        typeof value.name === 'string'
      )
    case 'tool_call_delta':
      return typeof value.index === 'number' && typeof value.argumentsDelta === 'string'
    case 'tool_call_end':
      return typeof value.index === 'number'
    case 'tool_calls':
      return Array.isArray(value.calls)
    case 'completed':
      return value.usage === undefined || isRecord(value.usage)
    default:
      return false
  }
}

function requireProviderChunk(value: unknown): ProviderChunk {
  if (isProviderChunk(value)) return value
  throw runtimeError(
    'PROCESS_PROVIDER_PROTOCOL_INVALID',
    'plugin',
    'Process Provider returned an invalid chunk.',
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
