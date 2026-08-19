import type { SessionEvent } from '@praxis/protocol'

export function sessionMessagesToEvents(
  sessionId: string,
  messages: readonly unknown[],
): SessionEvent[] {
  const events: SessionEvent[] = []
  let activeRunId: string | undefined

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    if (!isRecord(message) || typeof message.role !== 'string') continue

    if (message.role === 'user') {
      const prompt = visibleText(message.content)
      if (!prompt.trim()) continue
      activeRunId = `history-${index}`
      events.push({
        type: 'prompt_started',
        sessionId,
        runId: activeRunId,
        prompt,
        promptKind: message.intent === 'prompt' ? 'prompt' : 'follow_up',
      })
      continue
    }

    const runId = activeRunId ?? `history-${index}`
    if (message.role === 'assistant') {
      const text = visibleText(message.content)
      if (text) events.push({ type: 'text_delta', runId, text })
      for (const toolCall of toolCalls(message)) {
        events.push({
          type: 'tool_planning',
          runId,
          toolCallId: toolCall.id,
          name: toolCall.name,
          input: toolCall.input,
        })
      }
      continue
    }

    if (
      message.role === 'tool' &&
      typeof message.toolCallId === 'string' &&
      typeof message.name === 'string'
    ) {
      const summary = compactSummary(visibleText(message.content))
      events.push({
        type: 'tool_end',
        runId,
        toolCallId: message.toolCallId,
        ok: true,
        summary: summary || 'Tool completed.',
      })
    }
  }

  return events
}

export function latestAssistantText(events: readonly SessionEvent[]): string | undefined {
  let runId: string | undefined
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'text_delta' && event.runId !== 'cli' && event.text.trim()) {
      runId = event.runId
      break
    }
  }
  if (!runId) return undefined

  const text = events
    .filter(
      (event): event is Extract<SessionEvent, { type: 'text_delta' }> =>
        event.type === 'text_delta' && event.runId === runId,
    )
    .map((event) => event.text)
    .join('')
  return text.trim() ? text : undefined
}

function visibleText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(
      (block): block is { type: 'text'; text: string } =>
        isRecord(block) && block.type === 'text' && typeof block.text === 'string',
    )
    .map((block) => block.text)
    .join('')
}

function toolCalls(message: Record<string, unknown>): Array<{
  id: string
  name: string
  input: unknown
}> {
  const candidates = [
    ...(Array.isArray(message.content) ? message.content : []),
    ...(Array.isArray(message.toolCalls) ? message.toolCalls : []),
  ]
  const result: Array<{ id: string; name: string; input: unknown }> = []
  for (const candidate of candidates) {
    if (
      !isRecord(candidate) ||
      (candidate.type !== undefined && candidate.type !== 'tool_call') ||
      typeof candidate.id !== 'string' ||
      typeof candidate.name !== 'string'
    ) {
      continue
    }
    result.push({ id: candidate.id, name: candidate.name, input: candidate.input })
  }
  return result
}

function compactSummary(value: string, maximum = 160): string {
  const singleLine = value.replace(/\s+/g, ' ').trim()
  return singleLine.length > maximum ? `${singleLine.slice(0, maximum - 1)}…` : singleLine
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
