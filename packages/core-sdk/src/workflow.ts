import { runtimeError } from './contracts.js'

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/
const MAX_TEXT_BYTES = 32 * 1024

export type WorkflowModePolicyV1 = 'auto' | 'solo' | 'workflow'
export type WorkflowTopologyV1 = 'single_agent' | 'delegated_agents' | 'workflow_graph'
export type WorkflowStateV1 =
  | 'created'
  | 'running'
  | 'waiting'
  | 'paused'
  | 'cancelling'
  | 'cancelled'
  | 'completed'
  | 'failed'
  | 'terminated'

export type WorkflowNodeKindV1 =
  | 'agent_task'
  | 'tool_activity'
  | 'decision'
  | 'verification'
  | 'human_task'
  | 'timer'
  | 'signal_wait'
  | 'subworkflow'
  | 'compensation'
  | 'synthesis'

export type WorkflowNodeStateV1 =
  | 'proposed'
  | 'admitted'
  | 'scheduled'
  | 'leased'
  | 'running'
  | 'waiting'
  | 'verifying'
  | 'retry_wait'
  | 'unknown'
  | 'skipped'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'manual_intervention'

export type WorkflowAttemptStateV1 =
  | 'scheduled'
  | 'leased'
  | 'running'
  | 'waiting'
  | 'verifying'
  | 'retry_wait'
  | 'unknown'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'manual_intervention'

export type WorkflowEffectClassV1 =
  | 'pure'
  | 'read'
  | 'workspace_write'
  | 'external_idempotent'
  | 'external_non_idempotent'

export type VersionedWorkflowRefV1 = Readonly<{
  id: string
  version: number
  digest?: `sha256:${string}`
}>

export type WorkflowArtifactRefV1 = Readonly<{
  artifactId: string
  digest: `sha256:${string}`
  mediaType: string
}>

export type WorkflowBudgetV1 = Readonly<{
  maxWallClockMs: number
  maxTokens: number
  maxToolCalls: number
  maxAgentTasks: number
  maxParallelTasks: number
  maxCostUsd?: number
}>

export type AgentBudgetRequestV1 = Readonly<{
  maxWallClockMs?: number
  maxTokens?: number
  maxToolCalls?: number
  maxTurns?: number
}>

export type AgentHarnessProfileV1 = 'default' | 'worker' | 'explorer'

export type AgentModelRequestV1 = Readonly<{
  provider?: string
  model?: string
  tier?: 'fast' | 'balanced' | 'powerful'
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high'
}>

export type AgentResultRequestV1 = Readonly<{
  format: 'text' | 'markdown' | 'json'
  schema?: Readonly<Record<string, unknown>>
  maxInlineBytes?: number
}>

export type AgentSuccessCriterionRequestV1 = Readonly<{
  id: string
  description: string
}>

/** Model-proposed Child composition. Runtime validates, attenuates and records the effective form. */
export type AgentAssemblyRequestV1 = Readonly<{
  instructions?: string
  model?: AgentModelRequestV1
  result?: AgentResultRequestV1
  successCriteria?: readonly AgentSuccessCriterionRequestV1[]
}>

export type CapabilityRequestV1 = Readonly<{
  tools: readonly string[]
  skills: readonly string[]
  mcpServers: readonly string[]
  workspace: 'none' | 'read' | 'write'
  network: boolean
  mayDelegate: boolean
}>

export type EffectContractV1 = Readonly<{
  class: WorkflowEffectClassV1
  idempotencyKey?: string
  receiptSchemaRef?: VersionedWorkflowRefV1
  compensationRef?: VersionedWorkflowRefV1
  requiresApproval: boolean
}>

export type WorkflowRetryPolicyV1 = Readonly<{
  maxAttempts: number
  initialBackoffMs: number
  maxBackoffMs: number
  retryableCodes: readonly string[]
}>

export type WorkflowTimeoutPolicyV1 = Readonly<{
  totalMs: number
  noProgressMs: number
  heartbeatMs: number
}>

export type WorkflowVerificationCriterionV1 = Readonly<{
  criterionId: string
  kind: 'schema' | 'digest' | 'receipt' | 'rule' | 'check' | 'semantic' | 'human'
  description: string
  ref?: string
}>

export type WorkflowJoinPolicyV1 =
  | Readonly<{ kind: 'all' }>
  | Readonly<{ kind: 'any' }>
  | Readonly<{ kind: 'quorum'; minimum: number }>

export type WorkflowNodeSpecV1 = Readonly<{
  nodeId: string
  kind: WorkflowNodeKindV1
  title: string
  profileRef?: VersionedWorkflowRefV1
  inputRefs: readonly WorkflowArtifactRefV1[]
  outputSchemaRef?: VersionedWorkflowRefV1
  grantRequest: CapabilityRequestV1
  effect: EffectContractV1
  retry: WorkflowRetryPolicyV1
  timeout: WorkflowTimeoutPolicyV1
  criteria: readonly WorkflowVerificationCriterionV1[]
  maxIterations?: number
  join?: WorkflowJoinPolicyV1
}>

export type WorkflowEdgeV1 = Readonly<{
  from: string
  to: string
  condition?: Readonly<{
    operator: 'status_is' | 'exists' | 'eq' | 'in'
    pointer?: string
    value: unknown
  }>
}>

export type WorkflowSpecV1 = Readonly<{
  schemaVersion: 1
  workflowId: string
  runId: string
  sessionId: string
  parentWorkflowId?: string
  parentNodeId?: string
  executionTarget?: Readonly<{ providerId: string; model: string }>
  workspace: string
  objective: string
  modePolicy: WorkflowModePolicyV1
  topology: WorkflowTopologyV1
  revision: number
  nodes: readonly WorkflowNodeSpecV1[]
  edges: readonly WorkflowEdgeV1[]
  completion: 'all_required' | 'first_success' | 'explicit_synthesis'
  budget: WorkflowBudgetV1
  maxGraphMutations: number
  createdAt: string
}>

export type WorkflowNodeProjectionV1 = Readonly<{
  nodeId: string
  state: WorkflowNodeStateV1
  attemptIds: readonly string[]
  resultRef?: WorkflowArtifactRefV1
  errorCode?: string
}>

export type WorkflowAttemptProjectionV1 = Readonly<{
  attemptId: string
  nodeId: string
  ordinal: number
  state: WorkflowAttemptStateV1
  leaseToken?: string
  workerId?: string
  startedAt?: string
  lastProgressAt?: string
  finishedAt?: string
  resultRef?: WorkflowArtifactRefV1
  receiptRef?: WorkflowArtifactRefV1
  errorCode?: string
}>

export type WorkflowProjectionV1 = Readonly<{
  schemaVersion: 1
  workflowId: string
  runId: string
  sessionId: string
  revision: number
  sequence: number
  state: WorkflowStateV1
  spec: WorkflowSpecV1
  nodes: readonly WorkflowNodeProjectionV1[]
  attempts: readonly WorkflowAttemptProjectionV1[]
  graphMutations: number
  usage: Readonly<{
    turns: number
    toolCalls: number
    inputTokens: number
    outputTokens: number
    agentTasks: number
  }>
  updatedAt: string
  terminalCode?: string
}>

export type WorkflowEventDataV1 =
  | Readonly<{ type: 'workflow.created'; spec: WorkflowSpecV1 }>
  | Readonly<{ type: 'workflow.started' }>
  | Readonly<{ type: 'workflow.waiting' }>
  | Readonly<{ type: 'workflow.paused' }>
  | Readonly<{ type: 'workflow.resumed' }>
  | Readonly<{ type: 'workflow.cancelling'; code: string }>
  | Readonly<{
      type: 'workflow.terminal'
      state: 'cancelled' | 'completed' | 'failed' | 'terminated'
      code?: string
    }>
  | Readonly<{ type: 'workflow.topology_changed'; topology: WorkflowTopologyV1 }>
  | Readonly<{
      type: 'budget.charged'
      turns: number
      toolCalls: number
      inputTokens: number
      outputTokens: number
      agentTasks: number
    }>
  | Readonly<{ type: 'signal.received'; signalId: string; name: string }>
  | Readonly<{
      type: 'effect.receipt_recorded'
      receiptId: string
      nodeId: string
      attemptId: string
    }>
  | Readonly<{
      type: 'effect.reserved'
      nodeId: string
      attemptId: string
      idempotencyKey: string
      inputDigest: `sha256:${string}`
    }>
  | Readonly<{
      type: 'effect.replayed'
      nodeId: string
      attemptId: string
      idempotencyKey: string
    }>
  | Readonly<{
      type: 'execution.snapshot_bound'
      nodeId: string
      attemptId: string
      snapshotRef: WorkflowArtifactRefV1
    }>
  | Readonly<{
      type: 'effect.compensated'
      receiptId: string
      compensationReceiptId: string
      nodeId: string
    }>
  | Readonly<{ type: 'timer.fired'; timerId: string; nodeId: string }>
  | Readonly<{
      type: 'human_task.resolved'
      humanTaskId: string
      nodeId: string
      state: 'allowed' | 'denied' | 'expired' | 'cancelled'
    }>
  | Readonly<{ type: 'graph.patched'; spec: WorkflowSpecV1 }>
  | Readonly<{
      type: 'node.state_changed'
      nodeId: string
      state: WorkflowNodeStateV1
      errorCode?: string
      resultRef?: WorkflowArtifactRefV1
    }>
  | Readonly<{ type: 'attempt.created'; attempt: WorkflowAttemptProjectionV1 }>
  | Readonly<{
      type: 'attempt.state_changed'
      attemptId: string
      state: WorkflowAttemptStateV1
      leaseToken?: string
      workerId?: string
      at: string
      errorCode?: string
      resultRef?: WorkflowArtifactRefV1
      receiptRef?: WorkflowArtifactRefV1
    }>

export type WorkflowEventV1 = Readonly<{
  schemaVersion: 1
  eventId: string
  workflowId: string
  runId: string
  sequence: number
  occurredAt: string
  causationId?: string
  correlationId?: string
  data: WorkflowEventDataV1
}>

export type RouteReasonCodeV1 =
  | 'MULTI_DOMAIN'
  | 'PARALLEL_EVIDENCE'
  | 'EXTERNAL_WAIT'
  | 'HIGH_RISK_WRITE'
  | 'LONG_DURATION'
  | 'INDEPENDENT_VERIFICATION'
  | 'USER_REQUIRED_WORKFLOW'

export type DelegateProposalV1 = Readonly<{
  schemaVersion: 1
  proposalId: string
  profileRef: VersionedWorkflowRefV1
  objective: string
  inputRefs: readonly WorkflowArtifactRefV1[]
  grantRequest: CapabilityRequestV1
  budgetRequest: AgentBudgetRequestV1
  assemblyRequest?: AgentAssemblyRequestV1
  resultSchemaRef?: VersionedWorkflowRefV1
  reasons: readonly RouteReasonCodeV1[]
}>

export type GraphProposalV1 = Readonly<{
  schemaVersion: 1
  proposalId: string
  expectedRevision: number
  nodes: readonly WorkflowNodeSpecV1[]
  edges: readonly WorkflowEdgeV1[]
  reasons: readonly RouteReasonCodeV1[]
}>

export type GraphPatchProposalV1 = Readonly<{
  schemaVersion: 1
  proposalId: string
  expectedRevision: number
  triggerEventId: string
  addNodes: readonly WorkflowNodeSpecV1[]
  addEdges: readonly WorkflowEdgeV1[]
  cancelNodeIds: readonly string[]
  reusedEvidenceRefs: readonly WorkflowArtifactRefV1[]
  reasons: readonly RouteReasonCodeV1[]
}>

export type AgentDelegationPolicyV1 = Readonly<{
  mayDelegate: boolean
  maxDepth: number
  allowedProfiles: readonly string[]
}>

export type AgentProfileV1 = Readonly<{
  schemaVersion: 1
  profileId: string
  version: number
  digest: `sha256:${string}`
  description: string
  instructionsRef: VersionedWorkflowRefV1
  modelPolicy: Readonly<{ preferred?: string; allowedProviders: readonly string[] }>
  toolAllowlist: readonly string[]
  skillAllowlist: readonly string[]
  mcpAllowlist: readonly string[]
  defaultBudget: AgentBudgetRequestV1
  outputSchemaRef?: VersionedWorkflowRefV1
  delegationPolicy: AgentDelegationPolicyV1
}>

export function validateWorkflowSpecV1(value: unknown): WorkflowSpecV1 {
  const input = record(value, 'WORKFLOW_SPEC_INVALID')
  const executionTarget =
    input.executionTarget === undefined
      ? undefined
      : record(input.executionTarget, 'WORKFLOW_SPEC_INVALID')
  if (
    input.schemaVersion !== 1 ||
    !safeId(input.workflowId) ||
    !safeId(input.runId) ||
    !safeId(input.sessionId) ||
    (input.parentWorkflowId === undefined) !== (input.parentNodeId === undefined) ||
    (input.parentWorkflowId !== undefined && !safeId(input.parentWorkflowId)) ||
    (input.parentNodeId !== undefined && !safeId(input.parentNodeId)) ||
    (executionTarget !== undefined &&
      (!text(executionTarget.providerId) || !text(executionTarget.model))) ||
    typeof input.workspace !== 'string' ||
    input.workspace.length < 1 ||
    !text(input.objective) ||
    !MODE_POLICIES.has(input.modePolicy as WorkflowModePolicyV1) ||
    !TOPOLOGIES.has(input.topology as WorkflowTopologyV1) ||
    !positiveInteger(input.revision) ||
    !Array.isArray(input.nodes) ||
    input.nodes.length < 1 ||
    !Array.isArray(input.edges) ||
    !COMPLETION_POLICIES.has(input.completion as WorkflowSpecV1['completion']) ||
    !nonNegativeInteger(input.maxGraphMutations) ||
    !timestamp(input.createdAt)
  )
    fail('WORKFLOW_SPEC_INVALID')
  const nodes = input.nodes.map(validateNode)
  unique(
    nodes.map(({ nodeId }) => nodeId),
    'WORKFLOW_NODE_DUPLICATE',
  )
  const nodeIds = new Set(nodes.map(({ nodeId }) => nodeId))
  const edges = input.edges.map((edge) => validateEdge(edge, nodeIds))
  assertAcyclic(nodes, edges)
  for (const node of nodes) {
    if (node.join === undefined) continue
    if (node.kind !== 'decision' && node.kind !== 'synthesis') fail('WORKFLOW_JOIN_INVALID')
    const incoming = edges.filter(({ to }) => to === node.nodeId).length
    if (incoming === 0 || (node.join.kind === 'quorum' && node.join.minimum > incoming)) {
      fail('WORKFLOW_JOIN_INVALID')
    }
  }
  if (
    input.modePolicy === 'solo' &&
    nodes.some(({ nodeId, kind }) => nodeId !== 'root' && kind !== 'tool_activity')
  )
    fail('MODE_OVERRIDE_INCOMPATIBLE')
  return freeze({
    schemaVersion: 1,
    workflowId: input.workflowId,
    runId: input.runId,
    sessionId: input.sessionId,
    ...(input.parentWorkflowId === undefined
      ? {}
      : {
          parentWorkflowId: input.parentWorkflowId as string,
          parentNodeId: input.parentNodeId as string,
        }),
    ...(executionTarget === undefined
      ? {}
      : {
          executionTarget: {
            providerId: executionTarget.providerId as string,
            model: executionTarget.model as string,
          },
        }),
    workspace: input.workspace,
    objective: input.objective,
    modePolicy: input.modePolicy as WorkflowModePolicyV1,
    topology: input.topology as WorkflowTopologyV1,
    revision: input.revision,
    nodes,
    edges,
    completion: input.completion as WorkflowSpecV1['completion'],
    budget: validateBudget(input.budget),
    maxGraphMutations: input.maxGraphMutations,
    createdAt: input.createdAt,
  })
}

export function initialWorkflowProjectionV1(specValue: unknown): WorkflowProjectionV1 {
  const spec = validateWorkflowSpecV1(specValue)
  return freeze({
    schemaVersion: 1,
    workflowId: spec.workflowId,
    runId: spec.runId,
    sessionId: spec.sessionId,
    revision: spec.revision,
    sequence: 0,
    state: 'created',
    spec,
    nodes: spec.nodes.map(({ nodeId }) => ({ nodeId, state: 'proposed' as const, attemptIds: [] })),
    attempts: [],
    graphMutations: 0,
    usage: { turns: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, agentTasks: 0 },
    updatedAt: spec.createdAt,
  })
}

export function reduceWorkflowEventsV1(events: readonly WorkflowEventV1[]): WorkflowProjectionV1 {
  if (events.length === 0 || events[0]?.data.type !== 'workflow.created')
    fail('WORKFLOW_HISTORY_INVALID')
  let projection = initialWorkflowProjectionV1(events[0].data.spec)
  for (const event of events) projection = applyWorkflowEventV1(projection, event)
  return projection
}

export function applyWorkflowEventV1(
  current: WorkflowProjectionV1,
  event: WorkflowEventV1,
): WorkflowProjectionV1 {
  if (
    event.schemaVersion !== 1 ||
    !safeId(event.eventId) ||
    event.workflowId !== current.workflowId ||
    event.runId !== current.runId ||
    event.sequence !== current.sequence + 1 ||
    !timestamp(event.occurredAt)
  )
    fail('WORKFLOW_HISTORY_INVALID')
  let next: WorkflowProjectionV1 = {
    ...current,
    sequence: event.sequence,
    updatedAt: event.occurredAt,
  }
  const data = event.data
  switch (data.type) {
    case 'workflow.created':
      if (current.sequence !== 0 || data.spec.workflowId !== current.workflowId)
        fail('WORKFLOW_HISTORY_INVALID')
      break
    case 'workflow.started':
      assertWorkflowStateTransitionV1(current.state, 'running')
      next = { ...next, state: 'running' }
      break
    case 'workflow.waiting':
      assertWorkflowStateTransitionV1(current.state, 'waiting')
      next = { ...next, state: 'waiting' }
      break
    case 'workflow.paused':
      assertWorkflowStateTransitionV1(current.state, 'paused')
      next = { ...next, state: 'paused' }
      break
    case 'workflow.resumed':
      assertWorkflowStateTransitionV1(current.state, 'running')
      next = { ...next, state: 'running' }
      break
    case 'workflow.cancelling':
      assertWorkflowStateTransitionV1(current.state, 'cancelling')
      next = { ...next, state: 'cancelling', terminalCode: data.code }
      break
    case 'workflow.terminal':
      assertWorkflowStateTransitionV1(current.state, data.state)
      next = { ...next, state: data.state, terminalCode: data.code }
      break
    case 'workflow.topology_changed':
      next = { ...next, spec: { ...current.spec, topology: data.topology } }
      break
    case 'budget.charged':
      next = {
        ...next,
        usage: {
          turns: current.usage.turns + data.turns,
          toolCalls: current.usage.toolCalls + data.toolCalls,
          inputTokens: current.usage.inputTokens + data.inputTokens,
          outputTokens: current.usage.outputTokens + data.outputTokens,
          agentTasks: current.usage.agentTasks + data.agentTasks,
        },
      }
      // Usage is accounting evidence and may overshoot a limit by the final
      // provider turn. Persist it so terminalization remains auditable; runtime
      // admission checks use the recorded total to prevent further work.
      break
    case 'signal.received':
    case 'effect.receipt_recorded':
    case 'effect.reserved':
    case 'effect.replayed':
    case 'execution.snapshot_bound':
    case 'effect.compensated':
    case 'timer.fired':
    case 'human_task.resolved':
      break
    case 'graph.patched': {
      const spec = validateWorkflowSpecV1(data.spec)
      if (
        spec.revision !== current.revision + 1 ||
        current.graphMutations >= current.spec.maxGraphMutations
      ) {
        fail('WORKFLOW_GRAPH_PATCH_REJECTED')
      }
      const existing = new Map(current.nodes.map((node) => [node.nodeId, node]))
      next = {
        ...next,
        revision: spec.revision,
        spec,
        graphMutations: current.graphMutations + 1,
        nodes: spec.nodes.map(
          ({ nodeId }) => existing.get(nodeId) ?? { nodeId, state: 'proposed', attemptIds: [] },
        ),
      }
      break
    }
    case 'node.state_changed':
      next = { ...next, nodes: updateNode(current.nodes, data) }
      break
    case 'attempt.created': {
      if (current.attempts.some(({ attemptId }) => attemptId === data.attempt.attemptId))
        fail('WORKFLOW_ATTEMPT_DUPLICATE')
      const node = current.nodes.find(({ nodeId }) => nodeId === data.attempt.nodeId)
      if (node === undefined || data.attempt.ordinal !== node.attemptIds.length + 1)
        fail('WORKFLOW_ATTEMPT_INVALID')
      next = {
        ...next,
        attempts: [...current.attempts, freeze(data.attempt)],
        nodes: current.nodes.map((candidate) =>
          candidate.nodeId === node.nodeId
            ? { ...candidate, attemptIds: [...candidate.attemptIds, data.attempt.attemptId] }
            : candidate,
        ),
      }
      break
    }
    case 'attempt.state_changed':
      next = { ...next, attempts: updateAttempt(current.attempts, data) }
      break
  }
  return freeze(next)
}

export function readyWorkflowNodeIdsV1(projection: WorkflowProjectionV1): readonly string[] {
  if (projection.state !== 'running') return []
  return projection.spec.nodes
    .filter(({ nodeId }) => {
      const node = projection.nodes.find((candidate) => candidate.nodeId === nodeId)
      if (!['proposed', 'admitted', 'retry_wait'].includes(node?.state ?? '')) return false
      return workflowNodeReadinessV1(projection, nodeId) === 'ready'
    })
    .map(({ nodeId }) => nodeId)
}

export type WorkflowNodeReadinessV1 = 'waiting' | 'ready' | 'skipped' | 'blocked'

/** Deterministic edge evaluation over durable projection metadata only. */
export function workflowNodeReadinessV1(
  projection: WorkflowProjectionV1,
  nodeId: string,
): WorkflowNodeReadinessV1 {
  const incoming = projection.spec.edges.filter(({ to }) => to === nodeId)
  if (incoming.length === 0) return 'ready'
  const sources = new Map(projection.nodes.map((node) => [node.nodeId, node]))
  const spec = projection.spec.nodes.find((node) => node.nodeId === nodeId)
  const join = spec?.join
  const terminal = new Set([
    'unknown',
    'skipped',
    'succeeded',
    'failed',
    'cancelled',
    'manual_intervention',
  ])
  let active = 0
  let succeeded = 0
  let pending = 0
  for (const edge of incoming) {
    const source = sources.get(edge.from)
    if (source === undefined) return 'blocked'
    // A condition cannot be declared unselected until its source is terminal.
    // Before then it remains a possible active branch and contributes to quorum reachability.
    if (!terminal.has(source.state)) {
      active += 1
      pending += 1
      continue
    }
    const selected =
      edge.condition === undefined ? source.state !== 'skipped' : edgeMatches(source, edge)
    if (!selected) continue
    active += 1
    if (source.state === 'succeeded') succeeded += 1
  }
  if (active === 0) return join === undefined || join.kind === 'all' ? 'skipped' : 'blocked'
  const minimum = join?.kind === 'any' ? 1 : join?.kind === 'quorum' ? join.minimum : active
  if (succeeded >= minimum) return 'ready'
  return succeeded + pending < minimum ? 'blocked' : 'waiting'
}

function edgeMatches(source: WorkflowNodeProjectionV1, edge: WorkflowEdgeV1): boolean {
  const condition = edge.condition
  if (condition === undefined) return true
  if (condition.operator === 'status_is') return source.state === condition.value
  const selected = condition.pointer === undefined ? source : jsonPointer(source, condition.pointer)
  if (condition.operator === 'exists') return selected !== undefined
  if (condition.operator === 'eq') return deepEqual(selected, condition.value)
  return (
    Array.isArray(condition.value) && condition.value.some((value) => deepEqual(selected, value))
  )
}

function jsonPointer(value: unknown, pointer: string): unknown {
  if (pointer === '') return value
  let current = value
  for (const token of pointer
    .slice(1)
    .split('/')
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))) {
    if (typeof current !== 'object' || current === null || !(token in current)) return undefined
    current = (current as Record<string, unknown>)[token]
  }
  return current
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function assertWorkflowStateTransitionV1(from: WorkflowStateV1, to: WorkflowStateV1): void {
  if (!WORKFLOW_TRANSITIONS[from].has(to))
    fail('WORKFLOW_TRANSITION_INVALID', `workflow ${from} -> ${to}`)
}

export function assertWorkflowNodeTransitionV1(
  from: WorkflowNodeStateV1,
  to: WorkflowNodeStateV1,
): void {
  if (!NODE_TRANSITIONS[from].has(to)) fail('WORKFLOW_TRANSITION_INVALID', `node ${from} -> ${to}`)
}

function updateNode(
  nodes: readonly WorkflowNodeProjectionV1[],
  data: Extract<WorkflowEventDataV1, { type: 'node.state_changed' }>,
): WorkflowNodeProjectionV1[] {
  let found = false
  const updated = nodes.map((node) => {
    if (node.nodeId !== data.nodeId) return node
    found = true
    assertWorkflowNodeTransitionV1(node.state, data.state)
    return { ...node, state: data.state, errorCode: data.errorCode, resultRef: data.resultRef }
  })
  if (!found) fail('WORKFLOW_NODE_NOT_FOUND')
  return updated
}

function updateAttempt(
  attempts: readonly WorkflowAttemptProjectionV1[],
  data: Extract<WorkflowEventDataV1, { type: 'attempt.state_changed' }>,
): WorkflowAttemptProjectionV1[] {
  let found = false
  const updated = attempts.map((attempt) => {
    if (attempt.attemptId !== data.attemptId) return attempt
    found = true
    if (!ATTEMPT_TRANSITIONS[attempt.state].has(data.state))
      fail('WORKFLOW_TRANSITION_INVALID', `attempt ${attempt.state} -> ${data.state}`)
    return {
      ...attempt,
      state: data.state,
      leaseToken: data.leaseToken ?? attempt.leaseToken,
      workerId: data.workerId ?? attempt.workerId,
      startedAt: data.state === 'running' ? data.at : attempt.startedAt,
      lastProgressAt: data.at,
      finishedAt: TERMINAL_ATTEMPTS.has(data.state) ? data.at : attempt.finishedAt,
      errorCode: data.errorCode,
      resultRef: data.resultRef,
      receiptRef: data.receiptRef,
    }
  })
  if (!found) fail('WORKFLOW_ATTEMPT_NOT_FOUND')
  return updated
}

function validateNode(value: unknown): WorkflowNodeSpecV1 {
  const input = record(value, 'WORKFLOW_NODE_INVALID')
  if (
    !safeId(input.nodeId) ||
    !NODE_KINDS.has(input.kind as WorkflowNodeKindV1) ||
    !text(input.title) ||
    !Array.isArray(input.inputRefs) ||
    !Array.isArray(input.criteria) ||
    (input.maxIterations !== undefined && !positiveInteger(input.maxIterations))
  )
    fail('WORKFLOW_NODE_INVALID')
  return freeze({
    nodeId: input.nodeId,
    kind: input.kind as WorkflowNodeKindV1,
    title: input.title,
    profileRef: input.profileRef === undefined ? undefined : validateVersionedRef(input.profileRef),
    inputRefs: input.inputRefs.map(validateArtifactRef),
    outputSchemaRef:
      input.outputSchemaRef === undefined ? undefined : validateVersionedRef(input.outputSchemaRef),
    grantRequest: validateCapabilityRequest(input.grantRequest),
    effect: validateEffect(input.effect),
    retry: validateRetry(input.retry),
    timeout: validateTimeout(input.timeout),
    criteria: input.criteria.map(validateCriterion),
    maxIterations: input.maxIterations,
    join: input.join === undefined ? undefined : validateJoin(input.join),
  })
}

function validateJoin(value: unknown): WorkflowJoinPolicyV1 {
  const input = record(value, 'WORKFLOW_JOIN_INVALID')
  if (input.kind === 'all' || input.kind === 'any') return freeze({ kind: input.kind })
  if (input.kind === 'quorum' && positiveInteger(input.minimum)) {
    return freeze({ kind: 'quorum', minimum: input.minimum })
  }
  fail('WORKFLOW_JOIN_INVALID')
}

function validateEdge(value: unknown, nodeIds: ReadonlySet<string>): WorkflowEdgeV1 {
  const input = record(value, 'WORKFLOW_EDGE_INVALID')
  if (
    !safeId(input.from) ||
    !safeId(input.to) ||
    input.from === input.to ||
    !nodeIds.has(input.from) ||
    !nodeIds.has(input.to)
  )
    fail('WORKFLOW_EDGE_INVALID')
  if (input.condition !== undefined) {
    const condition = record(input.condition, 'WORKFLOW_EDGE_INVALID')
    if (!['status_is', 'exists', 'eq', 'in'].includes(String(condition.operator)))
      fail('WORKFLOW_EDGE_INVALID')
    if (
      condition.pointer !== undefined &&
      (typeof condition.pointer !== 'string' || !condition.pointer.startsWith('/'))
    )
      fail('WORKFLOW_EDGE_INVALID')
  }
  return freeze(input as WorkflowEdgeV1)
}

function assertAcyclic(
  nodes: readonly WorkflowNodeSpecV1[],
  edges: readonly WorkflowEdgeV1[],
): void {
  const outgoing = new Map<string, string[]>()
  const indegree = new Map(nodes.map(({ nodeId }) => [nodeId, 0]))
  for (const edge of edges) {
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to])
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1)
  }
  const ready = [...indegree].filter(([, count]) => count === 0).map(([id]) => id)
  let visited = 0
  while (ready.length > 0) {
    const id = ready.shift()!
    visited += 1
    for (const next of outgoing.get(id) ?? []) {
      const count = (indegree.get(next) ?? 0) - 1
      indegree.set(next, count)
      if (count === 0) ready.push(next)
    }
  }
  if (visited !== nodes.length) fail('WORKFLOW_GRAPH_CYCLE')
}

function validateBudget(value: unknown): WorkflowBudgetV1 {
  const input = record(value, 'WORKFLOW_BUDGET_INVALID')
  for (const key of [
    'maxWallClockMs',
    'maxTokens',
    'maxToolCalls',
    'maxAgentTasks',
    'maxParallelTasks',
  ]) {
    if (!positiveInteger(input[key])) fail('WORKFLOW_BUDGET_INVALID')
  }
  if (
    input.maxCostUsd !== undefined &&
    (typeof input.maxCostUsd !== 'number' || input.maxCostUsd < 0)
  )
    fail('WORKFLOW_BUDGET_INVALID')
  return freeze(input as WorkflowBudgetV1)
}

function validateCapabilityRequest(value: unknown): CapabilityRequestV1 {
  const input = record(value, 'WORKFLOW_CAPABILITY_INVALID')
  if (
    !Array.isArray(input.tools) ||
    !Array.isArray(input.skills) ||
    !Array.isArray(input.mcpServers) ||
    !['none', 'read', 'write'].includes(String(input.workspace)) ||
    typeof input.network !== 'boolean' ||
    typeof input.mayDelegate !== 'boolean'
  )
    fail('WORKFLOW_CAPABILITY_INVALID')
  for (const item of [...input.tools, ...input.skills, ...input.mcpServers])
    if (item !== '*' && !safeId(item)) fail('WORKFLOW_CAPABILITY_INVALID')
  return freeze(input as CapabilityRequestV1)
}

function validateEffect(value: unknown): EffectContractV1 {
  const input = record(value, 'WORKFLOW_EFFECT_INVALID')
  if (
    !EFFECT_CLASSES.has(input.class as WorkflowEffectClassV1) ||
    typeof input.requiresApproval !== 'boolean'
  )
    fail('WORKFLOW_EFFECT_INVALID')
  if (input.class === 'external_idempotent' && !safeId(input.idempotencyKey))
    fail('WORKFLOW_EFFECT_INVALID')
  return freeze(input as EffectContractV1)
}

function validateRetry(value: unknown): WorkflowRetryPolicyV1 {
  const input = record(value, 'WORKFLOW_RETRY_INVALID')
  if (
    !positiveInteger(input.maxAttempts) ||
    !nonNegativeInteger(input.initialBackoffMs) ||
    !nonNegativeInteger(input.maxBackoffMs) ||
    input.maxBackoffMs < input.initialBackoffMs ||
    !Array.isArray(input.retryableCodes) ||
    input.retryableCodes.some((code) => !safeId(code))
  )
    fail('WORKFLOW_RETRY_INVALID')
  return freeze(input as WorkflowRetryPolicyV1)
}

function validateTimeout(value: unknown): WorkflowTimeoutPolicyV1 {
  const input = record(value, 'WORKFLOW_TIMEOUT_INVALID')
  if (
    !positiveInteger(input.totalMs) ||
    !positiveInteger(input.noProgressMs) ||
    !positiveInteger(input.heartbeatMs) ||
    input.noProgressMs > input.totalMs ||
    input.heartbeatMs >= input.noProgressMs
  )
    fail('WORKFLOW_TIMEOUT_INVALID')
  return freeze(input as WorkflowTimeoutPolicyV1)
}

function validateCriterion(value: unknown): WorkflowVerificationCriterionV1 {
  const input = record(value, 'WORKFLOW_CRITERION_INVALID')
  if (
    !safeId(input.criterionId) ||
    !['schema', 'digest', 'receipt', 'rule', 'check', 'semantic', 'human'].includes(
      String(input.kind),
    ) ||
    !text(input.description)
  )
    fail('WORKFLOW_CRITERION_INVALID')
  return freeze(input as WorkflowVerificationCriterionV1)
}

function validateVersionedRef(value: unknown): VersionedWorkflowRefV1 {
  const input = record(value, 'WORKFLOW_REF_INVALID')
  if (
    !safeId(input.id) ||
    !positiveInteger(input.version) ||
    (input.digest !== undefined &&
      (typeof input.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(input.digest)))
  )
    fail('WORKFLOW_REF_INVALID')
  return freeze(input as VersionedWorkflowRefV1)
}

function validateArtifactRef(value: unknown): WorkflowArtifactRefV1 {
  const input = record(value, 'WORKFLOW_REF_INVALID')
  if (
    !safeId(input.artifactId) ||
    typeof input.digest !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/.test(input.digest) ||
    !text(input.mediaType)
  )
    fail('WORKFLOW_REF_INVALID')
  return freeze(input as WorkflowArtifactRefV1)
}

function record(value: unknown, code: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(code)
  return value as Record<string, unknown>
}

function safeId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_ID.test(value)
}
function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0
}
function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}
function text(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    Buffer.byteLength(value) <= MAX_TEXT_BYTES
  )
}
function timestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}
function unique(values: readonly string[], code: string): void {
  if (new Set(values).size !== values.length) fail(code)
}
function freeze<T>(value: T): T {
  return Object.freeze(value)
}
function fail(code: string, detail?: string): never {
  const message = `Workflow contract rejected the operation (${code})${detail === undefined ? '.' : `: ${detail}.`}`
  throw Object.assign(new Error(message), runtimeError(code, 'planner', message))
}

const MODE_POLICIES = new Set<WorkflowModePolicyV1>(['auto', 'solo', 'workflow'])
const TOPOLOGIES = new Set<WorkflowTopologyV1>([
  'single_agent',
  'delegated_agents',
  'workflow_graph',
])
const COMPLETION_POLICIES = new Set<WorkflowSpecV1['completion']>([
  'all_required',
  'first_success',
  'explicit_synthesis',
])
const NODE_KINDS = new Set<WorkflowNodeKindV1>([
  'agent_task',
  'tool_activity',
  'decision',
  'verification',
  'human_task',
  'timer',
  'signal_wait',
  'subworkflow',
  'compensation',
  'synthesis',
])
const EFFECT_CLASSES = new Set<WorkflowEffectClassV1>([
  'pure',
  'read',
  'workspace_write',
  'external_idempotent',
  'external_non_idempotent',
])
const TERMINAL_ATTEMPTS = new Set<WorkflowAttemptStateV1>([
  'succeeded',
  'failed',
  'cancelled',
  'manual_intervention',
])

const WORKFLOW_TRANSITIONS: Record<WorkflowStateV1, ReadonlySet<WorkflowStateV1>> = {
  created: new Set(['running', 'cancelled', 'terminated']),
  running: new Set(['waiting', 'paused', 'cancelling', 'completed', 'failed', 'terminated']),
  waiting: new Set(['running', 'paused', 'cancelling', 'failed', 'terminated']),
  paused: new Set(['running', 'cancelling', 'terminated']),
  cancelling: new Set(['cancelled', 'failed', 'terminated']),
  cancelled: new Set(),
  completed: new Set(),
  failed: new Set(),
  terminated: new Set(),
}

const NODE_TRANSITIONS: Record<WorkflowNodeStateV1, ReadonlySet<WorkflowNodeStateV1>> = {
  proposed: new Set(['admitted', 'cancelled', 'failed']),
  admitted: new Set(['scheduled', 'waiting', 'skipped', 'cancelled', 'failed']),
  scheduled: new Set(['leased', 'succeeded', 'cancelled', 'failed']),
  leased: new Set(['running', 'scheduled', 'unknown', 'cancelled']),
  running: new Set([
    'waiting',
    'verifying',
    'retry_wait',
    'unknown',
    'succeeded',
    'failed',
    'cancelled',
  ]),
  waiting: new Set(['scheduled', 'succeeded', 'cancelled', 'failed']),
  verifying: new Set(['succeeded', 'retry_wait', 'failed', 'manual_intervention']),
  retry_wait: new Set(['scheduled', 'failed', 'cancelled']),
  unknown: new Set(['succeeded', 'failed', 'manual_intervention']),
  skipped: new Set(),
  succeeded: new Set(),
  failed: new Set(['retry_wait']),
  cancelled: new Set(),
  manual_intervention: new Set(),
}

const ATTEMPT_TRANSITIONS: Record<WorkflowAttemptStateV1, ReadonlySet<WorkflowAttemptStateV1>> = {
  scheduled: new Set(['leased', 'cancelled']),
  leased: new Set(['running', 'scheduled', 'unknown', 'cancelled']),
  running: new Set([
    'waiting',
    'verifying',
    'retry_wait',
    'unknown',
    'succeeded',
    'failed',
    'cancelled',
  ]),
  waiting: new Set(['running', 'retry_wait', 'succeeded', 'failed', 'cancelled']),
  verifying: new Set(['succeeded', 'retry_wait', 'failed', 'manual_intervention']),
  retry_wait: new Set(['scheduled', 'failed', 'cancelled']),
  unknown: new Set(['succeeded', 'failed', 'manual_intervention']),
  succeeded: new Set(),
  failed: new Set(),
  cancelled: new Set(),
  manual_intervention: new Set(),
}
