import { Box, Text } from 'ink'
import { memo, useMemo } from 'react'
import type { SessionEvent } from '@praxis/protocol'
import { MarkdownText } from './MarkdownText.js'
import { palette } from './theme.js'
import {
  supervisorErrorCode,
  workflowPlanGraph,
  transcriptEvents,
  type WorkflowPlanView,
} from './tuiModel.js'

type Props = {
  events: readonly SessionEvent[]
  compact?: boolean
  columns?: number
  maxRows?: number
  plan?: WorkflowPlanView
}

export const EventList = memo(function EventList({ events, compact = false, plan }: Props) {
  const graph = useMemo(() => plan ?? workflowPlanGraph(events), [events, plan])
  const visible = useMemo(() => transcriptEvents(events), [events])
  const tools = useMemo(() => collectToolDetails(events), [events])

  if (visible.length === 0 && graph === undefined) return <EmptyState compact={compact} />

  return (
    <Box flexDirection="column" paddingX={1}>
      {graph === undefined ? null : <PlanGraph plan={graph} />}
      {visible.map((event, index) => (
        <EventRow
          event={event}
          key={`${index}-${event.type}`}
          tool={'toolCallId' in event ? tools.get(event.toolCallId) : undefined}
        />
      ))}
    </Box>
  )
})

const EventRow = memo(function EventRow({
  event,
  tool,
}: {
  event: SessionEvent
  tool?: ToolDetails
}) {
  switch (event.type) {
    case 'auth_login_action':
      return <Notice color={palette.amber}>Authentication: {event.deviceCode ?? event.url}</Notice>
    case 'auth_status_changed':
      return (
        <Notice color={palette.muted}>
          {event.provider}: {event.status}
          {event.accountLabel ? ` · ${event.accountLabel}` : ''}
        </Notice>
      )
    case 'runtime_warning':
      return <Notice color={palette.amber}>Warning: {event.message}</Notice>
    case 'prompt_started':
      return (
        <Box backgroundColor={palette.panelStrong} paddingX={1}>
          <Text bold color={palette.accent}>
            {'› '}
          </Text>
          <Text bold color={palette.ink} wrap="wrap">
            {event.prompt}
          </Text>
        </Box>
      )
    case 'thinking_delta':
      return (
        <Box paddingX={1}>
          <Text dimColor italic color={palette.muted}>
            ✻ Thinking…
          </Text>
        </Box>
      )
    case 'text_delta':
      return (
        <Box flexDirection="column" paddingX={1}>
          <MarkdownText source={event.text} />
        </Box>
      )
    case 'tool_planning':
      return <ToolLine marker="○" color={palette.muted} tool={tool} detail="planning" />
    case 'tool_start':
      return <ToolLine marker="●" color={palette.accent} tool={tool} detail="running" />
    case 'tool_update':
      return (
        <ToolLine
          marker="●"
          color={event.stream === 'stderr' ? palette.amber : palette.accent}
          tool={tool}
          detail={compactDetail(event.message || event.delta || formatBytes(event.bytes))}
        />
      )
    case 'tool_end':
      return (
        <ToolLine
          marker={event.ok ? '✓' : '×'}
          color={event.ok ? palette.mint : palette.danger}
          tool={tool}
          detail={
            event.error === undefined
              ? (event.summary ?? (event.ok ? 'done' : 'failed'))
              : `[${event.error.code}] ${event.summary ?? 'failed'}`
          }
        />
      )
    case 'steer_queued':
      return <Notice color={palette.amber}>Direction queued</Notice>
    case 'steer_applied':
      return <Notice color={palette.mint}>Direction applied</Notice>
    case 'prompt_completed':
      return (
        <Box paddingX={1}>
          <Text color={palette.faint}>
            ✓ Done
            {event.usage?.inputTokens === undefined
              ? ''
              : ` · ${event.usage.inputTokens} in / ${event.usage.outputTokens ?? '?'} out`}
            {event.usage?.costUsd === undefined ? '' : ` · $${event.usage.costUsd.toFixed(4)}`}
          </Text>
        </Box>
      )
    case 'prompt_failed':
      return (
        <Notice color={palette.danger}>
          {event.code?.startsWith('AGENT_') ? 'Run stopped' : 'Error'}
          {event.code ? ` [${event.code}]` : ''}: {event.error}
          {event.code?.startsWith('AGENT_') ? ' Enter a new prompt to continue.' : ''}
        </Notice>
      )
    case 'prompt_aborted':
      return <Notice color={palette.amber}>{event.reason ?? 'Run cancelled'}</Notice>
    case 'permission_request':
    case 'message_committed':
    case 'runtime_ready':
    case 'workflow_update':
      return null
    case 'supervisor_update':
      return supervisorErrorCode(event) === undefined ? null : (
        <Notice color={palette.danger}>
          V3 PlanGraph {event.update.correlation.stepId ?? event.update.correlation.planId} failed [
          {supervisorErrorCode(event)}]
        </Notice>
      )
  }
})

function PlanGraph({ plan }: { plan: WorkflowPlanView }) {
  const steps = plan.steps.slice(0, 6)
  return (
    <Box borderStyle="single" borderColor={palette.line} flexDirection="column" paddingX={1}>
      <Box>
        <Text bold color={palette.violet}>
          WORKFLOW
        </Text>
        <Text color={palette.faint}> {plan.planId} </Text>
        <Text bold color={stateColor(plan.state)}>
          [{plan.state.toUpperCase()}]
        </Text>
      </Box>
      {steps.map((step, index) => (
        <Box key={step.stepId}>
          <Text color={palette.faint}>{index + 1 === steps.length ? '└─' : '├─'} </Text>
          <Text color={palette.ink} wrap="truncate-end">
            {step.title ?? step.stepId}
          </Text>
          <Text bold color={stateColor(step.state)}>
            {' '}
            [{step.state.toUpperCase()}]
          </Text>
          {step.errorCode ? <Text color={palette.danger}> {step.errorCode}</Text> : null}
          {step.kind === 'human_task' && step.state === 'waiting' ? (
            <Text color={palette.amber}> /human-tasks</Text>
          ) : null}
        </Box>
      ))}
      {plan.steps.length > steps.length ? (
        <Text color={palette.faint}>… {plan.steps.length - steps.length} more step(s)</Text>
      ) : null}
    </Box>
  )
}

function stateColor(state: string): string {
  if (state === 'succeeded' || state === 'verified') return palette.mint
  if (state === 'failed' || state === 'blocked' || state === 'cancelled') return palette.danger
  if (state === 'running' || state === 'verifying') return palette.accent
  return palette.muted
}

function ToolLine({
  marker,
  color,
  tool,
  detail,
}: {
  marker: string
  color: string
  tool?: ToolDetails
  detail: string
}) {
  return (
    <Box paddingX={1}>
      <Text bold color={color}>
        {marker} {tool?.name ?? 'tool'}
      </Text>
      {tool?.target ? (
        <Text color={palette.muted} wrap="truncate-middle">
          {' '}
          {tool.target}
        </Text>
      ) : null}
      <Text color={palette.faint}> · {detail}</Text>
    </Box>
  )
}

function Notice({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <Box paddingX={1}>
      <Text color={color} wrap="wrap">
        {children}
      </Text>
    </Box>
  )
}

function EmptyState({ compact }: { compact: boolean }) {
  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Text bold color={palette.ink}>
        What do you want to build?
      </Text>
      <Text color={palette.muted}>
        Describe an outcome. Praxis will show the conversation and tool activity here.
      </Text>
      {!compact ? <Text color={palette.faint}>Try /plan · /session · /doctor</Text> : null}
    </Box>
  )
}

type ToolDetails = {
  name: string
  target?: string
}

function collectToolDetails(events: readonly SessionEvent[]): Map<string, ToolDetails> {
  const tools = new Map<string, ToolDetails>()
  for (const event of events) {
    if (event.type === 'tool_planning' || event.type === 'tool_start') {
      tools.set(event.toolCallId, {
        name: event.name,
        ...toolTarget(event.input),
      })
    }
  }
  return tools
}

function toolTarget(input: unknown): Pick<ToolDetails, 'target'> {
  if (!input || typeof input !== 'object') return {}
  const record = input as Record<string, unknown>
  for (const key of ['path', 'filePath', 'target', 'command', 'query', 'pattern', 'url']) {
    const value = record[key]
    if (typeof value !== 'string' || !value.trim()) continue
    return { target: compactDetail(value, 96) }
  }
  return {}
}

function compactDetail(value: string, maximum = 120): string {
  const singleLine = value.replace(/\s+/g, ' ').trim()
  return singleLine.length > maximum ? `${singleLine.slice(0, maximum - 1)}…` : singleLine
}

function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return 'running'
  if (bytes < 1_024) return `${bytes} B`
  return `${(bytes / 1_024).toFixed(1)} kB`
}
