import type { PluginGrant, PluginLifecycleState, PluginManifestV1 } from '@praxis/plugin-protocol'
import type {
  CommandCatalogSnapshotV1,
  CommandInvokeRequestV1,
  CommandInvokeResultV1,
} from '@praxis/core-sdk'

export type { CommandCatalogSnapshotV1, CommandInvokeRequestV1, CommandInvokeResultV1 }

export type OutputFormat = 'text' | 'json' | 'stream-json'

export type AutomationEnvelope = {
  schemaVersion: 1
  sequence: number
  kind: 'start' | 'delta' | 'tool' | 'permission' | 'usage' | 'terminal'
  runId?: string
  event: SessionEvent
}

export type InitializeParams = {
  protocolVersion: 1
  supportedProtocolVersions?: number[]
  client: { name: string; version: string }
  capabilities: {
    interactivePermissions: boolean
    outputFormats: OutputFormat[]
  }
}

export type InitializeResult = {
  protocolVersion: 1
  supportedProtocolVersions: readonly [1]
  runtime: { name: string; version: string; runtimeId: string }
  capabilities: {
    steer: boolean
    eventReplay: boolean
    traceExport: boolean
    providerContractVersion: 2
    eventStreamVersion: 1
    providers: readonly string[]
    tools: readonly unknown[]
  }
}

export type RpcError = {
  code: string
  message: string
  data?: unknown
  retryable?: boolean
}

export type JsonRpcRequest = {
  jsonrpc: '2.0'
  id: string
  method: string
  params?: unknown
}

export type JsonRpcSuccess = {
  jsonrpc: '2.0'
  id: string
  result: unknown
}

export type JsonRpcFailure = {
  jsonrpc: '2.0'
  id: string
  error: RpcError
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure

export type PermissionDecision =
  | { type: 'allow_once' }
  | { type: 'allow_always' }
  | { type: 'deny'; reason?: string }

export type ToolError = {
  code: string
  category: 'validation' | 'permission' | 'not_found' | 'execution' | 'truncated'
  retryable: boolean
}

export type SupervisorCorrelationV1 = Readonly<{
  parentRunId: string
  planId: string
  stepId?: string
  attemptId?: string
  childRunId?: string
  verificationId?: string
}>

export type SupervisorJournalUpdateV1 =
  | Readonly<{
      kind: 'plan'
      event: 'plan.created' | 'plan.state_changed' | 'plan.revised'
      state: 'draft' | 'running' | 'blocked' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted'
      objective?: string
      errorCode?: string
    }>
  | Readonly<{
      kind: 'planner_decision'
      event: 'plan.decision_recorded'
      action: 'retry' | 'continue' | 'fresh_worker' | 'replan' | 'ask_user'
      outcome: 'selected' | 'applied' | 'no_progress'
    }>
  | Readonly<{
      kind: 'step'
      event: 'step.created' | 'step.state_changed'
      state:
        | 'pending'
        | 'running'
        | 'verifying'
        | 'succeeded'
        | 'failed'
        | 'blocked'
        | 'cancelled'
        | 'interrupted'
      title?: string
      order?: number
      errorCode?: string
    }>
  | Readonly<{
      kind: 'attempt'
      event: 'attempt.created' | 'attempt.state_changed'
      state:
        | 'reserved'
        | 'running'
        | 'execution_succeeded'
        | 'execution_failed'
        | 'verifying'
        | 'verified'
        | 'rejected'
        | 'cancelled'
        | 'interrupted'
      errorCode?: string
    }>
  | Readonly<{
      kind: 'execution_completed'
      event: 'attempt.execution_completed'
      status: 'succeeded' | 'failed' | 'cancelled'
    }>
  | Readonly<{
      kind: 'subagent'
      event: 'subagent.execution_bound'
      status: 'bound'
    }>
  | Readonly<{
      kind: 'subagent'
      event: 'subagent.result_recorded'
      status: 'succeeded' | 'failed' | 'cancelled'
    }>
  | Readonly<{
      kind: 'verification_completed'
      event: 'verification.recorded'
      verifier: 'mechanical' | 'rule' | 'model'
      status: 'passed' | 'failed' | 'blocked'
    }>

export type SupervisorChildProgressV1 =
  | Readonly<{ kind: 'thinking'; text: string; truncated: boolean }>
  | Readonly<{
      kind: 'tool'
      phase: 'start'
      toolCallId: string
      name: string
    }>
  | Readonly<{
      kind: 'tool'
      phase: 'update'
      toolCallId: string
      message: string
      truncated: boolean
      stream?: 'stdout' | 'stderr'
      bytes?: number
    }>
  | Readonly<{
      kind: 'tool'
      phase: 'end'
      toolCallId: string
      ok: boolean
    }>

export type SupervisorUpdateV1 = Readonly<{
  schemaVersion: 1
  parentSequence: number
  sessionId: string
  correlation: SupervisorCorrelationV1
  source:
    | Readonly<{
        kind: 'journal'
        journalSequence: number
        revision: number
        entryId: string
        update: SupervisorJournalUpdateV1
      }>
    | Readonly<{
        kind: 'child_progress'
        progress: SupervisorChildProgressV1
      }>
}>

export type SessionEvent =
  | { type: 'runtime_ready'; runtimeId: string }
  | {
      type: 'auth_login_action'
      loginId: string
      action: 'open_url' | 'device_code'
      url?: string
      deviceCode?: string
    }
  | {
      type: 'auth_status_changed'
      provider: string
      status: AuthStatus
      accountLabel?: string
    }
  | { type: 'runtime_warning'; code: string; message: string }
  | {
      type: 'prompt_started'
      sessionId: string
      runId: string
      prompt: string
      promptKind?: 'prompt' | 'follow_up'
    }
  | { type: 'thinking_delta'; runId: string; text: string }
  | { type: 'text_delta'; runId: string; text: string }
  | {
      type: 'tool_planning'
      runId: string
      toolCallId: string
      name: string
      input: unknown
    }
  | {
      type: 'permission_request'
      runId: string
      requestId: string
      toolCallId: string
      tool: string
      input: unknown
      risk?: 'low' | 'medium' | 'high'
      target?: string
      rule?: string
      parentRunId?: string
      childRunId?: string
      childAgentRunId?: string
      childRequestId?: string
    }
  | {
      type: 'tool_start'
      runId: string
      toolCallId: string
      name: string
      input: unknown
    }
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
      error?: ToolError
    }
  | { type: 'steer_queued'; runId: string; steerId: string }
  | { type: 'steer_applied'; runId: string; steerId: string }
  | {
      type: 'message_committed'
      runId: string
      messageId: string
      role?: 'user' | 'assistant'
    }
  | {
      type: 'prompt_completed'
      runId: string
      usage?: UsageSummary
      stopReason?: string
    }
  | { type: 'prompt_failed'; runId: string; error: string; code?: string; usage?: UsageSummary }
  | { type: 'prompt_aborted'; runId: string; reason?: string; usage?: UsageSummary }
  | { type: 'supervisor_update'; update: SupervisorUpdateV1 }
  | { type: 'workflow_update'; update: WorkflowUpdateV1 }

export type WorkflowUpdateV1 = Readonly<{
  workflowId: string
  runId: string
  sessionId: string
  parentWorkflowId?: string
  parentNodeId?: string
  revision: number
  sequence: number
  state: string
  topology: string
  objective: string
  nodes: readonly Readonly<{
    nodeId: string
    title: string
    kind: string
    state: string
    errorCode?: string
  }>[]
  terminalCode?: string
}>

export type WorkflowHumanTaskInfoV1 = Readonly<{
  humanTaskId: string
  workflowId: string
  nodeId: string
  state: 'waiting' | 'allowed' | 'denied' | 'expired' | 'cancelled'
  request: Readonly<Record<string, unknown>>
  expiresAt?: string
  resolution?: Readonly<Record<string, unknown>>
}>

export type UsageSummary = {
  turns?: number
  toolCalls?: number
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  costUsd?: number
  subagents?: number
}

export type PromptInput = {
  sessionId: string
  text: string
  clientRequestId?: string
  commandInvocationId?: string
  budget?: {
    maxTurns?: number
    maxToolCalls?: number
    maxTokens?: number
  }
  timeoutMs?: number
}

export type CreateSessionInput = {
  cwd: string
  plannerMode?: 'auto' | 'solo' | 'workflow' | 'direct' | 'supervisor'
  provider?: string
  model?: string
  contextLimitTokens?: number
  name?: string
  labels?: string[]
  permissionMode?: 'interactive' | 'auto'
}

export type SessionInfo = {
  sessionId: string
  state: 'idle' | 'running' | 'closed'
  plannerMode?: 'auto' | 'solo' | 'workflow' | 'direct' | 'supervisor'
  cwd: string
  provider: string
  model: string
  createdAt?: string
  updatedAt?: string
  contextLimitTokens?: number
  name?: string
  parentSessionId?: string
  activeLeafId?: string
  labels?: string[]
  messageCount?: number
  usage?: UsageSummary
  lastTerminalState?: 'completed' | 'failed' | 'aborted'
}

export type UserSettingsInfo = {
  version: 1
  defaultModel: {
    provider: string
    model: string
    updatedAt: string
  } | null
}

export type ModelInfo = {
  catalogVersion: 1
  provider: string
  id: string
  name: string
  family: 'anthropic-messages' | 'openai-responses' | 'openai-chat' | 'mock'
  contextTokens?: number
  outputTokens?: number
  reasoningLevels: string[]
  modalities: string[]
  aliases?: string[]
  lifecycle?: 'active' | 'deprecated'
  catalogSource?: string
  retrievedAt?: string
}

export type SessionExportResult = {
  exportVersion: 1
  exportedAt: string
  session: SessionInfo
  messages: unknown[]
  memory: unknown
}

export type SessionTranscriptResult = {
  sessionId: string
  start: number
  end: number
  totalMessages: number
  hasMore: boolean
  messages: unknown[]
}

export type ArtifactInfo = {
  artifactId: string
  digest: string
  mimeType: string
  bytes: number
  createdAt?: string
}

export type DoctorResult = {
  ok: boolean
  runtimeId: string
  storeVersion: number
  workspace?: string
  providers: Array<{
    id: string
    status: AuthStatus
    health: string
    accountLabel?: string
  }>
  checks: Array<{ id: string; status: 'ok' | 'warning' | 'error'; message: string }>
}

export type PluginStatus = {
  id: string
  version: string
  digest: string
  origin: string
  instanceId?: string
  grants: PluginGrant[]
  health: 'stopped' | 'healthy' | 'degraded' | 'quarantined'
  lifecycle: PluginLifecycleState
  isolation: 'process' | 'mcp-stdio' | 'data-only'
  enabled: boolean
  provenance: 'verified' | 'unsigned'
}

export type PluginInspection = {
  id: string
  version: string
  digest: string
  origin: string
  installedAt: string
  storePath: string
  manifest: PluginManifestV1
  provenance: 'verified' | 'unsigned'
}

export type PluginDoctorResult = Array<{
  id: string
  version: string
  ok: boolean
  issue?: string
}>

export type ResourceInfo = {
  id: string
  localId: string
  name: string
  description: string
  kind: 'skill' | 'template' | 'theme'
  path: string
  relativeRoot: string
  provenance: {
    origin: string
    digest: string
    trusted: boolean
    sourceType: 'project' | 'plugin' | 'bundled'
  }
  metadata: {
    license?: string
    compatibility?: string
    values: Record<string, string | number | boolean | null>
    disableModelInvocation: boolean
  }
  enabled: boolean
  collision: boolean
  content?: string
}

export type AuthStatus = 'authenticated' | 'unauthenticated' | 'expired' | 'unavailable'

export type AuthInfo = {
  status: AuthStatus
  provider: string
  accountLabel?: string
  credentialSource?: 'stored' | 'environment' | 'provider'
  credentialVariable?: string
  protection?: {
    encrypted: boolean
    backend: string
    osDelegated: boolean
  }
}

export type TraceExportResult = {
  traceId: string
  path: string
  recordCount: number
  privacy: {
    included: [
      'eventKinds',
      'timestamps',
      'correlationIds',
      'declaredAttributes',
      'aggregateMetrics',
    ]
    excluded: ['prompts', 'credentials', 'environment', 'rawToolInput', 'rawToolOutput']
  }
}

export type EventNotification = {
  jsonrpc: '2.0'
  method: 'event'
  params: {
    subscriptionId: string
    sequence: number
    timestamp: string
    sessionId?: string
    runId?: string
    event: SessionEvent
  }
}

export interface RuntimeBridge {
  readonly runtimeId: string
  events(): AsyncIterable<SessionEvent>
  authStatus(provider?: string): Promise<AuthInfo>
  login(provider?: string, apiKey?: string): Promise<{ loginId: string }>
  logout(provider?: string): Promise<void>
  listModels(provider?: string): Promise<ModelInfo[]>
  getSettings(): Promise<UserSettingsInfo>
  setDefaultModel(provider: string, model: string): Promise<UserSettingsInfo>
  doctor(workspace?: string, deep?: boolean): Promise<DoctorResult>
  listCommands(workspace: string): Promise<CommandCatalogSnapshotV1>
  invokeCommand(input: CommandInvokeRequestV1): Promise<CommandInvokeResultV1>
  installPlugin(source: string): Promise<PluginStatus>
  listPlugins(workspace?: string): Promise<PluginStatus[]>
  inspectPlugin(id: string, version?: string): Promise<PluginInspection>
  enablePlugin(
    workspace: string,
    id: string,
    version: string,
    grants: PluginGrant[],
  ): Promise<PluginStatus>
  disablePlugin(workspace: string, id: string): Promise<void>
  pluginPermissions(
    workspace: string,
    id: string,
  ): Promise<{ requested: PluginGrant[]; approved: PluginGrant[] }>
  pluginDoctor(): Promise<PluginDoctorResult>
  updatePlugin(workspace: string, source: string, grants: PluginGrant[]): Promise<PluginStatus>
  rollbackPlugin(workspace: string, id: string): Promise<PluginStatus>
  uninstallPlugin(id: string, version: string): Promise<void>
  listResources(workspace: string): Promise<ResourceInfo[]>
  inspectResource(workspace: string, id: string, includeContent?: boolean): Promise<ResourceInfo>
  enableResource(workspace: string, id: string, projectTrusted?: boolean): Promise<ResourceInfo>
  disableResource(workspace: string, id: string): Promise<void>
  createSession(input: CreateSessionInput): Promise<SessionInfo>
  listSessions(): Promise<SessionInfo[]>
  searchSessions(query: string): Promise<SessionInfo[]>
  inspectSession(sessionId: string): Promise<SessionInfo>
  resumeSession(sessionId: string): Promise<SessionInfo>
  renameSession(sessionId: string, name: string): Promise<SessionInfo>
  configureSession(sessionId: string, provider: string, model: string): Promise<SessionInfo>
  closeSession(sessionId: string): Promise<void>
  deleteSession(sessionId: string): Promise<{ trashPath: string }>
  exportSession(sessionId: string): Promise<SessionExportResult>
  transcriptSession(
    sessionId: string,
    before?: number,
    limit?: number,
  ): Promise<SessionTranscriptResult>
  forkSession(sessionId: string, name?: string, throughMessage?: number): Promise<SessionInfo>
  branchSession(sessionId: string): Promise<SessionInfo>
  compactSession(sessionId: string): Promise<{ compacted: boolean; checkpointId?: string }>
  sessionPlan(sessionId: string): Promise<unknown>
  listWorkflows(sessionId?: string): Promise<WorkflowUpdateV1[]>
  getWorkflow(workflowId: string): Promise<WorkflowUpdateV1>
  pauseWorkflow(workflowId: string): Promise<WorkflowUpdateV1>
  resumeWorkflow(workflowId: string): Promise<WorkflowUpdateV1>
  cancelWorkflow(workflowId: string, reason?: string): Promise<WorkflowUpdateV1>
  terminateWorkflow(workflowId: string, reason?: string): Promise<WorkflowUpdateV1>
  listWorkflowHumanTasks(
    workflowId: string,
    state?: WorkflowHumanTaskInfoV1['state'],
  ): Promise<WorkflowHumanTaskInfoV1[]>
  resolveWorkflowHumanTask(
    humanTaskId: string,
    decision: Exclude<WorkflowHumanTaskInfoV1['state'], 'waiting'>,
    resolution?: Readonly<Record<string, unknown>>,
  ): Promise<WorkflowHumanTaskInfoV1>
  retryWorkflowNode(workflowId: string, nodeId: string): Promise<WorkflowUpdateV1>
  resolveUnknownWorkflowNode(
    workflowId: string,
    nodeId: string,
    resolution: 'succeeded' | 'failed' | 'manual_intervention',
    code?: string,
  ): Promise<WorkflowUpdateV1>
  listArtifacts(): Promise<ArtifactInfo[]>
  exportTrace(traceId: string, destination: string): Promise<TraceExportResult>
  prompt(input: PromptInput): AsyncIterable<SessionEvent>
  followUp(input: PromptInput): AsyncIterable<SessionEvent>
  steer(input: {
    sessionId: string
    runId: string
    text: string
  }): Promise<{ accepted: boolean; applyAt: 'next_safe_boundary' }>
  decidePermission(requestId: string, decision: PermissionDecision): Promise<void>
  abort(runId: string): Promise<void>
  dispose(): Promise<void>
}
