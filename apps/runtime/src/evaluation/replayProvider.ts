import type {
  ChatProvider,
  ProviderCapabilities,
  ProviderChunk,
  ProviderRequest,
} from '@praxis/core-sdk'
import {
  EvaluationError,
  type ProviderReplayExpectation,
  type ProviderReplayTurn,
  parseProviderReplay,
} from './scenario.js'

const capabilities: ProviderCapabilities = {
  streaming: { text: true, reasoning: false, usage: true },
  tools: { mode: 'native', parallelCalls: true },
  modalities: { text: true, vision: false, audio: false },
  output: { jsonSchema: false, citations: false },
  // Keep the offline fixture representative of a modern Provider. Tests that
  // need context pressure set an explicit smaller Session limit; leaving this
  // empty silently falls back to Runtime's 8K unknown-model window and can
  // consume replay turns in an unintended semantic-compaction request.
  limits: { maxContextTokens: 128 * 1_024, maxOutputTokens: 16 * 1_024 },
}

/** A deterministic, offline ChatProvider backed by validated synthetic turns. */
export class ReplayProvider implements ChatProvider {
  readonly id = 'replay'
  readonly defaultModel: string
  readonly capabilities = capabilities
  private readonly turns: ProviderReplayTurn[]

  constructor(fixture: unknown) {
    const replay = parseProviderReplay(fixture)
    this.turns = replay.turns
    this.defaultModel = replay.turns[0]?.expect?.model ?? 'replay-v1'
  }

  authState() {
    return { status: 'authenticated' as const, accountLabel: 'Synthetic replay fixture' }
  }

  remainingTurns(): number {
    return this.turns.length
  }

  assertConsumed(): void {
    if (this.turns.length === 0) return
    throw new EvaluationError(
      'EVAL_REPLAY_UNCONSUMED',
      `Provider replay fixture has ${this.turns.length} unconsumed turn(s).`,
    )
  }

  stream(request: ProviderRequest): AsyncIterable<ProviderChunk> {
    if (request.signal.aborted) {
      return failedReplay(
        new EvaluationError('EVAL_REPLAY_ABORTED', 'Provider replay was aborted.'),
      )
    }
    const turn = this.turns.shift()
    if (!turn) {
      return failedReplay(
        new EvaluationError(
          'EVAL_REPLAY_EXHAUSTED',
          'Provider replay fixture has no turn available for this request.',
        ),
      )
    }
    return this.replay(turn, request)
  }

  private async *replay(
    turn: ProviderReplayTurn,
    request: ProviderRequest,
  ): AsyncIterable<ProviderChunk> {
    assertExpectations(turn.expect, request)

    for (const chunk of turn.chunks) {
      assertNotAborted(request.signal)
      yield structuredClone(chunk)
    }
    assertNotAborted(request.signal)
  }
}

async function* failedReplay(error: EvaluationError): AsyncIterable<ProviderChunk> {
  throw error
}

function assertExpectations(
  expected: ProviderReplayExpectation | undefined,
  request: ProviderRequest,
): void {
  if (expected?.model !== undefined && request.model !== expected.model) {
    throw new EvaluationError(
      'EVAL_REPLAY_MODEL_MISMATCH',
      'Replay model expectation did not match the request.',
    )
  }

  const actualTools = request.tools.map((tool) => tool.name)
  if (expected?.tools !== undefined && !sameStrings(actualTools, expected.tools)) {
    throw new EvaluationError(
      'EVAL_REPLAY_TOOLS_MISMATCH',
      'Replay tool expectations did not match the request.',
    )
  }
}

function assertNotAborted(signal: AbortSignal): void {
  if (!signal.aborted) return
  throw new EvaluationError('EVAL_REPLAY_ABORTED', 'Provider replay was aborted.')
}

function sameStrings(actual: string[], expected: string[]): boolean {
  return (
    actual.length === expected.length && actual.every((value, index) => value === expected[index])
  )
}
