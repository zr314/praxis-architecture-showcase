import {
  type ProviderChunk,
  type ProviderMessage,
  ProviderStreamAccumulator,
  type ProviderToolCall,
  type ProviderTurnResult,
  runtimeError,
  type ToolExecutionDescriptor,
  type ToolResult,
} from '@praxis/core-sdk'

export type ProviderTurnCallbacks = {
  onText?(text: string): void
  onReasoning?(text: string): void
  shouldStop?(): boolean
  maxBufferedBytes?: number
}

export async function consumeProviderTurn(
  chunks: AsyncIterable<ProviderChunk>,
  callbacks: ProviderTurnCallbacks = {},
): Promise<ProviderTurnResult> {
  const stream = new ProviderStreamAccumulator()
  let bufferedBytes = 0
  for await (const chunk of chunks) {
    if (callbacks.shouldStop?.()) {
      throw runtimeError(
        'PROVIDER_CONSUMER_CANCELLED',
        'cancelled',
        'Provider stream consumption was cancelled.',
        undefined,
        true,
      )
    }
    bufferedBytes += providerChunkBytes(chunk)
    if (callbacks.maxBufferedBytes !== undefined && bufferedBytes > callbacks.maxBufferedBytes) {
      throw runtimeError(
        'PROVIDER_OUTPUT_OVERSIZED',
        'provider',
        'Provider output exceeded the bounded Runtime turn buffer.',
      )
    }
    stream.accept(chunk)
    if (chunk.type === 'text_delta') callbacks.onText?.(chunk.text)
    if (chunk.type === 'reasoning_delta') callbacks.onReasoning?.(chunk.text)
  }
  return stream.finish()
}

function providerChunkBytes(chunk: ProviderChunk): number {
  switch (chunk.type) {
    case 'text_delta':
    case 'reasoning_delta':
      return Buffer.byteLength(chunk.text, 'utf8')
    case 'tool_call_delta':
      return Buffer.byteLength(chunk.argumentsDelta, 'utf8')
    case 'tool_call_start':
      return Buffer.byteLength(chunk.id, 'utf8') + Buffer.byteLength(chunk.name, 'utf8')
    case 'tool_call_end':
      return chunk.input === undefined ? 0 : jsonBytes(chunk.input)
    case 'tool_calls':
      return jsonBytes(chunk.calls)
    default:
      return 0
  }
}

function jsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? 'null', 'utf8')
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

export type ToolBatchOutcome = {
  call: ProviderToolCall
  result: ToolResult
}

export async function executeToolBatch(
  calls: readonly ProviderToolCall[],
  execute: (call: ProviderToolCall) => Promise<ToolResult>,
  shouldStop: () => boolean = () => false,
  scheduling?: {
    descriptor(call: ProviderToolCall): ToolExecutionDescriptor | undefined
    maxParallel?: number
    settle?(outcome: ToolBatchOutcome): Promise<void>
  },
): Promise<ToolBatchOutcome[]> {
  const outcomes: ToolBatchOutcome[] = []
  const maximum = Math.max(1, Math.floor(scheduling?.maxParallel ?? 2))
  for (let index = 0; index < calls.length; ) {
    if (shouldStop()) break
    const call = calls[index]!
    const descriptor = scheduling?.descriptor(call)
    if (!isParallelCandidate(descriptor)) {
      const outcome = { call, result: await execute(call) }
      outcomes.push(outcome)
      await scheduling?.settle?.(outcome)
      index += 1
      continue
    }

    const group: ProviderToolCall[] = []
    const conflictKeys = new Set<string>()
    while (index < calls.length && group.length < maximum) {
      const candidate = calls[index]!
      const candidateDescriptor = scheduling?.descriptor(candidate)
      if (
        !isParallelCandidate(candidateDescriptor) ||
        conflictKeys.has(candidateDescriptor.conflictKey)
      ) {
        break
      }
      group.push(candidate)
      conflictKeys.add(candidateDescriptor.conflictKey)
      index += 1
    }
    const settled = await Promise.all(
      group.map(async (candidate) => ({
        call: candidate,
        result: await execute(candidate),
      })),
    )
    outcomes.push(...settled)
    for (const outcome of settled) await scheduling?.settle?.(outcome)
  }
  return outcomes
}

function isParallelCandidate(
  descriptor: ToolExecutionDescriptor | undefined,
): descriptor is ToolExecutionDescriptor {
  return (
    descriptor?.parallelSafe === true &&
    (descriptor.sideEffect === 'none' || descriptor.sideEffect === 'read')
  )
}

export type LoopProgressGuardOptions = {
  repeatedCallReminderInterval?: number
  noProgressReminderInterval?: number
  consecutiveFailureReminderInterval?: number
}

export class LoopProgressGuard {
  readonly #repeatedCallReminderInterval: number
  readonly #noProgressReminderInterval: number
  readonly #consecutiveFailureReminderInterval: number
  #lastCalls?: string
  #repeatedCalls = 0
  #lastResults?: string
  #unchangedResults = 0
  #lastFailure?: string
  #repeatedFailures = 0

  constructor(options: LoopProgressGuardOptions = {}) {
    this.#repeatedCallReminderInterval = positiveInterval(options.repeatedCallReminderInterval ?? 2)
    this.#noProgressReminderInterval = positiveInterval(options.noProgressReminderInterval ?? 2)
    this.#consecutiveFailureReminderInterval = positiveInterval(
      options.consecutiveFailureReminderInterval ?? 2,
    )
  }

  observeToolCalls(calls: readonly ProviderToolCall[]): string | undefined {
    if (calls.length === 0) {
      this.#lastCalls = undefined
      this.#repeatedCalls = 0
      return undefined
    }
    const signature = stableStringify(calls.map(({ name, input }) => ({ name, input })))
    if (signature === this.#lastCalls) this.#repeatedCalls += 1
    else {
      this.#lastCalls = signature
      this.#repeatedCalls = 1
    }
    if (!reminderDue(this.#repeatedCalls, this.#repeatedCallReminderInterval)) return undefined
    return (
      'Runtime guidance: the same Tool call has been requested repeatedly. ' +
      'Inspect the latest result, correct the input or working directory, or choose a different approach.'
    )
  }

  observeToolResults(
    results: readonly ToolResult[],
    calls: readonly ProviderToolCall[] = [],
  ): string | undefined {
    if (results.length === 0) return undefined
    const guidance: string[] = []

    for (const [index, result] of results.entries()) {
      if (result.ok) {
        this.#lastFailure = undefined
        this.#repeatedFailures = 0
        continue
      }

      const call = calls[index]
      const signature = stableStringify({
        call: call ? { name: call.name, input: call.input } : undefined,
        error: result.error,
        summary: result.summary,
        output: result.output,
      })
      if (signature === this.#lastFailure) this.#repeatedFailures += 1
      else {
        this.#lastFailure = signature
        this.#repeatedFailures = 1
      }

      if (reminderDue(this.#repeatedFailures, this.#consecutiveFailureReminderInterval)) {
        guidance.push(
          `Runtime guidance: ${call?.name ?? 'the same tool'} has failed repeatedly with the ` +
            'same input and result. Diagnose the error or choose a different approach instead of retrying it unchanged.',
        )
      }
    }

    const signature = stableStringify(
      results.map(({ ok, summary, output }, index) => {
        const call = calls[index]
        return {
          call: call ? { name: call.name, input: call.input } : undefined,
          ok,
          summary,
          output,
        }
      }),
    )
    if (signature === this.#lastResults) this.#unchangedResults += 1
    else {
      this.#lastResults = signature
      this.#unchangedResults = 1
    }
    if (reminderDue(this.#unchangedResults, this.#noProgressReminderInterval)) {
      guidance.push(
        'Runtime guidance: repeated Tool results show no observable progress. ' +
          'Reassess the plan or change the next action instead of relying on the same result.',
      )
    }
    return guidance.length > 0 ? [...new Set(guidance)].join(' ') : undefined
  }
}

export function typedSteerMessage(text: string): ProviderMessage {
  return {
    role: 'user',
    content: text,
    intent: 'steer',
    trust: 'low',
  }
}

function positiveInterval(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError('Loop progress reminder intervals must be positive integers.')
  }
  return value
}

function reminderDue(observations: number, interval: number): boolean {
  return observations >= interval && observations % interval === 0
}

function stableStringify(value: unknown): string {
  return JSON.stringify(canonical(value)).slice(0, 32_768)
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonical(nested)]),
  )
}
