import type {
  AutomationEnvelope,
  OutputFormat,
  PermissionDecision,
  SessionEvent,
} from '@praxis/protocol'

export async function renderNonInteractive(
  events: AsyncIterable<SessionEvent>,
  format: OutputFormat,
  decidePermission?: (requestId: string, decision: PermissionDecision) => Promise<void>,
  resolvePermission?: (
    event: Extract<SessionEvent, { type: 'permission_request' }>,
  ) => PermissionDecision,
): Promise<void> {
  let text = ''
  let finalEvent: SessionEvent | undefined
  let sequence = 0

  for await (const event of events) {
    finalEvent = event
    if (event.type === 'text_delta') text += event.text
    if (event.type === 'permission_request' && decidePermission) {
      await decidePermission(
        event.requestId,
        resolvePermission?.(event) ?? {
          type: 'deny',
          reason: 'Non-interactive mode does not auto-approve tools.',
        },
      )
    }
    if (format === 'stream-json') {
      const kinds =
        event.type === 'prompt_completed' && event.usage
          ? (['usage', 'terminal'] as const)
          : ([automationKind(event)] as const)
      for (const kind of kinds) {
        const envelope: AutomationEnvelope = {
          schemaVersion: 1,
          sequence: ++sequence,
          kind,
          ...('runId' in event ? { runId: event.runId } : {}),
          event,
        }
        process.stdout.write(`${JSON.stringify(envelope)}\n`)
      }
    }
  }

  if (format === 'text') {
    process.stdout.write(`${text}\n`)
  } else if (format === 'json') {
    process.stdout.write(
      `${JSON.stringify(
        { schemaVersion: 1, kind: 'result', text, terminal: finalEvent },
        undefined,
        2,
      )}\n`,
    )
  }

  if (finalEvent?.type === 'prompt_failed') {
    process.exitCode = 1
  } else if (finalEvent?.type === 'prompt_aborted') {
    process.exitCode = 130
  }
}

function automationKind(event: SessionEvent): AutomationEnvelope['kind'] {
  if (event.type === 'prompt_started') return 'start'
  if (event.type === 'text_delta' || event.type === 'thinking_delta') return 'delta'
  if (event.type === 'permission_request') return 'permission'
  if (event.type.startsWith('tool_')) return 'tool'
  if (
    event.type === 'prompt_completed' ||
    event.type === 'prompt_failed' ||
    event.type === 'prompt_aborted'
  ) {
    return 'terminal'
  }
  return 'delta'
}
