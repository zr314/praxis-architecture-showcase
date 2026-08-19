import { resolve } from 'node:path'
import {
  assertCommandCatalogBindingV1,
  commandSourceDigestV1,
  createCommandInvokeResultV1,
  validateCommandInvocationAgainstDescriptorV1,
  validateCommandInvokeRequestV1,
  type CommandInvokeOutputV1,
  type CommandJsonValueV1,
} from '@praxis/core-sdk'
import type { PluginGrant } from '@praxis/plugin-protocol'
import type {
  AuthInfo,
  ArtifactInfo,
  CommandCatalogSnapshotV1,
  CommandInvokeRequestV1,
  CommandInvokeResultV1,
  CreateSessionInput,
  DoctorResult,
  ModelInfo,
  PluginDoctorResult,
  PluginInspection,
  PluginStatus,
  PermissionDecision,
  PromptInput,
  ResourceInfo,
  RuntimeBridge,
  SessionEvent,
  SessionExportResult,
  SessionInfo,
  SessionTranscriptResult,
  TraceExportResult,
  UserSettingsInfo,
  WorkflowHumanTaskInfoV1,
  WorkflowUpdateV1,
} from '@praxis/protocol'
import {
  createMockRuntimeCommandRegistryV1,
  MOCK_COMMAND_CAPABILITIES_V1,
} from './mockCommandRegistry.js'

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function mockPlugin(origin: string): PluginStatus {
  return {
    id: 'mock.plugin',
    version: '0.1.0',
    digest: 'sha256:mock',
    origin,
    grants: [],
    health: 'stopped',
    lifecycle: 'installed',
    isolation: 'data-only',
    enabled: false,
    provenance: 'unsigned',
  }
}

function mockResource(workspace: string, id = 'project/mock'): ResourceInfo {
  return {
    id,
    localId: id.split('/').at(-1) ?? id,
    name: 'mock',
    description: 'Mock Skill resource.',
    kind: 'skill',
    path: resolve(workspace, '.praxis', 'skills', 'mock', 'SKILL.md'),
    relativeRoot: 'mock',
    provenance: {
      origin: `project:${resolve(workspace)}`,
      digest: `sha256:${'0'.repeat(64)}`,
      trusted: false,
      sourceType: 'project',
    },
    metadata: { values: {}, disableModelInvocation: false },
    enabled: false,
    collision: false,
  }
}

export class MockRuntimeBridge implements RuntimeBridge {
  readonly runtimeId = `local-${Date.now().toString(36)}`

  private readonly permissionDecisions = new Map<string, PermissionDecision>()
  private readonly commandRegistry = createMockRuntimeCommandRegistryV1()
  private defaultModel: UserSettingsInfo['defaultModel'] = {
    provider: 'mock',
    model: 'mock-v1',
    updatedAt: new Date(0).toISOString(),
  }

  async *events(): AsyncIterable<SessionEvent> {
    return
  }

  async authStatus(): Promise<AuthInfo> {
    return {
      status: 'authenticated',
      provider: 'mock',
      accountLabel: 'Mock Provider',
      credentialSource: 'provider',
    }
  }

  async login(_provider?: string, _apiKey?: string): Promise<{ loginId: string }> {
    return { loginId: `mock-login-${Date.now().toString(36)}` }
  }

  async logout(): Promise<void> {}

  async createSession(input: CreateSessionInput): Promise<SessionInfo> {
    return {
      sessionId: `mock-session-${Date.now().toString(36)}`,
      state: 'idle',
      cwd: input.cwd,
      provider: input.provider ?? 'mock',
      model: input.model ?? 'mock-v1',
      name: input.name,
      labels: input.labels,
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    return [
      {
        catalogVersion: 1,
        provider: 'mock',
        id: 'mock-v1',
        name: 'Mock v1',
        family: 'mock',
        reasoningLevels: ['none'],
        modalities: ['text'],
      },
    ]
  }

  async getSettings(): Promise<UserSettingsInfo> {
    return { version: 1, defaultModel: this.defaultModel ? { ...this.defaultModel } : null }
  }

  async setDefaultModel(provider: string, model: string): Promise<UserSettingsInfo> {
    this.defaultModel = { provider, model, updatedAt: new Date(0).toISOString() }
    return this.getSettings()
  }

  async doctor(workspace?: string, _deep?: boolean): Promise<DoctorResult> {
    return {
      ok: true,
      runtimeId: this.runtimeId,
      storeVersion: 3,
      ...(workspace ? { workspace } : {}),
      providers: [{ id: 'mock', status: 'authenticated', health: 'healthy' }],
      checks: [{ id: 'mock', status: 'ok', message: 'Mock bridge is ready.' }],
    }
  }

  async listCommands(workspace: string): Promise<CommandCatalogSnapshotV1> {
    return this.commandRegistry.snapshot({
      workspaceId: mockWorkspaceId(workspace),
      workspaceTrusted: true,
      capabilityIds: MOCK_COMMAND_CAPABILITIES_V1,
    })
  }

  async invokeCommand(input: CommandInvokeRequestV1): Promise<CommandInvokeResultV1> {
    const request = validateCommandInvokeRequestV1(input)
    const snapshot = assertCommandCatalogBindingV1(
      await this.listCommands(request.workspace),
      request,
    )
    const descriptor = snapshot.entries.find(
      (entry) => entry.descriptor.id === request.invocation.descriptorId,
    )?.descriptor
    if (descriptor === undefined) throw new Error('COMMAND_DESCRIPTOR_STALE')
    validateCommandInvocationAgainstDescriptorV1(request.invocation, descriptor)
    const arguments_ = request.invocation.arguments
    let output: CommandInvokeOutputV1
    switch (descriptor.command) {
      case 'new': {
        const session = await this.createSession({
          cwd: request.workspace,
          ...(typeof arguments_.name === 'string' ? { name: arguments_.name } : {}),
        })
        output = mockAction('session_changed', {
          session: mockJson(session),
          message: `Created session ${session.sessionId}.`,
          history: 'reset',
        })
        break
      }
      case 'resume': {
        const id = String(arguments_.id)
        const session = await this.resumeSession(id)
        output = mockAction('session_changed', {
          session: mockJson(session),
          message: `Resumed ${session.sessionId}.`,
          history: 'restore',
        })
        break
      }
      case 'session':
        output = mockAction('open_session_picker', {
          ...(typeof arguments_.query === 'string' ? { query: arguments_.query } : {}),
        })
        break
      case 'provider':
        output = mockAction('open_catalog', {
          view: typeof arguments_.id === 'string' ? 'models' : 'providers',
          ...(typeof arguments_.id === 'string' ? { provider: arguments_.id } : {}),
        })
        break
      case 'login':
        output = mockAction('open_catalog', {
          view: 'providers',
          intent: 'login',
          ...(typeof arguments_.provider === 'string' ? { provider: arguments_.provider } : {}),
        })
        break
      case 'logout':
        output =
          typeof arguments_.provider === 'string'
            ? mockAction('show_message', {
                message: `Disconnected ${arguments_.provider}; its stored credential was removed.`,
              })
            : mockAction('open_catalog', { view: 'providers', intent: 'logout' })
        break
      case 'model': {
        const model = arguments_.model
        if (model === 'mock-v1' || model === 'mock/mock-v1') {
          const session = await this.configureSession(
            request.sessionId ?? 'mock-session',
            'mock',
            'mock-v1',
          )
          output = mockAction('session_changed', {
            session: mockJson(session),
            message: 'Model: mock-v1 [mock]',
            history: 'preserve',
          })
        } else {
          output = mockAction('open_catalog', {
            view: 'models',
            ...(typeof model === 'string' ? { query: model } : {}),
          })
        }
        break
      }
      case 'compact':
        output = mockAction('show_message', { message: 'No compaction was needed.' })
        break
      case 'context':
        output = mockAction('show_message', { message: '{\n  "checkpointId": null\n}' })
        break
      case 'plan':
        output = mockAction('show_message', {
          message: JSON.stringify(
            {
              sessionId: request.sessionId ?? 'mock-session',
              plan: null,
              plannerGeneration: null,
            },
            undefined,
            2,
          ),
        })
        break
      case 'artifacts':
        output = mockAction('show_message', { message: 'No artifacts.' })
        break
      case 'export':
        output = mockAction('export_session', {
          sessionId: request.sessionId ?? 'mock-session',
          path: String(arguments_.path),
        })
        break
      case 'doctor':
        output = mockAction('show_message', { message: 'OK mock: Mock bridge is ready.' })
        break
      default:
        throw new Error('COMMAND_HANDLER_NOT_FOUND')
    }
    return createCommandInvokeResultV1({ descriptor, invocation: request.invocation, output })
  }

  async installPlugin(source: string): Promise<PluginStatus> {
    return mockPlugin(source)
  }

  async listPlugins(): Promise<PluginStatus[]> {
    return []
  }

  async inspectPlugin(id: string, version = '0.1.0'): Promise<PluginInspection> {
    return {
      ...mockPlugin(id),
      installedAt: new Date(0).toISOString(),
      storePath: id,
      manifest: {
        manifestVersion: 1,
        id: 'mock.plugin',
        name: 'Mock Plugin',
        version,
        apiVersion: 1,
        isolation: 'data-only',
        capabilities: [],
        grants: [],
      },
      version,
    }
  }

  async enablePlugin(
    _workspace: string,
    id: string,
    version: string,
    grants: PluginGrant[],
  ): Promise<PluginStatus> {
    return {
      ...mockPlugin(id),
      version,
      grants,
      lifecycle: 'workspace-enabled',
      enabled: true,
      instanceId: 'mock-instance',
    }
  }

  async disablePlugin(_workspace: string, _id: string): Promise<void> {}

  async pluginPermissions(): Promise<{ requested: PluginGrant[]; approved: PluginGrant[] }> {
    return { requested: [], approved: [] }
  }

  async pluginDoctor(): Promise<PluginDoctorResult> {
    return []
  }

  async updatePlugin(
    _workspace: string,
    source: string,
    grants: PluginGrant[],
  ): Promise<PluginStatus> {
    return { ...mockPlugin(source), grants, lifecycle: 'workspace-enabled', enabled: true }
  }

  async rollbackPlugin(_workspace: string, id: string): Promise<PluginStatus> {
    return { ...mockPlugin(id), lifecycle: 'workspace-enabled', enabled: true }
  }

  async uninstallPlugin(_id: string, _version: string): Promise<void> {}

  async listResources(_workspace: string): Promise<ResourceInfo[]> {
    return []
  }

  async inspectResource(workspace: string, id: string): Promise<ResourceInfo> {
    return mockResource(workspace, id)
  }

  async enableResource(
    workspace: string,
    id: string,
    _projectTrusted?: boolean,
  ): Promise<ResourceInfo> {
    return { ...mockResource(workspace, id), enabled: true }
  }

  async disableResource(_workspace: string, _id: string): Promise<void> {}

  async listSessions(): Promise<SessionInfo[]> {
    return []
  }

  async searchSessions(_query: string): Promise<SessionInfo[]> {
    return []
  }

  async inspectSession(sessionId: string): Promise<SessionInfo> {
    return this.resumeSession(sessionId)
  }

  async resumeSession(sessionId: string): Promise<SessionInfo> {
    return {
      sessionId,
      state: 'idle',
      cwd: process.cwd(),
      provider: 'mock',
      model: 'mock-v1',
    }
  }

  async renameSession(sessionId: string, name: string): Promise<SessionInfo> {
    return { ...(await this.resumeSession(sessionId)), name }
  }

  async configureSession(sessionId: string, provider: string, model: string): Promise<SessionInfo> {
    return { ...(await this.resumeSession(sessionId)), provider, model }
  }

  async closeSession(_sessionId: string): Promise<void> {}

  async deleteSession(_sessionId: string): Promise<{ trashPath: string }> {
    return { trashPath: 'mock-trash' }
  }

  async exportSession(sessionId: string): Promise<SessionExportResult> {
    return {
      exportVersion: 1,
      exportedAt: new Date(0).toISOString(),
      session: await this.resumeSession(sessionId),
      messages: [],
      memory: {},
    }
  }

  async transcriptSession(
    sessionId: string,
    before?: number,
    limit = 200,
  ): Promise<SessionTranscriptResult> {
    const exported = await this.exportSession(sessionId)
    const end = Math.min(before ?? exported.messages.length, exported.messages.length)
    const start = Math.max(0, end - limit)
    return {
      sessionId,
      start,
      end,
      totalMessages: exported.messages.length,
      hasMore: start > 0,
      messages: structuredClone(exported.messages.slice(start, end)),
    }
  }

  async forkSession(sessionId: string, name?: string): Promise<SessionInfo> {
    return {
      ...(await this.resumeSession(`fork-${sessionId}`)),
      ...(name ? { name } : {}),
      parentSessionId: sessionId,
    }
  }

  async branchSession(sessionId: string): Promise<SessionInfo> {
    return this.resumeSession(sessionId)
  }

  async compactSession(_sessionId: string): Promise<{ compacted: boolean; checkpointId?: string }> {
    return { compacted: false }
  }

  async sessionPlan(sessionId: string): Promise<unknown> {
    return { sessionId, plan: null, plannerGeneration: null }
  }

  async listWorkflows(_sessionId?: string): Promise<WorkflowUpdateV1[]> {
    return []
  }

  async getWorkflow(workflowId: string): Promise<WorkflowUpdateV1> {
    throw new Error(`Unknown workflow: ${workflowId}`)
  }

  async pauseWorkflow(workflowId: string): Promise<WorkflowUpdateV1> {
    return this.getWorkflow(workflowId)
  }

  async resumeWorkflow(workflowId: string): Promise<WorkflowUpdateV1> {
    return this.getWorkflow(workflowId)
  }

  async cancelWorkflow(workflowId: string, _reason?: string): Promise<WorkflowUpdateV1> {
    return this.getWorkflow(workflowId)
  }

  async terminateWorkflow(workflowId: string, _reason?: string): Promise<WorkflowUpdateV1> {
    return this.getWorkflow(workflowId)
  }

  async listWorkflowHumanTasks(
    _workflowId: string,
    _state?: WorkflowHumanTaskInfoV1['state'],
  ): Promise<WorkflowHumanTaskInfoV1[]> {
    return []
  }

  async resolveWorkflowHumanTask(
    humanTaskId: string,
    _decision: Exclude<WorkflowHumanTaskInfoV1['state'], 'waiting'>,
    _resolution?: Readonly<Record<string, unknown>>,
  ): Promise<WorkflowHumanTaskInfoV1> {
    throw new Error(`Unknown human task: ${humanTaskId}`)
  }

  async retryWorkflowNode(workflowId: string, _nodeId: string): Promise<WorkflowUpdateV1> {
    return this.getWorkflow(workflowId)
  }

  async resolveUnknownWorkflowNode(
    workflowId: string,
    _nodeId: string,
    _resolution: 'succeeded' | 'failed' | 'manual_intervention',
    _code?: string,
  ): Promise<WorkflowUpdateV1> {
    return this.getWorkflow(workflowId)
  }

  async listArtifacts(): Promise<ArtifactInfo[]> {
    return []
  }

  async exportTrace(traceId: string, destination: string): Promise<TraceExportResult> {
    return {
      traceId,
      path: resolve(destination, `${traceId}.json`),
      recordCount: 0,
      privacy: {
        included: [
          'eventKinds',
          'timestamps',
          'correlationIds',
          'declaredAttributes',
          'aggregateMetrics',
        ],
        excluded: ['prompts', 'credentials', 'environment', 'rawToolInput', 'rawToolOutput'],
      },
    }
  }

  async *prompt(input: PromptInput): AsyncIterable<SessionEvent> {
    const runId = `run-${Date.now().toString(36)}`

    yield {
      type: 'prompt_started',
      sessionId: input.sessionId,
      runId,
      prompt: input.text,
    }

    yield { type: 'thinking_delta', runId, text: '整理上下文' }
    await delay(120)
    yield { type: 'thinking_delta', runId, text: '规划工具边界' }
    await delay(120)

    if (/\b(read|file|文件|目录|项目)\b/i.test(input.text)) {
      const toolCallId = `tool-${Date.now().toString(36)}`
      const requestId = `perm-${Date.now().toString(36)}`
      const toolInput = { path: process.cwd() }

      yield {
        type: 'tool_planning',
        runId,
        toolCallId,
        name: 'read',
        input: toolInput,
      }
      yield {
        type: 'permission_request',
        runId,
        requestId,
        toolCallId,
        tool: 'read',
        input: toolInput,
      }

      await this.waitForPermission(requestId)

      yield {
        type: 'tool_start',
        runId,
        toolCallId,
        name: 'read',
        input: toolInput,
      }
      await delay(160)
      yield {
        type: 'tool_update',
        runId,
        toolCallId,
        message: '已读取工作区摘要',
      }
      await delay(120)
      yield {
        type: 'tool_end',
        runId,
        toolCallId,
        ok: true,
        summary: 'mock read completed',
      }
    }

    const chunks = [
      '这是 Praxis 前端壳的事件流演示。',
      ' 现在 UI 只消费后端事件，',
      '后面可以把 mock bridge 换成 TS core 或 Rust/JSON-RPC。',
    ]
    for (const text of chunks) {
      await delay(90)
      yield { type: 'text_delta', runId, text }
    }

    yield {
      type: 'message_committed',
      runId,
      messageId: `msg-${Date.now().toString(36)}`,
    }
    yield {
      type: 'prompt_completed',
      runId,
      usage: { inputTokens: 128, outputTokens: 64 },
    }
  }

  followUp(input: PromptInput): AsyncIterable<SessionEvent> {
    return this.prompt(input)
  }

  async steer(_input: {
    sessionId: string
    runId: string
    text: string
  }): Promise<{ accepted: boolean; applyAt: 'next_safe_boundary' }> {
    return { accepted: true, applyAt: 'next_safe_boundary' }
  }

  async decidePermission(requestId: string, decision: PermissionDecision): Promise<void> {
    this.permissionDecisions.set(requestId, decision)
  }

  async abort(_runId: string): Promise<void> {
    // The mock bridge has no long-running backend task to cancel yet.
  }

  async dispose(): Promise<void> {
    this.permissionDecisions.clear()
  }

  private async waitForPermission(requestId: string): Promise<void> {
    for (;;) {
      const decision = this.permissionDecisions.get(requestId)
      if (decision) {
        if (decision.type === 'deny') {
          throw new Error(decision.reason ?? 'Permission denied')
        }
        return
      }
      await delay(50)
    }
  }
}

function mockWorkspaceId(workspace: string): string {
  return `workspace:${commandSourceDigestV1(workspace).slice('sha256:'.length, 39)}`
}

function mockAction(
  action: string,
  payload: Readonly<Record<string, CommandJsonValueV1>>,
): CommandInvokeOutputV1 {
  return Object.freeze({ kind: 'ui_action', action, payload: Object.freeze({ ...payload }) })
}

function mockJson(value: unknown): CommandJsonValueV1 {
  return JSON.parse(JSON.stringify(value)) as CommandJsonValueV1
}
