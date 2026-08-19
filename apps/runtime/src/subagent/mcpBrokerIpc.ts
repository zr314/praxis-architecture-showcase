import { createHash } from 'node:crypto'
import type { Serializable } from 'node:child_process'
import { resolve } from 'node:path'
import {
  isRuntimeError,
  runtimeError,
  type RuntimeTool,
  type ToolDefinition,
  type ToolRequest,
  type ToolResult,
} from '@praxis/core-sdk'
import type { ProcessIpcController } from '../process/ndjsonProcessConnection.js'
import { digestToolDefinition, type McpToolGrant } from './childCapabilityBundle.js'

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/
const MAX_REQUEST_BYTES = 64 * 1024
const MAX_RESULT_BYTES = 64 * 1024
const MAX_JSON_DEPTH = 20
const MAX_JSON_NODES = 2_048

export type ChildMcpBrokerFailureCode =
  | 'CHILD_MCP_INVALID'
  | 'CHILD_MCP_UNAUTHORIZED'
  | 'CHILD_MCP_SERVER_UNHEALTHY'
  | 'CHILD_MCP_SCHEMA_DRIFT'
  | 'CHILD_MCP_CANCELLED'
  | 'CHILD_MCP_OUTPUT_OVERSIZED'
  | 'CHILD_MCP_SERVER_FAILED'

export type ChildMcpBrokerInvocation = Readonly<{
  parentRunId: string
  childRunId: string
  workspace: string
  bundleId: string
  bundleDigest: string
  grant: McpToolGrant
  input: Readonly<Record<string, unknown>>
  signal: AbortSignal
}>

export type ChildMcpBrokerPort = Readonly<{
  invoke(input: ChildMcpBrokerInvocation): Promise<ToolResult>
}>

export type ChildMcpBrokerCapability = Readonly<{
  grant: McpToolGrant
  tool: RuntimeTool
  sourceSurfaceDigest: `sha256:${string}`
  health: 'healthy' | 'unhealthy'
  authority: Readonly<{
    parentRunId: string
    childRunId: string
    workspace: string
    bundleId: string
    bundleDigest: string
  }>
}>

/** Captures the live parent Tool surface independently from its child-safe execution descriptor. */
export function bindChildMcpBrokerCapability(
  grant: McpToolGrant,
  tool: RuntimeTool,
  authority: ChildMcpBrokerCapability['authority'],
  health: ChildMcpBrokerCapability['health'] = 'healthy',
): ChildMcpBrokerCapability {
  return Object.freeze({
    grant,
    tool,
    sourceSurfaceDigest: digestMcpToolSurface(tool.definition),
    health,
    authority: Object.freeze({ ...authority, workspace: resolve(authority.workspace) }),
  })
}

/** Digest of the MCP-published contract; parent-only process metadata is intentionally excluded. */
export function digestMcpToolSurface(definition: ToolDefinition): `sha256:${string}` {
  return `sha256:${createHash('sha256')
    .update(
      canonicalJson({
        name: definition.name,
        description: definition.description,
        parameters: definition.parameters,
        ...(definition.outputSchema === undefined ? {} : { outputSchema: definition.outputSchema }),
      }),
    )
    .digest('hex')}`
}

/** Parent-owned broker that maps an opaque signed grant onto one live MCP Tool capability. */
export class ChildMcpToolBroker implements ChildMcpBrokerPort {
  constructor(
    private readonly resolveCapability: (
      brokerCapabilityId: string,
    ) => ChildMcpBrokerCapability | undefined,
  ) {}

  async invoke(input: ChildMcpBrokerInvocation): Promise<ToolResult> {
    if (input.signal.aborted) throw brokerFailure('CHILD_MCP_CANCELLED')
    const capability = this.resolveCapability(input.grant.brokerCapabilityId)
    if (capability === undefined) throw brokerFailure('CHILD_MCP_UNAUTHORIZED')
    if (
      capability.authority.parentRunId !== input.parentRunId ||
      capability.authority.childRunId !== input.childRunId ||
      capability.authority.workspace !== resolve(input.workspace) ||
      capability.authority.bundleId !== input.bundleId ||
      capability.authority.bundleDigest !== input.bundleDigest
    ) {
      throw brokerFailure('CHILD_MCP_UNAUTHORIZED')
    }
    if (capability.health !== 'healthy') throw brokerFailure('CHILD_MCP_SERVER_UNHEALTHY')
    assertCapabilityMatches(input.grant, capability)

    const request: ToolRequest = {
      name: capability.tool.definition.name,
      input: cloneJsonRecord(input.input, MAX_REQUEST_BYTES),
      cwd: resolve(input.workspace),
      signal: input.signal,
    }
    try {
      const result = await abortable(capability.tool.execute(request), input.signal)
      return validateToolResult(result, input.grant)
    } catch (error) {
      if (isChildMcpBrokerFailure(error)) throw error
      throw brokerFailure('CHILD_MCP_SERVER_FAILED')
    }
  }
}

type BrokerInvokeMessage = Readonly<{
  schemaVersion: 1
  type: 'mcp_broker.invoke'
  requestId: string
  tool: string
  input: Readonly<Record<string, unknown>>
}>

type BrokerCancelMessage = Readonly<{
  schemaVersion: 1
  type: 'mcp_broker.cancel'
  requestId: string
}>

type BrokerChildMessage = BrokerInvokeMessage | BrokerCancelMessage

type BrokerParentMessage =
  | Readonly<{
      schemaVersion: 1
      type: 'mcp_broker.result'
      requestId: string
      result: ToolResult
    }>
  | Readonly<{
      schemaVersion: 1
      type: 'mcp_broker.failed'
      requestId: string
      errorCode: ChildMcpBrokerFailureCode
    }>

type ChildIpcProcess = Pick<NodeJS.Process, 'connected' | 'send' | 'on' | 'off'>

/** Parent endpoint. Child messages identify a granted name, never a live Tool object. */
export class ChildMcpBrokerIpcServer implements ProcessIpcController {
  readonly #active = new Map<string, AbortController>()
  readonly #grants = new Map<string, McpToolGrant>()
  #send?: (message: Serializable) => Promise<void>
  #closed = false

  constructor(
    private readonly options: Readonly<{
      broker?: ChildMcpBrokerPort
      parentRunId: string
      childRunId: string
      workspace: string
      bundleId: string
      bundleDigest: string
      grants: readonly McpToolGrant[]
    }>,
  ) {
    for (const grant of options.grants) this.#grants.set(grant.name, grant)
  }

  attach(send: (message: Serializable) => Promise<void>): void {
    if (this.#send !== undefined || this.#closed) throw brokerFailure('CHILD_MCP_INVALID')
    this.#send = send
  }

  receive(message: unknown): void {
    if (this.#closed || !messageType(message)?.startsWith('mcp_broker.')) return
    let parsed: BrokerChildMessage
    try {
      parsed = validateChildMessage(message)
    } catch {
      this.close()
      return
    }
    if (parsed.type === 'mcp_broker.cancel') {
      this.#active.get(parsed.requestId)?.abort()
      return
    }
    void this.#invoke(parsed)
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    for (const controller of this.#active.values()) controller.abort()
    this.#active.clear()
  }

  async #invoke(message: BrokerInvokeMessage): Promise<void> {
    if (this.#active.has(message.requestId)) {
      await this.#failed(message.requestId, 'CHILD_MCP_INVALID')
      return
    }
    const controller = new AbortController()
    this.#active.set(message.requestId, controller)
    try {
      const grant = this.#grants.get(message.tool)
      if (grant === undefined || this.options.broker === undefined) {
        throw brokerFailure('CHILD_MCP_UNAUTHORIZED')
      }
      const result = await this.options.broker.invoke({
        parentRunId: this.options.parentRunId,
        childRunId: this.options.childRunId,
        workspace: this.options.workspace,
        bundleId: this.options.bundleId,
        bundleDigest: this.options.bundleDigest,
        grant,
        input: message.input,
        signal: controller.signal,
      })
      await this.#write({
        schemaVersion: 1,
        type: 'mcp_broker.result',
        requestId: message.requestId,
        result: validateToolResult(result, grant),
      })
    } catch (error) {
      await this.#failed(
        message.requestId,
        isChildMcpBrokerFailure(error) ? error.code : 'CHILD_MCP_SERVER_FAILED',
      )
    } finally {
      this.#active.delete(message.requestId)
    }
  }

  async #failed(requestId: string, errorCode: ChildMcpBrokerFailureCode): Promise<void> {
    try {
      await this.#write({
        schemaVersion: 1,
        type: 'mcp_broker.failed',
        requestId,
        errorCode,
      })
    } catch {
      this.close()
    }
  }

  async #write(message: BrokerParentMessage): Promise<void> {
    if (this.#closed || this.#send === undefined) throw brokerFailure('CHILD_MCP_CANCELLED')
    if (jsonBytes(message) > MAX_RESULT_BYTES) {
      throw brokerFailure('CHILD_MCP_OUTPUT_OVERSIZED')
    }
    await this.#send(message)
  }
}

/** Child endpoint shared by the proxy Runtime Tools realized from the signed bundle. */
export class ChildMcpBrokerIpcClient {
  readonly #active = new Map<
    string,
    { resolve(result: ToolResult): void; reject(error: unknown): void }
  >()
  readonly #onMessage = (message: unknown) => this.#receive(message)
  #nextRequestId = 1
  #closed = false

  constructor(private readonly childProcess: ChildIpcProcess = process) {
    childProcess.on('message', this.#onMessage)
  }

  invoke(
    grant: McpToolGrant,
    input: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    if (!this.#available()) return Promise.reject(brokerFailure('CHILD_MCP_UNAUTHORIZED'))
    if (signal.aborted) return Promise.reject(brokerFailure('CHILD_MCP_CANCELLED'))
    const requestId = `mcp-${this.#nextRequestId++}`
    return new Promise<ToolResult>((resolveResult, rejectResult) => {
      const abort = () => {
        void this.#send({ schemaVersion: 1, type: 'mcp_broker.cancel', requestId }).catch(
          () => undefined,
        )
        rejectResult(brokerFailure('CHILD_MCP_CANCELLED'))
        this.#active.delete(requestId)
      }
      const resolve = (result: ToolResult) => {
        signal.removeEventListener('abort', abort)
        resolveResult(result)
      }
      const reject = (error: unknown) => {
        signal.removeEventListener('abort', abort)
        rejectResult(error)
      }
      this.#active.set(requestId, { resolve, reject })
      signal.addEventListener('abort', abort, { once: true })
      void this.#send({
        schemaVersion: 1,
        type: 'mcp_broker.invoke',
        requestId,
        tool: grant.name,
        input: cloneJsonRecord(input, MAX_REQUEST_BYTES),
      }).catch((error) => {
        this.#active.delete(requestId)
        reject(error)
      })
    })
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.childProcess.off('message', this.#onMessage)
    const failure = brokerFailure('CHILD_MCP_CANCELLED')
    for (const record of this.#active.values()) record.reject(failure)
    this.#active.clear()
  }

  #available(): boolean {
    return (
      !this.#closed && this.childProcess.connected === true && this.childProcess.send !== undefined
    )
  }

  #receive(message: unknown): void {
    if (this.#closed || !messageType(message)?.startsWith('mcp_broker.')) return
    let parsed: BrokerParentMessage
    try {
      parsed = validateParentMessage(message)
    } catch {
      this.#failAll(brokerFailure('CHILD_MCP_INVALID'))
      return
    }
    const record = this.#active.get(parsed.requestId)
    if (record === undefined) return
    this.#active.delete(parsed.requestId)
    if (parsed.type === 'mcp_broker.result') record.resolve(parsed.result)
    else record.reject(brokerFailure(parsed.errorCode))
  }

  #send(message: BrokerChildMessage): Promise<void> {
    if (!this.#available() || this.childProcess.send === undefined) {
      return Promise.reject(brokerFailure('CHILD_MCP_UNAUTHORIZED'))
    }
    if (jsonBytes(message) > MAX_REQUEST_BYTES) {
      return Promise.reject(brokerFailure('CHILD_MCP_INVALID'))
    }
    try {
      this.childProcess.send(message)
      return Promise.resolve()
    } catch {
      return Promise.reject(brokerFailure('CHILD_MCP_CANCELLED'))
    }
  }

  #failAll(error: unknown): void {
    for (const record of this.#active.values()) record.reject(error)
    this.#active.clear()
  }
}

export class ChildMcpBrokerTool implements RuntimeTool {
  readonly definition: ToolDefinition

  constructor(
    private readonly grant: McpToolGrant,
    private readonly client: ChildMcpBrokerIpcClient,
  ) {
    this.definition = structuredClone(grant.definition)
  }

  execute(request: ToolRequest): Promise<ToolResult> {
    return this.client.invoke(this.grant, request.input, request.signal)
  }
}

function assertCapabilityMatches(
  requested: McpToolGrant,
  capability: ChildMcpBrokerCapability,
): void {
  const execution = requested.definition.execution
  if (
    requested.brokerCapabilityId !== capability.grant.brokerCapabilityId ||
    requested.name !== capability.grant.name ||
    requested.definitionDigest !== capability.grant.definitionDigest ||
    requested.definitionDigest !== digestToolDefinition(requested.definition) ||
    capability.grant.definitionDigest !== digestToolDefinition(capability.grant.definition) ||
    execution === undefined ||
    (execution.sideEffect !== 'none' && execution.sideEffect !== 'read') ||
    digestMcpToolSurface(requested.definition) !== capability.sourceSurfaceDigest ||
    digestMcpToolSurface(capability.tool.definition) !== capability.sourceSurfaceDigest
  ) {
    throw brokerFailure('CHILD_MCP_SCHEMA_DRIFT')
  }
}

function validateChildMessage(value: unknown): BrokerChildMessage {
  if (jsonBytes(value) > MAX_REQUEST_BYTES || !isRecord(value)) {
    throw brokerFailure('CHILD_MCP_INVALID')
  }
  if (
    value.type === 'mcp_broker.cancel' &&
    exactKeys(value, ['schemaVersion', 'type', 'requestId']) &&
    value.schemaVersion === 1 &&
    safeId(value.requestId)
  ) {
    return value as BrokerCancelMessage
  }
  if (
    value.type === 'mcp_broker.invoke' &&
    exactKeys(value, ['schemaVersion', 'type', 'requestId', 'tool', 'input']) &&
    value.schemaVersion === 1 &&
    safeId(value.requestId) &&
    safeId(value.tool)
  ) {
    return {
      schemaVersion: 1,
      type: 'mcp_broker.invoke',
      requestId: value.requestId,
      tool: value.tool,
      input: cloneJsonRecord(value.input, MAX_REQUEST_BYTES),
    }
  }
  throw brokerFailure('CHILD_MCP_INVALID')
}

function validateParentMessage(value: unknown): BrokerParentMessage {
  if (jsonBytes(value) > MAX_RESULT_BYTES || !isRecord(value)) {
    throw brokerFailure('CHILD_MCP_INVALID')
  }
  if (
    value.type === 'mcp_broker.failed' &&
    exactKeys(value, ['schemaVersion', 'type', 'requestId', 'errorCode']) &&
    value.schemaVersion === 1 &&
    safeId(value.requestId) &&
    isFailureCode(value.errorCode)
  ) {
    return value as BrokerParentMessage
  }
  if (
    value.type === 'mcp_broker.result' &&
    exactKeys(value, ['schemaVersion', 'type', 'requestId', 'result']) &&
    value.schemaVersion === 1 &&
    safeId(value.requestId)
  ) {
    return {
      schemaVersion: 1,
      type: 'mcp_broker.result',
      requestId: value.requestId,
      result: validateLooseToolResult(value.result),
    }
  }
  throw brokerFailure('CHILD_MCP_INVALID')
}

function validateToolResult(value: unknown, grant: McpToolGrant): ToolResult {
  const result = validateLooseToolResult(value)
  const maxInlineBytes = grant.definition.execution?.maxInlineBytes ?? MAX_RESULT_BYTES
  if (jsonBytes(result) > Math.min(MAX_RESULT_BYTES, maxInlineBytes)) {
    throw brokerFailure('CHILD_MCP_OUTPUT_OVERSIZED')
  }
  return result
}

function validateLooseToolResult(value: unknown): ToolResult {
  if (!isRecord(value) || typeof value.ok !== 'boolean' || typeof value.summary !== 'string') {
    throw brokerFailure('CHILD_MCP_SERVER_FAILED')
  }
  if (Buffer.byteLength(value.summary, 'utf8') > 4_096) {
    throw brokerFailure('CHILD_MCP_OUTPUT_OVERSIZED')
  }
  const result: ToolResult = { ok: value.ok, summary: value.summary }
  if (Object.hasOwn(value, 'output')) result.output = cloneJson(value.output)
  if (value.artifacts !== undefined) {
    if (!Array.isArray(value.artifacts) || value.artifacts.length > 32) {
      throw brokerFailure('CHILD_MCP_SERVER_FAILED')
    }
    result.artifacts = value.artifacts.map((artifact) => {
      if (
        !isRecord(artifact) ||
        typeof artifact.artifactId !== 'string' ||
        typeof artifact.digest !== 'string' ||
        typeof artifact.mimeType !== 'string' ||
        !Number.isSafeInteger(artifact.bytes) ||
        (artifact.bytes as number) < 0
      ) {
        throw brokerFailure('CHILD_MCP_SERVER_FAILED')
      }
      return {
        artifactId: artifact.artifactId,
        digest: artifact.digest,
        mimeType: artifact.mimeType,
        bytes: artifact.bytes as number,
      }
    })
  }
  if (value.error !== undefined) {
    if (
      !isRecord(value.error) ||
      typeof value.error.code !== 'string' ||
      !['validation', 'permission', 'not_found', 'execution', 'truncated'].includes(
        String(value.error.category),
      ) ||
      typeof value.error.retryable !== 'boolean'
    ) {
      throw brokerFailure('CHILD_MCP_SERVER_FAILED')
    }
    result.error = {
      code: value.error.code,
      category: value.error.category as NonNullable<ToolResult['error']>['category'],
      retryable: value.error.retryable,
    }
  }
  return result
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(brokerFailure('CHILD_MCP_CANCELLED'))
  return new Promise<T>((resolveResult, rejectResult) => {
    const abort = () => rejectResult(brokerFailure('CHILD_MCP_CANCELLED'))
    signal.addEventListener('abort', abort, { once: true })
    operation.then(
      (value) => {
        signal.removeEventListener('abort', abort)
        resolveResult(value)
      },
      (error) => {
        signal.removeEventListener('abort', abort)
        rejectResult(error)
      },
    )
  })
}

function brokerFailure(code: ChildMcpBrokerFailureCode) {
  return runtimeError(code, 'subagent', 'Child MCP broker request failed.')
}

function isChildMcpBrokerFailure(
  value: unknown,
): value is ReturnType<typeof brokerFailure> & { code: ChildMcpBrokerFailureCode } {
  return isRuntimeError(value) && isFailureCode(value.code)
}

function isFailureCode(value: unknown): value is ChildMcpBrokerFailureCode {
  return (
    typeof value === 'string' &&
    [
      'CHILD_MCP_INVALID',
      'CHILD_MCP_UNAUTHORIZED',
      'CHILD_MCP_SERVER_UNHEALTHY',
      'CHILD_MCP_SCHEMA_DRIFT',
      'CHILD_MCP_CANCELLED',
      'CHILD_MCP_OUTPUT_OVERSIZED',
      'CHILD_MCP_SERVER_FAILED',
    ].includes(value)
  )
}

function cloneJsonRecord(value: unknown, maxBytes: number): Record<string, unknown> {
  if (!isRecord(value)) throw brokerFailure('CHILD_MCP_INVALID')
  const cloned = cloneJson(value)
  if (!isRecord(cloned) || jsonBytes(cloned) > maxBytes) throw brokerFailure('CHILD_MCP_INVALID')
  return cloned
}

function cloneJson(value: unknown): unknown {
  const state = { nodes: 0 }
  return cloneJsonValue(value, 0, state)
}

function cloneJsonValue(value: unknown, depth: number, state: { nodes: number }): unknown {
  state.nodes += 1
  if (depth > MAX_JSON_DEPTH || state.nodes > MAX_JSON_NODES) {
    throw brokerFailure('CHILD_MCP_INVALID')
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map((entry) => cloneJsonValue(entry, depth + 1, state))
  if (!isRecord(value)) throw brokerFailure('CHILD_MCP_INVALID')
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, cloneJsonValue(entry, depth + 1, state)]),
  )
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  )
}

function jsonBytes(value: unknown): number {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) throw brokerFailure('CHILD_MCP_INVALID')
  return Buffer.byteLength(serialized, 'utf8')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function messageType(value: unknown): string | undefined {
  return isRecord(value) && typeof value.type === 'string' ? value.type : undefined
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

function safeId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_ID.test(value)
}
