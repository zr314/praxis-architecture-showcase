import type { PluginGrant } from './index.js'

export const PROCESS_PLUGIN_PROTOCOL_VERSION = 1 as const
export const PROCESS_PLUGIN_EVENT_TYPES = ['progress', 'output', 'diagnostic'] as const

export type ProcessPluginEventType = (typeof PROCESS_PLUGIN_EVENT_TYPES)[number]
export type ProcessPluginCapabilityKind = 'tool' | 'provider'
export type ProcessPluginCancellationReason =
  | 'user_abort'
  | 'deadline_exceeded'
  | 'budget_exhausted'
  | 'parent_cancelled'
  | 'plugin_failure'
  | 'runtime_shutdown'

export type ProcessProviderCapabilities = {
  streaming: { text: boolean; reasoning: boolean; usage: boolean }
  tools: { mode: 'none' | 'native' | 'emulated'; parallelCalls: boolean }
  modalities: { text: boolean; vision: boolean; audio: boolean }
  output: { jsonSchema: boolean; citations: boolean }
  limits: { maxContextTokens?: number; maxOutputTokens?: number }
}

export type ProcessPluginRuntimeManifest = {
  id: string
  version: string
  apiVersion: 1
  isolation: 'process'
  capabilities: ProcessPluginCapabilityKind[]
}

export type ProcessPluginToolCapabilityManifest = {
  id: string
  kind: 'tool'
  inputSchema: Record<string, unknown>
  outputSchema: Record<string, unknown>
  execution: {
    sideEffect: 'none' | 'read' | 'write' | 'process' | 'network'
    target: { kind: 'none' } | { kind: 'workspace' } | { kind: 'input_path'; field: string }
    parallelSafe: boolean
    conflictScope: 'target' | 'workspace' | 'global'
    maxInlineBytes: number
    timeoutMs?: number
  }
}

export type ProcessPluginProviderCapabilityManifest = {
  id: string
  kind: 'provider'
  inputSchema: Record<string, unknown>
  outputSchema: Record<string, unknown>
  provider: {
    defaultModel: string
    capabilities: ProcessProviderCapabilities
  }
}

export type ProcessPluginCapabilityManifest =
  | ProcessPluginToolCapabilityManifest
  | ProcessPluginProviderCapabilityManifest

export type ProcessPluginInitializeRequest = {
  jsonrpc: '2.0'
  id: string
  method: 'initialize'
  params: {
    protocolVersion: 1
    runtimeApiVersion: 1
    requestedPluginId: string
    grants: PluginGrant[]
    workspace: string
    deadlineAt?: string
  }
}

export type ProcessPluginInvokeRequest = {
  jsonrpc: '2.0'
  id: string
  method: 'capability.invoke'
  params: {
    invocationId: string
    capabilityId: string
    input: unknown
    cancellationId: string
    budget?: Record<string, unknown>
  }
}

export type ProcessPluginCancelRequest = {
  jsonrpc: '2.0'
  id: string
  method: 'capability.cancel'
  params: { invocationId: string; reason: ProcessPluginCancellationReason }
}

export type ProcessPluginPingRequest = {
  jsonrpc: '2.0'
  id: string
  method: 'health.ping'
  params: { nonce: string }
}

export type ProcessPluginShutdownRequest = {
  jsonrpc: '2.0'
  id: string
  method: 'shutdown'
  params: Record<never, never>
}

export type ProcessPluginRequest =
  | ProcessPluginInitializeRequest
  | ProcessPluginInvokeRequest
  | ProcessPluginCancelRequest
  | ProcessPluginPingRequest
  | ProcessPluginShutdownRequest

export type ProcessPluginEvent = {
  jsonrpc: '2.0'
  method: 'event'
  params: { invocationId: string; type: ProcessPluginEventType; payload: Record<string, unknown> }
}

export type ProcessPluginInitializeResult = {
  manifest: ProcessPluginRuntimeManifest
  capabilities: ProcessPluginCapabilityManifest[]
}

export type ProcessPluginInvokeResult = { invocationId: string; output: unknown }
export type ProcessPluginCancelResult = { invocationId: string; accepted: true }
export type ProcessPluginPingResult = { nonce: string }
export type ProcessPluginShutdownResult = { accepted: true }

export type ProcessPluginError = {
  code: string
  category:
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
  message: string
  retryable: boolean
  data?: Record<string, unknown>
}

export type ProcessPluginSuccess = {
  jsonrpc: '2.0'
  id: string
  result:
    | ProcessPluginInitializeResult
    | ProcessPluginInvokeResult
    | ProcessPluginCancelResult
    | ProcessPluginPingResult
    | ProcessPluginShutdownResult
}

export type ProcessPluginFailure = {
  jsonrpc: '2.0'
  id: string
  error: ProcessPluginError
}

export type ProcessPluginResponse = ProcessPluginSuccess | ProcessPluginFailure
export type ProcessPluginMessage = ProcessPluginRequest | ProcessPluginEvent | ProcessPluginResponse
