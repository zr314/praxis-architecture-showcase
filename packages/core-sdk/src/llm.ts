export type ProviderToolDefinition = {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export type ProviderToolCall = {
  id: string
  name: string
  input: unknown
}

export type ProviderTextContent = {
  type: 'text'
  text: string
}

export type ProviderReasoningContent = {
  type: 'reasoning'
  text: string
}

export type ProviderImageReferenceContent = {
  type: 'image_ref'
  artifactId: string
  mimeType?: string
  alt?: string
}

export type ProviderAudioReferenceContent = {
  type: 'audio_ref'
  artifactId: string
  mimeType?: string
  transcript?: string
}

export type ProviderCitationContent = {
  type: 'citation'
  title?: string
  url?: string
  artifactId?: string
  startIndex?: number
  endIndex?: number
}

export type ProviderToolCallContent = {
  type: 'tool_call'
  id: string
  name: string
  input: unknown
}

export type SkillInvocationEntry = {
  type: 'skill_invocation'
  version: 1
  capabilityId: string
  origin: string
  digest: `sha256:${string}`
  arguments: string
  content: string
}

export type ProviderContentBlock =
  | ProviderTextContent
  | ProviderReasoningContent
  | ProviderImageReferenceContent
  | ProviderAudioReferenceContent
  | ProviderCitationContent
  | ProviderToolCallContent

/** String content remains accepted for persisted v1 sessions and Provider adapters. */
export type ProviderContent = string | ProviderContentBlock[]

export type ProviderMessage =
  | {
      role: 'user'
      content: ProviderContent
      intent?: 'prompt' | 'follow_up' | 'steer' | 'context'
      trust?: 'user' | 'low'
      skillInvocation?: SkillInvocationEntry
    }
  | {
      role: 'assistant'
      content: ProviderContent
      /** @deprecated v1 compatibility; new adapters should emit Tool content blocks. */
      toolCalls?: ProviderToolCall[]
    }
  | {
      role: 'tool'
      toolCallId: string
      name: string
      content: ProviderContent
      skillInvocation?: SkillInvocationEntry
    }

export type ProviderUsage = {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  costUsd?: number
}

/**
 * Opaque Provider-owned context window. Runtime may persist and replay it only
 * to the exact Provider/model/prompt-program binding that created it.
 */
export type ProviderNativeContext = Readonly<{
  schemaVersion: 1
  provider: string
  model: string
  format: string
  items: readonly Readonly<Record<string, unknown>>[]
  messageStart: number
  messageEnd: number
  sourceDigest: `sha256:${string}`
  instructionsDigest: `sha256:${string}`
  estimatedTokens: number
  createdAt: string
}>

export type ProviderNativeCompactionResult = Readonly<{
  format: string
  items: readonly Readonly<Record<string, unknown>>[]
  usage?: ProviderUsage
}>

export type ProviderStopReason =
  | 'end_turn'
  | 'tool_calls'
  | 'max_output_tokens'
  | 'content_filter'
  | 'cancelled'
  | 'error'
  | 'unknown'

export type ProviderChunk =
  | { type: 'message_start' }
  | { type: 'text_start'; contentIndex: number }
  | { type: 'text_delta'; text: string; contentIndex?: number }
  | { type: 'text_end'; contentIndex: number }
  | { type: 'reasoning_start'; contentIndex: number }
  | { type: 'reasoning_delta'; contentIndex: number; text: string }
  | { type: 'reasoning_end'; contentIndex: number }
  | { type: 'tool_call_start'; index: number; id: string; name: string }
  | { type: 'tool_call_delta'; index: number; argumentsDelta: string }
  | { type: 'tool_call_end'; index: number; input?: unknown }
  /** @deprecated v1 Provider adapter compatibility. */
  | { type: 'tool_calls'; calls: ProviderToolCall[] }
  | {
      type: 'completed'
      /** Raw adapter value; Runtime normalizes this before exposing terminal semantics. */
      stopReason?: string
      usage?: ProviderUsage
    }

export type ProviderRequest = {
  model: string
  messages: ProviderMessage[]
  contextMessages?: ProviderMessage[]
  tools: ProviderToolDefinition[]
  /** Explicit structured-output selection for Provider-native Tool APIs. */
  toolChoice?: 'auto' | 'required' | { name: string }
  instructions?: string
  promptManifest?: PromptManifest
  /** Provider-owned prefix selected from a durable checkpoint. */
  nativeContext?: ProviderNativeContext
  signal: AbortSignal
  /** Optional caller ceiling for this Provider turn. */
  maxOutputTokens?: number
  /** Provider-neutral request hint; adapters map compact mode to their safest low-latency control. */
  reasoning?: {
    mode: 'default' | 'compact'
    effort?: 'none' | 'low' | 'medium' | 'high'
  }
  responseFormat?: {
    type: 'json_schema'
    name: string
    schema: Record<string, unknown>
    strict?: boolean
  }
}

/** An explicit routing candidate. Provider and model always change as one unit. */
export type ProviderTarget = {
  provider: string
  model: string
}

export type ProviderAuthState = {
  status: 'authenticated' | 'unauthenticated' | 'expired' | 'unavailable'
  accountLabel?: string
}

export type ProviderCapabilities = {
  streaming: { text: boolean; reasoning: boolean; usage: boolean }
  tools: { mode: 'none' | 'native' | 'emulated'; parallelCalls: boolean }
  modalities: { text: boolean; vision: boolean; audio: boolean }
  output: { jsonSchema: boolean; citations: boolean }
  limits: { maxContextTokens?: number; maxOutputTokens?: number }
}

export interface ChatProvider {
  readonly id: string
  readonly defaultModel: string
  /** Undefined identifies a legacy v1 adapter whose chunks are normalized by Runtime. */
  readonly contractVersion?: 2
  readonly capabilities?: ProviderCapabilities
  authState(): ProviderAuthState
  /** Applies a credential without restarting the Runtime. Providers may ignore unknown names. */
  configureCredential?(name: string, value: string | undefined): void | Promise<void>
  /** Optional stateless Provider-native compaction operation. */
  compact?(request: ProviderRequest): Promise<ProviderNativeCompactionResult>
  stream(request: ProviderRequest): AsyncIterable<ProviderChunk>
}

export function isProviderNativeContext(value: unknown): value is ProviderNativeContext {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const state = value as Record<string, unknown>
  if (
    !Object.keys(state).every((key) =>
      [
        'schemaVersion',
        'provider',
        'model',
        'format',
        'items',
        'messageStart',
        'messageEnd',
        'sourceDigest',
        'instructionsDigest',
        'estimatedTokens',
        'createdAt',
      ].includes(key),
    ) ||
    state.schemaVersion !== 1 ||
    !safeNativeContextId(state.provider) ||
    !safeNativeContextId(state.model) ||
    !safeNativeContextId(state.format) ||
    !Array.isArray(state.items) ||
    state.items.length === 0 ||
    state.items.length > 2_048 ||
    !state.items.every(
      (item) => typeof item === 'object' && item !== null && !Array.isArray(item),
    ) ||
    !Number.isSafeInteger(state.messageStart) ||
    (state.messageStart as number) < 0 ||
    !Number.isSafeInteger(state.messageEnd) ||
    (state.messageEnd as number) < (state.messageStart as number) ||
    typeof state.sourceDigest !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/.test(state.sourceDigest) ||
    typeof state.instructionsDigest !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/.test(state.instructionsDigest) ||
    !Number.isSafeInteger(state.estimatedTokens) ||
    (state.estimatedTokens as number) < 0 ||
    typeof state.createdAt !== 'string' ||
    Number.isNaN(Date.parse(state.createdAt))
  ) {
    return false
  }
  try {
    JSON.stringify(state.items)
    return true
  } catch {
    return false
  }
}

function safeNativeContextId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/.test(value)
}

export function contentText(content: ProviderContent): string {
  if (typeof content === 'string') return content
  return content
    .filter((block): block is ProviderTextContent => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

export function reasoningText(content: ProviderContent): string {
  if (typeof content === 'string') return ''
  return content
    .filter((block): block is ProviderReasoningContent => block.type === 'reasoning')
    .map((block) => block.text)
    .join('')
}

export function providerToolCalls(message: ProviderMessage): ProviderToolCall[] {
  if (message.role !== 'assistant') return []
  const legacy = message.toolCalls ?? []
  const structured =
    typeof message.content === 'string'
      ? []
      : message.content
          .filter((block): block is ProviderToolCallContent => block.type === 'tool_call')
          .map(({ id, name, input }) => ({ id, name, input }))
  if (legacy.length === 0) return structured
  if (structured.length === 0) return legacy.map((call) => ({ ...call }))
  const calls = new Map<string, ProviderToolCall>()
  for (const call of [...legacy, ...structured]) calls.set(call.id, { ...call })
  return [...calls.values()]
}

export function isSkillInvocationEntry(value: unknown): value is SkillInvocationEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const entry = value as Record<string, unknown>
  return (
    Object.keys(entry).every((key) =>
      ['type', 'version', 'capabilityId', 'origin', 'digest', 'arguments', 'content'].includes(key),
    ) &&
    entry.type === 'skill_invocation' &&
    entry.version === 1 &&
    typeof entry.capabilityId === 'string' &&
    entry.capabilityId.length > 0 &&
    entry.capabilityId.length <= 256 &&
    typeof entry.origin === 'string' &&
    entry.origin.length > 0 &&
    entry.origin.length <= 1_024 &&
    typeof entry.digest === 'string' &&
    /^sha256:[a-f0-9]{64}$/.test(entry.digest) &&
    typeof entry.arguments === 'string' &&
    Buffer.byteLength(entry.arguments, 'utf8') <= 4_096 &&
    typeof entry.content === 'string' &&
    Buffer.byteLength(entry.content, 'utf8') <= 64 * 1_024
  )
}

export function normalizeProviderStopReason(value: string | undefined): ProviderStopReason {
  switch (value) {
    case 'end_turn':
    case 'stop':
      return 'end_turn'
    case 'tool_calls':
    case 'tool_use':
      return 'tool_calls'
    case 'max_output_tokens':
    case 'length':
      return 'max_output_tokens'
    case 'content_filter':
      return 'content_filter'
    case 'cancelled':
    case 'aborted':
      return 'cancelled'
    case 'error':
      return 'error'
    default:
      return 'unknown'
  }
}
import type { PromptManifest } from './prompt.js'
