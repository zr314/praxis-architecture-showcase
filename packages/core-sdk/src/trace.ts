export type TraceKind =
  | 'run.started'
  | 'run.completed'
  | 'run.failed'
  | 'run.aborted'
  | 'provider.started'
  | 'provider.first_token'
  | 'provider.retry'
  | 'provider.fallback'
  | 'provider.completed'
  | 'provider.failed'
  | 'tool.started'
  | 'tool.completed'
  | 'tool.failed'
  | 'permission.decided'
  | 'plugin.started'
  | 'plugin.stopped'
  | 'plugin.failed'
  | 'prompt.manifest'
  | 'context.selected'
  | 'context.compacted'
  | 'persistence.completed'
  | 'persistence.failed'

export type TraceContext = {
  traceId: string
  runtimeId: string
  sessionId?: string
  runId?: string
  parentRunId?: string
  childRunId?: string
  parentTraceId?: string
  turnId?: string
  toolCallId?: string
  pluginCallId?: string
}

/** Fixed, content-free annotations for a trace event. */
export type TraceAttributes = {
  providerId?: string
  model?: string
  toolName?: string
  pluginId?: string
  capabilityId?: string
  stopReason?: string
  errorCode?: string
  errorCategory?: string
  permissionDecision?: 'allow_once' | 'allow_always' | 'deny'
  toolOutcome?: 'completed' | 'input_blocked' | 'policy_blocked' | 'invocation_failed'
  health?: 'healthy' | 'degraded' | 'unhealthy'
  manifestDigest?: string
  promptVariant?: 'baseline-v1' | 'iron-law-lean-v1'
  promptSectionId?: string
  promptSectionDigest?: string
  promptSectionSource?: 'builtin' | 'runtime' | 'project'
  promptSectionCacheScope?: 'request'
  promptSectionIncluded?: boolean
  compactionReason?: 'threshold' | 'overflow' | 'manual'
}

/** Bounded, aggregate measurements for a trace event. */
export type TraceMetrics = {
  durationMs?: number
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  costUsd?: number
  candidateIndex?: number
  attemptIndex?: number
  sectionCount?: number
  sectionOrder?: number
  characters?: number
  estimatedTokens?: number
  uncompactedTokens?: number
  contextLimitTokens?: number
  reservedTokens?: number
  selectedMessages?: number
  omittedMessages?: number
  checkpointTokens?: number
  toolResultTokensBefore?: number
  toolResultTokensAfter?: number
  truncatedToolResults?: number
  truncatedToolResultTokens?: number
  clearedToolResults?: number
  clearedToolResultTokens?: number
  reasoningTokensBefore?: number
  reasoningTokensAfter?: number
  clearedReasoningBlocks?: number
  clearedReasoningTurns?: number
  clearedReasoningTokens?: number
}

export type TraceRecord = {
  schemaVersion: 1
  kind: TraceKind
  timestamp: string
  context: TraceContext
  attributes?: TraceAttributes
  metrics?: TraceMetrics
}

export type CreateTraceRecordInput = Omit<TraceRecord, 'schemaVersion'>

const TRACE_KINDS: ReadonlySet<TraceKind> = new Set([
  'run.started',
  'run.completed',
  'run.failed',
  'run.aborted',
  'provider.started',
  'provider.first_token',
  'provider.retry',
  'provider.fallback',
  'provider.completed',
  'provider.failed',
  'tool.started',
  'tool.completed',
  'tool.failed',
  'permission.decided',
  'plugin.started',
  'plugin.stopped',
  'plugin.failed',
  'prompt.manifest',
  'context.selected',
  'context.compacted',
  'persistence.completed',
  'persistence.failed',
])

const PERMISSION_DECISIONS: ReadonlySet<NonNullable<TraceAttributes['permissionDecision']>> =
  new Set(['allow_once', 'allow_always', 'deny'])

const HEALTH_VALUES: ReadonlySet<NonNullable<TraceAttributes['health']>> = new Set([
  'healthy',
  'degraded',
  'unhealthy',
])

const MAX_TRACE_INDEX = 65_535
const MAX_TRACE_AGGREGATE = 2_147_483_647
const MAX_TRACE_STRING = 128
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/
const SAFE_TRACE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const SAFE_REASON = /^[a-z][a-z0-9_]{0,63}$/
const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/
const SAFE_ERROR_CATEGORY = /^[a-z][a-z0-9_]{0,31}$/
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/
const PROMPT_SECTION_SOURCES: ReadonlySet<NonNullable<TraceAttributes['promptSectionSource']>> =
  new Set(['builtin', 'runtime', 'project'])
const PROMPT_CACHE_SCOPES: ReadonlySet<NonNullable<TraceAttributes['promptSectionCacheScope']>> =
  new Set(['request'])
const PROMPT_VARIANTS: ReadonlySet<NonNullable<TraceAttributes['promptVariant']>> = new Set([
  'baseline-v1',
  'iron-law-lean-v1',
])
const TOOL_OUTCOMES: ReadonlySet<NonNullable<TraceAttributes['toolOutcome']>> = new Set([
  'completed',
  'input_blocked',
  'policy_blocked',
  'invocation_failed',
])
const COMPACTION_REASONS: ReadonlySet<NonNullable<TraceAttributes['compactionReason']>> = new Set([
  'threshold',
  'overflow',
  'manual',
])

export interface TraceSink {
  append(record: TraceRecord): Promise<void>
  flush(): Promise<void>
}

/**
 * Builds a trace record from the fixed trace vocabulary only. This deliberately
 * excludes provider and tool payloads, prompts, inputs, outputs, and metadata bags.
 */
export function createTraceRecord(input: CreateTraceRecordInput): TraceRecord {
  assertTraceKind(input.kind)
  const attributes = cloneAttributes(input.attributes)
  const metrics = cloneMetrics(input.metrics)

  return {
    schemaVersion: 1,
    kind: input.kind,
    timestamp: validTimestamp(input.timestamp),
    context: cloneContext(input.context),
    ...(attributes === undefined ? {} : { attributes }),
    ...(metrics === undefined ? {} : { metrics }),
  }
}

export class NoopTraceSink implements TraceSink {
  async append(_record: TraceRecord): Promise<void> {}

  async flush(): Promise<void> {}
}

function cloneContext(context: TraceContext): TraceContext {
  return {
    traceId: safeTraceId(context.traceId),
    runtimeId: safeIdentifier(context.runtimeId, 'context.runtimeId'),
    ...optionalIdentifier(context.sessionId, 'sessionId'),
    ...optionalIdentifier(context.runId, 'runId'),
    ...optionalIdentifier(context.parentRunId, 'parentRunId'),
    ...optionalIdentifier(context.childRunId, 'childRunId'),
    ...optionalIdentifier(context.parentTraceId, 'parentTraceId'),
    ...optionalIdentifier(context.turnId, 'turnId'),
    ...optionalIdentifier(context.toolCallId, 'toolCallId'),
    ...optionalIdentifier(context.pluginCallId, 'pluginCallId'),
  }
}

function safeTraceId(value: unknown): string {
  const string = requiredString(value, 'context.traceId')
  if (!SAFE_TRACE_ID.test(string)) {
    throw new TypeError(
      `Trace field context.traceId must be a safe identifier using only letters, digits, underscores, and hyphens and be at most ${MAX_TRACE_STRING} characters.`,
    )
  }
  return string
}

function cloneAttributes(attributes: TraceAttributes | undefined): TraceAttributes | undefined {
  if (attributes === undefined) return undefined
  return {
    ...optionalIdentifier(attributes.providerId, 'providerId'),
    ...optionalIdentifier(attributes.model, 'model'),
    ...optionalIdentifier(attributes.toolName, 'toolName'),
    ...optionalIdentifier(attributes.pluginId, 'pluginId'),
    ...optionalIdentifier(attributes.capabilityId, 'capabilityId'),
    ...optionalSafeToken(attributes.stopReason, 'stopReason', SAFE_REASON, 'other'),
    ...optionalSafeToken(attributes.errorCode, 'errorCode', SAFE_ERROR_CODE, 'UNCLASSIFIED'),
    ...optionalSafeToken(attributes.errorCategory, 'errorCategory', SAFE_ERROR_CATEGORY, 'unknown'),
    ...optionalPermissionDecision(attributes.permissionDecision),
    ...optionalToolOutcome(attributes.toolOutcome),
    ...optionalHealth(attributes.health),
    ...optionalDigest(attributes.manifestDigest, 'manifestDigest'),
    ...optionalPromptVariant(attributes.promptVariant),
    ...optionalIdentifier(attributes.promptSectionId, 'promptSectionId'),
    ...optionalDigest(attributes.promptSectionDigest, 'promptSectionDigest'),
    ...optionalPromptSectionSource(attributes.promptSectionSource),
    ...optionalPromptCacheScope(attributes.promptSectionCacheScope),
    ...optionalBoolean(attributes.promptSectionIncluded, 'promptSectionIncluded'),
    ...optionalCompactionReason(attributes.compactionReason),
  }
}

function optionalPromptVariant(value: unknown): Partial<Pick<TraceAttributes, 'promptVariant'>> {
  if (value === undefined) return {}
  if (
    typeof value !== 'string' ||
    !PROMPT_VARIANTS.has(value as NonNullable<TraceAttributes['promptVariant']>)
  ) {
    throw new TypeError('Trace attribute promptVariant must be an allowed Prompt variant.')
  }
  return { promptVariant: value as TraceAttributes['promptVariant'] }
}

function cloneMetrics(metrics: TraceMetrics | undefined): TraceMetrics | undefined {
  if (metrics === undefined) return undefined
  return {
    ...optionalMetric(metrics.durationMs, 'durationMs'),
    ...optionalMetric(metrics.inputTokens, 'inputTokens'),
    ...optionalMetric(metrics.outputTokens, 'outputTokens'),
    ...optionalMetric(metrics.cacheReadTokens, 'cacheReadTokens'),
    ...optionalMetric(metrics.cacheWriteTokens, 'cacheWriteTokens'),
    ...optionalMetric(metrics.costUsd, 'costUsd'),
    ...optionalBoundedIndex(metrics.candidateIndex, 'candidateIndex'),
    ...optionalBoundedIndex(metrics.attemptIndex, 'attemptIndex'),
    ...optionalBoundedAggregate(metrics.sectionCount, 'sectionCount'),
    ...optionalBoundedAggregate(metrics.sectionOrder, 'sectionOrder'),
    ...optionalBoundedAggregate(metrics.characters, 'characters'),
    ...optionalBoundedAggregate(metrics.estimatedTokens, 'estimatedTokens'),
    ...optionalBoundedAggregate(metrics.uncompactedTokens, 'uncompactedTokens'),
    ...optionalBoundedAggregate(metrics.contextLimitTokens, 'contextLimitTokens'),
    ...optionalBoundedAggregate(metrics.reservedTokens, 'reservedTokens'),
    ...optionalBoundedAggregate(metrics.selectedMessages, 'selectedMessages'),
    ...optionalBoundedAggregate(metrics.omittedMessages, 'omittedMessages'),
    ...optionalBoundedAggregate(metrics.checkpointTokens, 'checkpointTokens'),
    ...optionalBoundedAggregate(metrics.toolResultTokensBefore, 'toolResultTokensBefore'),
    ...optionalBoundedAggregate(metrics.toolResultTokensAfter, 'toolResultTokensAfter'),
    ...optionalBoundedAggregate(metrics.truncatedToolResults, 'truncatedToolResults'),
    ...optionalBoundedAggregate(metrics.truncatedToolResultTokens, 'truncatedToolResultTokens'),
    ...optionalBoundedAggregate(metrics.clearedToolResults, 'clearedToolResults'),
    ...optionalBoundedAggregate(metrics.clearedToolResultTokens, 'clearedToolResultTokens'),
    ...optionalBoundedAggregate(metrics.reasoningTokensBefore, 'reasoningTokensBefore'),
    ...optionalBoundedAggregate(metrics.reasoningTokensAfter, 'reasoningTokensAfter'),
    ...optionalBoundedAggregate(metrics.clearedReasoningBlocks, 'clearedReasoningBlocks'),
    ...optionalBoundedAggregate(metrics.clearedReasoningTurns, 'clearedReasoningTurns'),
    ...optionalBoundedAggregate(metrics.clearedReasoningTokens, 'clearedReasoningTokens'),
  }
}

function optionalHealth(value: unknown): Partial<Pick<TraceAttributes, 'health'>> {
  if (value === undefined) return {}
  if (
    typeof value !== 'string' ||
    !HEALTH_VALUES.has(value as NonNullable<TraceAttributes['health']>)
  ) {
    throw new TypeError('Trace attribute health must be an allowed health value.')
  }
  return { health: value as TraceAttributes['health'] }
}

function optionalToolOutcome(value: unknown): Partial<Pick<TraceAttributes, 'toolOutcome'>> {
  if (value === undefined) return {}
  if (
    typeof value !== 'string' ||
    !TOOL_OUTCOMES.has(value as NonNullable<TraceAttributes['toolOutcome']>)
  ) {
    throw new TypeError('Trace attribute toolOutcome must be an allowed outcome.')
  }
  return { toolOutcome: value as TraceAttributes['toolOutcome'] }
}

function optionalDigest<T extends 'manifestDigest' | 'promptSectionDigest'>(
  value: unknown,
  property: T,
): Partial<Pick<TraceAttributes, T>> {
  if (value === undefined) return {}
  if (typeof value !== 'string' || !SHA256_DIGEST.test(value)) {
    throw new TypeError(`Trace attribute ${property} must be a SHA-256 digest.`)
  }
  return { [property]: value } as Partial<Pick<TraceAttributes, T>>
}

function optionalPromptSectionSource(
  value: unknown,
): Partial<Pick<TraceAttributes, 'promptSectionSource'>> {
  if (value === undefined) return {}
  if (
    typeof value !== 'string' ||
    !PROMPT_SECTION_SOURCES.has(value as NonNullable<TraceAttributes['promptSectionSource']>)
  ) {
    throw new TypeError('Trace attribute promptSectionSource must be an allowed source.')
  }
  return { promptSectionSource: value as TraceAttributes['promptSectionSource'] }
}

function optionalPromptCacheScope(
  value: unknown,
): Partial<Pick<TraceAttributes, 'promptSectionCacheScope'>> {
  if (value === undefined) return {}
  if (
    typeof value !== 'string' ||
    !PROMPT_CACHE_SCOPES.has(value as NonNullable<TraceAttributes['promptSectionCacheScope']>)
  ) {
    throw new TypeError('Trace attribute promptSectionCacheScope must be an allowed scope.')
  }
  return { promptSectionCacheScope: value as TraceAttributes['promptSectionCacheScope'] }
}

function optionalBoolean<T extends 'promptSectionIncluded'>(
  value: unknown,
  property: T,
): Partial<Pick<TraceAttributes, T>> {
  if (value === undefined) return {}
  if (typeof value !== 'boolean') {
    throw new TypeError(`Trace attribute ${property} must be a boolean.`)
  }
  return { [property]: value } as Partial<Pick<TraceAttributes, T>>
}

function optionalCompactionReason(
  value: unknown,
): Partial<Pick<TraceAttributes, 'compactionReason'>> {
  if (value === undefined) return {}
  if (
    typeof value !== 'string' ||
    !COMPACTION_REASONS.has(value as NonNullable<TraceAttributes['compactionReason']>)
  ) {
    throw new TypeError('Trace attribute compactionReason must be an allowed reason.')
  }
  return { compactionReason: value as TraceAttributes['compactionReason'] }
}

function optionalIdentifier<T extends string>(
  value: unknown,
  property: T,
): Partial<Record<T, string>> {
  if (value === undefined) return {}
  return { [property]: safeIdentifier(value, property) } as Partial<Record<T, string>>
}

function optionalSafeToken<T extends string>(
  value: unknown,
  property: T,
  grammar: RegExp,
  fallback: string,
): Partial<Record<T, string>> {
  if (value === undefined) return {}
  const string = requiredString(value, property)
  return { [property]: grammar.test(string) ? string : fallback } as Partial<Record<T, string>>
}

function optionalPermissionDecision(
  value: unknown,
): Partial<Pick<TraceAttributes, 'permissionDecision'>> {
  if (value === undefined) return {}
  if (
    typeof value !== 'string' ||
    !PERMISSION_DECISIONS.has(value as NonNullable<TraceAttributes['permissionDecision']>)
  ) {
    throw new TypeError('Trace attribute permissionDecision must be an allowed decision.')
  }
  return { permissionDecision: value as TraceAttributes['permissionDecision'] }
}

function optionalMetric<T extends keyof TraceMetrics>(
  value: number | undefined,
  property: T,
): Partial<Pick<TraceMetrics, T>> {
  if (value === undefined) return {}
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`Trace metric ${property} must be a finite, non-negative number.`)
  }
  return { [property]: value } as Partial<Pick<TraceMetrics, T>>
}

function optionalBoundedIndex<T extends 'candidateIndex' | 'attemptIndex'>(
  value: number | undefined,
  property: T,
): Partial<Pick<TraceMetrics, T>> {
  if (value === undefined) return {}
  if (!Number.isInteger(value) || value < 0 || value > MAX_TRACE_INDEX) {
    throw new RangeError(
      `Trace metric ${property} must be an integer between 0 and ${MAX_TRACE_INDEX}.`,
    )
  }
  return { [property]: value } as Partial<Pick<TraceMetrics, T>>
}

function optionalBoundedAggregate<
  T extends
    | 'sectionCount'
    | 'sectionOrder'
    | 'characters'
    | 'estimatedTokens'
    | 'uncompactedTokens'
    | 'contextLimitTokens'
    | 'reservedTokens'
    | 'selectedMessages'
    | 'omittedMessages'
    | 'checkpointTokens'
    | 'toolResultTokensBefore'
    | 'toolResultTokensAfter'
    | 'truncatedToolResults'
    | 'truncatedToolResultTokens'
    | 'clearedToolResults'
    | 'clearedToolResultTokens'
    | 'reasoningTokensBefore'
    | 'reasoningTokensAfter'
    | 'clearedReasoningBlocks'
    | 'clearedReasoningTurns'
    | 'clearedReasoningTokens',
>(value: number | undefined, property: T): Partial<Pick<TraceMetrics, T>> {
  if (value === undefined) return {}
  if (!Number.isInteger(value) || value < 0 || value > MAX_TRACE_AGGREGATE) {
    throw new RangeError(
      `Trace metric ${property} must be an integer between 0 and ${MAX_TRACE_AGGREGATE}.`,
    )
  }
  return { [property]: value } as Partial<Pick<TraceMetrics, T>>
}

function assertTraceKind(kind: unknown): asserts kind is TraceKind {
  if (typeof kind !== 'string' || !TRACE_KINDS.has(kind as TraceKind)) {
    throw new TypeError('Trace kind must be an allowed trace event kind.')
  }
}

function requiredString(value: unknown, property: string): string {
  if (typeof value !== 'string') {
    throw new TypeError(`Trace field ${property} must be a string.`)
  }
  return value
}

function safeIdentifier(value: unknown, property: string): string {
  const string = requiredString(value, property)
  if (string.length > MAX_TRACE_STRING || !SAFE_IDENTIFIER.test(string)) {
    throw new TypeError(
      `Trace field ${property} must be a safe identifier of at most ${MAX_TRACE_STRING} characters.`,
    )
  }
  return string
}

function validTimestamp(value: unknown): string {
  const timestamp = requiredString(value, 'timestamp')
  let canonical: string
  try {
    canonical = new Date(timestamp).toISOString()
  } catch {
    throw new TypeError('Trace field timestamp must be a canonical UTC timestamp.')
  }
  if (canonical !== timestamp) {
    throw new TypeError('Trace field timestamp must be a canonical UTC timestamp.')
  }
  return timestamp
}
