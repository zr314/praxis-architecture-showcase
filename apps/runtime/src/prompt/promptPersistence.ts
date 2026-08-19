import {
  promptDigest,
  validatePromptEnvelope,
  type ProviderContent,
  type ProviderContentBlock,
  type PromptEnvelope,
  type ProviderMessage,
} from '@praxis/core-sdk'

/** Projects only the effective user part; rawInput and low-trust expansions are separate records. */
export function durablePromptMessage(
  input: PromptEnvelope,
  intent: 'prompt' | 'follow_up',
): Extract<ProviderMessage, { role: 'user' }> {
  const envelope = validatePromptEnvelope(input)
  const userInput = envelope.parts[0]!
  const content =
    userInput.persistence === 'plaintext'
      ? envelope.effectiveText
      : userInput.persistence === 'redacted'
        ? '[User input redacted by persistence policy.]'
        : userInput.persistence === 'digest'
          ? `[User input retained by digest only: ${userInput.digest}]`
          : '[User input omitted by persistence policy.]'
  return { role: 'user', content, intent, trust: 'user' }
}

/** Keeps current-turn output intact while preventing declared command secrets from crossing a run. */
export function durableSensitiveMessage(
  message: ProviderMessage,
  sensitiveValues: readonly string[],
): ProviderMessage {
  const replacements = sensitiveValues
    .filter((value) => value.length > 0)
    .map((value) => ({ value, descriptor: `[redacted:${promptDigest(value)}]` }))
    .sort((left, right) => right.value.length - left.value.length)
  const clone = structuredClone(message)
  return {
    ...clone,
    content: redactContent(clone.content, replacements),
    ...('toolCalls' in clone && clone.toolCalls !== undefined
      ? {
          toolCalls: clone.toolCalls.map((call) => ({
            ...call,
            input: redactUnknown(call.input, replacements),
          })),
        }
      : {}),
    ...('skillInvocation' in clone && clone.skillInvocation !== undefined
      ? {
          skillInvocation: {
            ...clone.skillInvocation,
            arguments: redactString(clone.skillInvocation.arguments, replacements),
            content: redactString(clone.skillInvocation.content, replacements),
          },
        }
      : {}),
  } as ProviderMessage
}

function redactContent(
  content: ProviderContent,
  replacements: readonly { value: string; descriptor: string }[],
): ProviderContent {
  if (typeof content === 'string') return redactString(content, replacements)
  return content.map((block): ProviderContentBlock => {
    switch (block.type) {
      case 'text':
      case 'reasoning':
        return { ...block, text: redactString(block.text, replacements) }
      case 'image_ref':
        return {
          ...block,
          ...(block.alt === undefined ? {} : { alt: redactString(block.alt, replacements) }),
        }
      case 'audio_ref':
        return {
          ...block,
          ...(block.transcript === undefined
            ? {}
            : { transcript: redactString(block.transcript, replacements) }),
        }
      case 'citation':
        return {
          ...block,
          ...(block.title === undefined ? {} : { title: redactString(block.title, replacements) }),
          ...(block.url === undefined ? {} : { url: redactString(block.url, replacements) }),
        }
      case 'tool_call':
        return { ...block, input: redactUnknown(block.input, replacements) }
    }
    return block
  })
}

function redactString(
  value: string,
  replacements: readonly { value: string; descriptor: string }[],
): string {
  return replacements.reduce(
    (redacted, replacement) => redacted.replaceAll(replacement.value, replacement.descriptor),
    value,
  )
}

function redactUnknown(
  value: unknown,
  replacements: readonly { value: string; descriptor: string }[],
): unknown {
  if (typeof value === 'string') return redactString(value, replacements)
  if (Array.isArray(value)) return value.map((item) => redactUnknown(item, replacements))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, redactUnknown(nested, replacements)]),
    )
  }
  return value
}
