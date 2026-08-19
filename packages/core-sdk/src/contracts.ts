import type { ProviderMessage, ProviderUsage, SkillInvocationEntry } from './llm.js'
import type { ToolResult } from './tool.js'
import type { TraceContext } from './trace.js'

export type AgentRunTraceContext = TraceContext & {
  sessionId: string
  runId: string
}

export type PermissionDecision =
  | { type: 'allow_once' }
  | { type: 'allow_always' }
  | { type: 'deny'; reason?: string }

export type AgentEvent =
  | {
      type: 'prompt_started'
      sessionId: string
      runId: string
      prompt: string
      promptKind?: 'prompt' | 'follow_up'
    }
  | { type: 'text_delta'; runId: string; text: string }
  | { type: 'thinking_delta'; runId: string; text: string }
  | { type: 'tool_planning'; runId: string; toolCallId: string; name: string; input: unknown }
  | { type: 'tool_start'; runId: string; toolCallId: string; name: string; input: unknown }
  | {
      type: 'tool_update'
      runId: string
      toolCallId: string
      message: string
      stream?: 'stdout' | 'stderr'
      delta?: string
      bytes?: number
    }
  | {
      type: 'tool_end'
      runId: string
      toolCallId: string
      ok: boolean
      summary?: string
      output?: unknown
      error?: ToolResult['error']
    }
  | { type: 'steer_queued'; runId: string; steerId: string }
  | { type: 'steer_applied'; runId: string; steerId: string }
  | { type: 'message_committed'; runId: string; messageId: string; role?: 'user' | 'assistant' }
  | {
      type: 'prompt_completed'
      runId: string
      usage?: ProviderUsage
      stopReason?: string
    }
  | {
      type: 'prompt_failed'
      runId: string
      error: string
      code?: string
      category?: RuntimeErrorCategory
    }
  | { type: 'prompt_aborted'; runId: string; reason?: CancellationReason }

export type RuntimeErrorCategory =
  | 'protocol'
  | 'configuration'
  | 'provider'
  | 'tool'
  | 'permission'
  | 'plugin'
  | 'planner'
  | 'subagent'
  | 'persistence'
  | 'cancelled'

export type RuntimeError = {
  code: string
  category: RuntimeErrorCategory
  message: string
  retryable: boolean
  data?: Record<string, unknown>
}

const SENSITIVE_KEY =
  /(api[-_]?key|authorization|token|secret|env|password|credential|cookie|prompt|instruction|conversation)/i

export function runtimeError(
  code: string,
  category: RuntimeErrorCategory,
  message: string,
  data?: Record<string, unknown>,
  retryable = false,
): RuntimeError {
  return {
    code,
    category,
    message,
    retryable,
    ...(data ? { data: redactDiagnosticData(data) } : {}),
  }
}

export function isRuntimeError(value: unknown): value is RuntimeError {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as RuntimeError).code === 'string' &&
    typeof (value as RuntimeError).category === 'string' &&
    typeof (value as RuntimeError).message === 'string' &&
    typeof (value as RuntimeError).retryable === 'boolean'
  )
}

export function redactDiagnosticData(data: Record<string, unknown>): Record<string, unknown> {
  return redactValue(data, new WeakSet<object>()) as Record<string, unknown>
}

function redactValue(value: unknown, ancestors: WeakSet<object>): unknown {
  if (value === null || typeof value !== 'object') return value
  if (ancestors.has(value)) return '[Circular]'

  ancestors.add(value)
  try {
    if (Array.isArray(value)) return value.map((item) => redactValue(item, ancestors))

    const redacted: Record<string, unknown> = {}
    for (const [key, nested] of Object.entries(value)) {
      if (SENSITIVE_KEY.test(key)) continue
      redacted[key] = redactValue(nested, ancestors)
    }
    return redacted
  } finally {
    ancestors.delete(value)
  }
}

export type CancellationReason =
  | 'user_abort'
  | 'deadline_exceeded'
  | 'budget_exhausted'
  | 'parent_cancelled'
  | 'plugin_failure'
  | 'runtime_shutdown'

export type ExecutionBudget = {
  maxTurns: number
  maxToolCalls: number
  maxTokens?: number
  maxChildRuns: number
  maxParallelChildren: number
  maxDepth: number
  deadlineAt?: string
}

/**
 * The pre-admission-split budget shape. It is accepted only by the explicitly versioned
 * compatibility adapter below; new runtime boundaries must use {@link ExecutionBudget}.
 */
export type LegacyExecutionBudgetV1 = {
  maxTurns: number
  maxToolCalls: number
  maxTokens?: number
  maxSubagents: number
  maxDepth: number
  deadlineAt?: string
}

export type LegacyExecutionBudgetDeprecationV1 = Readonly<{
  code: 'LEGACY_EXECUTION_BUDGET_V1_DEPRECATED'
  replacement: 'ExecutionBudget'
  removedField: 'maxSubagents'
  replacementFields: readonly ['maxChildRuns', 'maxParallelChildren']
}>

export const LEGACY_EXECUTION_BUDGET_V1_DEPRECATION: LegacyExecutionBudgetDeprecationV1 =
  Object.freeze({
    code: 'LEGACY_EXECUTION_BUDGET_V1_DEPRECATED',
    replacement: 'ExecutionBudget',
    removedField: 'maxSubagents',
    replacementFields: Object.freeze(['maxChildRuns', 'maxParallelChildren'] as const),
  })

export function adaptLegacyExecutionBudgetV1(
  legacy: LegacyExecutionBudgetV1,
  options: {
    maxParallelChildren: number
    onDeprecation?: (notice: LegacyExecutionBudgetDeprecationV1) => void
  },
): ExecutionBudget {
  if (typeof legacy !== 'object' || legacy === null || Array.isArray(legacy)) {
    throw runtimeError(
      'INVALID_EXECUTION_BUDGET',
      'configuration',
      'Legacy execution budget input must be an object.',
    )
  }
  const candidate = legacy as LegacyExecutionBudgetV1 & Record<string, unknown>
  if (Object.hasOwn(candidate, 'maxChildRuns') || Object.hasOwn(candidate, 'maxParallelChildren')) {
    throw runtimeError(
      'EXECUTION_BUDGET_VERSION_MIXED',
      'configuration',
      'Legacy and current execution budget fields cannot be mixed.',
    )
  }
  const legacyKeys = new Set([
    'maxTurns',
    'maxToolCalls',
    'maxTokens',
    'maxSubagents',
    'maxDepth',
    'deadlineAt',
  ])
  if (Object.keys(candidate).some((key) => !legacyKeys.has(key))) {
    throw runtimeError(
      'INVALID_EXECUTION_BUDGET',
      'configuration',
      'Legacy execution budget input contains an unsupported field.',
    )
  }
  if (
    !isSafeIntegerAtLeast(legacy.maxTurns, 0) ||
    !isSafeIntegerAtLeast(legacy.maxToolCalls, 0) ||
    !isSafeIntegerAtLeast(legacy.maxSubagents, 0) ||
    !isSafeIntegerAtLeast(legacy.maxDepth, 0) ||
    (legacy.maxTokens !== undefined && !isSafeIntegerAtLeast(legacy.maxTokens, 0)) ||
    !isSafeIntegerAtLeast(options.maxParallelChildren, 0) ||
    options.maxParallelChildren > legacy.maxSubagents
  ) {
    throw runtimeError(
      'INVALID_EXECUTION_BUDGET',
      'configuration',
      'Execution budget limits must be bounded non-negative safe integers.',
    )
  }
  if (legacy.deadlineAt !== undefined) toTimestamp(legacy.deadlineAt)
  options.onDeprecation?.(LEGACY_EXECUTION_BUDGET_V1_DEPRECATION)
  return {
    maxTurns: legacy.maxTurns,
    maxToolCalls: legacy.maxToolCalls,
    ...(legacy.maxTokens === undefined ? {} : { maxTokens: legacy.maxTokens }),
    maxChildRuns: legacy.maxSubagents,
    maxParallelChildren: options.maxParallelChildren,
    maxDepth: legacy.maxDepth,
    ...(legacy.deadlineAt === undefined ? {} : { deadlineAt: legacy.deadlineAt }),
  }
}

export type BudgetUsage = {
  turns: number
  toolCalls: number
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  costUsd?: number
  subagents: number
}

export function clampChildBudget(
  requested: ExecutionBudget,
  remaining: ExecutionBudget,
): ExecutionBudget {
  return {
    maxTurns: Math.min(requested.maxTurns, remaining.maxTurns),
    maxToolCalls: Math.min(requested.maxToolCalls, remaining.maxToolCalls),
    ...minOptional(requested.maxTokens, remaining.maxTokens, 'maxTokens'),
    maxChildRuns: Math.min(requested.maxChildRuns, remaining.maxChildRuns),
    maxParallelChildren: Math.min(requested.maxParallelChildren, remaining.maxParallelChildren),
    maxDepth: Math.min(requested.maxDepth, remaining.maxDepth),
    ...earliestDeadline(requested.deadlineAt, remaining.deadlineAt),
  }
}

function isSafeIntegerAtLeast(value: unknown, minimum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum
}

function minOptional(
  requested: number | undefined,
  remaining: number | undefined,
  property: 'maxTokens',
): Partial<Pick<ExecutionBudget, 'maxTokens'>> {
  if (requested === undefined && remaining === undefined) return {}
  if (requested === undefined) return { [property]: remaining }
  if (remaining === undefined) return { [property]: requested }
  return { [property]: Math.min(requested, remaining) }
}

function earliestDeadline(
  requested: string | undefined,
  remaining: string | undefined,
): Partial<Pick<ExecutionBudget, 'deadlineAt'>> {
  const requestedTimestamp = requested === undefined ? undefined : toTimestamp(requested)
  const remainingTimestamp = remaining === undefined ? undefined : toTimestamp(remaining)
  if (requestedTimestamp === undefined && remainingTimestamp === undefined) return {}
  if (requestedTimestamp === undefined) return { deadlineAt: remaining! }
  if (remainingTimestamp === undefined) return { deadlineAt: requested! }
  return { deadlineAt: requestedTimestamp <= remainingTimestamp ? requested! : remaining! }
}

function toTimestamp(deadlineAt: string): number {
  const timestamp = Date.parse(deadlineAt)
  if (!Number.isNaN(timestamp)) return timestamp
  throw runtimeError(
    'INVALID_DEADLINE',
    'configuration',
    'Execution budget deadlineAt must be a valid timestamp.',
    {
      deadlineAt,
    },
  )
}

export class CancellationTree {
  private readonly children = new Map<string, Set<string>>()
  private readonly parents = new Map<string, string>()
  private readonly cancelled = new Map<string, CancellationReason>()

  link(parentRunId: string, childRunId: string): void {
    if (parentRunId === childRunId) {
      throw runtimeError(
        'CANCELLATION_TREE_CYCLE',
        'cancelled',
        'A run cannot be its own cancellation parent.',
      )
    }
    const existingParent = this.parents.get(childRunId)
    if (existingParent !== undefined && existingParent !== parentRunId) {
      throw runtimeError(
        'CANCELLATION_TREE_MULTIPLE_PARENTS',
        'cancelled',
        'A run cannot have more than one cancellation parent.',
        { childRunId, existingParent, parentRunId },
      )
    }
    if (existingParent === parentRunId) return
    if (this.wouldCreateCycle(parentRunId, childRunId)) {
      throw runtimeError(
        'CANCELLATION_TREE_CYCLE',
        'cancelled',
        'A cancellation link cannot create an indirect cycle.',
        { parentRunId, childRunId },
      )
    }

    this.parents.set(childRunId, parentRunId)
    const children = this.children.get(parentRunId) ?? new Set<string>()
    children.add(childRunId)
    this.children.set(parentRunId, children)

    if (this.cancelled.has(parentRunId) && !this.cancelled.has(childRunId)) {
      this.cancel(childRunId, 'parent_cancelled')
    }
  }

  unlink(parentRunId: string, childRunId: string): boolean {
    if (this.parents.get(childRunId) !== parentRunId) return false
    this.parents.delete(childRunId)
    const siblings = this.children.get(parentRunId)
    siblings?.delete(childRunId)
    if (siblings?.size === 0) this.children.delete(parentRunId)
    return true
  }

  cancel(runId: string, reason: CancellationReason): Array<[string, CancellationReason]> {
    if (this.cancelled.has(runId)) return []

    const cancelled: Array<[string, CancellationReason]> = [[runId, reason]]
    this.cancelled.set(runId, reason)
    for (let index = 0; index < cancelled.length; index += 1) {
      const [parentRunId] = cancelled[index]
      for (const childRunId of this.children.get(parentRunId) ?? []) {
        if (this.cancelled.has(childRunId)) continue
        this.cancelled.set(childRunId, 'parent_cancelled')
        cancelled.push([childRunId, 'parent_cancelled'])
      }
    }
    return cancelled
  }

  reasonFor(runId: string): CancellationReason | undefined {
    return this.cancelled.get(runId)
  }

  parentFor(runId: string): string | undefined {
    return this.parents.get(runId)
  }

  private wouldCreateCycle(parentRunId: string, childRunId: string): boolean {
    let candidate: string | undefined = parentRunId
    while (candidate !== undefined) {
      if (candidate === childRunId) return true
      candidate = this.parents.get(candidate)
    }
    return false
  }
}

export type SessionRecord = {
  recordVersion?: 2
  sessionId: string
  state: 'idle' | 'running' | 'closed'
  plannerMode?: 'auto' | 'solo' | 'workflow' | 'direct' | 'supervisor'
  cwd: string
  provider: string
  model: string
  contextLimitTokens?: number
  createdAt: string
  updatedAt: string
  name?: string
  parentSessionId?: string
  activeLeafId?: string
  labels?: string[]
  messageCount?: number
  usage?: ProviderUsage
  lastTerminalState?: 'completed' | 'failed' | 'aborted'
}

/** Structural execution state shared by planners and loops, never by persistence services. */
export type AgentRun = {
  id: string
  sessionId: string
  trace: AgentRunTraceContext
  promptKind: 'prompt' | 'follow_up'
  text: string
  aborted: boolean
  cancellationReason?: CancellationReason
  terminal: boolean
  controller: AbortController
  steerQueue: Array<{ id: string; text: string }>
  budget?: ExecutionBudget
  usage?: BudgetUsage
}

export type AgentSession = {
  sessionId: string
  cwd: string
  provider: string
  model: string
  messages: ProviderMessage[]
}

export type SummaryCheckpoint = {
  id: string
  trust?: 'low'
  scope?: Readonly<{ kind: 'parent' | 'child'; sessionId: string }>
  messageStart: number
  messageEnd: number
  content: string
  digest: string
  estimatedTokens: number
  estimatedGainTokens?: number
  createdAt: string
  reason?: 'manual' | 'threshold' | 'overflow'
  summary?: CompactionSummary
  provenance?: CompactionProvenance
  skillInvocations?: SkillInvocationEntry[]
  /** Optional Provider/model-bound acceleration; the semantic fields remain portable. */
  nativeContext?: import('./llm.js').ProviderNativeContext
}

export type CompactionGeneratorIdentity =
  | {
      kind: 'deterministic'
      id: string
    }
  | {
      kind: 'model'
      id: string
      provider: string
      model: string
    }

export type CompactionProvenance = {
  schemaVersion: 1
  generator: CompactionGeneratorIdentity
  fallbackFrom?: CompactionGeneratorIdentity
}

export type CompactionSummary = {
  objective?: string
  /** Runtime-owned references that must survive removal of the original task message. */
  relevantRefs?: string[]
  decisions: string[]
  constraints: string[]
  readFiles: string[]
  modifiedFiles: string[]
  unresolved: string[]
  activePlan: string[]
}

export type PlanStep = {
  id: string
  title: string
  state: 'pending' | 'in_progress' | 'completed' | 'blocked'
}

export type CompactPlan = {
  objective: string
  steps: PlanStep[]
  revision: number
  updatedAt: string
}

export type SessionMemory = {
  sessionId: string
  checkpoint?: SummaryCheckpoint
  plan?: CompactPlan
}

export interface SessionRepository {
  initialize(): Promise<void>
  list(): Promise<SessionRecord[]>
  get(sessionId: string): Promise<SessionRecord | undefined>
  create(session: SessionRecord): Promise<void>
  update(session: SessionRecord): Promise<void>
  appendMessage(sessionId: string, message: ProviderMessage): Promise<void>
  loadMessages(sessionId: string): Promise<ProviderMessage[]>
  loadMemory(sessionId: string): Promise<SessionMemory>
  saveMemory(memory: SessionMemory): Promise<void>
  appendRequestMessage?(
    sessionId: string,
    clientRequestId: string,
    runId: string,
    message: ProviderMessage,
  ): Promise<{ duplicateRunId?: string }>
  loadClientRequests?(sessionId: string): Promise<Record<string, string>>
  updateTerminal?(
    sessionId: string,
    terminal: NonNullable<SessionRecord['lastTerminalState']>,
    usage: ProviderUsage,
    messageCount: number,
    errorCode?: string,
  ): Promise<SessionRecord>
}

/**
 * @deprecated Compatibility-only telemetry contract. New runtime work must use
 * the privacy-by-construction TraceRecord contract from `trace.ts`.
 */
export type TelemetryRecord = {
  runtimeId?: string
  sessionId?: string
  runId?: string
  parentRunId?: string
  pluginId?: string
  capabilityId?: string
  durationMs?: number
  outcome: string
  usage?: BudgetUsage
  data?: Record<string, unknown>
}

export interface TelemetrySink {
  record(record: TelemetryRecord): void
  records(): readonly TelemetryRecord[]
}

export function createTelemetryRecord(record: TelemetryRecord): TelemetryRecord {
  const {
    runtimeId,
    sessionId,
    runId,
    parentRunId,
    pluginId,
    capabilityId,
    durationMs,
    outcome,
    usage,
    data,
  } = record

  return {
    ...(runtimeId === undefined ? {} : { runtimeId }),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(runId === undefined ? {} : { runId }),
    ...(parentRunId === undefined ? {} : { parentRunId }),
    ...(pluginId === undefined ? {} : { pluginId }),
    ...(capabilityId === undefined ? {} : { capabilityId }),
    ...(durationMs === undefined ? {} : { durationMs }),
    outcome,
    ...(usage === undefined ? {} : { usage: { ...usage } }),
    ...(data === undefined ? {} : { data: redactDiagnosticData(data) }),
  }
}

export function recordTelemetry(sink: TelemetrySink, record: TelemetryRecord): void {
  sink.record(createTelemetryRecord(record))
}

export class NoopTelemetrySink implements TelemetrySink {
  record(_record: TelemetryRecord): void {}

  records(): readonly TelemetryRecord[] {
    return []
  }
}
