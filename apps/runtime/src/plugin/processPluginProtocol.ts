import {
  isPluginGrantArray,
  PROCESS_PLUGIN_EVENT_TYPES,
  PROCESS_PLUGIN_PROTOCOL_VERSION,
  type ProcessPluginCancellationReason,
  type ProcessPluginCancelRequest,
  type ProcessPluginCancelResult,
  type ProcessPluginCapabilityKind,
  type ProcessPluginCapabilityManifest,
  type ProcessPluginError,
  type ProcessPluginEvent,
  type ProcessPluginEventType,
  type ProcessPluginInitializeRequest,
  type ProcessPluginInitializeResult,
  type ProcessPluginInvokeRequest,
  type ProcessPluginInvokeResult,
  type ProcessPluginMessage,
  type ProcessPluginPingRequest,
  type ProcessPluginPingResult,
  type ProcessPluginProviderCapabilityManifest,
  type ProcessPluginRequest,
  type ProcessPluginResponse,
  type ProcessPluginRuntimeManifest,
  type ProcessPluginShutdownResult,
  type ProcessPluginSuccess,
  type ProcessPluginToolCapabilityManifest,
  type ProcessProviderCapabilities,
} from '@praxis/plugin-protocol'

export {
  PROCESS_PLUGIN_EVENT_TYPES,
  PROCESS_PLUGIN_PROTOCOL_VERSION,
  type ProcessPluginCancellationReason,
  type ProcessPluginCancelRequest,
  type ProcessPluginCancelResult,
  type ProcessPluginCapabilityKind,
  type ProcessPluginCapabilityManifest,
  type ProcessPluginError,
  type ProcessPluginEvent,
  type ProcessPluginEventType,
  type ProcessPluginInitializeRequest,
  type ProcessPluginInitializeResult,
  type ProcessPluginInvokeRequest,
  type ProcessPluginInvokeResult,
  type ProcessPluginMessage,
  type ProcessPluginPingRequest,
  type ProcessPluginPingResult,
  type ProcessPluginProviderCapabilityManifest,
  type ProcessPluginRequest,
  type ProcessPluginResponse,
  type ProcessPluginRuntimeManifest,
  type ProcessPluginShutdownRequest,
  type ProcessPluginShutdownResult,
  type ProcessPluginSuccess,
  type ProcessPluginToolCapabilityManifest,
  type ProcessProviderCapabilities,
} from '@praxis/plugin-protocol'

const cancellationReasons: readonly ProcessPluginCancellationReason[] = [
  'user_abort',
  'deadline_exceeded',
  'budget_exhausted',
  'parent_cancelled',
  'plugin_failure',
  'runtime_shutdown',
]

const errorCategories = [
  'protocol',
  'configuration',
  'provider',
  'tool',
  'permission',
  'plugin',
  'planner',
  'subagent',
  'persistence',
  'cancelled',
] as const

export function isProcessPluginMessage(value: unknown): value is ProcessPluginMessage {
  return (
    isProcessPluginRequest(value) || isProcessPluginEvent(value) || isProcessPluginResponse(value)
  )
}

export function isProcessPluginRequest(value: unknown): value is ProcessPluginRequest {
  if (
    !isRecord(value) ||
    value.jsonrpc !== '2.0' ||
    !isNonBlankString(value.id) ||
    !isNonBlankString(value.method)
  ) {
    return false
  }
  switch (value.method) {
    case 'initialize':
      return (
        isExactRecord(value, ['jsonrpc', 'id', 'method', 'params']) &&
        isInitializeParams(value.params)
      )
    case 'capability.invoke':
      return (
        isExactRecord(value, ['jsonrpc', 'id', 'method', 'params']) && isInvokeParams(value.params)
      )
    case 'capability.cancel':
      return (
        isExactRecord(value, ['jsonrpc', 'id', 'method', 'params']) && isCancelParams(value.params)
      )
    case 'health.ping':
      return (
        isExactRecord(value, ['jsonrpc', 'id', 'method', 'params']) && isPingParams(value.params)
      )
    case 'shutdown':
      return (
        isExactRecord(value, ['jsonrpc', 'id', 'method', 'params']) &&
        isExactRecord(value.params, [])
      )
    default:
      return false
  }
}

export function isProcessPluginEvent(value: unknown): value is ProcessPluginEvent {
  return (
    isRecord(value) &&
    value.jsonrpc === '2.0' &&
    value.method === 'event' &&
    isExactRecord(value, ['jsonrpc', 'method', 'params']) &&
    isEventParams(value.params)
  )
}

export function isProcessPluginResponse(value: unknown): value is ProcessPluginResponse {
  if (!isRecord(value) || value.jsonrpc !== '2.0' || !isNonBlankString(value.id)) return false
  if (Object.hasOwn(value, 'result')) {
    return isExactRecord(value, ['jsonrpc', 'id', 'result']) && isSuccessResult(value.result)
  }
  return (
    Object.hasOwn(value, 'error') &&
    isExactRecord(value, ['jsonrpc', 'id', 'error']) &&
    isRuntimeError(value.error)
  )
}

/**
 * Validates a response in the context of the original request. The optional
 * declared capabilities let a host reject an invoke response for an undeclared
 * capability after a successful initialize handshake.
 */
export function isProcessPluginResponseFor(
  request: unknown,
  response: unknown,
  declaredCapabilities?: readonly ProcessPluginCapabilityManifest[],
): boolean {
  if (
    !isProcessPluginRequest(request) ||
    !isProcessPluginResponse(response) ||
    request.id !== response.id
  )
    return false
  if ('error' in response) return true
  switch (request.method) {
    case 'initialize':
      return (
        isInitializeResult(response.result) &&
        response.result.manifest.id === request.params.requestedPluginId
      )
    case 'capability.invoke':
      return (
        isInvokeResult(response.result) &&
        response.result.invocationId === request.params.invocationId &&
        (declaredCapabilities === undefined ||
          declaredCapabilities.some((capability) => capability.id === request.params.capabilityId))
      )
    case 'capability.cancel':
      return (
        isCancelResult(response.result) &&
        response.result.invocationId === request.params.invocationId
      )
    case 'health.ping':
      return isPingResult(response.result) && response.result.nonce === request.params.nonce
    case 'shutdown':
      return isShutdownResult(response.result)
  }
}

function isInitializeParams(value: unknown): value is ProcessPluginInitializeRequest['params'] {
  return (
    isRecord(value) &&
    isExactRecord(
      value,
      value.deadlineAt === undefined
        ? ['protocolVersion', 'runtimeApiVersion', 'requestedPluginId', 'grants', 'workspace']
        : [
            'protocolVersion',
            'runtimeApiVersion',
            'requestedPluginId',
            'grants',
            'workspace',
            'deadlineAt',
          ],
    ) &&
    value.protocolVersion === PROCESS_PLUGIN_PROTOCOL_VERSION &&
    value.runtimeApiVersion === 1 &&
    isNonBlankString(value.requestedPluginId) &&
    isPluginGrantArray(value.grants) &&
    isNonBlankString(value.workspace) &&
    (value.deadlineAt === undefined || isNonBlankString(value.deadlineAt))
  )
}

function isInvokeParams(value: unknown): value is ProcessPluginInvokeRequest['params'] {
  return (
    isRecord(value) &&
    isExactRecord(
      value,
      value.budget === undefined
        ? ['invocationId', 'capabilityId', 'input', 'cancellationId']
        : ['invocationId', 'capabilityId', 'input', 'cancellationId', 'budget'],
    ) &&
    isNonBlankString(value.invocationId) &&
    isNonBlankString(value.capabilityId) &&
    Object.hasOwn(value, 'input') &&
    isNonBlankString(value.cancellationId) &&
    (value.budget === undefined || isRecord(value.budget))
  )
}

function isCancelParams(value: unknown): value is ProcessPluginCancelRequest['params'] {
  return (
    isRecord(value) &&
    isExactRecord(value, ['invocationId', 'reason']) &&
    isNonBlankString(value.invocationId) &&
    isCancellationReason(value.reason)
  )
}

function isPingParams(value: unknown): value is ProcessPluginPingRequest['params'] {
  return isRecord(value) && isExactRecord(value, ['nonce']) && isNonBlankString(value.nonce)
}

function isEventParams(value: unknown): value is ProcessPluginEvent['params'] {
  return (
    isRecord(value) &&
    isExactRecord(value, ['invocationId', 'type', 'payload']) &&
    isNonBlankString(value.invocationId) &&
    isEventType(value.type) &&
    isRecord(value.payload)
  )
}

function isSuccessResult(value: unknown): value is ProcessPluginSuccess['result'] {
  return (
    isInitializeResult(value) ||
    isInvokeResult(value) ||
    isCancelResult(value) ||
    isPingResult(value) ||
    isShutdownResult(value)
  )
}

function isInitializeResult(value: unknown): value is ProcessPluginInitializeResult {
  if (!isRecord(value) || !isExactRecord(value, ['manifest', 'capabilities'])) return false
  const manifest = value.manifest
  const capabilities = value.capabilities
  return (
    isPluginManifest(manifest) &&
    Array.isArray(capabilities) &&
    capabilities.every(isCapabilityManifest) &&
    capabilities.every((capability) => manifest.capabilities.includes(capability.kind)) &&
    new Set(capabilities.map((capability) => capability.id)).size === capabilities.length
  )
}

function isInvokeResult(value: unknown): value is ProcessPluginInvokeResult {
  return (
    isRecord(value) &&
    isExactRecord(value, ['invocationId', 'output']) &&
    isNonBlankString(value.invocationId) &&
    Object.hasOwn(value, 'output')
  )
}

function isCancelResult(value: unknown): value is ProcessPluginCancelResult {
  return (
    isRecord(value) &&
    isExactRecord(value, ['invocationId', 'accepted']) &&
    isNonBlankString(value.invocationId) &&
    value.accepted === true
  )
}

function isPingResult(value: unknown): value is ProcessPluginPingResult {
  return isRecord(value) && isExactRecord(value, ['nonce']) && isNonBlankString(value.nonce)
}

function isShutdownResult(value: unknown): value is ProcessPluginShutdownResult {
  return isRecord(value) && isExactRecord(value, ['accepted']) && value.accepted === true
}

function isPluginManifest(value: unknown): value is ProcessPluginRuntimeManifest {
  return (
    isRecord(value) &&
    isExactRecord(value, ['id', 'version', 'apiVersion', 'isolation', 'capabilities']) &&
    isNonBlankString(value.id) &&
    isNonBlankString(value.version) &&
    value.apiVersion === 1 &&
    value.isolation === 'process' &&
    Array.isArray(value.capabilities) &&
    value.capabilities.every(isCapabilityKind) &&
    new Set(value.capabilities).size === value.capabilities.length
  )
}

function isCapabilityManifest(value: unknown): value is ProcessPluginCapabilityManifest {
  if (!isRecord(value)) return false
  if (
    !isNonBlankString(value.id) ||
    !isBoundedSchema(value.inputSchema) ||
    !isBoundedSchema(value.outputSchema)
  ) {
    return false
  }
  if (value.kind === 'tool') {
    return (
      isExactRecord(value, ['id', 'kind', 'inputSchema', 'outputSchema', 'execution']) &&
      isToolExecution(value.execution)
    )
  }
  return (
    value.kind === 'provider' &&
    isExactRecord(value, ['id', 'kind', 'inputSchema', 'outputSchema', 'provider']) &&
    isProviderDescriptor(value.provider)
  )
}

function isRuntimeError(value: unknown): value is ProcessPluginError {
  if (!isRecord(value)) return false
  const keys =
    value.data === undefined
      ? ['code', 'category', 'message', 'retryable']
      : ['code', 'category', 'message', 'retryable', 'data']
  return (
    isExactRecord(value, keys) &&
    isNonBlankString(value.code) &&
    isErrorCategory(value.category) &&
    isNonBlankString(value.message) &&
    typeof value.retryable === 'boolean' &&
    (value.data === undefined || isRecord(value.data))
  )
}

function isCancellationReason(value: unknown): value is ProcessPluginCancellationReason {
  return (
    typeof value === 'string' &&
    cancellationReasons.includes(value as ProcessPluginCancellationReason)
  )
}

function isErrorCategory(value: unknown): boolean {
  return (
    typeof value === 'string' && errorCategories.includes(value as (typeof errorCategories)[number])
  )
}

function isEventType(value: unknown): value is ProcessPluginEventType {
  return (
    typeof value === 'string' &&
    PROCESS_PLUGIN_EVENT_TYPES.includes(value as ProcessPluginEventType)
  )
}

function isCapabilityKind(value: unknown): value is ProcessPluginCapabilityKind {
  return value === 'tool' || value === 'provider'
}

function isToolExecution(
  value: unknown,
): value is ProcessPluginToolCapabilityManifest['execution'] {
  if (!isRecord(value)) return false
  const keys =
    value.timeoutMs === undefined
      ? ['sideEffect', 'target', 'parallelSafe', 'conflictScope', 'maxInlineBytes']
      : ['sideEffect', 'target', 'parallelSafe', 'conflictScope', 'maxInlineBytes', 'timeoutMs']
  return (
    isExactRecord(value, keys) &&
    ['none', 'read', 'write', 'process', 'network'].includes(String(value.sideEffect)) &&
    isToolTarget(value.target) &&
    typeof value.parallelSafe === 'boolean' &&
    ['target', 'workspace', 'global'].includes(String(value.conflictScope)) &&
    isPositiveInteger(value.maxInlineBytes, 16 * 1024 * 1024) &&
    (value.timeoutMs === undefined ||
      (Number.isSafeInteger(value.timeoutMs) && Number(value.timeoutMs) >= 1))
  )
}

function isToolTarget(
  value: unknown,
): value is ProcessPluginToolCapabilityManifest['execution']['target'] {
  if (!isRecord(value) || typeof value.kind !== 'string') return false
  if (value.kind === 'none' || value.kind === 'workspace') {
    return isExactRecord(value, ['kind'])
  }
  return (
    value.kind === 'input_path' &&
    isExactRecord(value, ['kind', 'field']) &&
    isNonBlankString(value.field)
  )
}

function isProviderDescriptor(
  value: unknown,
): value is ProcessPluginProviderCapabilityManifest['provider'] {
  return (
    isRecord(value) &&
    isExactRecord(value, ['defaultModel', 'capabilities']) &&
    isNonBlankString(value.defaultModel) &&
    isProviderCapabilities(value.capabilities)
  )
}

function isProviderCapabilities(value: unknown): value is ProcessProviderCapabilities {
  return (
    isRecord(value) &&
    isExactRecord(value, ['streaming', 'tools', 'modalities', 'output', 'limits']) &&
    hasExactBooleans(value.streaming, ['text', 'reasoning', 'usage']) &&
    isRecord(value.tools) &&
    isExactRecord(value.tools, ['mode', 'parallelCalls']) &&
    ['none', 'native', 'emulated'].includes(String(value.tools.mode)) &&
    typeof value.tools.parallelCalls === 'boolean' &&
    hasExactBooleans(value.modalities, ['text', 'vision', 'audio']) &&
    hasExactBooleans(value.output, ['jsonSchema', 'citations']) &&
    isRecord(value.limits) &&
    Object.keys(value.limits).every((key) =>
      ['maxContextTokens', 'maxOutputTokens'].includes(key),
    ) &&
    (value.limits.maxContextTokens === undefined ||
      isPositiveInteger(value.limits.maxContextTokens, 10_000_000)) &&
    (value.limits.maxOutputTokens === undefined ||
      isPositiveInteger(value.limits.maxOutputTokens, 10_000_000))
  )
}

function hasExactBooleans(value: unknown, keys: readonly string[]): boolean {
  return (
    isRecord(value) &&
    isExactRecord(value, keys) &&
    keys.every((key) => typeof value[key] === 'boolean')
  )
}

function isPositiveInteger(value: unknown, maximum: number): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= maximum
}

function isBoundedSchema(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false
  try {
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 64 * 1024) return false
  } catch {
    return false
  }
  let nodes = 0
  const visit = (candidate: unknown, depth: number): boolean => {
    nodes += 1
    if (nodes > 2_048 || depth > 32) return false
    if (Array.isArray(candidate)) return candidate.every((item) => visit(item, depth + 1))
    if (!isRecord(candidate)) return true
    if (
      typeof candidate.$ref === 'string' &&
      candidate.$ref.length > 0 &&
      !candidate.$ref.startsWith('#')
    ) {
      return false
    }
    return Object.values(candidate).every((item) => visit(item, depth + 1))
  }
  return visit(value, 0)
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}
