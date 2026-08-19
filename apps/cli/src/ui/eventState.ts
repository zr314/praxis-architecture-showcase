import type { SessionEvent } from '@praxis/protocol'

export function appendEvent(events: SessionEvent[], event: SessionEvent): SessionEvent[] {
  const previous = events.at(-1)
  if (
    previous?.type === 'text_delta' &&
    event.type === 'text_delta' &&
    previous.runId === event.runId
  ) {
    return [...events.slice(0, -1), { ...previous, text: `${previous.text}${event.text}` }]
  }
  if (
    previous?.type === 'thinking_delta' &&
    event.type === 'thinking_delta' &&
    previous.runId === event.runId
  ) {
    return [...events.slice(0, -1), { ...previous, text: `${previous.text}${event.text}` }]
  }
  if (
    previous?.type === 'tool_update' &&
    event.type === 'tool_update' &&
    previous.toolCallId === event.toolCallId &&
    previous.stream === event.stream
  ) {
    return [
      ...events.slice(0, -1),
      {
        ...event,
        message: `${previous.message}${event.message}`,
        ...(previous.delta !== undefined || event.delta !== undefined
          ? { delta: `${previous.delta ?? ''}${event.delta ?? ''}` }
          : {}),
        ...(previous.bytes !== undefined || event.bytes !== undefined
          ? { bytes: (previous.bytes ?? 0) + (event.bytes ?? 0) }
          : {}),
      },
    ]
  }
  if (event.type === 'supervisor_update' && event.update.source.kind === 'child_progress') {
    const key = childProgressKey(event)
    let replaceIndex = -1
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const candidate = events[index]
      if (
        candidate?.type === 'supervisor_update' &&
        candidate.update.source.kind === 'child_progress' &&
        childProgressKey(candidate) === key
      ) {
        replaceIndex = index
        break
      }
    }
    if (replaceIndex >= 0) {
      return [...events.slice(0, replaceIndex), event, ...events.slice(replaceIndex + 1)]
    }
  }
  return [...events, event]
}

function childProgressKey(event: Extract<SessionEvent, { type: 'supervisor_update' }>): string {
  const { correlation, source } = event.update
  if (source.kind !== 'child_progress') return ''
  const progress = source.progress
  if (progress.kind === 'thinking') return `${correlation.childRunId ?? 'child'}:thinking`
  return `${correlation.childRunId ?? 'child'}:tool:${progress.toolCallId}:${progress.phase}`
}
