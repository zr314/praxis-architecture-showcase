import {
  canonicalDigestV1,
  runtimeError,
  type PlanToolInvocationContextV1,
  type ProviderContentBlock,
  type ProviderToolCall,
} from '@praxis/core-sdk'

const SAFE_PROVIDER_TOOL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/u

export function normalizeProviderToolCallIdsV1(
  input: Readonly<{
    sessionId: string
    runId: string
    providerTurnId: string
    content: readonly ProviderContentBlock[]
    toolCalls: readonly ProviderToolCall[]
  }>,
): Readonly<{ content: ProviderContentBlock[]; toolCalls: ProviderToolCall[] }> {
  const contentToolIndexes = new Map<number, number>()
  let ordinal = 0
  for (let contentIndex = 0; contentIndex < input.content.length; contentIndex += 1) {
    if (input.content[contentIndex]?.type === 'tool_call') {
      contentToolIndexes.set(contentIndex, ordinal)
      ordinal += 1
    }
  }
  const normalized = input.toolCalls.map((call, toolIndex) => {
    const supplied = typeof call.id === 'string' ? call.id.trim() : ''
    const id =
      supplied.length > 0
        ? supplied
        : `ptc_${canonicalDigestV1({
            sessionId: input.sessionId,
            runId: input.runId,
            providerTurnId: input.providerTurnId,
            contentIndex:
              [...contentToolIndexes.entries()].find(([, index]) => index === toolIndex)?.[0] ??
              input.content.length + toolIndex,
            toolIndex,
          }).slice('sha256:'.length)}`
    if (!SAFE_PROVIDER_TOOL_ID.test(id)) {
      throw runtimeError(
        'PROVIDER_TOOL_CALL_ID_INVALID',
        'provider',
        'Provider returned an invalid Tool call ID.',
      )
    }
    return { ...structuredClone(call), id }
  })
  if (new Set(normalized.map((call) => call.id)).size !== normalized.length) {
    throw runtimeError(
      'PROVIDER_TOOL_CALL_ID_DUPLICATE',
      'provider',
      'Provider returned duplicate Tool call IDs in one turn.',
    )
  }
  let contentOrdinal = 0
  const content = input.content.map((block) => {
    if (block.type !== 'tool_call') return structuredClone(block)
    const call = normalized[contentOrdinal++]
    if (call === undefined) {
      throw runtimeError(
        'PROVIDER_TOOL_CALL_CONTENT_MISMATCH',
        'provider',
        'Provider Tool content does not match its Tool call list.',
      )
    }
    return { type: 'tool_call' as const, id: call.id, name: call.name, input: call.input }
  })
  if (contentOrdinal < normalized.length) {
    content.push(
      ...normalized.slice(contentOrdinal).map((call) => ({
        type: 'tool_call' as const,
        id: call.id,
        name: call.name,
        input: call.input,
      })),
    )
  }
  return Object.freeze({ content, toolCalls: normalized })
}

export function planToolInvocationContextV1(
  input: Readonly<{
    sessionId: string
    runId: string
    providerTurnId: string
    providerToolCallId: string
    toolName: string
  }>,
): PlanToolInvocationContextV1 {
  return Object.freeze({
    invocationId: `pti_${canonicalDigestV1(input).slice('sha256:'.length)}`,
    sessionId: input.sessionId,
    runId: input.runId,
    providerTurnId: input.providerTurnId,
    providerToolCallId: input.providerToolCallId,
  })
}

export function rewriteAssistantToolContentV1(
  content: readonly ProviderContentBlock[],
  toolCalls: readonly ProviderToolCall[],
): ProviderContentBlock[] {
  let toolIndex = 0
  return content.map((block) => {
    if (block.type !== 'tool_call') return structuredClone(block)
    const call = toolCalls[toolIndex++]
    if (call === undefined) {
      throw runtimeError(
        'PROVIDER_TOOL_CALL_CONTENT_MISMATCH',
        'provider',
        'Provider Tool content does not match its rewritten Tool call list.',
      )
    }
    return { type: 'tool_call', id: call.id, name: call.name, input: structuredClone(call.input) }
  })
}
