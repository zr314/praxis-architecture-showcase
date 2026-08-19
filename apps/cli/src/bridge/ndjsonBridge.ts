import { randomUUID } from 'node:crypto'
import { PraxisClient, type RuntimeEpochTransition } from '@praxis/client'
import { validateCommandCatalogSnapshotV1, validateCommandInvokeResultV1 } from '@praxis/core-sdk'
import type { PluginGrant } from '@praxis/plugin-protocol'
import type {
  ArtifactInfo,
  AuthInfo,
  CommandCatalogSnapshotV1,
  CommandInvokeRequestV1,
  CommandInvokeResultV1,
  CreateSessionInput,
  DoctorResult,
  ModelInfo,
  PermissionDecision,
  PluginDoctorResult,
  PluginInspection,
  PluginStatus,
  PromptInput,
  ResourceInfo,
  RuntimeBridge,
  RuntimeMethod,
  SessionEvent,
  SessionExportResult,
  SessionInfo,
  SessionTranscriptResult,
  TraceExportResult,
  UserSettingsInfo,
  WorkflowHumanTaskInfoV1,
  WorkflowUpdateV1,
} from '@praxis/protocol'
import { PRAXIS_PRODUCT_VERSION } from '@praxis/protocol'
import { ChildProtocolConnection } from './childProtocolConnection.js'

class EventQueue {
  private readonly events: SessionEvent[] = []
  private readonly waiters: Array<{
    resolve: (event: IteratorResult<SessionEvent>) => void
    reject: (error: Error) => void
  }> = []
  private closed = false
  private failure?: Error

  push(event: SessionEvent): void {
    const waiter = this.waiters.shift()
    if (waiter) waiter.resolve({ value: event, done: false })
    else this.events.push(event)
  }

  close(): void {
    this.closed = true
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ value: undefined, done: true })
    }
  }

  fail(error: Error): void {
    if (this.closed) return
    this.failure = error
    this.closed = true
    for (const waiter of this.waiters.splice(0)) waiter.reject(error)
  }

  async next(): Promise<IteratorResult<SessionEvent>> {
    const event = this.events.shift()
    if (event) return { value: event, done: false }
    if (this.failure) throw this.failure
    if (this.closed) return { value: undefined, done: true }
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }))
  }
}

export class NdjsonRuntimeBridge implements RuntimeBridge {
  runtimeId = ''

  private readonly client: PraxisClient
  private readonly runQueues = new Map<string, EventQueue>()
  private readonly bufferedRunEvents = new Map<string, SessionEvent[]>()
  private readonly globalEvents = new EventQueue()
  private disposed = false
  private connectionError?: Error

  private constructor(command: string, args: string[], env?: NodeJS.ProcessEnv) {
    this.client = new PraxisClient(async () => new ChildProtocolConnection(command, args, env), {
      reconnectAttempts: 1,
      client: { name: 'praxis-cli', version: PRAXIS_PRODUCT_VERSION },
      onRuntimeEpoch: (transition) => this.handleRuntimeEpoch(transition),
    })
  }

  private handleRuntimeEpoch(transition: RuntimeEpochTransition): void {
    this.runtimeId = transition.runtimeId
    if (!transition.previousRuntimeId) return
    const error = new Error(
      `Runtime restarted (${transition.previousRuntimeId} -> ${transition.runtimeId}); active runs must be resumed from durable Session state.`,
    )
    for (const queue of this.runQueues.values()) queue.fail(error)
    this.runQueues.clear()
    this.bufferedRunEvents.clear()
    this.globalEvents.push({ type: 'runtime_ready', runtimeId: transition.runtimeId })
  }

  private startEventPump(): void {
    void (async () => {
      try {
        for await (const event of this.client.events()) this.handleEvent(event)
      } catch (error) {
        if (!this.disposed) {
          this.failConnection(
            error instanceof Error ? error : new Error('Runtime event connection failed.'),
          )
        }
      }
    })()
  }

  static async start(
    command: string,
    args: string[] = [],
    options: { env?: NodeJS.ProcessEnv } = {},
  ): Promise<NdjsonRuntimeBridge> {
    const bridge = new NdjsonRuntimeBridge(command, args, options.env)
    try {
      await bridge.client.connect()
      bridge.startEventPump()
      return bridge
    } catch (error) {
      await bridge.terminate(
        error instanceof Error ? error : new Error('Runtime initialization failed.'),
      )
      throw error
    }
  }

  async createSession(input: CreateSessionInput): Promise<SessionInfo> {
    return this.request<SessionInfo>('session.create', input)
  }

  async listModels(provider?: string): Promise<ModelInfo[]> {
    return this.request<ModelInfo[]>('models.list', { ...(provider ? { provider } : {}) })
  }

  async getSettings(): Promise<UserSettingsInfo> {
    return this.request<UserSettingsInfo>('settings.get', {})
  }

  async setDefaultModel(provider: string, model: string): Promise<UserSettingsInfo> {
    return this.request<UserSettingsInfo>('settings.model.set', { provider, model })
  }

  async doctor(workspace?: string, deep?: boolean): Promise<DoctorResult> {
    return this.request<DoctorResult>('runtime.doctor', {
      ...(workspace ? { workspace } : {}),
      ...(deep === undefined ? {} : { deep }),
    })
  }

  async listCommands(workspace: string): Promise<CommandCatalogSnapshotV1> {
    return validateCommandCatalogSnapshotV1(await this.request('commands.list', { workspace }))
  }

  async invokeCommand(input: CommandInvokeRequestV1): Promise<CommandInvokeResultV1> {
    return validateCommandInvokeResultV1(await this.request('commands.invoke', { ...input }))
  }

  async installPlugin(source: string): Promise<PluginStatus> {
    return this.request('plugin.install', { source })
  }

  async listPlugins(workspace?: string): Promise<PluginStatus[]> {
    return this.request('plugin.list', { ...(workspace ? { workspace } : {}) })
  }

  async inspectPlugin(id: string, version?: string): Promise<PluginInspection> {
    return this.request('plugin.inspect', { id, ...(version ? { version } : {}) })
  }

  async enablePlugin(
    workspace: string,
    id: string,
    version: string,
    grants: PluginGrant[],
  ): Promise<PluginStatus> {
    return this.request('plugin.enable', { workspace, id, version, grants })
  }

  async disablePlugin(workspace: string, id: string): Promise<void> {
    await this.request('plugin.disable', { workspace, id })
  }

  async pluginPermissions(
    workspace: string,
    id: string,
  ): Promise<{ requested: PluginGrant[]; approved: PluginGrant[] }> {
    return this.request('plugin.permissions', { workspace, id })
  }

  async pluginDoctor(): Promise<PluginDoctorResult> {
    return this.request('plugin.doctor', {})
  }

  async updatePlugin(
    workspace: string,
    source: string,
    grants: PluginGrant[],
  ): Promise<PluginStatus> {
    return this.request('plugin.update', { workspace, source, grants })
  }

  async rollbackPlugin(workspace: string, id: string): Promise<PluginStatus> {
    return this.request('plugin.rollback', { workspace, id })
  }

  async uninstallPlugin(id: string, version: string): Promise<void> {
    await this.request('plugin.uninstall', { id, version })
  }

  async listResources(workspace: string): Promise<ResourceInfo[]> {
    return this.request('resource.list', { workspace })
  }

  async inspectResource(
    workspace: string,
    id: string,
    includeContent = false,
  ): Promise<ResourceInfo> {
    return this.request('resource.inspect', {
      workspace,
      id,
      ...(includeContent ? { includeContent: true } : {}),
    })
  }

  async enableResource(
    workspace: string,
    id: string,
    projectTrusted = false,
  ): Promise<ResourceInfo> {
    return this.request('resource.enable', {
      workspace,
      id,
      ...(projectTrusted ? { projectTrusted: true } : {}),
    })
  }

  async disableResource(workspace: string, id: string): Promise<void> {
    await this.request('resource.disable', { workspace, id })
  }

  async listSessions(): Promise<SessionInfo[]> {
    return this.request<SessionInfo[]>('session.list', {})
  }

  async searchSessions(query: string): Promise<SessionInfo[]> {
    return this.request<SessionInfo[]>('session.search', { query })
  }

  async inspectSession(sessionId: string): Promise<SessionInfo> {
    return this.request<SessionInfo>('session.inspect', { sessionId })
  }

  async resumeSession(sessionId: string): Promise<SessionInfo> {
    return this.request<SessionInfo>('session.resume', { sessionId })
  }

  async renameSession(sessionId: string, name: string): Promise<SessionInfo> {
    return this.request<SessionInfo>('session.rename', { sessionId, name })
  }

  async configureSession(sessionId: string, provider: string, model: string): Promise<SessionInfo> {
    return this.request<SessionInfo>('session.configure', { sessionId, provider, model })
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.request('session.close', { sessionId })
  }

  async deleteSession(sessionId: string): Promise<{ trashPath: string }> {
    return this.request('session.delete', { sessionId })
  }

  async exportSession(sessionId: string): Promise<SessionExportResult> {
    return this.request('session.export', { sessionId })
  }

  async transcriptSession(
    sessionId: string,
    before?: number,
    limit = 200,
  ): Promise<SessionTranscriptResult> {
    return this.request('session.transcript', {
      sessionId,
      ...(before === undefined ? {} : { before }),
      limit,
    })
  }

  async forkSession(
    sessionId: string,
    name?: string,
    throughMessage?: number,
  ): Promise<SessionInfo> {
    return this.request('session.fork', {
      sessionId,
      ...(name ? { name } : {}),
      ...(throughMessage === undefined ? {} : { throughMessage }),
    })
  }

  async branchSession(sessionId: string): Promise<SessionInfo> {
    return this.request('session.branch', { sessionId })
  }

  async compactSession(sessionId: string): Promise<{ compacted: boolean; checkpointId?: string }> {
    return this.request('session.compact', { sessionId })
  }

  async sessionPlan(sessionId: string): Promise<unknown> {
    return this.request('session.plan', { sessionId })
  }

  async listWorkflows(sessionId?: string): Promise<WorkflowUpdateV1[]> {
    return this.request('workflow.list', sessionId === undefined ? {} : { sessionId })
  }

  async getWorkflow(workflowId: string): Promise<WorkflowUpdateV1> {
    return this.request('workflow.get', { workflowId })
  }

  async pauseWorkflow(workflowId: string): Promise<WorkflowUpdateV1> {
    return this.request('workflow.pause', { workflowId })
  }

  async resumeWorkflow(workflowId: string): Promise<WorkflowUpdateV1> {
    return this.request('workflow.resume', { workflowId })
  }

  async cancelWorkflow(workflowId: string, reason?: string): Promise<WorkflowUpdateV1> {
    return this.request('workflow.cancel', { workflowId, ...(reason ? { reason } : {}) })
  }

  async terminateWorkflow(workflowId: string, reason?: string): Promise<WorkflowUpdateV1> {
    return this.request('workflow.terminate', { workflowId, ...(reason ? { reason } : {}) })
  }

  async listWorkflowHumanTasks(
    workflowId: string,
    state?: WorkflowHumanTaskInfoV1['state'],
  ): Promise<WorkflowHumanTaskInfoV1[]> {
    return this.request('workflow.human-tasks.list', {
      workflowId,
      ...(state ? { state } : {}),
    })
  }

  async resolveWorkflowHumanTask(
    humanTaskId: string,
    decision: Exclude<WorkflowHumanTaskInfoV1['state'], 'waiting'>,
    resolution?: Readonly<Record<string, unknown>>,
  ): Promise<WorkflowHumanTaskInfoV1> {
    return this.request('workflow.human-task.resolve', {
      humanTaskId,
      decision,
      resolution: resolution ?? {},
    })
  }

  async retryWorkflowNode(workflowId: string, nodeId: string): Promise<WorkflowUpdateV1> {
    return this.request('workflow.retry-node', { workflowId, nodeId })
  }

  async resolveUnknownWorkflowNode(
    workflowId: string,
    nodeId: string,
    resolution: 'succeeded' | 'failed' | 'manual_intervention',
    code?: string,
  ): Promise<WorkflowUpdateV1> {
    return this.request('workflow.resolve-unknown', {
      workflowId,
      nodeId,
      resolution,
      ...(code ? { code } : {}),
    })
  }

  async listArtifacts(): Promise<ArtifactInfo[]> {
    return this.request('artifacts.list', {})
  }

  async exportTrace(traceId: string, destination: string): Promise<TraceExportResult> {
    return this.request('trace.export', { traceId, destination })
  }

  async *events(): AsyncIterable<SessionEvent> {
    for (;;) {
      const next = await this.globalEvents.next()
      if (next.done) return
      yield next.value
    }
  }

  async authStatus(provider = 'kimi'): Promise<AuthInfo> {
    return this.request<AuthInfo>('auth.status', { provider })
  }

  async login(provider = 'kimi', apiKey?: string): Promise<{ loginId: string }> {
    return this.request('auth.login', {
      provider,
      mode: 'api_key',
      ...(apiKey ? { apiKey } : {}),
    })
  }

  async logout(provider = 'kimi'): Promise<void> {
    await this.request('auth.logout', { provider })
  }

  prompt(input: PromptInput): AsyncIterable<SessionEvent> {
    return this.startRun('session.prompt', input)
  }

  followUp(input: PromptInput): AsyncIterable<SessionEvent> {
    return this.startRun('session.follow_up', input)
  }

  async steer(input: {
    sessionId: string
    runId: string
    text: string
  }): Promise<{ accepted: boolean; applyAt: 'next_safe_boundary' }> {
    return this.request('session.steer', input)
  }

  async decidePermission(requestId: string, decision: PermissionDecision): Promise<void> {
    await this.request('permission.decide', { requestId, decision })
  }

  async abort(runId: string): Promise<void> {
    await this.request('session.abort', { runId })
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    if (this.connectionError) {
      this.disposed = true
      await this.client.close()
      return
    }
    try {
      await Promise.race([
        this.request('shutdown', {}),
        new Promise<void>((resolve) => setTimeout(resolve, 750)),
      ])
    } finally {
      this.disposed = true
      await this.client.close()
      this.failConnection(new Error('Runtime disposed.'))
    }
  }

  private async *startRun(
    method: 'session.prompt' | 'session.follow_up',
    input: PromptInput,
  ): AsyncIterable<SessionEvent> {
    const result = await this.request<{ runId: string; accepted: boolean }>(method, {
      ...input,
      clientRequestId: input.clientRequestId ?? this.newClientRequestId(),
    })
    const queue = this.getRunQueue(result.runId)

    for (;;) {
      const next = await queue.next()
      if (next.done) return
      yield next.value
      if (isTerminalEvent(next.value)) {
        queue.close()
        this.runQueues.delete(result.runId)
        return
      }
    }
  }

  private request<T>(method: RuntimeMethod, params: Record<string, unknown>): Promise<T> {
    if (this.disposed) return Promise.reject(new Error('Runtime bridge is disposed.'))
    if (this.connectionError) return Promise.reject(this.connectionError)
    return this.client.request<T>(method, params)
  }

  private handleEvent(event: SessionEvent): void {
    const runId = getRunId(event)
    if (!runId) {
      this.globalEvents.push(event)
      return
    }
    const queue = this.runQueues.get(runId)
    if (queue) {
      queue.push(event)
      return
    }
    const buffered = this.bufferedRunEvents.get(runId) ?? []
    buffered.push(event)
    this.bufferedRunEvents.set(runId, buffered)
  }

  private getRunQueue(runId: string): EventQueue {
    const existing = this.runQueues.get(runId)
    if (existing) return existing
    const queue = new EventQueue()
    if (this.connectionError) {
      queue.fail(this.connectionError)
      return queue
    }
    this.runQueues.set(runId, queue)
    for (const event of this.bufferedRunEvents.get(runId) ?? []) queue.push(event)
    this.bufferedRunEvents.delete(runId)
    return queue
  }

  private failConnection(error: Error): void {
    if (this.connectionError) return
    this.connectionError = error
    for (const queue of this.runQueues.values()) queue.fail(error)
    this.runQueues.clear()
    this.globalEvents.fail(error)
  }

  private async terminate(error: Error): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    await this.client.close()
    this.failConnection(error)
  }

  private newClientRequestId(): string {
    return `client-${Date.now().toString(36)}-${randomUUID()}`
  }
}

function getRunId(event: SessionEvent): string | undefined {
  return 'runId' in event ? event.runId : undefined
}

function isTerminalEvent(event: SessionEvent): boolean {
  return (
    event.type === 'prompt_completed' ||
    event.type === 'prompt_failed' ||
    event.type === 'prompt_aborted'
  )
}
