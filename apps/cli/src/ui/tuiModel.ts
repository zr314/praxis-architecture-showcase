import type { SessionEvent, UsageSummary } from '@praxis/protocol'

export type TerminalLayout = {
  columns: number
  rows: number
  compact: boolean
  wide: boolean
  railWidth: number
  transcriptWidth: number
  composerColumns: number
  editorRows: number
}

export type ActivitySummary = {
  prompts: number
  tools: number
  failedTools: number
  warnings: number
  artifacts: number
  usage?: UsageSummary
}

export type WorkflowPlanView = Readonly<{
  planId: string
  state: string
  objective?: string
  steps: readonly Readonly<{
    stepId: string
    title?: string
    kind?: string
    order: number
    state: string
    errorCode?: string
  }>[]
}>

export function terminalLayout(columns = 80, rows = 24): TerminalLayout {
  // Never render into the terminal's final column. Windows terminals keep a
  // pending-wrap flag after a full-width line; a later cursor movement can
  // then materialize that wrap and make an in-place update scroll. Ink's
  // incremental renderer relies on cursor movement, so one spare column is
  // required in addition to the spare hardware row below.
  const safeColumns = Math.max(1, Math.floor(columns) - 1)
  const safeRows = Math.max(1, Math.floor(rows))
  const compact = safeColumns < 88
  const wide = safeColumns >= 104 && safeRows >= 34
  const railWidth = wide ? 29 : 0
  const transcriptWidth = wide ? safeColumns - railWidth - 1 : safeColumns
  return {
    columns: safeColumns,
    rows: safeRows,
    compact,
    wide,
    railWidth,
    transcriptWidth,
    composerColumns: Math.max(1, safeColumns - 6),
    editorRows: clamp(Math.floor(safeRows / 8), 1, 6),
  }
}

export type EditorViewport = {
  value: string
  cursorIndex: number
  hiddenAbove: number
  hiddenBelow: number
  totalRows: number
}

export function editorViewport(
  value: string,
  cursorIndex: number,
  columns: number,
  maximumRows: number,
): EditorViewport {
  const width = Math.max(1, columns)
  const rows = visualRows(value, width)
  const boundedCursor = Math.max(0, Math.min(value.length, cursorIndex))
  let cursorRow = 0
  for (let index = 0; index < rows.length; index += 1) {
    if ((rows[index]?.start ?? 0) <= boundedCursor) cursorRow = index
  }
  const visibleRows = Math.max(1, maximumRows)
  const start = clamp(
    cursorRow - Math.floor(visibleRows / 2),
    0,
    Math.max(0, rows.length - visibleRows),
  )
  const end = Math.min(rows.length, start + visibleRows)
  const visibleStart = rows[start]?.start ?? 0
  const visibleEnd = rows[end - 1]?.end ?? value.length
  return {
    value: value.slice(visibleStart, visibleEnd),
    cursorIndex: boundedCursor - visibleStart,
    hiddenAbove: start,
    hiddenBelow: rows.length - end,
    totalRows: rows.length,
  }
}

export function transcriptEvents(events: readonly SessionEvent[]): readonly SessionEvent[] {
  const latestToolEvent = new Map<string, SessionEvent>()
  const runsWithAssistantText = new Set<string>()
  const currentPlanBoundary = new Map<string, number>()

  for (const event of events) {
    if (isToolLifecycleEvent(event)) latestToolEvent.set(event.toolCallId, event)
    if (event.type === 'text_delta' && event.text.trim()) runsWithAssistantText.add(event.runId)
    if (
      event.type === 'supervisor_update' &&
      event.update.source.kind === 'journal' &&
      event.update.source.update.kind === 'plan' &&
      (event.update.source.update.event === 'plan.created' ||
        event.update.source.update.event === 'plan.revised')
    ) {
      currentPlanBoundary.set(event.update.correlation.planId, event.update.parentSequence)
    }
  }

  return events.filter((event) => {
    if (
      event.type === 'runtime_ready' ||
      event.type === 'message_committed' ||
      event.type === 'permission_request' ||
      (event.type === 'supervisor_update' && supervisorErrorCode(event) === undefined)
    ) {
      return false
    }
    if (event.type === 'thinking_delta' && runsWithAssistantText.has(event.runId)) return false
    if (isToolLifecycleEvent(event)) return latestToolEvent.get(event.toolCallId) === event
    if (
      event.type === 'supervisor_update' &&
      event.update.source.kind === 'journal' &&
      event.update.parentSequence < (currentPlanBoundary.get(event.update.correlation.planId) ?? 0)
    ) {
      return false
    }
    return true
  })
}

export function transcriptWindow(
  events: readonly SessionEvent[],
  columns: number,
  maximumRows: number,
): readonly SessionEvent[] {
  const candidates = transcriptEvents(events)
  const rowBudget = Math.max(1, Math.floor(maximumRows))
  let latestPromptIndex = -1
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    if (candidates[index]?.type !== 'prompt_started') continue
    latestPromptIndex = index
    break
  }
  const anchoredPrompt =
    rowBudget > 1 && latestPromptIndex >= 0
      ? visiblePromptHead(candidates[latestPromptIndex]!, columns)
      : undefined
  let remaining = rowBudget - (anchoredPrompt === undefined ? 0 : 1)
  const selected: SessionEvent[] = []
  const lowerBound = anchoredPrompt === undefined ? 0 : latestPromptIndex + 1
  for (let index = candidates.length - 1; index >= lowerBound && remaining > 0; index -= 1) {
    const event = candidates[index]!
    const rows = eventRows(event, columns)
    if (event.type === 'text_delta' && rows > remaining) {
      selected.push({ ...event, text: visibleTextTail(event.text, columns, remaining) })
      remaining = 0
      break
    }
    if (rows > remaining) break
    selected.push(event)
    remaining -= rows
  }
  if (anchoredPrompt !== undefined) selected.push(anchoredPrompt)
  return selected.reverse()
}

export function workflowPlanGraph(
  events: readonly SessionEvent[],
  snapshot?: WorkflowPlanView,
): WorkflowPlanView | undefined {
  let plan: { planId: string; state: string; objective?: string } | undefined = snapshot
    ? {
        planId: snapshot.planId,
        state: snapshot.state,
        ...(snapshot.objective === undefined ? {} : { objective: snapshot.objective }),
      }
    : undefined
  const steps = new Map<
    string,
    {
      stepId: string
      title?: string
      kind?: string
      order: number
      state: string
      errorCode?: string
    }
  >()
  for (const step of snapshot?.steps ?? []) steps.set(step.stepId, { ...step })
  for (const event of events) {
    if (event.type === 'workflow_update') {
      plan = {
        planId: event.update.workflowId,
        state: event.update.state,
        objective: event.update.objective,
      }
      steps.clear()
      for (const [order, node] of event.update.nodes.entries()) {
        steps.set(node.nodeId, {
          stepId: node.nodeId,
          title: node.title,
          kind: node.kind,
          order,
          state: node.state,
          ...(node.errorCode === undefined ? {} : { errorCode: node.errorCode }),
        })
      }
      continue
    }
    if (event.type !== 'supervisor_update' || event.update.source.kind !== 'journal') continue
    const { correlation } = event.update
    const update = event.update.source.update
    if (update.kind === 'plan') {
      if (
        plan?.planId !== correlation.planId ||
        update.event === 'plan.created' ||
        update.event === 'plan.revised'
      ) {
        steps.clear()
      }
      plan = {
        planId: correlation.planId,
        state: update.state,
        ...((update.objective ?? plan?.objective) === undefined
          ? {}
          : { objective: update.objective ?? plan?.objective }),
      }
      continue
    }
    if (update.kind !== 'step' || correlation.stepId === undefined) continue
    const prior = steps.get(correlation.stepId)
    steps.set(correlation.stepId, {
      stepId: correlation.stepId,
      ...((update.title ?? prior?.title) === undefined
        ? {}
        : { title: update.title ?? prior?.title }),
      order: update.order ?? prior?.order ?? steps.size,
      state: update.state,
      ...(update.errorCode === undefined ? {} : { errorCode: update.errorCode }),
    })
  }
  if (plan === undefined) return undefined
  return {
    ...plan,
    steps: [...steps.values()].sort(
      (left, right) => left.order - right.order || left.stepId.localeCompare(right.stepId),
    ),
  }
}

/** Parses the durable session.plan response without trusting transport input. */
export function workflowPlanSnapshot(value: unknown): WorkflowPlanView | undefined {
  if (!isRecord(value) || !isRecord(value.plan)) return undefined
  const plan = value.plan
  if (
    typeof plan.planId !== 'string' ||
    typeof plan.state !== 'string' ||
    !Array.isArray(plan.steps)
  ) {
    return undefined
  }
  const steps: Array<WorkflowPlanView['steps'][number]> = []
  for (let index = 0; index < plan.steps.length; index += 1) {
    const step = plan.steps[index]
    if (!isRecord(step) || typeof step.stepId !== 'string' || typeof step.state !== 'string') {
      return undefined
    }
    steps.push({
      stepId: step.stepId,
      ...(typeof step.title === 'string' ? { title: step.title } : {}),
      order: typeof step.order === 'number' && Number.isFinite(step.order) ? step.order : index,
      state: step.state,
      ...(typeof step.errorCode === 'string' ? { errorCode: step.errorCode } : {}),
    })
  }
  return {
    planId: plan.planId,
    state: plan.state,
    ...(typeof plan.objective === 'string' ? { objective: plan.objective } : {}),
    steps: steps.sort(
      (left, right) => left.order - right.order || left.stepId.localeCompare(right.stepId),
    ),
  }
}

export function supervisorErrorCode(
  event: Extract<SessionEvent, { type: 'supervisor_update' }>,
): string | undefined {
  if (event.update.source.kind !== 'journal') return undefined
  const update = event.update.source.update
  return 'errorCode' in update && typeof update.errorCode === 'string'
    ? update.errorCode
    : undefined
}

function eventRows(event: SessionEvent, columns: number): number {
  if (event.type === 'text_delta') return visualRows(event.text, Math.max(1, columns - 2)).length
  if (event.type === 'prompt_started') {
    return Math.max(1, visualRows(event.prompt, Math.max(1, columns - 4)).length)
  }
  return 1
}

function visibleTextTail(value: string, columns: number, maximumRows: number): string {
  const rows = visualRows(value, Math.max(1, columns - 2))
  if (rows.length <= maximumRows) return value
  const first = rows[Math.max(0, rows.length - maximumRows)]
  return `…\n${value.slice(first?.start ?? 0)}`
}

function visiblePromptHead(event: SessionEvent, columns: number): SessionEvent {
  if (event.type !== 'prompt_started') return event
  const rows = visualRows(event.prompt, Math.max(1, columns - 4))
  if (rows.length <= 1) return event
  return { ...event, prompt: `${event.prompt.slice(0, rows[0]?.end ?? 0)}…` }
}

function isToolLifecycleEvent(
  event: SessionEvent,
): event is Extract<
  SessionEvent,
  { type: 'tool_planning' | 'tool_start' | 'tool_update' | 'tool_end' }
> {
  return (
    event.type === 'tool_planning' ||
    event.type === 'tool_start' ||
    event.type === 'tool_update' ||
    event.type === 'tool_end'
  )
}

export function summarizeActivity(
  events: readonly SessionEvent[],
  fallbackUsage?: UsageSummary,
): ActivitySummary {
  let prompts = 0
  let tools = 0
  let failedTools = 0
  let warnings = 0
  let artifacts = 0
  let usage = fallbackUsage

  for (const event of events) {
    if (event.type === 'prompt_started') prompts += 1
    if (event.type === 'tool_start') tools += 1
    if (event.type === 'tool_end') {
      if (!event.ok) failedTools += 1
      artifacts += artifactCount(event.output)
    }
    if (event.type === 'runtime_warning') warnings += 1
    if (event.type === 'prompt_completed' && event.usage) usage = event.usage
  }

  return { prompts, tools, failedTools, warnings, artifacts, usage }
}

export function contextPressure(
  events: readonly SessionEvent[],
  limit: number | undefined,
  fallbackUsage?: UsageSummary,
): number | undefined {
  if (!limit || limit <= 0) return undefined
  let usage = fallbackUsage
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'prompt_completed' && event.usage) {
      usage = event.usage
      break
    }
  }
  if (!usage) return 0
  return Math.min(1, ((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)) / limit)
}

function artifactCount(output: unknown): number {
  if (!output || typeof output !== 'object') return 0
  const artifacts = (output as { artifacts?: unknown }).artifacts
  return Array.isArray(artifacts) ? artifacts.length : 0
}

function visualRows(value: string, columns: number): Array<{ start: number; end: number }> {
  const segments = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value)]
  const rows: Array<{ start: number; end: number }> = []
  let start = 0
  let cells = 0
  for (const segment of segments) {
    if (segment.segment === '\n') {
      rows.push({ start, end: segment.index })
      start = segment.index + segment.segment.length
      cells = 0
      continue
    }
    const nextCells = graphemeCells(segment.segment)
    if (cells > 0 && cells + nextCells > columns) {
      rows.push({ start, end: segment.index })
      start = segment.index
      cells = 0
    }
    cells += nextCells
  }
  rows.push({ start, end: value.length })
  return rows
}

function graphemeCells(value: string): number {
  if (value === '\t') return 2
  if (/\p{Extended_Pictographic}/u.test(value)) return 2
  const point = value.codePointAt(0) ?? 0
  return isWideCodePoint(point) ? 2 : 1
}

function isWideCodePoint(point: number): boolean {
  return (
    (point >= 0x1100 && point <= 0x115f) ||
    (point >= 0x2e80 && point <= 0xa4cf) ||
    (point >= 0xac00 && point <= 0xd7a3) ||
    (point >= 0xf900 && point <= 0xfaff) ||
    (point >= 0xfe10 && point <= 0xfe6f) ||
    (point >= 0xff00 && point <= 0xff60) ||
    (point >= 0xffe0 && point <= 0xffe6) ||
    (point >= 0x1f300 && point <= 0x1faff)
  )
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
