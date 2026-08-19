import { createHash } from 'node:crypto'
import {
  type BudgetUsage,
  type CompactionGeneratorIdentity,
  type CompactPlan,
  type ExecutionBudget,
  runtimeError,
} from './contracts.js'
import {
  isProviderNativeContext,
  type ProviderMessage,
  type ProviderNativeContext,
  type ProviderUsage,
  type SkillInvocationEntry,
} from './llm.js'
import {
  assertPlanAttemptTransitionV1,
  assertPlanStateTransitionV1,
  assertPlanStepTransitionV1,
  type PlanAttemptStateV1,
  type PlanStateV1,
  type PlanStepAccessV1,
  type PlanStepStateV1,
  type PlanSuccessCriterionV1,
  readyPlanStepIdsV1,
  validatePlanGraphV1,
  validatePlanStepV1,
} from './plan.js'
import { type SubagentExecutionRequestV1, validateSubagentExecutionRequestV1 } from './subagent.js'
import type { ArtifactReference } from './tool.js'

const MAX_ENTRIES = 100_000
const MAX_TEXT_BYTES = 8 * 1024
const MAX_CONTENT_BLOCK_TEXT_BYTES = 768 * 1_024
const MAX_LIST_ITEMS = 256
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/
const SHA256 = /^sha256:[a-f0-9]{64}$/

export type SessionLifecycleStateV3 = 'open' | 'closed' | 'deleted'
export type SessionPlannerModeV3 = 'auto' | 'solo' | 'workflow' | 'direct' | 'supervisor'
export type SessionPlanStateV3 = PlanStateV1
export type SessionStepStateV3 = PlanStepStateV1
export type SessionAttemptStateV3 = PlanAttemptStateV1
export type SessionRetrySafetyV3 = 'read_only_idempotent' | 'non_idempotent' | 'unknown'

export type SessionCompactionReasonV3 = 'manual' | 'threshold' | 'overflow'

export type SessionCompactionSummaryV3 = Readonly<{
  schemaVersion: 1
  trust: 'low'
  objective?: string
  /** Durable task/evidence references retained across checkpoint replacement. */
  relevantRefs?: readonly string[]
  decisions: readonly string[]
  constraints: readonly string[]
  readFiles: readonly string[]
  modifiedFiles: readonly string[]
  unresolved: readonly string[]
  activePlan: readonly string[]
}>

export type SessionCompactionProvenanceV3 = Readonly<{
  schemaVersion: 1
  generator: CompactionGeneratorIdentity
  fallbackFrom?: CompactionGeneratorIdentity
}>

export type SessionEntryCorrelationV3 = Readonly<{
  traceId?: string
  parentRunId?: string
  childRunId?: string
  planId?: string
  stepId?: string
  attemptId?: string
  toolCallId?: string
  commandId?: string
}>

type SessionEntryEnvelopeV3<TType extends string, TData> = Readonly<{
  schemaVersion: 3
  entryId: string
  sessionId: string
  sequence: number
  revision: number
  timestamp: string
  type: TType
  runId?: string
  correlation?: SessionEntryCorrelationV3
  data: Readonly<TData>
}>

export type SessionCreatedEntryV3 = SessionEntryEnvelopeV3<
  'session.created',
  {
    cwd: string
    provider: string
    model: string
    name: string
    labels: readonly string[]
    plannerMode?: SessionPlannerModeV3
    contextLimitTokens?: number
    fork?: Readonly<{ parentSessionId: string; sourceEntryId: string }>
  }
>
export type SessionMetadataUpdatedEntryV3 = SessionEntryEnvelopeV3<
  'session.metadata_updated',
  {
    name?: string
    labels?: readonly string[]
    provider?: string
    model?: string
    activeLeafId?: string
    plannerMode?: SessionPlannerModeV3
    contextLimitTokens?: number
  }
>
export type SessionPlanUpdatedEntryV3 = SessionEntryEnvelopeV3<
  'session.plan_updated',
  { plan: CompactPlan | null }
>
export type SessionClosedEntryV3 = SessionEntryEnvelopeV3<'session.closed', { reason?: string }>
export type SessionReopenedEntryV3 = SessionEntryEnvelopeV3<'session.reopened', { reason?: string }>
export type SessionForkedEntryV3 = SessionEntryEnvelopeV3<
  'session.forked',
  { childSessionId: string; sourceEntryId: string }
>
export type SessionDeletedEntryV3 = SessionEntryEnvelopeV3<
  'session.deleted',
  | { mode: 'tombstone'; reason?: string }
  | {
      mode: 'purge_receipt'
      receiptRef: string
      receiptDigest: `sha256:${string}`
    }
>
export type MessageCommittedEntryV3 = SessionEntryEnvelopeV3<
  'message.committed',
  { messageId: string; message: ProviderMessage }
>
export type RunStartedEntryV3 = SessionEntryEnvelopeV3<'run.started', { clientRequestId: string }>
export type RunTerminalEntryV3 = SessionEntryEnvelopeV3<
  'run.terminal',
  {
    status: 'completed' | 'failed' | 'aborted' | 'interrupted'
    usage: Readonly<ProviderUsage>
    errorCode?: string
  }
>
export type CommandInvokedEntryV3 = SessionEntryEnvelopeV3<
  'command.invoked',
  {
    commandId: string
    descriptorId: string
    descriptorDigest: `sha256:${string}`
    persistence: 'plaintext' | 'redacted' | 'digest' | 'none'
    argumentDigest?: `sha256:${string}`
    resultRef?: string
  }
>
export type SkillInvokedEntryV3 = SessionEntryEnvelopeV3<
  'skill.invoked',
  { invocationId: string; invocation: SkillInvocationEntry }
>
export type PermissionDecidedEntryV3 = SessionEntryEnvelopeV3<
  'permission.decided',
  {
    requestId: string
    toolCallId: string
    tool: string
    decision: 'allow_once' | 'allow_always' | 'deny'
    ruleDigest: `sha256:${string}`
  }
>
export type UsageRecordedEntryV3 = SessionEntryEnvelopeV3<
  'usage.recorded',
  { source: 'provider' | 'tool' | 'subagent'; usage: Readonly<BudgetUsage> }
>
export type PlannerGenerationRecordedEntryV3 = SessionEntryEnvelopeV3<
  'planner.generation_recorded',
  {
    phase: 'initial' | 'replan'
    generatorId: string
    source: 'model' | 'fallback'
    status: 'succeeded' | 'failed'
    fallbackUsed: boolean
    route?: 'parent_only' | 'dag'
    failureCode?: string
    fallbackFromCode?: string
  }
>
export type CompactionCreatedEntryV3 = SessionEntryEnvelopeV3<
  'compaction.created',
  {
    checkpointId: string
    coveredStartSequence: number
    coveredEndSequence: number
    previousCheckpointId?: string
    retainedStartSequence: number
    summary: SessionCompactionSummaryV3
    provenance: SessionCompactionProvenanceV3
    summaryDigest: `sha256:${string}`
    summaryTokens: number
    reason: SessionCompactionReasonV3
    /** Product checkpoint fields required to restore the exact prompt projection. */
    checkpoint?: Readonly<{
      messageStart: number
      messageEnd: number
      content: string
      digest: `sha256:${string}`
      estimatedGainTokens?: number
      scope?: Readonly<{ kind: 'parent' | 'child'; sessionId: string }>
      skillInvocations?: readonly SkillInvocationEntry[]
      nativeContext?: ProviderNativeContext
    }>
  }
>
export type PlanCreatedEntryV3 = SessionEntryEnvelopeV3<
  'plan.created',
  {
    planId: string
    planRevision: number
    objective: string
    state: SessionPlanStateV3
  }
>
export type PlanStateChangedEntryV3 = SessionEntryEnvelopeV3<
  'plan.state_changed',
  { planId: string; planRevision: number; state: SessionPlanStateV3 }
>
export type PlannerDecisionActionV3 = 'retry' | 'continue' | 'fresh_worker' | 'replan' | 'ask_user'
export type PlannerDecisionRecordedEntryV3 = SessionEntryEnvelopeV3<
  'plan.decision_recorded',
  {
    planId: string
    planRevision: number
    action: PlannerDecisionActionV3
    outcome: 'selected' | 'applied' | 'no_progress'
    reasonCode: string
    stepId?: string
    attemptId?: string
  }
>
export type PlanRevisedEntryV3 = SessionEntryEnvelopeV3<
  'plan.revised',
  {
    planId: string
    fromRevision: number
    toRevision: number
    objective: string
    state: 'running'
    reuseProofs: readonly Readonly<{
      stepId: string
      previousInputDigest: `sha256:${string}`
      nextInputDigest: `sha256:${string}`
    }>[]
  }
>
export type StepCreatedEntryV3 = SessionEntryEnvelopeV3<
  'step.created',
  {
    planId: string
    planRevision: number
    stepId: string
    title: string
    order: number
    state: SessionStepStateV3
    dependencies: readonly string[]
    access: PlanStepAccessV1
    capabilities: readonly string[]
    conflictKeys: readonly string[]
    criteria: readonly PlanSuccessCriterionV1[]
    budget: Readonly<ExecutionBudget>
    maxAttempts: number
  }
>
export type StepStateChangedEntryV3 = SessionEntryEnvelopeV3<
  'step.state_changed',
  {
    planId: string
    planRevision: number
    stepId: string
    state: SessionStepStateV3
    reason?: 'retry_approved' | 'recovery_retry_approved' | 'external_condition_changed'
    newAttemptId?: string
    errorCode?: string
  }
>
export type AttemptCreatedEntryV3 = SessionEntryEnvelopeV3<
  'attempt.created',
  {
    planId: string
    planRevision: number
    stepId: string
    attemptId: string
    ordinal: number
    state: SessionAttemptStateV3
    childRunId?: string
  }
>
export type AttemptStateChangedEntryV3 = SessionEntryEnvelopeV3<
  'attempt.state_changed',
  {
    planId: string
    planRevision: number
    stepId: string
    attemptId: string
    state: SessionAttemptStateV3
    errorCode?: string
  }
>
export type AttemptExecutionCompletedEntryV3 = SessionEntryEnvelopeV3<
  'attempt.execution_completed',
  {
    planId: string
    planRevision: number
    stepId: string
    attemptId: string
    status: 'succeeded' | 'failed' | 'cancelled'
  }
>
export type SubagentExecutionBoundEntryV3 = SessionEntryEnvelopeV3<
  'subagent.execution_bound',
  {
    planId: string
    planRevision: number
    stepId: string
    attemptId: string
    childRunId: string
    request: SubagentExecutionRequestV1
    retrySafety: SessionRetrySafetyV3
  }
>
export type SubagentResultRecordedEntryV3 = SessionEntryEnvelopeV3<
  'subagent.result_recorded',
  {
    planId: string
    planRevision: number
    stepId: string
    attemptId: string
    childRunId: string
    resultRef: string
    resultDigest: `sha256:${string}`
    status: 'succeeded' | 'failed' | 'cancelled'
  }
>
export type VerificationRecordedEntryV3 = SessionEntryEnvelopeV3<
  'verification.recorded',
  {
    planId: string
    planRevision: number
    stepId: string
    attemptId: string
    verificationId: string
    verifier: 'mechanical' | 'rule' | 'model'
    status: 'passed' | 'failed' | 'blocked'
    evidenceRefs: readonly string[]
    code?: string
    retryable?: boolean
  }
>
export type ArtifactReferencedEntryV3 = SessionEntryEnvelopeV3<
  'artifact.referenced',
  {
    owner: 'message' | 'run' | 'command' | 'compaction' | 'subagent' | 'verification'
    artifact: ArtifactReference
  }
>

export type SessionEntryV3 =
  | SessionCreatedEntryV3
  | SessionMetadataUpdatedEntryV3
  | SessionPlanUpdatedEntryV3
  | SessionClosedEntryV3
  | SessionReopenedEntryV3
  | SessionForkedEntryV3
  | SessionDeletedEntryV3
  | MessageCommittedEntryV3
  | RunStartedEntryV3
  | RunTerminalEntryV3
  | CommandInvokedEntryV3
  | SkillInvokedEntryV3
  | PermissionDecidedEntryV3
  | UsageRecordedEntryV3
  | PlannerGenerationRecordedEntryV3
  | CompactionCreatedEntryV3
  | PlanCreatedEntryV3
  | PlanStateChangedEntryV3
  | PlannerDecisionRecordedEntryV3
  | PlanRevisedEntryV3
  | StepCreatedEntryV3
  | StepStateChangedEntryV3
  | AttemptCreatedEntryV3
  | AttemptStateChangedEntryV3
  | AttemptExecutionCompletedEntryV3
  | SubagentExecutionBoundEntryV3
  | SubagentResultRecordedEntryV3
  | VerificationRecordedEntryV3
  | ArtifactReferencedEntryV3

export type SessionRunProjectionV3 = Readonly<{
  runId: string
  clientRequestId: string
  state: 'running' | 'completed' | 'failed' | 'aborted' | 'interrupted'
  usage: Readonly<Partial<BudgetUsage>>
  errorCode?: string
}>

export type SessionAttemptProjectionV3 = Readonly<{
  attemptId: string
  ordinal: number
  state: SessionAttemptStateV3
  childRunId?: string
  resultRef?: string
  resultDigest?: `sha256:${string}`
  verificationRef?: string
  errorCode?: string
  execution?: Readonly<{
    request: SubagentExecutionRequestV1
    retrySafety: SessionRetrySafetyV3
  }>
  verifications: readonly SessionVerificationProjectionV3[]
}>

export type SessionVerificationProjectionV3 = Readonly<{
  verificationId: string
  verifier: 'mechanical' | 'rule' | 'model'
  status: 'passed' | 'failed' | 'blocked'
  evidenceRefs: readonly string[]
  code?: string
  retryable?: boolean
}>

export type SessionStepProjectionV3 = Readonly<{
  stepId: string
  title: string
  order: number
  state: SessionStepStateV3
  errorCode?: string
  dependencies: readonly string[]
  access: PlanStepAccessV1
  capabilities: readonly string[]
  conflictKeys: readonly string[]
  criteria: readonly PlanSuccessCriterionV1[]
  budget: Readonly<ExecutionBudget>
  maxAttempts: number
  attemptIds: readonly string[]
  attempts: readonly SessionAttemptProjectionV3[]
}>

export type SessionPlanGraphProjectionV3 = Readonly<{
  schemaVersion: 1
  planId: string
  revision: number
  objective: string
  state: SessionPlanStateV3
  readyStepIds: readonly string[]
  steps: readonly SessionStepProjectionV3[]
}>

export type SessionPlannerGenerationProjectionV3 = Readonly<{
  phase: 'initial' | 'replan'
  generatorId: string
  source: 'model' | 'fallback'
  status: 'succeeded' | 'failed'
  fallbackUsed: boolean
  route?: 'parent_only' | 'dag'
  failureCode?: string
  fallbackFromCode?: string
  runId: string
  recordedAt: string
}>

export type SessionSnapshotV3 = Readonly<{
  schemaVersion: 3
  sessionId: string
  sequence: number
  revision: number
  lifecycle: SessionLifecycleStateV3
  plannerMode?: SessionPlannerModeV3
  createdAt?: string
  updatedAt?: string
  contextLimitTokens?: number
  cwd: string
  provider: string
  model: string
  name: string
  labels: readonly string[]
  activeLeafId: string
  parentSessionId?: string
  sourceEntryId?: string
  messages: readonly Readonly<{
    messageId: string
    message: ProviderMessage
  }>[]
  runs: readonly SessionRunProjectionV3[]
  commandIds: readonly string[]
  skillInvocationIds: readonly string[]
  permissionRequestIds: readonly string[]
  usage: Readonly<BudgetUsage>
  checkpointId?: string
  artifactIds: readonly string[]
}>

export type SessionCatalogProjectionV3 = Readonly<{
  sessionId: string
  name: string
  workspace: string
  provider: string
  model: string
  lifecycle: SessionLifecycleStateV3
  activeLeafId: string
  parentSessionId?: string
  messageCount: number
  updatedAt: string
  revision: number
}>

export type SessionContextViewProjectionV3 = Readonly<{
  sessionId: string
  revision: number
  checkpointId?: string
  recentEntryRange: Readonly<{ startSequence: number; endSequence: number }>
  resultRefs: readonly string[]
  artifactIds: readonly string[]
  omittedEntries: number
}>

export type SessionCompactionCheckpointProjectionV3 = Readonly<{
  checkpointId: string
  entryId: string
  createdAt: string
  coveredRange: Readonly<{ startSequence: number; endSequence: number }>
  previousCheckpointId?: string
  retainedStartSequence: number
  summary: SessionCompactionSummaryV3
  provenance: SessionCompactionProvenanceV3
  summaryDigest: `sha256:${string}`
  summaryTokens: number
  reason: SessionCompactionReasonV3
  checkpoint?: Readonly<{
    messageStart: number
    messageEnd: number
    content: string
    digest: `sha256:${string}`
    estimatedGainTokens?: number
    scope?: Readonly<{ kind: 'parent' | 'child'; sessionId: string }>
    skillInvocations?: readonly SkillInvocationEntry[]
    nativeContext?: ProviderNativeContext
  }>
}>

export type SessionProjectionV3 = Readonly<{
  snapshot: SessionSnapshotV3
  catalog: SessionCatalogProjectionV3
  contextView: SessionContextViewProjectionV3
  checkpoint?: SessionCompactionCheckpointProjectionV3
  planGraph?: SessionPlanGraphProjectionV3
  plannerGeneration?: SessionPlannerGenerationProjectionV3
  compactPlan?: CompactPlan
}>

type MutableAttempt = {
  attemptId: string
  ordinal: number
  state: SessionAttemptStateV3
  childRunId?: string
  resultRef?: string
  resultDigest?: `sha256:${string}`
  resultStatus?: 'succeeded' | 'failed' | 'cancelled'
  verificationRef?: string
  errorCode?: string
  execution?: Readonly<{
    request: SubagentExecutionRequestV1
    retrySafety: SessionRetrySafetyV3
  }>
  verifications: SessionVerificationProjectionV3[]
}
type MutableStep = {
  stepId: string
  title: string
  order: number
  state: SessionStepStateV3
  errorCode?: string
  dependencies: readonly string[]
  access: PlanStepAccessV1
  capabilities: readonly string[]
  conflictKeys: readonly string[]
  criteria: readonly PlanSuccessCriterionV1[]
  budget: Readonly<ExecutionBudget>
  maxAttempts: number
  attempts: Map<string, MutableAttempt>
}
type MutablePlan = {
  planId: string
  revision: number
  objective: string
  state: SessionPlanStateV3
  steps: Map<string, MutableStep>
}

export function validateSessionEntryV3(input: unknown): SessionEntryV3 {
  if (!isRecord(input)) throw entryFailure('SESSION_ENTRY_INVALID')
  if (input.schemaVersion !== 3) throw entryFailure('SESSION_ENTRY_VERSION_UNSUPPORTED')
  validateJsonValue(input)
  if (
    !onlyKeys(input, [
      'schemaVersion',
      'entryId',
      'sessionId',
      'sequence',
      'revision',
      'timestamp',
      'type',
      'runId',
      'correlation',
      'data',
    ]) ||
    !safeId(input.entryId) ||
    !safeId(input.sessionId) ||
    !positiveInteger(input.sequence) ||
    !positiveInteger(input.revision) ||
    !instant(input.timestamp) ||
    typeof input.type !== 'string' ||
    (input.runId !== undefined && !safeId(input.runId)) ||
    (input.correlation !== undefined && !validCorrelation(input.correlation)) ||
    !isRecord(input.data)
  ) {
    throw entryFailure('SESSION_ENTRY_INVALID')
  }
  validatePayload(input.type, input.data, input.runId)
  return deepFreeze(structuredClone(input)) as SessionEntryV3
}

/** Rebuilds every public Session projection from the same ordered entry stream. */
export function reduceSessionEntriesV3(input: readonly unknown[]): SessionProjectionV3 {
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_ENTRIES) {
    throw reducerFailure('SESSION_REDUCER_FIRST_ENTRY_INVALID')
  }
  const entries = input.map(validateSessionEntryV3)
  const first = entries[0]!
  if (first.type !== 'session.created' || first.sequence !== 1 || first.revision !== 1) {
    throw reducerFailure('SESSION_REDUCER_FIRST_ENTRY_INVALID')
  }

  const entryIds = new Set<string>()
  const stableIds = new Set<string>()
  const forkedSessionIds = new Set<string>()
  const messages: Array<{ messageId: string; message: ProviderMessage }> = []
  const runs = new Map<string, SessionRunProjectionV3>()
  const commandIds: string[] = []
  const skillInvocationIds: string[] = []
  const permissionRequestIds: string[] = []
  const artifacts = new Map<string, ArtifactReference>()
  const resultRefs: string[] = []
  let activeRunId: string | undefined
  let lifecycle: SessionLifecycleStateV3 = 'open'
  const cwd = first.data.cwd
  let provider = first.data.provider
  let model = first.data.model
  let plannerMode: SessionPlannerModeV3 = first.data.plannerMode ?? 'auto'
  let contextLimitTokens = first.data.contextLimitTokens
  let name = first.data.name
  let labels = [...first.data.labels]
  let activeLeafId = first.sessionId
  let checkpoint: SessionCompactionCheckpointProjectionV3 | undefined
  let usage: BudgetUsage = { turns: 0, toolCalls: 0, subagents: 0 }
  let plan: MutablePlan | undefined
  let plannerGeneration: SessionPlannerGenerationProjectionV3 | undefined
  let previous: SessionEntryV3 = first

  for (const entry of entries) {
    if (entry.sessionId !== first.sessionId) {
      throw reducerFailure('SESSION_REDUCER_SESSION_MISMATCH')
    }
    if (entry !== first) {
      if (entry.sequence !== previous.sequence + 1) {
        throw reducerFailure('SESSION_REDUCER_SEQUENCE_INVALID')
      }
      if (entry.revision < previous.revision || entry.revision > previous.revision + 1) {
        throw reducerFailure('SESSION_REDUCER_REVISION_INVALID')
      }
      if (entry.timestamp < previous.timestamp) {
        throw reducerFailure('SESSION_REDUCER_TIMESTAMP_INVALID')
      }
      if (lifecycle === 'deleted') throw reducerFailure('SESSION_REDUCER_TRANSITION_INVALID')
      if (
        lifecycle === 'closed' &&
        ![
          'session.metadata_updated',
          'session.reopened',
          'session.forked',
          'session.deleted',
        ].includes(entry.type)
      ) {
        transitionInvalid()
      }
    }
    useId(entryIds, entry.entryId)

    switch (entry.type) {
      case 'session.created':
        if (entry !== first) throw reducerFailure('SESSION_REDUCER_ID_REUSED')
        break
      case 'session.metadata_updated':
        if (entry.data.name !== undefined) name = entry.data.name
        if (entry.data.labels !== undefined) labels = [...entry.data.labels]
        if (entry.data.provider !== undefined) provider = entry.data.provider
        if (entry.data.model !== undefined) model = entry.data.model
        if (entry.data.activeLeafId !== undefined) activeLeafId = entry.data.activeLeafId
        if (entry.data.plannerMode !== undefined) plannerMode = entry.data.plannerMode
        if (entry.data.contextLimitTokens !== undefined) {
          contextLimitTokens = entry.data.contextLimitTokens
        }
        break
      case 'session.plan_updated':
        break
      case 'session.closed':
        if (lifecycle !== 'open' || activeRunId !== undefined) transitionInvalid()
        lifecycle = 'closed'
        break
      case 'session.reopened':
        if (lifecycle !== 'closed') transitionInvalid()
        lifecycle = 'open'
        break
      case 'session.forked':
        if (
          entry.data.childSessionId === first.sessionId ||
          entry.data.sourceEntryId === entry.entryId ||
          !entryIds.has(entry.data.sourceEntryId)
        ) {
          transitionInvalid()
        }
        useId(forkedSessionIds, entry.data.childSessionId)
        activeLeafId = entry.data.childSessionId
        break
      case 'session.deleted':
        if (activeRunId !== undefined) transitionInvalid()
        lifecycle = 'deleted'
        break
      case 'message.committed':
        useStableId(stableIds, 'message', entry.data.messageId)
        messages.push({
          messageId: entry.data.messageId,
          message: structuredClone(entry.data.message),
        })
        break
      case 'run.started':
        if (lifecycle !== 'open' || activeRunId !== undefined || entry.runId === undefined) {
          transitionInvalid()
        }
        useStableId(stableIds, 'run', entry.runId)
        useStableId(stableIds, 'client-request', entry.data.clientRequestId)
        activeRunId = entry.runId
        runs.set(entry.runId, {
          runId: entry.runId,
          clientRequestId: entry.data.clientRequestId,
          state: 'running',
          usage: {},
        })
        break
      case 'run.terminal': {
        if (entry.runId === undefined || activeRunId !== entry.runId) transitionInvalid()
        const run = runs.get(entry.runId)
        if (run === undefined || run.state !== 'running') transitionInvalid()
        runs.set(entry.runId, {
          ...run,
          state: entry.data.status,
          usage: {
            ...entry.data.usage,
            ...(run.usage.turns === undefined ? {} : { turns: run.usage.turns }),
            ...(run.usage.toolCalls === undefined ? {} : { toolCalls: run.usage.toolCalls }),
            ...(run.usage.subagents === undefined ? {} : { subagents: run.usage.subagents }),
          },
          ...(entry.data.errorCode === undefined ? {} : { errorCode: entry.data.errorCode }),
        })
        activeRunId = undefined
        break
      }
      case 'command.invoked':
        useStableId(stableIds, 'command', entry.data.commandId)
        commandIds.push(entry.data.commandId)
        if (entry.data.resultRef !== undefined) resultRefs.push(entry.data.resultRef)
        break
      case 'skill.invoked':
        useStableId(stableIds, 'skill-invocation', entry.data.invocationId)
        skillInvocationIds.push(entry.data.invocationId)
        break
      case 'permission.decided':
        useStableId(stableIds, 'permission-request', entry.data.requestId)
        permissionRequestIds.push(entry.data.requestId)
        break
      case 'usage.recorded':
        usage = mergeUsage(usage, entry.data.usage)
        if (entry.runId !== undefined) {
          if (activeRunId !== entry.runId) transitionInvalid()
          const run = runs.get(entry.runId)
          if (run === undefined || run.state !== 'running') transitionInvalid()
          runs.set(entry.runId, {
            ...run,
            usage: mergeUsage(normalizeBudgetUsage(run.usage), entry.data.usage),
          })
        }
        break
      case 'planner.generation_recorded':
        if (entry.runId === undefined || activeRunId !== entry.runId) transitionInvalid()
        plannerGeneration = {
          ...structuredClone(entry.data),
          runId: entry.runId,
          recordedAt: entry.timestamp,
        }
        break
      case 'compaction.created':
        if (entry.data.coveredEndSequence >= entry.sequence) transitionInvalid()
        if (
          entry.data.retainedStartSequence !== entry.data.coveredEndSequence + 1 ||
          entry.data.summaryDigest !== sessionCompactionSummaryDigestV3(entry.data.summary) ||
          (checkpoint === undefined
            ? entry.data.previousCheckpointId !== undefined || entry.data.coveredStartSequence !== 1
            : entry.data.previousCheckpointId !== checkpoint.checkpointId ||
              entry.data.coveredStartSequence !== checkpoint.coveredRange.startSequence ||
              entry.data.coveredEndSequence <= checkpoint.coveredRange.endSequence)
        ) {
          transitionInvalid()
        }
        useStableId(stableIds, 'checkpoint', entry.data.checkpointId)
        checkpoint = {
          checkpointId: entry.data.checkpointId,
          entryId: entry.entryId,
          createdAt: entry.timestamp,
          coveredRange: {
            startSequence: entry.data.coveredStartSequence,
            endSequence: entry.data.coveredEndSequence,
          },
          ...(entry.data.previousCheckpointId === undefined
            ? {}
            : { previousCheckpointId: entry.data.previousCheckpointId }),
          retainedStartSequence: entry.data.retainedStartSequence,
          summary: structuredClone(entry.data.summary),
          provenance: structuredClone(entry.data.provenance),
          summaryDigest: entry.data.summaryDigest,
          summaryTokens: entry.data.summaryTokens,
          reason: entry.data.reason,
          ...(entry.data.checkpoint === undefined
            ? {}
            : { checkpoint: structuredClone(entry.data.checkpoint) }),
        }
        break
      case 'plan.created':
        if (
          plan !== undefined &&
          !['succeeded', 'failed', 'cancelled', 'interrupted'].includes(plan.state)
        ) {
          transitionInvalid()
        }
        useStableId(stableIds, 'plan', entry.data.planId)
        plan = {
          planId: entry.data.planId,
          revision: entry.data.planRevision,
          objective: entry.data.objective,
          state: entry.data.state,
          steps: new Map(),
        }
        break
      case 'plan.state_changed': {
        const current = requirePlanRevision(plan, entry.data.planId, entry.data.planRevision)
        assertReducerTransition(() => assertPlanStateTransitionV1(current.state, entry.data.state))
        if (
          entry.data.state === 'succeeded' &&
          [...current.steps.values()].some((step) => step.state !== 'succeeded')
        ) {
          transitionInvalid()
        }
        current.state = entry.data.state
        break
      }
      case 'plan.decision_recorded': {
        const current = requirePlanRevision(plan, entry.data.planId, entry.data.planRevision)
        if (entry.data.stepId !== undefined) {
          const step = current.steps.get(entry.data.stepId)
          if (step === undefined) transitionInvalid()
          if (entry.data.attemptId !== undefined && !step.attempts.has(entry.data.attemptId)) {
            transitionInvalid()
          }
        }
        break
      }
      case 'plan.revised': {
        const current = requirePlanRevision(plan, entry.data.planId, entry.data.fromRevision)
        if (
          // Ordinary failed plans remain terminal. The revision event is the
          // sole recovery path because it atomically replaces unfinished work.
          !['running', 'blocked', 'failed'].includes(current.state) ||
          entry.data.toRevision !== current.revision + 1 ||
          entry.data.state !== 'running' ||
          [...current.steps.values()].some(
            (step) =>
              ['running', 'verifying'].includes(step.state) ||
              [...step.attempts.values()].some((attempt) =>
                ['reserved', 'running', 'execution_succeeded', 'verifying'].includes(attempt.state),
              ),
          )
        ) {
          transitionInvalid()
        }
        const reused = new Map<string, MutableStep>()
        for (const proof of entry.data.reuseProofs) {
          const step = current.steps.get(proof.stepId)
          const attempt = step === undefined ? undefined : latestStepAttempt(step)
          if (
            step?.state !== 'succeeded' ||
            attempt?.state !== 'verified' ||
            attempt.execution?.request.packetRef.digest !== proof.previousInputDigest ||
            proof.previousInputDigest !== proof.nextInputDigest ||
            step.dependencies.some(
              (dependency) =>
                !entry.data.reuseProofs.some((candidate) => candidate.stepId === dependency),
            )
          ) {
            transitionInvalid()
          }
          reused.set(step.stepId, step)
        }
        current.revision = entry.data.toRevision
        current.objective = entry.data.objective
        current.state = entry.data.state
        current.steps = reused
        break
      }
      case 'step.created': {
        const current = requirePlanRevision(plan, entry.data.planId, entry.data.planRevision)
        useStableId(stableIds, 'step', entry.data.stepId)
        if (current.steps.has(entry.data.stepId)) transitionInvalid()
        current.steps.set(entry.data.stepId, {
          stepId: entry.data.stepId,
          title: entry.data.title,
          order: entry.data.order,
          state: entry.data.state,
          dependencies: [...entry.data.dependencies],
          access: structuredClone(entry.data.access),
          capabilities: [...entry.data.capabilities],
          conflictKeys: [...entry.data.conflictKeys],
          criteria: structuredClone(entry.data.criteria),
          budget: structuredClone(entry.data.budget),
          maxAttempts: entry.data.maxAttempts,
          attempts: new Map(),
        })
        break
      }
      case 'step.state_changed': {
        const step = requireStepRevision(
          plan,
          entry.data.planId,
          entry.data.planRevision,
          entry.data.stepId,
        )
        const newAttempt =
          entry.data.newAttemptId === undefined
            ? undefined
            : step.attempts.get(entry.data.newAttemptId)
        assertReducerTransition(() =>
          assertPlanStepTransitionV1(step.state, entry.data.state, {
            retryApproved: entry.data.reason === 'retry_approved',
            recoveryRetryApproved: entry.data.reason === 'recovery_retry_approved',
            externalConditionChanged: entry.data.reason === 'external_condition_changed',
            createsNewAttempt:
              newAttempt !== undefined &&
              newAttempt.ordinal === step.attempts.size &&
              newAttempt.state === 'reserved',
          }),
        )
        const latestAttempt = latestStepAttempt(step)
        if (
          (entry.data.state === 'running' && latestAttempt?.state !== 'reserved') ||
          (entry.data.state === 'verifying' && latestAttempt?.state !== 'verifying') ||
          (entry.data.state === 'succeeded' && latestAttempt?.state !== 'verified')
        ) {
          transitionInvalid()
        }
        step.state = entry.data.state
        if (entry.data.errorCode === undefined) delete step.errorCode
        else step.errorCode = entry.data.errorCode
        break
      }
      case 'attempt.created': {
        const step = requireStepRevision(
          plan,
          entry.data.planId,
          entry.data.planRevision,
          entry.data.stepId,
        )
        if ([...step.attempts.values()].some((attempt) => attempt.ordinal === entry.data.ordinal)) {
          transitionInvalid()
        }
        if (
          entry.data.ordinal !== step.attempts.size + 1 ||
          entry.data.ordinal > step.maxAttempts
        ) {
          transitionInvalid()
        }
        useStableId(stableIds, 'attempt', entry.data.attemptId)
        if (entry.data.childRunId !== undefined) {
          useStableId(stableIds, 'child-run', entry.data.childRunId)
        }
        step.attempts.set(entry.data.attemptId, {
          attemptId: entry.data.attemptId,
          ordinal: entry.data.ordinal,
          state: entry.data.state,
          ...(entry.data.childRunId === undefined ? {} : { childRunId: entry.data.childRunId }),
          verifications: [],
        })
        break
      }
      case 'attempt.state_changed': {
        const attempt = requireAttemptRevision(
          plan,
          entry.data.planId,
          entry.data.planRevision,
          entry.data.stepId,
          entry.data.attemptId,
        )
        assertReducerTransition(() =>
          assertPlanAttemptTransitionV1(attempt.state, entry.data.state),
        )
        if (entry.data.state === 'execution_succeeded' || entry.data.state === 'execution_failed') {
          transitionInvalid()
        }
        if (
          (entry.data.state === 'verified' &&
            (attempt.verifications.length === 0 ||
              attempt.verifications.some((verification) => verification.status !== 'passed'))) ||
          (entry.data.state === 'rejected' &&
            !attempt.verifications.some((verification) => verification.status !== 'passed'))
        ) {
          transitionInvalid()
        }
        attempt.state = entry.data.state
        if (entry.data.errorCode === undefined) delete attempt.errorCode
        else attempt.errorCode = entry.data.errorCode
        break
      }
      case 'attempt.execution_completed': {
        const attempt = requireAttemptRevision(
          plan,
          entry.data.planId,
          entry.data.planRevision,
          entry.data.stepId,
          entry.data.attemptId,
        )
        const nextState =
          entry.data.status === 'succeeded'
            ? 'execution_succeeded'
            : entry.data.status === 'failed'
              ? 'execution_failed'
              : 'cancelled'
        assertReducerTransition(() => assertPlanAttemptTransitionV1(attempt.state, nextState))
        if (attempt.resultRef === undefined || attempt.resultStatus !== entry.data.status) {
          transitionInvalid()
        }
        attempt.state = nextState
        break
      }
      case 'subagent.execution_bound': {
        const attempt = requireAttemptRevision(
          plan,
          entry.data.planId,
          entry.data.planRevision,
          entry.data.stepId,
          entry.data.attemptId,
        )
        const request = validateSubagentExecutionRequestV1(entry.data.request)
        if (
          attempt.state !== 'running' ||
          attempt.execution !== undefined ||
          attempt.childRunId !== entry.data.childRunId ||
          request.parentRunId !== entry.correlation?.parentRunId ||
          request.childRunId !== entry.data.childRunId
        ) {
          transitionInvalid()
        }
        attempt.execution = deepFreeze({
          request,
          retrySafety: entry.data.retrySafety,
        })
        break
      }
      case 'subagent.result_recorded': {
        const attempt = requireAttemptRevision(
          plan,
          entry.data.planId,
          entry.data.planRevision,
          entry.data.stepId,
          entry.data.attemptId,
        )
        if (
          attempt.state !== 'running' ||
          attempt.resultRef !== undefined ||
          (attempt.childRunId !== undefined && attempt.childRunId !== entry.data.childRunId)
        ) {
          transitionInvalid()
        }
        if (attempt.childRunId === undefined) {
          useStableId(stableIds, 'child-run', entry.data.childRunId)
          attempt.childRunId = entry.data.childRunId
        }
        attempt.resultRef = entry.data.resultRef
        attempt.resultDigest = entry.data.resultDigest
        attempt.resultStatus = entry.data.status
        resultRefs.push(entry.data.resultRef)
        break
      }
      case 'verification.recorded': {
        useStableId(stableIds, 'verification', entry.data.verificationId)
        const attempt = requireAttemptRevision(
          plan,
          entry.data.planId,
          entry.data.planRevision,
          entry.data.stepId,
          entry.data.attemptId,
        )
        const step = requireStepRevision(
          plan,
          entry.data.planId,
          entry.data.planRevision,
          entry.data.stepId,
        )
        if (attempt.state !== 'verifying' || step.state !== 'verifying') transitionInvalid()
        attempt.verificationRef = `journal://verification/${entry.data.verificationId}`
        attempt.verifications.push({
          verificationId: entry.data.verificationId,
          verifier: entry.data.verifier,
          status: entry.data.status,
          evidenceRefs: [...entry.data.evidenceRefs],
          ...(entry.data.code === undefined ? {} : { code: entry.data.code }),
          ...(entry.data.retryable === undefined ? {} : { retryable: entry.data.retryable }),
        })
        resultRefs.push(...entry.data.evidenceRefs)
        break
      }
      case 'artifact.referenced':
        useStableId(stableIds, 'artifact', entry.data.artifact.artifactId)
        artifacts.set(entry.data.artifact.artifactId, structuredClone(entry.data.artifact))
        break
    }
    previous = entry
  }

  const planGraph = projectPlan(plan)
  const snapshot: SessionSnapshotV3 = deepFreeze({
    schemaVersion: 3 as const,
    sessionId: first.sessionId,
    sequence: previous.sequence,
    revision: previous.revision,
    lifecycle,
    plannerMode,
    createdAt: first.timestamp,
    updatedAt: previous.timestamp,
    ...(contextLimitTokens === undefined ? {} : { contextLimitTokens }),
    cwd,
    provider,
    model,
    name,
    labels,
    activeLeafId,
    ...(first.data.fork === undefined
      ? {}
      : {
          parentSessionId: first.data.fork.parentSessionId,
          sourceEntryId: first.data.fork.sourceEntryId,
        }),
    messages,
    runs: [...runs.values()],
    commandIds,
    skillInvocationIds,
    permissionRequestIds,
    usage,
    ...(checkpoint === undefined ? {} : { checkpointId: checkpoint.checkpointId }),
    artifactIds: [...artifacts.keys()],
  })
  return deepFreeze({
    snapshot,
    catalog: {
      sessionId: snapshot.sessionId,
      name: snapshot.name,
      workspace: snapshot.cwd,
      provider: snapshot.provider,
      model: snapshot.model,
      lifecycle: snapshot.lifecycle,
      activeLeafId: snapshot.activeLeafId,
      ...(snapshot.parentSessionId === undefined
        ? {}
        : { parentSessionId: snapshot.parentSessionId }),
      messageCount: snapshot.messages.length,
      updatedAt: previous.timestamp,
      revision: snapshot.revision,
    },
    contextView: {
      sessionId: snapshot.sessionId,
      revision: snapshot.revision,
      ...(checkpoint === undefined ? {} : { checkpointId: checkpoint.checkpointId }),
      recentEntryRange: {
        startSequence: checkpoint?.retainedStartSequence ?? 1,
        endSequence: snapshot.sequence,
      },
      resultRefs: unique(resultRefs),
      artifactIds: snapshot.artifactIds,
      omittedEntries: checkpoint?.coveredRange.endSequence ?? 0,
    },
    ...(checkpoint === undefined ? {} : { checkpoint }),
    ...(planGraph === undefined ? {} : { planGraph }),
    ...(plannerGeneration === undefined ? {} : { plannerGeneration }),
  })
}

function validatePayload(type: string, data: Record<string, unknown>, runId: unknown): void {
  switch (type) {
    case 'session.created':
      exactData(
        data,
        ['cwd', 'provider', 'model', 'name', 'labels'],
        ['fork', 'plannerMode', 'contextLimitTokens'],
      )
      boundedText(data.cwd)
      safe(data.provider)
      safe(data.model)
      boundedText(data.name)
      stringList(data.labels)
      if (data.plannerMode !== undefined)
        enumValue(data.plannerMode, ['auto', 'solo', 'workflow', 'direct', 'supervisor'])
      if (data.contextLimitTokens !== undefined) positive(data.contextLimitTokens)
      if (data.fork !== undefined) {
        exactRecord(data.fork, ['parentSessionId', 'sourceEntryId'])
        safe(data.fork.parentSessionId)
        safe(data.fork.sourceEntryId)
      }
      break
    case 'session.metadata_updated':
      exactData(
        data,
        [],
        [
          'name',
          'labels',
          'provider',
          'model',
          'activeLeafId',
          'plannerMode',
          'contextLimitTokens',
        ],
      )
      if (Object.keys(data).length === 0) invalid()
      optionalBounded(data.name)
      if (data.labels !== undefined) stringList(data.labels)
      optionalSafe(data.provider)
      optionalSafe(data.model)
      optionalSafe(data.activeLeafId)
      if (data.plannerMode !== undefined)
        enumValue(data.plannerMode, ['auto', 'solo', 'workflow', 'direct', 'supervisor'])
      if (data.contextLimitTokens !== undefined) positive(data.contextLimitTokens)
      break
    case 'session.plan_updated':
      exactData(data, ['plan'])
      if (data.plan !== null) compactPlanValue(data.plan)
      break
    case 'session.closed':
    case 'session.reopened':
      exactData(data, [], ['reason'])
      optionalBounded(data.reason)
      break
    case 'session.forked':
      exactData(data, ['childSessionId', 'sourceEntryId'])
      safe(data.childSessionId)
      safe(data.sourceEntryId)
      break
    case 'session.deleted':
      if (data.mode === 'tombstone') {
        exactData(data, ['mode'], ['reason'])
        optionalBounded(data.reason)
      } else if (data.mode === 'purge_receipt') {
        exactData(data, ['mode', 'receiptRef', 'receiptDigest'])
        boundedText(data.receiptRef)
        digest(data.receiptDigest)
      } else invalid()
      break
    case 'message.committed':
      exactData(data, ['messageId', 'message'])
      safe(data.messageId)
      providerMessage(data.message)
      break
    case 'run.started':
      requireRunId(runId)
      exactData(data, ['clientRequestId'])
      safe(data.clientRequestId)
      break
    case 'run.terminal':
      requireRunId(runId)
      exactData(data, ['status', 'usage'], ['errorCode'])
      enumValue(data.status, ['completed', 'failed', 'aborted', 'interrupted'])
      providerUsageValue(data.usage)
      optionalSafe(data.errorCode)
      break
    case 'command.invoked':
      exactData(
        data,
        ['commandId', 'descriptorId', 'descriptorDigest', 'persistence'],
        ['argumentDigest', 'resultRef'],
      )
      safe(data.commandId)
      safe(data.descriptorId)
      digest(data.descriptorDigest)
      enumValue(data.persistence, ['plaintext', 'redacted', 'digest', 'none'])
      if (data.argumentDigest !== undefined) digest(data.argumentDigest)
      optionalBounded(data.resultRef)
      break
    case 'skill.invoked':
      exactData(data, ['invocationId', 'invocation'])
      safe(data.invocationId)
      skillInvocation(data.invocation)
      break
    case 'permission.decided':
      exactData(data, ['requestId', 'toolCallId', 'tool', 'decision', 'ruleDigest'])
      safe(data.requestId)
      safe(data.toolCallId)
      safe(data.tool)
      enumValue(data.decision, ['allow_once', 'allow_always', 'deny'])
      digest(data.ruleDigest)
      break
    case 'usage.recorded':
      exactData(data, ['source', 'usage'])
      enumValue(data.source, ['provider', 'tool', 'subagent'])
      budgetUsageValue(data.usage)
      break
    case 'planner.generation_recorded':
      exactData(
        data,
        ['phase', 'generatorId', 'source', 'status', 'fallbackUsed'],
        ['failureCode', 'fallbackFromCode', 'route'],
      )
      enumValue(data.phase, ['initial', 'replan'])
      safe(data.generatorId)
      enumValue(data.source, ['model', 'fallback'])
      enumValue(data.status, ['succeeded', 'failed'])
      if (typeof data.fallbackUsed !== 'boolean') invalid()
      if (data.route !== undefined) enumValue(data.route, ['parent_only', 'dag'])
      optionalSafe(data.failureCode)
      optionalSafe(data.fallbackFromCode)
      if (
        (data.source === 'fallback') !== data.fallbackUsed ||
        (data.status === 'failed') !== (data.failureCode !== undefined) ||
        data.fallbackUsed !== (data.fallbackFromCode !== undefined)
      ) {
        invalid()
      }
      if (runId === undefined) invalid()
      break
    case 'compaction.created':
      exactData(
        data,
        [
          'checkpointId',
          'coveredStartSequence',
          'coveredEndSequence',
          'retainedStartSequence',
          'summary',
          'provenance',
          'summaryDigest',
          'summaryTokens',
          'reason',
        ],
        ['previousCheckpointId', 'checkpoint'],
      )
      safe(data.checkpointId)
      positive(data.coveredStartSequence)
      positive(data.coveredEndSequence)
      if ((data.coveredEndSequence as number) < (data.coveredStartSequence as number)) invalid()
      if (data.previousCheckpointId !== undefined) safe(data.previousCheckpointId)
      positive(data.retainedStartSequence)
      compactionSummary(data.summary)
      compactionProvenance(data.provenance)
      digest(data.summaryDigest)
      if (
        data.summaryDigest !==
        sessionCompactionSummaryDigestV3(data.summary as SessionCompactionSummaryV3)
      ) {
        invalid()
      }
      nonNegative(data.summaryTokens)
      enumValue(data.reason, ['manual', 'threshold', 'overflow'])
      if (data.checkpoint !== undefined) checkpointValue(data.checkpoint, data.checkpointId)
      break
    case 'plan.created':
      exactData(data, ['planId', 'planRevision', 'objective', 'state'])
      safe(data.planId)
      positive(data.planRevision)
      boundedText(data.objective)
      planState(data.state)
      break
    case 'plan.state_changed':
      exactData(data, ['planId', 'planRevision', 'state'])
      safe(data.planId)
      positive(data.planRevision)
      planState(data.state)
      break
    case 'plan.decision_recorded':
      exactData(
        data,
        ['planId', 'planRevision', 'action', 'outcome', 'reasonCode'],
        ['stepId', 'attemptId'],
      )
      safe(data.planId)
      positive(data.planRevision)
      enumValue(data.action, ['retry', 'continue', 'fresh_worker', 'replan', 'ask_user'])
      enumValue(data.outcome, ['selected', 'applied', 'no_progress'])
      safe(data.reasonCode)
      optionalSafe(data.stepId)
      optionalSafe(data.attemptId)
      if ((data.attemptId === undefined) !== (data.stepId === undefined)) invalid()
      if (
        (data.action === 'replan' &&
          !['applied', 'no_progress'].includes(data.outcome as string)) ||
        (data.action !== 'replan' && data.outcome !== 'selected') ||
        (data.action === 'replan' && data.stepId !== undefined) ||
        (['retry', 'continue', 'fresh_worker'].includes(data.action as string) &&
          data.stepId === undefined) ||
        (data.action === 'ask_user' && data.stepId !== undefined)
      ) {
        invalid()
      }
      break
    case 'plan.revised':
      exactData(data, ['planId', 'fromRevision', 'toRevision', 'objective', 'state', 'reuseProofs'])
      safe(data.planId)
      positive(data.fromRevision)
      positive(data.toRevision)
      boundedText(data.objective)
      if (data.state !== 'running') invalid()
      replanReuseProofs(data.reuseProofs)
      break
    case 'step.created':
      exactData(data, [
        'planId',
        'planRevision',
        'stepId',
        'title',
        'order',
        'state',
        'dependencies',
        'access',
        'capabilities',
        'conflictKeys',
        'criteria',
        'budget',
        'maxAttempts',
      ])
      safe(data.planId)
      positive(data.planRevision)
      safe(data.stepId)
      boundedText(data.title)
      nonNegative(data.order)
      stepState(data.state)
      validatePlanStepPayload(data)
      break
    case 'step.state_changed':
      exactData(
        data,
        ['planId', 'planRevision', 'stepId', 'state'],
        ['reason', 'newAttemptId', 'errorCode'],
      )
      safe(data.planId)
      positive(data.planRevision)
      safe(data.stepId)
      stepState(data.state)
      if ((data.reason === undefined) !== (data.newAttemptId === undefined)) invalid()
      if (data.reason !== undefined) {
        enumValue(data.reason, [
          'retry_approved',
          'recovery_retry_approved',
          'external_condition_changed',
        ])
        safe(data.newAttemptId)
      }
      optionalSafe(data.errorCode)
      if (
        data.errorCode !== undefined &&
        !['failed', 'blocked', 'cancelled', 'interrupted'].includes(data.state as string)
      ) {
        invalid()
      }
      break
    case 'attempt.created':
      exactData(
        data,
        ['planId', 'planRevision', 'stepId', 'attemptId', 'ordinal', 'state'],
        ['childRunId'],
      )
      safe(data.planId)
      positive(data.planRevision)
      safe(data.stepId)
      safe(data.attemptId)
      positive(data.ordinal)
      attemptState(data.state)
      optionalSafe(data.childRunId)
      break
    case 'attempt.state_changed':
      exactData(data, ['planId', 'planRevision', 'stepId', 'attemptId', 'state'], ['errorCode'])
      safe(data.planId)
      positive(data.planRevision)
      safe(data.stepId)
      safe(data.attemptId)
      attemptState(data.state)
      optionalSafe(data.errorCode)
      if (
        data.errorCode !== undefined &&
        !['execution_failed', 'rejected', 'cancelled', 'interrupted'].includes(data.state as string)
      ) {
        invalid()
      }
      break
    case 'attempt.execution_completed':
      exactData(data, ['planId', 'planRevision', 'stepId', 'attemptId', 'status'])
      safe(data.planId)
      positive(data.planRevision)
      safe(data.stepId)
      safe(data.attemptId)
      enumValue(data.status, ['succeeded', 'failed', 'cancelled'])
      break
    case 'subagent.execution_bound': {
      exactData(data, [
        'planId',
        'planRevision',
        'stepId',
        'attemptId',
        'childRunId',
        'request',
        'retrySafety',
      ])
      for (const value of [data.planId, data.stepId, data.attemptId, data.childRunId]) safe(value)
      positive(data.planRevision)
      enumValue(data.retrySafety, ['read_only_idempotent', 'non_idempotent', 'unknown'])
      try {
        const request = validateSubagentExecutionRequestV1(data.request)
        if (request.childRunId !== data.childRunId) invalid()
      } catch {
        invalid()
      }
      break
    }
    case 'subagent.result_recorded':
      exactData(data, [
        'planId',
        'planRevision',
        'stepId',
        'attemptId',
        'childRunId',
        'resultRef',
        'resultDigest',
        'status',
      ])
      for (const value of [data.planId, data.stepId, data.attemptId, data.childRunId]) safe(value)
      positive(data.planRevision)
      boundedText(data.resultRef)
      digest(data.resultDigest)
      enumValue(data.status, ['succeeded', 'failed', 'cancelled'])
      break
    case 'verification.recorded':
      exactData(
        data,
        [
          'planId',
          'planRevision',
          'stepId',
          'attemptId',
          'verificationId',
          'verifier',
          'status',
          'evidenceRefs',
        ],
        ['code', 'retryable'],
      )
      for (const value of [data.planId, data.stepId, data.attemptId, data.verificationId])
        safe(value)
      positive(data.planRevision)
      enumValue(data.verifier, ['mechanical', 'rule', 'model'])
      enumValue(data.status, ['passed', 'failed', 'blocked'])
      stringList(data.evidenceRefs)
      if (data.code !== undefined) safe(data.code)
      if (data.retryable !== undefined && typeof data.retryable !== 'boolean') invalid()
      break
    case 'artifact.referenced':
      exactData(data, ['owner', 'artifact'])
      enumValue(data.owner, ['message', 'run', 'command', 'compaction', 'subagent', 'verification'])
      artifact(data.artifact)
      break
    default:
      invalid()
  }
}

function projectPlan(plan: MutablePlan | undefined): SessionPlanGraphProjectionV3 | undefined {
  if (plan === undefined) return undefined
  const orderedSteps = [...plan.steps.values()].sort(
    (left, right) => left.order - right.order || left.stepId.localeCompare(right.stepId),
  )
  assertPlanDependencies(orderedSteps)
  const attempts = orderedSteps.flatMap((step) =>
    [...step.attempts.values()]
      .sort((left, right) => left.ordinal - right.ordinal)
      .map((attempt) => {
        assertAttemptResultConsistency(attempt)
        return {
          attemptId: attempt.attemptId,
          stepId: step.stepId,
          ordinal: attempt.ordinal,
          state: attempt.state,
          ...(attempt.childRunId === undefined ? {} : { childRunId: attempt.childRunId }),
          ...(attempt.resultRef === undefined ? {} : { resultRef: attempt.resultRef }),
          ...(attempt.resultDigest === undefined ? {} : { resultDigest: attempt.resultDigest }),
          ...(attempt.verificationRef === undefined
            ? {}
            : { verificationRef: attempt.verificationRef }),
        }
      }),
  )
  const graph = validateReducerPlanGraph({
    schemaVersion: 1,
    planId: plan.planId,
    revision: plan.revision,
    objective: plan.objective,
    state: plan.state,
    steps: orderedSteps.map((step) => ({
      stepId: step.stepId,
      title: step.title,
      order: step.order,
      state: step.state,
      dependencies: step.dependencies,
      access: step.access,
      capabilities: step.capabilities,
      conflictKeys: step.conflictKeys,
      criteria: step.criteria,
      budget: step.budget,
      maxAttempts: step.maxAttempts,
      attemptIds: [...step.attempts.values()]
        .sort((left, right) => left.ordinal - right.ordinal)
        .map((attempt) => attempt.attemptId),
    })),
    attempts,
  })
  return deepFreeze({
    schemaVersion: 1 as const,
    planId: graph.planId,
    revision: graph.revision,
    objective: graph.objective,
    state: graph.state,
    readyStepIds: [...readyPlanStepIdsV1(graph)],
    steps: orderedSteps.map((step) => ({
      stepId: step.stepId,
      title: step.title,
      order: step.order,
      state: step.state,
      ...(step.errorCode === undefined ? {} : { errorCode: step.errorCode }),
      dependencies: [...step.dependencies],
      access: structuredClone(step.access),
      capabilities: [...step.capabilities],
      conflictKeys: [...step.conflictKeys],
      criteria: structuredClone(step.criteria),
      budget: structuredClone(step.budget),
      maxAttempts: step.maxAttempts,
      attemptIds: [...step.attempts.values()]
        .sort((left, right) => left.ordinal - right.ordinal)
        .map((attempt) => attempt.attemptId),
      attempts: [...step.attempts.values()]
        .sort((left, right) => left.ordinal - right.ordinal)
        .map((attempt) => ({
          attemptId: attempt.attemptId,
          ordinal: attempt.ordinal,
          state: attempt.state,
          ...(attempt.childRunId === undefined ? {} : { childRunId: attempt.childRunId }),
          ...(attempt.errorCode === undefined ? {} : { errorCode: attempt.errorCode }),
          ...(attempt.execution === undefined
            ? {}
            : { execution: structuredClone(attempt.execution) }),
          ...(attempt.resultRef === undefined ? {} : { resultRef: attempt.resultRef }),
          ...(attempt.resultDigest === undefined ? {} : { resultDigest: attempt.resultDigest }),
          ...(attempt.verificationRef === undefined
            ? {}
            : { verificationRef: attempt.verificationRef }),
          verifications: structuredClone(attempt.verifications),
        })),
    })),
  })
}

function requirePlan(plan: MutablePlan | undefined, planId: string): MutablePlan {
  if (plan === undefined || plan.planId !== planId) transitionInvalid()
  return plan
}

function requirePlanRevision(
  plan: MutablePlan | undefined,
  planId: string,
  planRevision: number,
): MutablePlan {
  const current = requirePlan(plan, planId)
  if (current.revision !== planRevision) transitionInvalid()
  return current
}

function requireStepRevision(
  plan: MutablePlan | undefined,
  planId: string,
  planRevision: number,
  stepId: string,
): MutableStep {
  const step = requirePlanRevision(plan, planId, planRevision).steps.get(stepId)
  if (step === undefined) transitionInvalid()
  return step
}

function requireAttemptRevision(
  plan: MutablePlan | undefined,
  planId: string,
  planRevision: number,
  stepId: string,
  attemptId: string,
): MutableAttempt {
  const attempt = requireStepRevision(plan, planId, planRevision, stepId).attempts.get(attemptId)
  if (attempt === undefined) transitionInvalid()
  return attempt
}

function latestStepAttempt(step: MutableStep): MutableAttempt | undefined {
  return [...step.attempts.values()].sort((left, right) => right.ordinal - left.ordinal)[0]
}

function assertAttemptResultConsistency(attempt: MutableAttempt): void {
  if (attempt.resultRef === undefined) return
  const consistent =
    (attempt.resultStatus === 'succeeded' &&
      ['verifying', 'verified', 'rejected', 'cancelled', 'interrupted'].includes(attempt.state)) ||
    (attempt.resultStatus === 'failed' &&
      ['execution_failed', 'interrupted'].includes(attempt.state)) ||
    (attempt.resultStatus === 'cancelled' && ['cancelled', 'interrupted'].includes(attempt.state))
  if (!consistent) transitionInvalid()
}

function assertPlanDependencies(steps: readonly MutableStep[]): void {
  const byId = new Map(steps.map((step) => [step.stepId, step]))
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (stepId: string): void => {
    if (visited.has(stepId)) return
    if (visiting.has(stepId)) transitionInvalid()
    const step = byId.get(stepId)
    if (step === undefined) transitionInvalid()
    visiting.add(stepId)
    for (const dependency of step.dependencies) {
      if (!byId.has(dependency)) transitionInvalid()
      visit(dependency)
    }
    visiting.delete(stepId)
    visited.add(stepId)
  }
  for (const step of steps) visit(step.stepId)
}

function validateReducerPlanGraph(input: unknown) {
  try {
    return validatePlanGraphV1(input)
  } catch {
    transitionInvalid()
  }
}

function assertReducerTransition(assertion: () => void): void {
  try {
    assertion()
  } catch {
    transitionInvalid()
  }
}

function useId(ids: Set<string>, id: string): void {
  if (ids.has(id)) throw reducerFailure('SESSION_REDUCER_ID_REUSED')
  ids.add(id)
}

function useStableId(ids: Set<string>, namespace: string, id: string): void {
  useId(ids, `${namespace}:${id}`)
}

function mergeUsage(current: BudgetUsage, update: BudgetUsage): BudgetUsage {
  const merged: BudgetUsage = {
    turns: current.turns + update.turns,
    toolCalls: current.toolCalls + update.toolCalls,
    subagents: current.subagents + update.subagents,
  }
  for (const key of [
    'inputTokens',
    'outputTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
    'costUsd',
  ] as const) {
    const left = current[key]
    const right = update[key]
    if (left !== undefined || right !== undefined) merged[key] = (left ?? 0) + (right ?? 0)
  }
  return merged
}

function normalizeBudgetUsage(current: Readonly<Partial<BudgetUsage>>): BudgetUsage {
  return {
    ...current,
    turns: current.turns ?? 0,
    toolCalls: current.toolCalls ?? 0,
    subagents: current.subagents ?? 0,
  }
}

function validCorrelation(value: unknown): boolean {
  if (!isRecord(value)) return false
  const keys = [
    'traceId',
    'parentRunId',
    'childRunId',
    'planId',
    'stepId',
    'attemptId',
    'toolCallId',
    'commandId',
  ]
  return (
    Object.keys(value).length > 0 && onlyKeys(value, keys) && Object.values(value).every(safeId)
  )
}

function providerMessage(value: unknown): void {
  if (!isRecord(value)) invalid()
  switch (value.role) {
    case 'user':
      exactData(value, ['role', 'content'], ['intent', 'trust', 'skillInvocation'])
      providerContent(value.content)
      if (value.intent !== undefined) {
        enumValue(value.intent, ['prompt', 'follow_up', 'steer', 'context'])
      }
      if (value.trust !== undefined) enumValue(value.trust, ['user', 'low'])
      if (value.skillInvocation !== undefined) skillInvocation(value.skillInvocation)
      break
    case 'assistant':
      exactData(value, ['role', 'content'], ['toolCalls'])
      providerContent(value.content)
      if (value.toolCalls !== undefined) providerToolCalls(value.toolCalls)
      break
    case 'tool':
      exactData(value, ['role', 'toolCallId', 'name', 'content'], ['skillInvocation'])
      safe(value.toolCallId)
      safe(value.name)
      providerContent(value.content)
      if (value.skillInvocation !== undefined) skillInvocation(value.skillInvocation)
      break
    default:
      invalid()
  }
}

function providerContent(value: unknown): void {
  if (typeof value === 'string') return
  if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS) invalid()
  for (const block of value) providerContentBlock(block)
}

function providerContentBlock(value: unknown): void {
  if (!isRecord(value)) invalid()
  switch (value.type) {
    case 'text':
    case 'reasoning':
      exactData(value, ['type', 'text'])
      boundedContentText(value.text)
      break
    case 'image_ref':
      exactData(value, ['type', 'artifactId'], ['mimeType', 'alt'])
      safe(value.artifactId)
      optionalBounded(value.mimeType)
      optionalBounded(value.alt)
      break
    case 'audio_ref':
      exactData(value, ['type', 'artifactId'], ['mimeType', 'transcript'])
      safe(value.artifactId)
      optionalBounded(value.mimeType)
      optionalBounded(value.transcript)
      break
    case 'citation':
      exactData(value, ['type'], ['title', 'url', 'artifactId', 'startIndex', 'endIndex'])
      if (value.title === undefined && value.url === undefined && value.artifactId === undefined) {
        invalid()
      }
      optionalBounded(value.title)
      optionalBounded(value.url)
      optionalSafe(value.artifactId)
      if (value.startIndex !== undefined) nonNegative(value.startIndex)
      if (value.endIndex !== undefined) nonNegative(value.endIndex)
      if (
        value.startIndex !== undefined &&
        value.endIndex !== undefined &&
        (value.endIndex as number) < (value.startIndex as number)
      ) {
        invalid()
      }
      break
    case 'tool_call':
      exactData(value, ['type', 'id', 'name', 'input'])
      safe(value.id)
      safe(value.name)
      break
    default:
      invalid()
  }
}

function providerToolCalls(value: unknown): void {
  if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS) invalid()
  for (const call of value) {
    if (!isRecord(call)) invalid()
    exactData(call, ['id', 'name', 'input'])
    safe(call.id)
    safe(call.name)
  }
}

function skillInvocation(value: unknown): void {
  if (
    !isRecord(value) ||
    !onlyKeys(value, [
      'type',
      'version',
      'capabilityId',
      'origin',
      'digest',
      'arguments',
      'content',
    ]) ||
    value.type !== 'skill_invocation' ||
    value.version !== 1 ||
    !safeId(value.capabilityId) ||
    typeof value.origin !== 'string' ||
    !SHA256.test(String(value.digest)) ||
    typeof value.arguments !== 'string' ||
    typeof value.content !== 'string'
  ) {
    invalid()
  }
  boundedText(value.origin)
  boundedText(value.arguments)
  boundedText(value.content)
}

function compactionSummary(value: unknown): void {
  if (!isRecord(value)) invalid()
  exactData(
    value,
    [
      'schemaVersion',
      'trust',
      'decisions',
      'constraints',
      'readFiles',
      'modifiedFiles',
      'unresolved',
      'activePlan',
    ],
    ['objective', 'relevantRefs'],
  )
  if (value.schemaVersion !== 1) invalid()
  if (value.trust !== 'low') invalid()
  optionalBounded(value.objective)
  if (value.relevantRefs !== undefined) stringList(value.relevantRefs)
  for (const field of [
    'decisions',
    'constraints',
    'readFiles',
    'modifiedFiles',
    'unresolved',
    'activePlan',
  ] as const) {
    stringList(value[field])
  }
}

function compactionProvenance(value: unknown): void {
  if (!isRecord(value)) invalid()
  exactData(value, ['schemaVersion', 'generator'], ['fallbackFrom'])
  if (value.schemaVersion !== 1) invalid()
  compactionGeneratorIdentity(value.generator)
  if (value.fallbackFrom !== undefined) compactionGeneratorIdentity(value.fallbackFrom)
}

function compactionGeneratorIdentity(value: unknown): void {
  if (!isRecord(value)) invalid()
  if (value.kind === 'deterministic') {
    exactData(value, ['kind', 'id'])
    safe(value.id)
    return
  }
  if (value.kind === 'model') {
    exactData(value, ['kind', 'id', 'provider', 'model'])
    safe(value.id)
    safe(value.provider)
    safe(value.model)
    return
  }
  invalid()
}

function compactPlanValue(value: unknown): void {
  if (!isRecord(value)) invalid()
  exactData(value, ['objective', 'steps', 'revision', 'updatedAt'])
  boundedText(value.objective)
  nonNegative(value.revision)
  if (
    !instant(value.updatedAt) ||
    !Array.isArray(value.steps) ||
    value.steps.length > MAX_LIST_ITEMS
  ) {
    invalid()
  }
  for (const step of value.steps) {
    if (!isRecord(step)) invalid()
    exactData(step, ['id', 'title', 'state'])
    safe(step.id)
    boundedText(step.title)
    enumValue(step.state, ['pending', 'in_progress', 'completed', 'blocked'])
  }
}

function checkpointValue(value: unknown, _checkpointId: unknown): void {
  if (!isRecord(value)) invalid()
  exactData(
    value,
    ['messageStart', 'messageEnd', 'content', 'digest'],
    ['estimatedGainTokens', 'scope', 'skillInvocations', 'nativeContext'],
  )
  nonNegative(value.messageStart)
  nonNegative(value.messageEnd)
  if ((value.messageEnd as number) < (value.messageStart as number)) invalid()
  boundedText(value.content)
  digest(value.digest)
  if (value.estimatedGainTokens !== undefined) nonNegative(value.estimatedGainTokens)
  if (value.scope !== undefined) {
    if (!isRecord(value.scope)) invalid()
    exactData(value.scope, ['kind', 'sessionId'])
    enumValue(value.scope.kind, ['parent', 'child'])
    safe(value.scope.sessionId)
  }
  if (value.skillInvocations !== undefined) {
    if (!Array.isArray(value.skillInvocations) || value.skillInvocations.length > MAX_LIST_ITEMS) {
      invalid()
    }
    for (const invocation of value.skillInvocations) skillInvocation(invocation)
  }
  if (value.nativeContext !== undefined && !isProviderNativeContext(value.nativeContext)) invalid()
}

export function sessionCompactionSummaryDigestV3(
  value: SessionCompactionSummaryV3,
): `sha256:${string}` {
  compactionSummary(value)
  const summary = value as SessionCompactionSummaryV3
  const canonical = {
    schemaVersion: 1 as const,
    trust: 'low' as const,
    ...(summary.objective === undefined ? {} : { objective: summary.objective }),
    ...(summary.relevantRefs === undefined ? {} : { relevantRefs: [...summary.relevantRefs] }),
    decisions: [...summary.decisions],
    constraints: [...summary.constraints],
    readFiles: [...summary.readFiles],
    modifiedFiles: [...summary.modifiedFiles],
    unresolved: [...summary.unresolved],
    activePlan: [...summary.activePlan],
  }
  return `sha256:${createHash('sha256').update(JSON.stringify(canonical)).digest('hex')}`
}

function providerUsageValue(value: unknown): void {
  if (!isRecord(value)) invalid()
  const keys = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'costUsd']
  if (!onlyKeys(value, keys)) invalid()
  validateUsageCounts(value)
}

function budgetUsageValue(value: unknown): void {
  if (!isRecord(value)) invalid()
  const keys = [
    'turns',
    'toolCalls',
    'inputTokens',
    'outputTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
    'costUsd',
    'subagents',
  ]
  if (
    !onlyKeys(value, keys) ||
    !['turns', 'toolCalls', 'subagents'].every((key) => Object.hasOwn(value, key))
  ) {
    invalid()
  }
  validateUsageCounts(value)
}

function validateUsageCounts(value: Record<string, unknown>): void {
  for (const [key, count] of Object.entries(value)) {
    if (key === 'costUsd') {
      if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) invalid()
    } else if (!Number.isSafeInteger(count) || (count as number) < 0) invalid()
  }
}

function artifact(value: unknown): void {
  if (!isRecord(value)) invalid()
  exactData(value, ['artifactId', 'digest', 'mimeType', 'bytes'])
  safe(value.artifactId)
  digest(value.digest)
  boundedText(value.mimeType)
  nonNegative(value.bytes)
}

function exactData(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  if (
    !required.every((key) => Object.hasOwn(value, key)) ||
    !onlyKeys(value, [...required, ...optional])
  ) {
    invalid()
  }
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
): asserts value is Record<string, unknown> {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(value, key))
  ) {
    invalid()
  }
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key))
}

function stringList(value: unknown): void {
  if (
    !Array.isArray(value) ||
    value.length > MAX_LIST_ITEMS ||
    !value.every(
      (entry) => typeof entry === 'string' && Buffer.byteLength(entry, 'utf8') <= MAX_TEXT_BYTES,
    )
  ) {
    invalid()
  }
}

function replanReuseProofs(value: unknown): void {
  if (!Array.isArray(value) || value.length > 64) invalid()
  const stepIds = new Set<string>()
  for (const proof of value) {
    if (!isRecord(proof)) invalid()
    exactData(proof, ['stepId', 'previousInputDigest', 'nextInputDigest'])
    safe(proof.stepId)
    digest(proof.previousInputDigest)
    digest(proof.nextInputDigest)
    if (stepIds.has(proof.stepId)) invalid()
    stepIds.add(proof.stepId)
  }
}

function enumValue(value: unknown, values: readonly string[]): void {
  if (typeof value !== 'string' || !values.includes(value)) invalid()
}

function validatePlanStepPayload(data: Record<string, unknown>): void {
  try {
    validatePlanStepV1({
      stepId: data.stepId,
      title: data.title,
      order: data.order,
      state: data.state,
      dependencies: data.dependencies,
      access: data.access,
      capabilities: data.capabilities,
      conflictKeys: data.conflictKeys,
      criteria: data.criteria,
      budget: data.budget,
      maxAttempts: data.maxAttempts,
      attemptIds: [],
    })
  } catch {
    invalid()
  }
}

function planState(value: unknown): void {
  enumValue(value, [
    'draft',
    'running',
    'blocked',
    'succeeded',
    'failed',
    'cancelled',
    'interrupted',
  ])
}

function stepState(value: unknown): void {
  enumValue(value, [
    'pending',
    'running',
    'verifying',
    'succeeded',
    'failed',
    'blocked',
    'cancelled',
    'interrupted',
  ])
}

function attemptState(value: unknown): void {
  enumValue(value, [
    'reserved',
    'running',
    'execution_succeeded',
    'execution_failed',
    'verifying',
    'verified',
    'rejected',
    'cancelled',
    'interrupted',
  ])
}

function requireRunId(value: unknown): void {
  if (!safeId(value)) invalid()
}

function boundedText(value: unknown): void {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_TEXT_BYTES) invalid()
}

function boundedContentText(value: unknown): void {
  if (
    typeof value !== 'string' ||
    Buffer.byteLength(value, 'utf8') > MAX_CONTENT_BLOCK_TEXT_BYTES
  ) {
    invalid()
  }
}

function optionalBounded(value: unknown): void {
  if (value !== undefined) boundedText(value)
}

function safe(value: unknown): asserts value is string {
  if (!safeId(value)) invalid()
}

function optionalSafe(value: unknown): void {
  if (value !== undefined) safe(value)
}

function digest(value: unknown): void {
  if (typeof value !== 'string' || !SHA256.test(value)) invalid()
}

function positive(value: unknown): void {
  if (!positiveInteger(value)) invalid()
}

function nonNegative(value: unknown): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid()
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0
}

function instant(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString() === value
  )
}

function safeId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_ID.test(value)
}

function validateJsonValue(value: unknown): void {
  try {
    assertJsonValue(value, new Set(), 0)
    const serialized = JSON.stringify(value)
    if (serialized === undefined) invalid()
  } catch {
    throw entryFailure('SESSION_ENTRY_INVALID')
  }
}

function assertJsonValue(value: unknown, ancestors: Set<object>, depth: number): void {
  if (depth > 64) invalid()
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return
  }
  if (typeof value !== 'object' || value === null) invalid()
  if (ancestors.has(value)) invalid()
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) invalid()
  ancestors.add(value)
  for (const nested of Array.isArray(value) ? value : Object.values(value)) {
    assertJsonValue(nested, ancestors, depth + 1)
  }
  ancestors.delete(value)
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const nested of Object.values(value)) deepFreeze(nested)
  return Object.freeze(value)
}

function invalid(): never {
  throw entryFailure('SESSION_ENTRY_INVALID')
}

function transitionInvalid(): never {
  throw reducerFailure('SESSION_REDUCER_TRANSITION_INVALID')
}

function entryFailure(code: string) {
  return runtimeError(code, 'persistence', 'Session entry is invalid.')
}

function reducerFailure(code: string) {
  return runtimeError(code, 'persistence', 'Session entry stream cannot be reduced.')
}
