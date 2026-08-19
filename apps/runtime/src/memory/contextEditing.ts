import { createHash } from 'node:crypto'
import type { ProviderMessage, ToolDefinition } from '@praxis/core-sdk'
import type { TokenizerAdapter } from './tokenizer.js'

export type ContextEditingPolicy = Readonly<{
  /** Maximum active-context tokens retained for one Tool result. */
  maxToolResultTokens: number
  /** Total replayable Tool-result volume that activates stale-result clearing. */
  toolResultTriggerTokens: number
  /** Recent replayable Tool results that always remain available verbatim. */
  keepRecentToolResults: number
  /** Avoid invalidating a stable prompt prefix for negligible savings. */
  clearAtLeastTokens: number
}>

export type ContextEditingReport = Readonly<{
  toolResultTokensBefore: number
  toolResultTokensAfter: number
  truncatedToolResults: number
  truncatedToolResultTokens: number
  clearedToolResults: number
  clearedToolResultTokens: number
}>

export const DEFAULT_CONTEXT_EDITING_POLICY: ContextEditingPolicy = Object.freeze({
  maxToolResultTokens: 12_000,
  toolResultTriggerTokens: 32_000,
  keepRecentToolResults: 3,
  clearAtLeastTokens: 8_000,
})

export function contextEditingPolicy(
  input: Partial<ContextEditingPolicy> = {},
): ContextEditingPolicy {
  const value = { ...DEFAULT_CONTEXT_EDITING_POLICY, ...input }
  if (
    !positiveInteger(value.maxToolResultTokens) ||
    value.maxToolResultTokens < 1_024 ||
    !positiveInteger(value.toolResultTriggerTokens) ||
    !nonNegativeInteger(value.keepRecentToolResults) ||
    !positiveInteger(value.clearAtLeastTokens) ||
    value.clearAtLeastTokens > value.toolResultTriggerTokens
  ) {
    throw new TypeError('CONTEXT_EDITING_POLICY_INVALID')
  }
  return Object.freeze(value)
}

/**
 * Produces a provider-only view of canonical Session messages. The stored
 * transcript remains byte-for-byte unchanged. Only replayable read/none Tool
 * results are eligible for stale-result clearing. Mutation, collaboration and
 * Skill results are never stale-cleared because repeating them can be unsafe or
 * semantically different; exact Skill invocations remain available to the
 * checkpoint replay path.
 */
export function editToolResultContext(
  input: Readonly<{
    messages: readonly ProviderMessage[]
    tools: readonly ToolDefinition[]
    tokenizer: TokenizerAdapter
    policy?: Partial<ContextEditingPolicy>
    /** First canonical message that can still enter the Provider request. */
    messageStart?: number
  }>,
): Readonly<{ messages: readonly ProviderMessage[]; report: ContextEditingReport }> {
  const policy = contextEditingPolicy(input.policy)
  const replayable = new Set(
    input.tools
      .filter(({ name, execution }) => {
        const effect = execution?.sideEffect
        return (
          (effect === 'none' || effect === 'read') &&
          !name.startsWith('agent.') &&
          !name.startsWith('workflow.')
        )
      })
      .map(({ name }) => name),
  )
  const messageStart = Math.min(
    input.messages.length,
    Math.max(0, Math.floor(input.messageStart ?? 0)),
  )
  const messages = input.messages.map((message, index) =>
    index < messageStart ? message : structuredClone(message),
  )
  const candidates: Array<{
    index: number
    activeTokens: number
    replacement: Extract<ProviderMessage, { role: 'tool' }>
    replacementTokens: number
    savings: number
  }> = []
  let toolResultTokensBefore = 0
  let truncatedToolResults = 0
  let truncatedToolResultTokens = 0

  for (let index = messageStart; index < messages.length; index += 1) {
    const message = messages[index]!
    if (message.role !== 'tool') continue
    const originalTokens = input.tokenizer.countMessage(message)
    toolResultTokensBefore += originalTokens
    if (message.skillInvocation !== undefined) continue
    if (originalTokens > policy.maxToolResultTokens) {
      const replacement = boundedToolResult(message, input.tokenizer, policy.maxToolResultTokens)
      messages[index] = replacement
      truncatedToolResults += 1
      truncatedToolResultTokens += Math.max(
        0,
        originalTokens - input.tokenizer.countMessage(replacement),
      )
    }
    if (replayable.has(message.name)) {
      const activeTokens = input.tokenizer.countMessage(messages[index]!)
      const replacement = clearedToolResult(message, originalTokens, activeTokens)
      const replacementTokens = input.tokenizer.countMessage(replacement)
      candidates.push({
        index,
        activeTokens,
        replacement,
        replacementTokens,
        savings: Math.max(0, activeTokens - replacementTokens),
      })
    }
  }

  const replayableTokens = candidates.reduce(
    (total, candidate) => total + candidate.activeTokens,
    0,
  )
  const clearable = candidates.slice(
    0,
    Math.max(0, candidates.length - policy.keepRecentToolResults),
  )
  const desiredSavings = Math.max(
    policy.clearAtLeastTokens,
    replayableTokens - policy.toolResultTriggerTokens,
  )
  const possibleSavings = clearable.reduce((total, candidate) => total + candidate.savings, 0)
  let clearedToolResults = 0
  let clearedToolResultTokens = 0
  if (
    replayableTokens > policy.toolResultTriggerTokens &&
    possibleSavings >= policy.clearAtLeastTokens
  ) {
    for (const candidate of clearable) {
      if (candidate.savings === 0) continue
      messages[candidate.index] = candidate.replacement
      clearedToolResults += 1
      clearedToolResultTokens += candidate.savings
      if (clearedToolResultTokens >= desiredSavings) break
    }
  }

  const toolResultTokensAfter = messages
    .slice(messageStart)
    .reduce(
      (total, message) =>
        total + (message.role === 'tool' ? input.tokenizer.countMessage(message) : 0),
      0,
    )
  return Object.freeze({
    messages: Object.freeze(messages),
    report: Object.freeze({
      toolResultTokensBefore,
      toolResultTokensAfter,
      truncatedToolResults,
      truncatedToolResultTokens,
      clearedToolResults,
      clearedToolResultTokens,
    }),
  })
}

function boundedToolResult(
  message: Extract<ProviderMessage, { role: 'tool' }>,
  tokenizer: TokenizerAdapter,
  maximumTokens: number,
): Extract<ProviderMessage, { role: 'tool' }> {
  const text =
    typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
  const base = toolContextEnvelope('truncated', message, text)
  if (tokenizer.countMessage(base) >= maximumTokens) return base

  let low = 1
  let high = Buffer.byteLength(text, 'utf8')
  let best = base
  while (low <= high) {
    const previewBytes = Math.floor((low + high) / 2)
    const candidate = toolContextEnvelope('truncated', message, text, {
      previewHead: utf8Prefix(text, Math.floor(previewBytes * 0.67)),
      previewTail: utf8Suffix(text, Math.floor(previewBytes * 0.33)),
    })
    if (tokenizer.countMessage(candidate) <= maximumTokens) {
      best = candidate
      low = previewBytes + 1
    } else {
      high = previewBytes - 1
    }
  }
  return best
}

function clearedToolResult(
  message: Extract<ProviderMessage, { role: 'tool' }>,
  originalTokens: number,
  activeTokens: number,
): Extract<ProviderMessage, { role: 'tool' }> {
  const text =
    typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
  return toolContextEnvelope('cleared', message, text, { originalTokens, activeTokens })
}

function toolContextEnvelope(
  kind: 'truncated' | 'cleared',
  message: Extract<ProviderMessage, { role: 'tool' }>,
  text: string,
  details: Record<string, unknown> = {},
): Extract<ProviderMessage, { role: 'tool' }> {
  return {
    role: 'tool',
    toolCallId: message.toolCallId,
    name: message.name,
    content: JSON.stringify({
      contextEdit: {
        schemaVersion: 1,
        kind,
        canonicalLocation: 'durable_session_history',
        recovery: kind === 'cleared' ? 'repeat_read_only_tool' : 'use_artifact_or_repeat_tool',
        digest: `sha256:${createHash('sha256').update(text).digest('hex')}`,
        originalBytes: Buffer.byteLength(text, 'utf8'),
      },
      original: toolResultMetadata(text),
      ...details,
    }),
  }
}

function toolResultMetadata(text: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return {}
  }
  if (!isRecord(parsed)) return {}
  const artifacts = Array.isArray(parsed.artifacts)
    ? parsed.artifacts.flatMap((value) => {
        const artifact = artifactMetadata(value)
        return artifact === undefined ? [] : [artifact]
      })
    : []
  const outputArtifact = isRecord(parsed.output)
    ? artifactMetadata(parsed.output.artifact)
    : undefined
  return {
    ...(typeof parsed.ok === 'boolean' ? { ok: parsed.ok } : {}),
    ...(typeof parsed.summary === 'string' ? { summary: boundedUtf8(parsed.summary, 1_024) } : {}),
    ...errorMetadata(parsed.error),
    ...(artifacts.length === 0
      ? {}
      : {
          artifacts: artifacts.slice(0, 8),
          artifactCount: artifacts.length,
        }),
    ...(outputArtifact === undefined ? {} : { outputArtifact }),
  }
}

function errorMetadata(value: unknown): Readonly<{ error?: Record<string, unknown> }> {
  if (!isRecord(value)) return {}
  return {
    error: {
      ...(typeof value.code === 'string' ? { code: boundedUtf8(value.code, 128) } : {}),
      ...(typeof value.category === 'string' ? { category: boundedUtf8(value.category, 64) } : {}),
      ...(typeof value.retryable === 'boolean' ? { retryable: value.retryable } : {}),
    },
  }
}

function artifactMetadata(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value) || typeof value.artifactId !== 'string') return undefined
  return {
    artifactId: boundedUtf8(value.artifactId, 256),
    ...(typeof value.digest === 'string' ? { digest: boundedUtf8(value.digest, 256) } : {}),
    ...(typeof value.mimeType === 'string' ? { mimeType: boundedUtf8(value.mimeType, 128) } : {}),
    ...(typeof value.bytes === 'number' && Number.isSafeInteger(value.bytes) && value.bytes >= 0
      ? { bytes: value.bytes }
      : {}),
  }
}

function boundedUtf8(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(value, 'utf8')
  return bytes.length <= maximumBytes
    ? value
    : new TextDecoder().decode(bytes.subarray(0, maximumBytes))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function utf8Prefix(value: string, maximumBytes: number): string {
  let bytes = 0
  let result = ''
  for (const character of value) {
    const size = Buffer.byteLength(character, 'utf8')
    if (bytes + size > maximumBytes) break
    result += character
    bytes += size
  }
  return result
}

function utf8Suffix(value: string, maximumBytes: number): string {
  let bytes = 0
  const result: string[] = []
  for (const character of [...value].reverse()) {
    const size = Buffer.byteLength(character, 'utf8')
    if (bytes + size > maximumBytes) break
    result.push(character)
    bytes += size
  }
  return result.reverse().join('')
}

function positiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

function nonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}
