import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  CallToolResultSchema,
  DiscoverResultSchema,
  InitializeResultSchema,
  ListToolsResultSchema,
  ProgressNotificationSchema,
} from '@modelcontextprotocol/core'
import {
  type RuntimeTool,
  runtimeError,
  type ToolProgressUpdate,
  type ToolResult,
} from '@praxis/core-sdk'
import { PRAXIS_PRODUCT_VERSION } from '@praxis/protocol'
import { type LongDurationTimer, scheduleLongDurationTimer } from '../longDurationTimer.js'
import { terminateProcessTree, waitForProcessExit } from '../process/processTree.js'

const MODERN_PROTOCOL_VERSION = '2026-07-28'
const LEGACY_PROTOCOL_VERSION = '2025-06-18'
const MODERN_META_PREFIX = 'io.modelcontextprotocol'
const MAX_TOOL_LIST_PAGES = 64
const MAX_PUBLISHED_TOOLS = 512
const MAX_DESCRIPTOR_TEXT_BYTES = 2_048
const MAX_SCHEMA_BYTES = 64 * 1024
const MAX_SCHEMA_DEPTH = 32
const MAX_SCHEMA_NODES = 2_048
const MAX_SETTLED_REQUEST_IDS = 1_024

export type McpStdioLaunch = {
  command: string
  args?: string[]
  cwd?: string
  environment?: Record<string, string>
  pluginId?: string
  serverId?: string
  requestTimeoutMs?: number
  maxLineBytes?: number
  maxStderrBytes?: number
  signal?: AbortSignal
}

export type McpToolDescriptor = {
  name: string
  title?: string
  description?: string
  inputSchema: Record<string, unknown>
  outputSchema?: Record<string, unknown>
}

type PendingRequest = {
  resolve(value: unknown): void
  reject(error: unknown): void
  timeout?: LongDurationTimer
  progressToken?: string
  onUpdate?: (update: ToolProgressUpdate) => void
}

/**
 * Deliberately narrow MCP client. Praxis exposes Tools only; Resources, Prompts,
 * Sampling, Roots, and server-initiated requests are rejected at the boundary.
 */
export class McpStdioClient {
  readonly #child: ChildProcessWithoutNullStreams
  readonly #pending = new Map<number, PendingRequest>()
  readonly #completedRequestIds = new Set<number>()
  readonly #cancelledRequestIds = new Set<number>()
  readonly #tools = new Map<string, McpToolDescriptor>()
  readonly #requestTimeoutMs?: number
  readonly #maxLineBytes: number
  readonly #maxStderrBytes: number
  readonly #pluginId: string
  readonly #serverId: string
  #counter = 1
  #closed = false
  #stderr = ''
  #protocolVersion?: string
  #stdoutParts: Buffer[] = []
  #stdoutBytes = 0
  #stderrBytes = Buffer.alloc(0)
  #terminalError?: unknown
  #termination?: Promise<void>

  private constructor(child: ChildProcessWithoutNullStreams, launch: McpStdioLaunch) {
    this.#child = child
    this.#requestTimeoutMs = optionalPositiveInteger(launch.requestTimeoutMs)
    this.#maxLineBytes = bounded(launch.maxLineBytes, 256 * 1024, 1024, 4 * 1024 * 1024)
    this.#maxStderrBytes = bounded(launch.maxStderrBytes, 16 * 1024, 1024, 1024 * 1024)
    this.#pluginId = launch.pluginId ?? 'standalone'
    this.#serverId = launch.serverId ?? 'default'
    child.stdout.on('data', (chunk: Buffer) => this.#onStdout(chunk))
    child.stderr.on('data', (chunk: Buffer) => this.#onStderr(chunk))
    child.stdin.on('error', () => {})
    child.once('error', () => this.#terminate(mcpError('MCP_PROCESS_FAILED', true)))
    child.once('exit', () => this.#terminate(mcpError('MCP_PROCESS_EXITED', true)))
  }

  static async start(launch: McpStdioLaunch): Promise<McpStdioClient> {
    const child = spawn(launch.command, launch.args ?? [], {
      cwd: launch.cwd,
      env: processEnvironment(launch.environment),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
      ...(launch.signal ? { signal: launch.signal } : {}),
    })
    const client = new McpStdioClient(child, launch)
    try {
      try {
        const discovered = DiscoverResultSchema.safeParse(
          await client.#request('server/discover', {}, undefined, true, 1_000),
        )
        if (
          !discovered.success ||
          !discovered.data.supportedVersions.includes(MODERN_PROTOCOL_VERSION)
        ) {
          throw mcpError('MCP_PROTOCOL_INVALID')
        }
        client.#protocolVersion = MODERN_PROTOCOL_VERSION
      } catch (error) {
        if (!canFallbackToLegacy(error)) throw error
        const initialized = InitializeResultSchema.safeParse(
          await client.#request('initialize', {
            protocolVersion: LEGACY_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'praxis', version: PRAXIS_PRODUCT_VERSION },
          }),
        )
        if (!initialized.success || initialized.data.protocolVersion !== LEGACY_PROTOCOL_VERSION) {
          throw mcpError('MCP_PROTOCOL_INVALID')
        }
        client.#protocolVersion = LEGACY_PROTOCOL_VERSION
        client.#notify('notifications/initialized', {})
      }
      await client.refreshTools()
      return client
    } catch (error) {
      await client.shutdown().catch(() => undefined)
      throw error
    }
  }

  get stderr(): string {
    return this.#stderr
  }

  get protocolVersion(): string {
    if (!this.#protocolVersion) throw mcpError('MCP_PROTOCOL_INVALID')
    return this.#protocolVersion
  }

  listTools(): McpToolDescriptor[] {
    return [...this.#tools.values()].map((tool) => structuredClone(tool))
  }

  async refreshTools(): Promise<McpToolDescriptor[]> {
    const tools: McpToolDescriptor[] = []
    const cursors = new Set<string>()
    let cursor: string | undefined
    let complete = false
    for (let page = 0; page < MAX_TOOL_LIST_PAGES; page += 1) {
      const result = ListToolsResultSchema.safeParse(
        await this.#request('tools/list', cursor === undefined ? {} : { cursor }),
      )
      if (!result.success) throw mcpError('MCP_PROTOCOL_INVALID')
      tools.push(...result.data.tools.map(parseTool))
      if (tools.length > MAX_PUBLISHED_TOOLS) throw mcpError('MCP_PROTOCOL_INVALID')
      if (result.data.nextCursor === undefined) {
        complete = true
        break
      }
      if (cursors.has(result.data.nextCursor)) throw mcpError('MCP_PROTOCOL_INVALID')
      cursors.add(result.data.nextCursor)
      cursor = result.data.nextCursor
    }
    if (!complete) throw mcpError('MCP_PROTOCOL_INVALID')
    if (new Set(tools.map((tool) => tool.name)).size !== tools.length) {
      throw mcpError('MCP_TOOL_COLLISION')
    }
    this.#tools.clear()
    for (const tool of tools) this.#tools.set(tool.name, tool)
    return this.listTools()
  }

  runtimeTools(): RuntimeTool[] {
    return this.listTools().map((descriptor) => ({
      definition: {
        name: mcpRuntimeToolName(this.#pluginId, this.#serverId, descriptor.name),
        description: descriptor.description ?? `MCP Tool ${descriptor.name}`,
        parameters: descriptor.inputSchema,
        ...(descriptor.outputSchema ? { outputSchema: descriptor.outputSchema } : {}),
        execution: {
          sideEffect: 'process',
          target: { kind: 'workspace' },
          parallelSafe: false,
          conflictScope: 'workspace',
          maxInlineBytes: 64 * 1024,
          ...(this.#requestTimeoutMs === undefined ? {} : { timeoutMs: this.#requestTimeoutMs }),
        },
      },
      execute: async (request) =>
        await this.callTool(descriptor.name, request.input, request.signal, request.onUpdate),
    }))
  }

  async callTool(
    name: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: (update: ToolProgressUpdate) => void,
  ): Promise<ToolResult> {
    if (!this.#tools.has(name)) throw mcpError('MCP_TOOL_UNKNOWN')
    const result = CallToolResultSchema.safeParse(
      await this.#request(
        'tools/call',
        { name, arguments: input },
        signal,
        undefined,
        undefined,
        onUpdate,
      ),
    )
    if (!result.success) throw mcpError('MCP_PROTOCOL_INVALID')
    const descriptor = this.#tools.get(name)
    if (!descriptor) throw mcpError('MCP_TOOL_UNKNOWN')
    const hasStructuredContent = Object.hasOwn(result.data, 'structuredContent')
    if (descriptor.outputSchema && !hasStructuredContent) {
      throw mcpError('MCP_PROTOCOL_INVALID')
    }
    const text = result.data.content
      .filter(
        (item): item is { type: 'text'; text: string } =>
          isRecord(item) && item.type === 'text' && typeof item.text === 'string',
      )
      .map((item) => item.text)
      .join('\n')
    const isError = result.data.isError === true
    return {
      ok: !isError,
      summary: text || (isError ? `MCP Tool ${name} failed.` : `MCP Tool ${name} completed.`),
      output: descriptor.outputSchema
        ? structuredClone(result.data.structuredContent)
        : {
            content: structuredClone(result.data.content),
            ...(hasStructuredContent
              ? { structuredContent: structuredClone(result.data.structuredContent) }
              : {}),
          },
      ...(isError
        ? {
            error: {
              code: 'MCP_TOOL_ERROR',
              category: 'execution' as const,
              retryable: false,
            },
          }
        : {}),
    }
  }

  async unsupported(surface: string): Promise<never> {
    throw runtimeError(
      'MCP_SURFACE_UNSUPPORTED',
      'plugin',
      `MCP surface "${surface}" is not supported; Praxis currently exposes tools/list and tools/call only.`,
      { surface },
    )
  }

  async shutdown(): Promise<void> {
    if (this.#closed) return
    try {
      if (this.#protocolVersion !== MODERN_PROTOCOL_VERSION) {
        await this.#request('shutdown', {}).catch(() => undefined)
      }
    } finally {
      this.#closed = true
      const closed = mcpError('MCP_CLIENT_CLOSED')
      this.#terminalError ??= closed
      this.#failAll(closed)
      // Start tree termination while the server PID still names the root of its Windows job tree.
      // Ending stdin first lets a fast server exit and orphan its descendant before taskkill /t
      // can discover it, which makes shutdown nondeterministic under a busy test/runtime host.
      const termination = this.#terminateTree()
      this.#child.stdin.end()
      await termination
      await waitForProcessExit(this.#child, 1_000)
    }
  }

  #request(
    method: string,
    params: unknown,
    signal?: AbortSignal,
    modernEnvelope = this.#protocolVersion === MODERN_PROTOCOL_VERSION,
    timeoutMs = this.#requestTimeoutMs,
    onUpdate?: (update: ToolProgressUpdate) => void,
  ): Promise<unknown> {
    if (this.#terminalError) return Promise.reject(this.#terminalError)
    if (this.#closed) return Promise.reject(mcpError('MCP_CLIENT_CLOSED'))
    const id = this.#counter++
    const progressToken = onUpdate ? `praxis-mcp-${id}` : undefined
    return new Promise((resolve, reject) => {
      const abort = () => {
        const pending = this.#pending.get(id)
        this.#pending.delete(id)
        pending?.timeout?.cancel()
        rememberId(this.#cancelledRequestIds, id)
        this.#notify('notifications/cancelled', {
          requestId: id,
          reason: String(signal?.reason ?? 'cancelled'),
        })
        reject(mcpError('MCP_REQUEST_CANCELLED'))
      }
      const timeout =
        timeoutMs === undefined
          ? undefined
          : scheduleLongDurationTimer(() => {
              this.#pending.delete(id)
              signal?.removeEventListener('abort', abort)
              rememberId(this.#cancelledRequestIds, id)
              this.#notify('notifications/cancelled', {
                requestId: id,
                reason: 'deadline',
              })
              reject(mcpError('MCP_REQUEST_TIMEOUT', true))
            }, timeoutMs)
      this.#pending.set(id, {
        resolve: (value) => {
          signal?.removeEventListener('abort', abort)
          resolve(value)
        },
        reject: (error) => {
          signal?.removeEventListener('abort', abort)
          reject(error)
        },
        timeout,
        ...(progressToken ? { progressToken } : {}),
        ...(onUpdate ? { onUpdate } : {}),
      })
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
      else {
        const requestParams =
          progressToken === undefined ? params : withProgressToken(params, progressToken)
        this.#write({
          jsonrpc: '2.0',
          id,
          method,
          params: modernEnvelope ? withModernEnvelope(requestParams) : requestParams,
        })
      }
    })
  }

  #notify(method: string, params: unknown): void {
    if (!this.#closed) {
      this.#write({
        jsonrpc: '2.0',
        method,
        params:
          this.#protocolVersion === MODERN_PROTOCOL_VERSION ? withModernEnvelope(params) : params,
      })
    }
  }

  #write(value: unknown): void {
    this.#child.stdin.write(`${JSON.stringify(value)}\n`)
  }

  #onStdout(chunk: Buffer): void {
    let offset = 0
    while (offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset)
      const end = newline < 0 ? chunk.length : newline
      const segment = chunk.subarray(offset, end)
      if (this.#stdoutBytes + segment.length > this.#maxLineBytes) {
        this.#failProtocol()
        return
      }
      if (segment.length > 0) {
        this.#stdoutParts.push(segment)
        this.#stdoutBytes += segment.length
      }
      if (newline < 0) return
      const frame = Buffer.concat(this.#stdoutParts, this.#stdoutBytes)
      this.#stdoutParts = []
      this.#stdoutBytes = 0
      const normalized =
        frame.length > 0 && frame[frame.length - 1] === 0x0d
          ? frame.subarray(0, frame.length - 1)
          : frame
      let line: string
      try {
        line = new TextDecoder('utf-8', { fatal: true }).decode(normalized)
      } catch {
        this.#failProtocol()
        return
      }
      this.#onLine(line)
      if (this.#closed || this.#child.killed) return
      offset = newline + 1
    }
  }

  #onStderr(chunk: Buffer): void {
    const next =
      chunk.length >= this.#maxStderrBytes
        ? Buffer.from(chunk.subarray(chunk.length - this.#maxStderrBytes))
        : Buffer.concat([this.#stderrBytes, chunk]).subarray(-this.#maxStderrBytes)
    this.#stderrBytes = Buffer.from(next)
    this.#stderr = new TextDecoder().decode(this.#stderrBytes)
  }

  #onLine(line: string): void {
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      this.#failProtocol()
      return
    }
    if (!isRecord(message)) return
    if (typeof message.method === 'string') {
      if (message.method === 'notifications/progress') {
        this.#onProgress(message)
        return
      }
      if (
        message.method.startsWith('resources/') ||
        message.method.startsWith('prompts/') ||
        message.method.startsWith('sampling/') ||
        message.method.startsWith('roots/')
      ) {
        const error = mcpError('MCP_SURFACE_UNSUPPORTED')
        this.#terminalError ??= error
        this.#failAll(error)
        void this.#terminateTree()
      }
      return
    }
    if (typeof message.id !== 'number') {
      this.#failProtocol()
      return
    }
    const pending = this.#pending.get(message.id)
    if (!pending) {
      if (this.#cancelledRequestIds.has(message.id)) return
      this.#failProtocol()
      return
    }
    this.#pending.delete(message.id)
    rememberId(this.#completedRequestIds, message.id)
    pending.timeout?.cancel()
    if (isRecord(message.error)) {
      pending.reject(
        runtimeError(
          'MCP_REMOTE_ERROR',
          'plugin',
          typeof message.error.message === 'string'
            ? message.error.message
            : 'MCP server returned an error.',
          { remoteCode: message.error.code },
        ),
      )
    } else if (Object.hasOwn(message, 'result')) {
      pending.resolve(message.result)
    } else {
      pending.reject(mcpError('MCP_PROTOCOL_INVALID'))
    }
  }

  #onProgress(message: Record<string, unknown>): void {
    const parsed = ProgressNotificationSchema.safeParse(message)
    if (!parsed.success) {
      this.#failProtocol()
      return
    }
    const pending = [...this.#pending.values()].find(
      (candidate) => candidate.progressToken === parsed.data.params.progressToken,
    )
    if (!pending?.onUpdate) return
    const supplied = parsed.data.params.message
    const messageText =
      typeof supplied === 'string' && supplied.length > 0
        ? supplied.slice(0, 1_024)
        : `MCP progress ${parsed.data.params.progress}`
    try {
      pending.onUpdate({ message: messageText })
    } catch {
      // A presentation callback cannot corrupt the MCP protocol lifecycle.
    }
  }

  #failProtocol(): void {
    this.#stdoutParts = []
    this.#stdoutBytes = 0
    const error = mcpError('MCP_PROTOCOL_INVALID')
    this.#terminalError ??= error
    this.#failAll(error)
    void this.#terminateTree()
  }

  #terminate(error: unknown): void {
    this.#terminalError ??= error
    this.#failAll(this.#terminalError)
    void this.#terminateTree()
  }

  #terminateTree(): Promise<void> {
    this.#termination ??= terminateProcessTree(this.#child.pid)
    return this.#termination
  }

  #failAll(error: unknown): void {
    for (const pending of this.#pending.values()) {
      pending.timeout?.cancel()
      pending.reject(error)
    }
    this.#pending.clear()
  }
}

function parseTool(value: unknown): McpToolDescriptor {
  if (
    !isRecord(value) ||
    typeof value.name !== 'string' ||
    value.name.trim().length === 0 ||
    !isRecord(value.inputSchema)
  ) {
    throw mcpError('MCP_PROTOCOL_INVALID')
  }
  assertSafeSchema(value.inputSchema)
  if (isRecord(value.outputSchema)) assertSafeSchema(value.outputSchema)
  return {
    name: value.name,
    ...(typeof value.title === 'string'
      ? { title: boundedUtf8(value.title, MAX_DESCRIPTOR_TEXT_BYTES) }
      : {}),
    ...(typeof value.description === 'string'
      ? { description: boundedUtf8(value.description, MAX_DESCRIPTOR_TEXT_BYTES) }
      : {}),
    inputSchema: structuredClone(value.inputSchema),
    ...(isRecord(value.outputSchema) ? { outputSchema: structuredClone(value.outputSchema) } : {}),
  }
}

function assertSafeSchema(schema: Record<string, unknown>): void {
  let serialized: string
  try {
    serialized = JSON.stringify(schema)
  } catch {
    throw mcpError('MCP_PROTOCOL_INVALID')
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_SCHEMA_BYTES) {
    throw mcpError('MCP_PROTOCOL_INVALID')
  }
  const pending: Array<{ value: unknown; depth: number }> = [{ value: schema, depth: 0 }]
  let nodes = 0
  while (pending.length > 0) {
    const current = pending.pop()
    if (!current) break
    nodes += 1
    if (nodes > MAX_SCHEMA_NODES || current.depth > MAX_SCHEMA_DEPTH) {
      throw mcpError('MCP_PROTOCOL_INVALID')
    }
    if (Array.isArray(current.value)) {
      for (const item of current.value) {
        pending.push({ value: item, depth: current.depth + 1 })
      }
      continue
    }
    if (!isRecord(current.value)) continue
    for (const [key, item] of Object.entries(current.value)) {
      if (
        (key === '$ref' || key === '$dynamicRef' || key === '$recursiveRef') &&
        (typeof item !== 'string' || !item.startsWith('#'))
      ) {
        throw mcpError('MCP_PROTOCOL_INVALID')
      }
      pending.push({ value: item, depth: current.depth + 1 })
    }
  }
}

function boundedUtf8(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.length <= maximumBytes) return value
  return new TextDecoder().decode(bytes.subarray(0, maximumBytes))
}

function processEnvironment(explicit?: Record<string, string>): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name, value]) =>
        value !== undefined &&
        ['comspec', 'path', 'pathext', 'systemdrive', 'systemroot', 'windir'].includes(
          name.toLowerCase(),
        ),
    ),
  )
  return { ...inherited, ...explicit }
}

export function mcpRuntimeToolName(pluginId: string, serverId: string, toolName: string): string {
  return `mcp__${boundedNamePart(pluginId, 8)}__${boundedNamePart(
    serverId,
    8,
  )}__${boundedNamePart(toolName, 12)}`
}

function boundedNamePart(value: string, visibleBytes: number): string {
  const visible =
    value
      .normalize('NFKC')
      .replace(/[^A-Za-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, visibleBytes) || 'id'
  const digest = createHash('sha256').update(value).digest('hex').slice(0, 8)
  return `${visible}_${digest}`
}

function rememberId(ids: Set<number>, id: number): void {
  ids.add(id)
  if (ids.size <= MAX_SETTLED_REQUEST_IDS) return
  const oldest = ids.values().next().value
  if (typeof oldest === 'number') ids.delete(oldest)
}

function withProgressToken(params: unknown, progressToken: string): Record<string, unknown> {
  const value = isRecord(params) ? structuredClone(params) : {}
  const existing = isRecord(value._meta) ? value._meta : {}
  return {
    ...value,
    _meta: {
      ...existing,
      progressToken,
    },
  }
}

function withModernEnvelope(params: unknown): Record<string, unknown> {
  const value = isRecord(params) ? structuredClone(params) : {}
  const existing = isRecord(value._meta) ? value._meta : {}
  return {
    ...value,
    _meta: {
      ...existing,
      [`${MODERN_META_PREFIX}/protocolVersion`]: MODERN_PROTOCOL_VERSION,
      [`${MODERN_META_PREFIX}/clientInfo`]: {
        name: 'praxis',
        version: PRAXIS_PRODUCT_VERSION,
      },
      [`${MODERN_META_PREFIX}/clientCapabilities`]: {},
    },
  }
}

function canFallbackToLegacy(error: unknown): boolean {
  if (!isRecord(error) || typeof error.code !== 'string') return false
  if (error.code === 'MCP_REQUEST_TIMEOUT') return true
  return (
    error.code === 'MCP_REMOTE_ERROR' && isRecord(error.data) && error.data.remoteCode === -32601
  )
}

function mcpError(code: string, retryable = false) {
  return runtimeError(
    code,
    code.includes('CANCEL') ? 'cancelled' : 'plugin',
    `MCP boundary failed (${code}).`,
    undefined,
    retryable,
  )
}

function bounded(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return Math.min(maximum, Math.max(minimum, Math.floor(value ?? fallback)))
}

function optionalPositiveInteger(value: number | undefined): number | undefined {
  if (value === undefined) return undefined
  return Number.isSafeInteger(value) && value >= 1 ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
