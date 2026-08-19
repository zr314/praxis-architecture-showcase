import type { ProviderMessage } from '@praxis/core-sdk'
import type { TokenizerAdapter } from './tokenizer.js'

export type ReasoningContextEditingPolicy = Readonly<{
  /** Active reasoning volume that activates editing. */
  triggerTokens: number
  /** Recent assistant turns whose reasoning blocks remain intact. */
  keepRecentTurns: number
  /** Avoid breaking a cache prefix for negligible savings. */
  clearAtLeastTokens: number
}>

export type ReasoningContextEditingReport = Readonly<{
  reasoningTokensBefore: number
  reasoningTokensAfter: number
  clearedReasoningBlocks: number
  clearedReasoningTurns: number
  clearedReasoningTokens: number
}>

export const DEFAULT_REASONING_CONTEXT_EDITING_POLICY: ReasoningContextEditingPolicy =
  Object.freeze({
    triggerTokens: 8_000,
    keepRecentTurns: 1,
    clearAtLeastTokens: 2_000,
  })

export function reasoningContextEditingPolicy(
  input: Partial<ReasoningContextEditingPolicy> = {},
): ReasoningContextEditingPolicy {
  const value = { ...DEFAULT_REASONING_CONTEXT_EDITING_POLICY, ...input }
  if (
    !positiveInteger(value.triggerTokens) ||
    !nonNegativeInteger(value.keepRecentTurns) ||
    !positiveInteger(value.clearAtLeastTokens) ||
    value.clearAtLeastTokens > value.triggerTokens
  ) {
    throw new TypeError('REASONING_CONTEXT_EDITING_POLICY_INVALID')
  }
  return Object.freeze(value)
}

/**
 * Removes stale reasoning blocks from the Provider-only view. Canonical Session
 * messages remain untouched, and the newest reasoning-bearing Tool turn is kept
 * so a Provider can continue an in-flight reasoning/tool sequence.
 */
export function editReasoningContext(
  input: Readonly<{
    messages: readonly ProviderMessage[]
    tokenizer: TokenizerAdapter
    policy?: Partial<ReasoningContextEditingPolicy>
    messageStart?: number
  }>,
): Readonly<{
  messages: readonly ProviderMessage[]
  report: ReasoningContextEditingReport
}> {
  const policy = reasoningContextEditingPolicy(input.policy)
  const messageStart = Math.min(
    input.messages.length,
    Math.max(0, Math.floor(input.messageStart ?? 0)),
  )
  const messages = input.messages.map((message, index) =>
    index < messageStart ? message : structuredClone(message),
  )
  const turns: Array<{ index: number; blocks: number; tokens: number }> = []
  let reasoningTokensBefore = 0
  for (let index = messageStart; index < messages.length; index += 1) {
    const message = messages[index]!
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue
    const reasoning = message.content.filter((block) => block.type === 'reasoning')
    if (reasoning.length === 0) continue
    const tokens = reasoning.reduce(
      (total, block) => total + input.tokenizer.countText(JSON.stringify(block)),
      0,
    )
    reasoningTokensBefore += tokens
    turns.push({ index, blocks: reasoning.length, tokens })
  }

  let clearedReasoningBlocks = 0
  let clearedReasoningTurns = 0
  let clearedReasoningTokens = 0
  const clearable = turns.slice(0, Math.max(0, turns.length - policy.keepRecentTurns))
  const possibleSavings = clearable.reduce((total, turn) => total + turn.tokens, 0)
  if (
    reasoningTokensBefore > policy.triggerTokens &&
    possibleSavings >= policy.clearAtLeastTokens
  ) {
    const desiredSavings = Math.max(
      policy.clearAtLeastTokens,
      reasoningTokensBefore - policy.triggerTokens,
    )
    for (const turn of clearable) {
      const message = messages[turn.index]!
      if (message.role !== 'assistant' || !Array.isArray(message.content)) continue
      message.content = message.content.filter((block) => block.type !== 'reasoning')
      clearedReasoningBlocks += turn.blocks
      clearedReasoningTurns += 1
      clearedReasoningTokens += turn.tokens
      if (clearedReasoningTokens >= desiredSavings) break
    }
  }

  return Object.freeze({
    messages: Object.freeze(messages),
    report: Object.freeze({
      reasoningTokensBefore,
      reasoningTokensAfter: Math.max(0, reasoningTokensBefore - clearedReasoningTokens),
      clearedReasoningBlocks,
      clearedReasoningTurns,
      clearedReasoningTokens,
    }),
  })
}

function positiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

function nonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}
