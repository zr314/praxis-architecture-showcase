import type {
  PlanCreateInputV1,
  PlanExecutionBindingV1,
  PlanToolInvocationContextV1,
  PreparedReviewRefV1,
  ReadSessionEntriesInputV3,
  ReviewDecisionRefV1,
  ReviewPlanItemStateV1,
  ReviewPlanMutationOriginV1,
  ReviewPlanProjectionV1,
  SessionCommitReceiptV3,
  SessionCommitV3,
  SessionEntryPageV3,
  SessionProjectionV3,
  SessionQueryInputV3,
  SessionQueryResultV3,
  VerifiedPlanControlFactV1,
  PlanControlAuthorizationChallengeV1,
  PlanControlReasonCodeV1,
  PlanControlTargetSelectorV1,
} from '@praxis/core-sdk'

export interface ReviewPlanJournalPortV1 {
  loadProjection(sessionId: string): Promise<SessionProjectionV3>
  readEntries(input: ReadSessionEntriesInputV3): Promise<SessionEntryPageV3>
  querySession(input: SessionQueryInputV3): Promise<SessionQueryResultV3>
  appendCommit(commit: SessionCommitV3): Promise<SessionCommitReceiptV3>
}

export type MaterializedPlanDefinitionV1 = Readonly<{
  input: PlanCreateInputV1
  definitionDigest: `sha256:${string}`
}>

export interface PlanDefinitionMaterializerV1 {
  materialize(input: {
    sessionId: string
    objective: string
    criteria: PlanCreateInputV1['acceptanceCriteria']
    items: PlanCreateInputV1['items']
    reviewPolicy?: PlanCreateInputV1['reviewPolicy']
  }): Promise<MaterializedPlanDefinitionV1>
}

export type PlanMutationReceiptBaseV1 = Readonly<{
  planId: string
  planRevision: number
  journalRevision: number
  eventIds: readonly string[]
  projection: ReviewPlanProjectionV1
}>

export type PlanToolMutationReceiptV1 = PlanMutationReceiptBaseV1 &
  Readonly<{ origin: Extract<ReviewPlanMutationOriginV1, { kind: 'tool' }> }>
export type PlanRuntimeMutationReceiptV1 = PlanMutationReceiptBaseV1 &
  Readonly<{ origin: Extract<ReviewPlanMutationOriginV1, { kind: 'runtime' }> }>
export type PlanHostMutationReceiptV1 = PlanMutationReceiptBaseV1 &
  Readonly<{ origin: Extract<ReviewPlanMutationOriginV1, { kind: 'host' }> }>
export type PlanMutationReceiptV1 =
  | PlanToolMutationReceiptV1
  | PlanRuntimeMutationReceiptV1
  | PlanHostMutationReceiptV1

export type PlanCreateRequestV1 = Readonly<{
  sessionId: string
  invocation: PlanToolInvocationContextV1
  input: PlanCreateInputV1
}>

export type PlanUpdateRequestV1 = Readonly<{
  sessionId: string
  expectedPlanRevision: number
  invocation: PlanToolInvocationContextV1
  input: PlanCreateInputV1
  carryForwardAttemptIds?: readonly string[]
  planControlGrant?: VerifiedPlanControlFactV1
}>

export type PlanProgressRequestV1 = Readonly<{
  sessionId: string
  expectedPlanRevision: number
  invocation: PlanToolInvocationContextV1
  action:
    | Readonly<{ kind: 'start'; itemId: string }>
    | Readonly<{ kind: 'focus'; itemId: string; itemAttemptId: string }>
    | Readonly<{
        kind: 'block'
        itemId: string
        itemAttemptId?: string
        reason: string
        code?: string
      }>
    | Readonly<{ kind: 'request_skip'; itemId: string }>
}>

export type PlanReviewPrepareRequestV1 = Readonly<{
  sessionId: string
  expectedPlanRevision: number
  origin:
    | Extract<ReviewPlanMutationOriginV1, { kind: 'tool' }>
    | Extract<ReviewPlanMutationOriginV1, { kind: 'runtime' }>
  preparedReview: PreparedReviewRefV1
}>

export type PreparedReviewReceiptV1 = PlanMutationReceiptV1 &
  Readonly<{ preparedReview: PreparedReviewRefV1 }>

export type PlanAbandonRequestV1 = Readonly<{
  sessionId: string
  expectedPlanRevision: number
  invocation: PlanToolInvocationContextV1
  explanation: string
  controlFact: VerifiedPlanControlFactV1
}>

export type ReviewPlanExecutionRequestEventV1 = Readonly<{
  sessionId: string
  planId: string
  expectedPlanRevision: number
  itemId: string
  itemAttemptId: string
  executionInputDigest: `sha256:${string}`
  origin: Extract<ReviewPlanMutationOriginV1, { kind: 'runtime' }>
}>

export type ReviewPlanExecutionBindingEventV1 = Readonly<{
  sessionId: string
  planId: string
  expectedPlanRevision: number
  itemId: string
  itemAttemptId: string
  executionRequestId: string
  taskRef: string
  binding: PlanExecutionBindingV1
  origin: Extract<ReviewPlanMutationOriginV1, { kind: 'runtime' }>
}>

export type ReviewPlanRootToolRequestV1 = Readonly<{
  sessionId: string
  planId: string
  expectedPlanRevision: number
  itemId: string
  itemAttemptId: string
  requestId: string
  invocation: PlanToolInvocationContextV1
  toolName: string
  inputDigest: `sha256:${string}`
  origin: Extract<ReviewPlanMutationOriginV1, { kind: 'runtime' }>
}>

export type ReviewPlanRootToolResultV1 = Readonly<{
  sessionId: string
  planId: string
  expectedPlanRevision: number
  itemId: string
  itemAttemptId: string
  requestId: string
  resultRef?: string
  effectReceiptRef?: string
  changedFilesDigest?: `sha256:${string}`
  origin: Extract<ReviewPlanMutationOriginV1, { kind: 'runtime' }>
}>

export type RequestSemanticReviewEventV1 = Readonly<{
  sessionId: string
  planId: string
  expectedPlanRevision: number
  preparedReviewId: string
  deterministicDigest: `sha256:${string}`
  deterministicAttemptCount: number
  providerAttemptCount: number
  origin: Extract<ReviewPlanMutationOriginV1, { kind: 'runtime' }>
}>

export type ApplyReviewDecisionRequestV1 = Readonly<{
  sessionId: string
  planId: string
  expectedPlanRevision: number
  preparedReviewId: string
  decision: ReviewDecisionRefV1
  origin: Extract<ReviewPlanMutationOriginV1, { kind: 'runtime' }>
}>

export type ResolveReviewPlanBlockRequestV1 = Readonly<{
  sessionId: string
  planId: string
  expectedPlanRevision: number
  blockId: `rpb_${string}`
  controlFact: VerifiedPlanControlFactV1
  origin: Extract<ReviewPlanMutationOriginV1, { kind: 'host' }>
}>

export interface PlanControlServicePortV1 {
  create(input: PlanCreateRequestV1): Promise<PlanToolMutationReceiptV1>
  update(input: PlanUpdateRequestV1): Promise<PlanToolMutationReceiptV1>
  progress(input: PlanProgressRequestV1): Promise<PlanToolMutationReceiptV1>
  prepareReview(input: PlanReviewPrepareRequestV1): Promise<PreparedReviewReceiptV1>
  abandon(input: PlanAbandonRequestV1): Promise<PlanToolMutationReceiptV1>
  requestExecution(input: ReviewPlanExecutionRequestEventV1): Promise<PlanRuntimeMutationReceiptV1>
  bindExecution(input: ReviewPlanExecutionBindingEventV1): Promise<PlanRuntimeMutationReceiptV1>
  recordRootToolRequest(input: ReviewPlanRootToolRequestV1): Promise<PlanRuntimeMutationReceiptV1>
  recordRootToolResult(input: ReviewPlanRootToolResultV1): Promise<PlanRuntimeMutationReceiptV1>
  requestSemanticReview(input: RequestSemanticReviewEventV1): Promise<PlanRuntimeMutationReceiptV1>
  applyReviewDecision(input: ApplyReviewDecisionRequestV1): Promise<PlanRuntimeMutationReceiptV1>
  resolveTrustedBlock(input: ResolveReviewPlanBlockRequestV1): Promise<PlanHostMutationReceiptV1>
}

export type PlanReviewCandidateRequestV1 = Readonly<{
  sessionId: string
  expectedPlanRevision: number
  invocation: PlanToolInvocationContextV1
  scope: Readonly<{ kind: 'item'; itemId: string }> | Readonly<{ kind: 'final' }>
  summary: string
  evidenceRefs: readonly string[]
}>

export type PlanReviewToolResultV1 = Readonly<{
  status: 'accepted' | 'needs_fix' | 'reviewing' | 'blocked'
  summary: string
  planId: string
  planRevision: number
  reviewRequestId?: string
  findings?: readonly Readonly<{
    criterionId: string
    status: 'passed' | 'failed' | 'unverifiable'
    reason: string
    evidenceRefs: readonly string[]
  }>[]
  projection: ReviewPlanProjectionV1
}>

export interface ReviewCoordinatorPortV1 {
  review(input: PlanReviewCandidateRequestV1, signal: AbortSignal): Promise<PlanReviewToolResultV1>
}

export type PlanProgressResultStateV1 = Extract<
  ReviewPlanItemStateV1,
  'pending' | 'running' | 'blocked' | 'skipped'
>

export type AuthenticatedHostActorV1 = Readonly<{
  actorId: string
  actorBindingDigest: `sha256:${string}`
}>

export type PreparePlanControlAuthorizationInputV1 = Readonly<{
  authorizationRequestId: string
  sessionId: string
  action: PlanControlAuthorizationChallengeV1['action']
  reasonCode: PlanControlReasonCodeV1
  target: PlanControlTargetSelectorV1
  challengeTtlSeconds?: number
  authorizationTtlSeconds?: number
}>

export type AuthorizePlanControlInputV1 = Readonly<{
  authorizationRequestId: string
  sessionId: string
  challenge: PlanControlAuthorizationChallengeV1
  confirmationTokenDigest: `sha256:${string}`
}>

export type VerifyPlanControlTokenInputV1 = Readonly<{
  controlEventId: string
  confirmationToken: string
}>

export type BindPlanControlTurnInputV1 = Readonly<{
  verifiedFact: VerifiedPlanControlFactV1
  runId: string
  providerTurnId: string
}>

export type DiscardPlanControlTurnInputV1 = Readonly<{
  controlEventId: string
  runId: string
  providerTurnId: string
  reason: 'not_used' | 'abort' | 'timeout' | 'provider_failure' | 'run_terminated'
}>

export interface PlanControlTokenServicePortV1 {
  prepareChallenge(
    input: PreparePlanControlAuthorizationInputV1,
    actor: AuthenticatedHostActorV1,
  ): Promise<PlanControlAuthorizationChallengeV1>
  authorize(
    input: AuthorizePlanControlInputV1,
    actor: AuthenticatedHostActorV1,
  ): Promise<Readonly<{ controlEventId: string; expiresAt: string; replayed: boolean }>>
  verify(
    input: VerifyPlanControlTokenInputV1,
    actor: AuthenticatedHostActorV1,
  ): Promise<VerifiedPlanControlFactV1>
  bindToProviderTurn(input: BindPlanControlTurnInputV1): Promise<VerifiedPlanControlFactV1>
  discardProviderTurnGrant(input: DiscardPlanControlTurnInputV1): Promise<void>
}
