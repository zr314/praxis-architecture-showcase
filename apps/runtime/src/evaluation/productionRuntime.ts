import {
  runtimeError,
  type ChatProvider,
  type ProviderCapabilities,
  type ProviderChunk,
  type ProviderRequest,
  type ProviderUsage,
  type SessionRecord,
} from '@praxis/core-sdk'
import { createRuntimeKernel } from '../run.js'
import { JsonlRepository } from '../session-db/index.js'
import { JsonlTraceSink, TraceService } from '../trace/index.js'
import { ReplayProvider } from './replayProvider.js'
import type { ProviderReplay } from './scenario.js'

export type ProductionEvaluationRuntimeOptions = {
  repositoryRoot: string
  traceRoot: string
  replay: ProviderReplay
  chunkDelayMs?: number
  failFirstFinalization?: boolean
  fallback?: {
    fromProvider: string
    toProvider: 'replay'
    toModel: string
  }
}

/** Builds an evaluation Runtime through the same production composition factory as `runRuntime`. */
export function createProductionEvaluationRuntime(options: ProductionEvaluationRuntimeOptions) {
  const chunkDelayMs =
    options.chunkDelayMs === undefined ? undefined : boundedChunkDelay(options.chunkDelayMs)
  const replay = new ReplayProvider(options.replay)
  const providers: ChatProvider[] = [
    chunkDelayMs === undefined ? replay : new DelayedProvider(replay, chunkDelayMs),
  ]
  if (options.fallback) {
    providers.push(new FailingEvaluationProvider(options.fallback.fromProvider))
  }
  const repository = options.failFirstFinalization
    ? new FirstFinalizationFailureRepository(options.repositoryRoot)
    : new JsonlRepository(options.repositoryRoot)
  return createRuntimeKernel({
    sessionRepository: repository,
    traceService: new TraceService({ sink: new JsonlTraceSink(options.traceRoot) }),
    providers,
    providerRouting: {
      retryAttempts: 0,
      ...(options.fallback
        ? {
            fallbacks: {
              [options.fallback.fromProvider]: [
                {
                  provider: options.fallback.toProvider,
                  model: options.fallback.toModel,
                },
              ],
            },
          }
        : {}),
    },
  })
}

class DelayedProvider implements ChatProvider {
  readonly id: string
  readonly defaultModel: string
  readonly capabilities

  constructor(
    private readonly provider: ReplayProvider,
    private readonly delayMs: number,
  ) {
    this.id = provider.id
    this.defaultModel = provider.defaultModel
    this.capabilities = provider.capabilities
  }

  authState() {
    return this.provider.authState()
  }

  async *stream(request: ProviderRequest): AsyncIterable<ProviderChunk> {
    for await (const chunk of this.provider.stream(request)) {
      await abortableDelay(this.delayMs, request.signal)
      yield chunk
    }
  }
}

class FailingEvaluationProvider implements ChatProvider {
  readonly defaultModel = 'primary-v1'
  readonly capabilities: ProviderCapabilities = {
    streaming: { text: true, reasoning: false, usage: true },
    tools: { mode: 'native', parallelCalls: true },
    modalities: { text: true, vision: false, audio: false },
    output: { jsonSchema: false, citations: false },
    limits: {},
  }

  constructor(readonly id: string) {}

  authState() {
    return { status: 'authenticated' as const, accountLabel: 'Synthetic failing Provider' }
  }

  async *stream(_request: ProviderRequest): AsyncIterable<ProviderChunk> {
    throw runtimeError(
      'EVALUATION_PRIMARY_FAILURE',
      'provider',
      'Synthetic primary Provider failure.',
      undefined,
      false,
    )
  }
}

class FirstFinalizationFailureRepository extends JsonlRepository {
  #failed = false

  override async updateTerminal(
    sessionId: string,
    terminal: NonNullable<SessionRecord['lastTerminalState']>,
    usage: ProviderUsage,
    messageCount: number,
  ): Promise<SessionRecord> {
    if (!this.#failed) {
      this.#failed = true
      throw new Error('Synthetic terminal persistence failure.')
    }
    return super.updateTerminal(sessionId, terminal, usage, messageCount)
  }
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortReason(signal))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, milliseconds)
    const abort = () => finish(abortReason(signal))
    signal.addEventListener('abort', abort, { once: true })
    function finish(error?: unknown) {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      if (error === undefined) resolve()
      else reject(error)
    }
  })
}

function boundedChunkDelay(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1_000) {
    throw new TypeError('Production evaluation chunk delay must be between 0 and 1000 ms.')
  }
  return Math.floor(value)
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error('Production evaluation replay was aborted.')
}
