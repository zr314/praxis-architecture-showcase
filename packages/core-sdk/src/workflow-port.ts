import type {
  AgentProfileV1,
  EffectContractV1,
  VersionedWorkflowRefV1,
  WorkflowArtifactRefV1,
  WorkflowAttemptStateV1,
  WorkflowEventDataV1,
  WorkflowEventV1,
  WorkflowProjectionV1,
  WorkflowRetryPolicyV1,
  WorkflowSpecV1,
  WorkflowTimeoutPolicyV1,
} from './workflow.js'

export type WorkflowTaskKindV1 = 'agent' | 'tool' | 'verification' | 'compensation' | 'subworkflow'
export type WorkflowTaskStateV1 =
  | 'ready'
  | 'leased'
  | 'completed'
  | 'failed'
  | 'unknown'
  | 'cancelled'

export type WorkflowTaskV1 = Readonly<{
  schemaVersion: 1
  taskId: string
  workflowId: string
  runId: string
  nodeId: string
  attemptId: string
  kind: WorkflowTaskKindV1
  profileRef?: VersionedWorkflowRefV1
  capabilityBundleRef?: VersionedWorkflowRefV1
  payload: Readonly<Record<string, unknown>>
  state: WorkflowTaskStateV1
  priority: number
  readyAt: string
  deadlineAt: string
  conflictKeys: readonly string[]
  effect: EffectContractV1
  retry: WorkflowRetryPolicyV1
  timeout: WorkflowTimeoutPolicyV1
  lease?: WorkflowTaskLeaseV1
  createdAt: string
  updatedAt: string
}>

export type WorkflowTaskLeaseV1 = Readonly<{
  token: string
  workerId: string
  acquiredAt: string
  expiresAt: string
  lastHeartbeatAt: string
  lastProgressAt: string
}>

export type WorkflowTaskClaimV1 = Readonly<{
  task: WorkflowTaskV1
  lease: WorkflowTaskLeaseV1
}>

export type WorkflowOutboxMessageV1 = Readonly<{
  messageId: string
  workflowId: string
  topic: string
  key: string
  payload: Readonly<Record<string, unknown>>
  availableAt: string
}>

export type WorkflowTimerV1 = Readonly<{
  timerId: string
  workflowId: string
  nodeId: string
  fireAt: string
  payload: Readonly<Record<string, unknown>>
}>

export type WorkflowSignalV1 = Readonly<{
  signalId: string
  workflowId: string
  name: string
  payload: Readonly<Record<string, unknown>>
  receivedAt: string
}>

export type WorkflowMessageTypeV1 =
  | 'instruction'
  | 'progress'
  | 'milestone'
  | 'question'
  | 'answer'
  | 'result'
  | 'error'
  | 'control'

export type WorkflowMessagePartyV1 = Readonly<{
  kind: 'user' | 'runtime' | 'node'
  id: string
  attemptId?: string
}>

export type WorkflowMessageRecipientV1 = Readonly<{
  kind: 'workflow' | 'node'
  id: string
}>

/**
 * Durable, addressed coordination input. Large bodies remain in the Artifact
 * Store; the mailbox carries only bounded routing data and evidence refs.
 */
export type WorkflowMessageInputV1 = Readonly<{
  schemaVersion: 1
  messageId: string
  workflowId: string
  sender: WorkflowMessagePartyV1
  recipient: WorkflowMessageRecipientV1
  type: WorkflowMessageTypeV1
  payload: Readonly<Record<string, unknown>>
  artifactRefs?: readonly WorkflowArtifactRefV1[]
  causationId?: string
  correlationId?: string
  createdAt: string
}>

export type WorkflowMessageV1 = WorkflowMessageInputV1 &
  Readonly<{
    sequence: number
    acknowledgedAt?: string
  }>

export type WorkflowHumanTaskV1 = Readonly<{
  humanTaskId: string
  workflowId: string
  nodeId: string
  state: 'waiting' | 'allowed' | 'denied' | 'expired' | 'cancelled'
  request: Readonly<Record<string, unknown>>
  expiresAt?: string
  resolution?: Readonly<Record<string, unknown>>
}>

export type WorkflowEffectReceiptV1 = Readonly<{
  receiptId: string
  workflowId: string
  nodeId: string
  attemptId: string
  effectClass: Extract<EffectContractV1['class'], 'external_idempotent' | 'external_non_idempotent'>
  idempotencyKey?: string
  state: 'committed' | 'compensated'
  artifactRef: WorkflowArtifactRefV1
  createdAt: string
  compensatedAt?: string
  compensationReceiptRef?: WorkflowArtifactRefV1
}>

export type WorkflowEffectReservationV1 = Readonly<{
  workflowId: string
  idempotencyKey: string
  inputDigest: `sha256:${string}`
  attemptId: string
  state: 'reserved' | 'committed' | 'unknown' | 'released'
  leaseExpiresAt: string
  receiptRef?: WorkflowArtifactRefV1
  updatedAt: string
}>

export type WorkflowEffectAdmissionV1 = Readonly<{
  decision: 'execute' | 'replay' | 'in_progress' | 'conflict'
  reservation: WorkflowEffectReservationV1
}>

export type WorkflowTransactionV1 = Readonly<{
  transactionId: string
  workflowId: string
  expectedSequence: number
  events: readonly WorkflowEventDataV1[]
  enqueueTasks?: readonly WorkflowTaskV1[]
  outbox?: readonly WorkflowOutboxMessageV1[]
  timers?: readonly WorkflowTimerV1[]
  humanTasks?: readonly WorkflowHumanTaskV1[]
  effectReceipts?: readonly WorkflowEffectReceiptV1[]
  /** Atomically publishes typed coordination messages with the state change. */
  messages?: readonly WorkflowMessageInputV1[]
  effectReservationTerminal?: Readonly<{
    idempotencyKey: string
    attemptId: string
    state: 'committed' | 'unknown' | 'released'
    receiptRef?: WorkflowArtifactRefV1
  }>
  acknowledgeTask?: Readonly<{
    taskId: string
    leaseToken: string
    state: Extract<WorkflowTaskStateV1, 'completed' | 'failed' | 'unknown' | 'cancelled'>
  }>
  /** Atomically retires dependency-pruned tasks that were never leased. */
  cancelReadyTasks?: readonly string[]
  occurredAt: string
}>

export type WorkflowRecoveryDecisionV1 = Readonly<{
  taskId: string
  attemptId: string
  priorState: WorkflowAttemptStateV1
  decision: 'retry' | 'unknown' | 'manual_intervention'
  code:
    | 'LEASE_EXPIRED_RETRYABLE'
    | 'LEASE_EXPIRED_EFFECT_UNKNOWN'
    | 'LEASE_EXPIRED_ATTEMPTS_EXHAUSTED'
}>

export interface WorkflowAuthorityPortV1 {
  initialize(): Promise<void>
  create(
    spec: WorkflowSpecV1,
    transactionId: string,
    bootstrap?: Readonly<{
      events?: readonly WorkflowEventDataV1[]
      tasks?: readonly WorkflowTaskV1[]
      outbox?: readonly WorkflowOutboxMessageV1[]
      timers?: readonly WorkflowTimerV1[]
      humanTasks?: readonly WorkflowHumanTaskV1[]
      effectReceipts?: readonly WorkflowEffectReceiptV1[]
    }>,
  ): Promise<WorkflowProjectionV1>
  transact(input: WorkflowTransactionV1): Promise<WorkflowProjectionV1>
  get(workflowId: string): Promise<WorkflowProjectionV1>
  events(workflowId: string, afterSequence?: number): Promise<readonly WorkflowEventV1[]>
  list(
    options?: Readonly<{ sessionId?: string; states?: readonly string[]; limit?: number }>,
  ): Promise<readonly WorkflowProjectionV1[]>
  listTasks(
    options?: Readonly<{
      workflowId?: string
      states?: readonly WorkflowTaskStateV1[]
      kinds?: readonly WorkflowTaskKindV1[]
      limit?: number
    }>,
  ): Promise<readonly WorkflowTaskV1[]>
  bindTaskCapabilityBundle(
    taskId: string,
    leaseToken: string,
    ref: VersionedWorkflowRefV1,
    at?: string,
  ): Promise<WorkflowTaskV1>
  claim(
    workerId: string,
    options?: Readonly<{
      workflowId?: string
      nodeId?: string
      kinds?: readonly WorkflowTaskKindV1[]
      leaseMs?: number
      now?: string
    }>,
  ): Promise<WorkflowTaskClaimV1 | undefined>
  heartbeat(
    taskId: string,
    leaseToken: string,
    progress: boolean,
    now?: string,
  ): Promise<WorkflowTaskLeaseV1>
  recoverExpired(now?: string): Promise<readonly WorkflowRecoveryDecisionV1[]>
  signal(input: WorkflowSignalV1): Promise<boolean>
  postMessage(input: WorkflowMessageInputV1): Promise<WorkflowMessageV1>
  listMessages(
    options: Readonly<{
      workflowId: string
      recipientNodeId?: string
      afterSequence?: number
      types?: readonly WorkflowMessageTypeV1[]
      includeAcknowledged?: boolean
      limit?: number
    }>,
  ): Promise<readonly WorkflowMessageV1[]>
  acknowledgeMessages(
    workflowId: string,
    recipientNodeId: string,
    throughSequence: number,
    at?: string,
  ): Promise<number>
  acknowledgeMessage(
    workflowId: string,
    messageId: string,
    recipientNodeId: string,
    at?: string,
  ): Promise<boolean>
  fireDueTimers(now?: string): Promise<readonly WorkflowTimerV1[]>
  expireDueHumanTasks(now?: string): Promise<readonly WorkflowHumanTaskV1[]>
  getEffectReceipt(
    workflowId: string,
    idempotencyKey: string,
  ): Promise<WorkflowEffectReceiptV1 | undefined>
  listEffectReceipts(workflowId: string): Promise<readonly WorkflowEffectReceiptV1[]>
  reserveEffect(
    workflowId: string,
    idempotencyKey: string,
    inputDigest: `sha256:${string}`,
    attemptId: string,
    leaseExpiresAt: string,
    at?: string,
  ): Promise<WorkflowEffectAdmissionV1>
  markEffectCompensated(
    workflowId: string,
    sourceReceiptArtifactId: string,
    compensationReceiptArtifactId: string,
    at?: string,
  ): Promise<WorkflowEffectReceiptV1>
  listHumanTasks(
    workflowId: string,
    states?: readonly WorkflowHumanTaskV1['state'][],
  ): Promise<readonly WorkflowHumanTaskV1[]>
  resolveHumanTask(
    humanTaskId: string,
    state: Exclude<WorkflowHumanTaskV1['state'], 'waiting'>,
    resolution?: Readonly<Record<string, unknown>>,
    at?: string,
  ): Promise<WorkflowHumanTaskV1>
  retryNode(workflowId: string, nodeId: string, at?: string): Promise<WorkflowProjectionV1>
  resolveUnknown(
    workflowId: string,
    nodeId: string,
    resolution: 'succeeded' | 'failed' | 'manual_intervention',
    code?: string,
    at?: string,
  ): Promise<WorkflowProjectionV1>
  registerProfile(profile: AgentProfileV1): Promise<void>
  getProfile(profileId: string, version?: number): Promise<AgentProfileV1>
  listProfiles(): Promise<readonly AgentProfileV1[]>
  close(): void
}
