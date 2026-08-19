import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import {
  type CancellationReason,
  isRuntimeError,
  runtimeError,
  type TraceContext,
  type TraceRecord,
} from '@praxis/core-sdk'
import type { PluginGrant } from '@praxis/plugin-protocol'
import { type LongDurationTimer, scheduleLongDurationTimer } from '../longDurationTimer.js'
import { terminateProcessTree, waitForProcessExit } from '../process/processTree.js'
import type { IsolationBackend } from '../security/isolationBackend.js'
import {
  isProcessPluginEvent,
  isProcessPluginResponseFor,
  type ProcessPluginCapabilityManifest,
  type ProcessPluginEvent,
  type ProcessPluginInitializeResult,
  type ProcessPluginRequest,
  type ProcessPluginResponse,
} from './processPluginProtocol.js'

const DEFAULT_TIMEOUT_MS = 5_000
const MAX_STDOUT_LINE_BYTES = 64 * 1024
const MAX_ACTIVE_INVOCATIONS = 1_024

export type ProcessPluginLaunch = {
  command: string
  args?: string[]
  cwd?: string
  pluginId?: string
  workspace?: string
  grants?: PluginGrant[]
  deadlineAt?: string
  version?: string
  capabilities?: Array<{ id: string; kind: 'tool' | 'provider' }>
  isolation?: {
    backend: IsolationBackend
    pluginRoot: string
    grants: PluginGrant[]
    environment?: Record<string, string>
    allowTrustedOnly?: boolean
  }
}

export type ProcessPluginHostOptions = {
  enabled?: boolean
  /** Optional hard limit for capability invocations. Omitted means unlimited. */
  requestTimeoutMs?: number
  /** Liveness deadline for initialize/cancel/health/shutdown control messages. */
  controlTimeoutMs?: number
  maxStdoutLineBytes?: number
}

export type ProcessPluginTraceBoundary = {
  context: TraceContext
  trace(record: Omit<TraceRecord, 'schemaVersion' | 'timestamp'>): Promise<void>
}

export type ProcessPluginClient = {
  readonly capabilities: readonly ProcessPluginCapabilityManifest[]
  invoke(
    capabilityId: string,
    input: unknown,
    cancellationId?: string,
    trace?: ProcessPluginTraceBoundary,
    onEvent?: (event: ProcessPluginEvent) => void,
  ): Promise<unknown>
  cancel(invocationOrCancellationId: string, reason: CancellationReason): Promise<void>
  health(): Promise<boolean>
  shutdown(): Promise<void>
}

type PendingRequest = {
  request: ProcessPluginRequest
  resolve(response: ProcessPluginResponse): void
  reject(error: unknown): void
  timer?: LongDurationTimer
}

type ActiveInvocation = {
  invocationId: string
  cancellationId: string
  pluginId: string
  capabilityId: string
  context: TraceContext
  trace?: ProcessPluginTraceBoundary
  onEvent?: (event: ProcessPluginEvent) => void
  startedAt: number
  terminal?: 'completed' | 'failed' | 'cancelled'
  requestQueued: Promise<void>
  markRequestQueued(): void
}

/** Supervises a process-isolated plugin whose stdout is strictly JSON-RPC. */
export class ProcessPluginHost {
  private readonly enabled: boolean
  private readonly requestTimeoutMs?: number
  private readonly controlTimeoutMs: number
  private readonly maxStdoutLineBytes: number

  constructor(options: ProcessPluginHostOptions = {}) {
    this.enabled = options.enabled ?? false
    this.requestTimeoutMs =
      options.requestTimeoutMs === undefined
        ? undefined
        : Math.max(1, Math.floor(options.requestTimeoutMs))
    this.controlTimeoutMs = Math.max(1, Math.floor(options.controlTimeoutMs ?? DEFAULT_TIMEOUT_MS))
    this.maxStdoutLineBytes = Math.max(
      1,
      Math.floor(options.maxStdoutLineBytes ?? MAX_STDOUT_LINE_BYTES),
    )
  }

  async start(launch: ProcessPluginLaunch): Promise<ProcessPluginClient> {
    if (!this.enabled) {
      throw runtimeError(
        'PROCESS_PLUGIN_DISABLED',
        'plugin',
        'Process plugins are disabled until the isolated host is enabled by Runtime configuration.',
      )
    }
    const isolated = launch.isolation
      ? await launch.isolation.backend.prepare({
          command: launch.command,
          args: launch.args,
          pluginRoot: launch.isolation.pluginRoot,
          workspace: launch.workspace ?? launch.cwd ?? process.cwd(),
          grants: launch.isolation.grants,
          environment: launch.isolation.environment,
          allowTrustedOnly: launch.isolation.allowTrustedOnly,
        })
      : undefined
    const child = spawn(isolated?.command ?? launch.command, isolated?.args ?? launch.args ?? [], {
      cwd: isolated?.cwd ?? launch.cwd,
      env: isolated?.environment ?? processBootstrapEnvironment(process.env),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    })
    const client = new IsolatedProcessPlugin(
      child,
      this.requestTimeoutMs,
      this.controlTimeoutMs,
      this.maxStdoutLineBytes,
    )
    try {
      const initialize = await client.request({
        jsonrpc: '2.0',
        id: client.nextId(),
        method: 'initialize',
        params: {
          protocolVersion: 1,
          runtimeApiVersion: 1,
          requestedPluginId: launch.pluginId ?? 'process-plugin',
          grants: launch.grants ?? [],
          workspace: launch.workspace ?? launch.cwd ?? process.cwd(),
          ...(launch.deadlineAt === undefined ? {} : { deadlineAt: launch.deadlineAt }),
        },
      })
      if ('error' in initialize || !isInitializeResponse(initialize)) {
        throw 'error' in initialize
          ? initialize.error
          : runtimeError(
              'PROCESS_PLUGIN_PROTOCOL_INVALID',
              'plugin',
              'Plugin returned an invalid initialize response.',
            )
      }
      assertExpectedPlugin(initialize.result, launch)
      return client.configure(initialize.result, launch.pluginId ?? 'process-plugin')
    } catch (error) {
      await client.shutdown().catch(() => undefined)
      throw error
    }
  }
}

const PROCESS_BOOTSTRAP_ENVIRONMENT = new Set([
  'comspec',
  'path',
  'pathext',
  'systemdrive',
  'systemroot',
  'windir',
])

function processBootstrapEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([name, value]) =>
        value !== undefined && PROCESS_BOOTSTRAP_ENVIRONMENT.has(name.toLowerCase()),
    ),
  )
}

class IsolatedProcessPlugin {
  private readonly pending = new Map<string, PendingRequest>()
  private counter = 1
  private capabilities: readonly ProcessPluginCapabilityManifest[] = []
  private readonly activeByInvocationId = new Map<string, ActiveInvocation>()
  private readonly activeByCancellationId = new Map<string, ActiveInvocation>()
  private closed = false
  private stdout = Buffer.alloc(0)
  private stderr = Buffer.alloc(0)
  private termination?: Promise<void>

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly invocationTimeoutMs: number | undefined,
    private readonly controlTimeoutMs: number,
    private readonly maximumLineBytes: number,
  ) {
    child.stdout.on('data', (chunk: Buffer) => this.onStdout(chunk))
    child.stderr.on('data', (chunk: Buffer) => {
      this.stderr = Buffer.concat([this.stderr, chunk]).subarray(-16 * 1024)
    })
    child.once('error', (_error) =>
      this.failAll(
        runtimeError(
          'PROCESS_PLUGIN_SPAWN_FAILED',
          'plugin',
          'Plugin process could not be started.',
          undefined,
          true,
        ),
      ),
    )
    child.once('exit', () =>
      this.failAll(
        runtimeError(
          'PROCESS_PLUGIN_EXITED',
          'plugin',
          'Plugin process exited before completing its request.',
          undefined,
          true,
        ),
      ),
    )
  }

  configure(result: ProcessPluginInitializeResult, pluginId: string): ProcessPluginClient {
    this.capabilities = Object.freeze(result.capabilities.map((capability) => ({ ...capability })))
    return {
      capabilities: this.capabilities,
      invoke: (capabilityId, input, cancellationId = `cancel-${this.nextId()}`, trace, onEvent) =>
        this.invoke(pluginId, capabilityId, input, cancellationId, trace, onEvent),
      cancel: (invocationOrCancellationId, reason) =>
        this.cancel(invocationOrCancellationId, reason),
      health: () => this.health(),
      shutdown: () => this.shutdown(),
    }
  }

  nextId(): string {
    return `plugin-${this.counter++}`
  }

  async request(
    request: ProcessPluginRequest,
    timeoutMs: number | null = this.controlTimeoutMs,
  ): Promise<ProcessPluginResponse> {
    if (this.closed)
      throw runtimeError('PROCESS_PLUGIN_CLOSED', 'plugin', 'Plugin process is closed.')
    return await new Promise<ProcessPluginResponse>((resolve, reject) => {
      const timer =
        timeoutMs === null
          ? undefined
          : scheduleLongDurationTimer(() => {
              this.pending.delete(request.id)
              reject(
                runtimeError(
                  'PROCESS_PLUGIN_TIMEOUT',
                  'plugin',
                  'Plugin request exceeded its deadline.',
                  undefined,
                  true,
                ),
              )
            }, timeoutMs)
      this.pending.set(request.id, { request, resolve, reject, timer })
      this.child.stdin.write(`${JSON.stringify(request)}\n`, (error) => {
        if (!error) return
        const pending = this.pending.get(request.id)
        if (!pending) return
        this.pending.delete(request.id)
        pending.timer?.cancel()
        pending.reject(
          runtimeError(
            'PROCESS_PLUGIN_WRITE_FAILED',
            'plugin',
            'Plugin request could not be written.',
            undefined,
            true,
          ),
        )
      })
    })
  }

  private async invoke(
    pluginId: string,
    capabilityId: string,
    input: unknown,
    cancellationId: string,
    trace?: ProcessPluginTraceBoundary,
    onEvent?: (event: ProcessPluginEvent) => void,
  ): Promise<unknown> {
    const pluginCallId = `plugin-call-${this.nextId()}`
    const context = { ...trace?.context, pluginCallId } as TraceContext
    const startedAt = Date.now()
    const invocationId = `invoke-${this.nextId()}`
    let markRequestQueued: () => void = () => {}
    const requestQueued = new Promise<void>((resolve) => {
      markRequestQueued = resolve
    })
    const active: ActiveInvocation = {
      invocationId,
      cancellationId,
      pluginId,
      capabilityId,
      context,
      trace,
      ...(onEvent ? { onEvent } : {}),
      startedAt,
      requestQueued,
      markRequestQueued,
    }
    let registrationError: unknown
    if (this.capabilities.some((capability) => capability.id === capabilityId)) {
      try {
        this.registerActive(active)
      } catch (error) {
        registrationError = error
      }
    }
    try {
      await safeTrace(trace, {
        kind: 'plugin.started',
        context,
        attributes: { pluginId, capabilityId },
      })
      if (registrationError !== undefined) throw registrationError
      if (!this.capabilities.some((capability) => capability.id === capabilityId)) {
        throw runtimeError(
          'PROCESS_PLUGIN_CAPABILITY_UNKNOWN',
          'plugin',
          'Plugin capability was not declared during initialization.',
          { capabilityId },
        )
      }
      const responsePromise = this.request(
        {
          jsonrpc: '2.0',
          id: this.nextId(),
          method: 'capability.invoke',
          params: { invocationId, capabilityId, input, cancellationId },
        },
        this.invocationTimeoutMs ?? null,
      )
      active.markRequestQueued()
      const response = await responsePromise
      if ('error' in response) throw response.error
      if (!isInvokeResponse(response))
        throw runtimeError(
          'PROCESS_PLUGIN_PROTOCOL_INVALID',
          'plugin',
          'Plugin returned an invalid invocation response.',
        )
      if (active.terminal === 'cancelled') throw processPluginCancelled()
      await this.claimTerminal(active, 'completed', {
        kind: 'plugin.stopped',
        context,
        attributes: { pluginId, capabilityId, stopReason: 'completed', health: 'healthy' },
        metrics: { durationMs: elapsed(startedAt) },
      })
      return response.result.output
    } catch (error) {
      if (active.terminal === 'cancelled') throw processPluginCancelled()
      if (active.terminal === undefined) {
        await this.claimTerminal(active, 'failed', {
          kind: 'plugin.failed',
          context,
          attributes: {
            pluginId,
            capabilityId,
            errorCode: pluginErrorCode(error),
            health: 'unhealthy',
          },
          metrics: { durationMs: elapsed(startedAt) },
        })
      }
      throw error
    } finally {
      active.markRequestQueued()
      this.removeActive(active)
    }
  }

  private async cancel(
    invocationOrCancellationId: string,
    reason: CancellationReason,
  ): Promise<void> {
    const active =
      this.activeByInvocationId.get(invocationOrCancellationId) ??
      this.activeByCancellationId.get(invocationOrCancellationId)
    if (!active) {
      throw runtimeError(
        'PROCESS_PLUGIN_INVOCATION_UNKNOWN',
        'plugin',
        'Plugin invocation is no longer active.',
      )
    }
    await active.requestQueued
    const response = await this.request({
      jsonrpc: '2.0',
      id: this.nextId(),
      method: 'capability.cancel',
      params: { invocationId: active.invocationId, reason },
    })
    if ('error' in response) throw response.error
    await this.claimTerminal(active, 'cancelled', {
      kind: 'plugin.stopped',
      context: active.context,
      attributes: {
        pluginId: active.pluginId,
        capabilityId: active.capabilityId,
        stopReason: reason,
        health: 'degraded',
      },
      metrics: { durationMs: elapsed(active.startedAt) },
    })
    this.removeActive(active)
  }

  private async health(): Promise<boolean> {
    const nonce = `health-${this.nextId()}`
    const response = await this.request({
      jsonrpc: '2.0',
      id: this.nextId(),
      method: 'health.ping',
      params: { nonce },
    })
    return !('error' in response) && 'nonce' in response.result && response.result.nonce === nonce
  }

  private async claimTerminal(
    active: ActiveInvocation,
    terminal: NonNullable<ActiveInvocation['terminal']>,
    record: TraceInput,
  ): Promise<boolean> {
    if (active.terminal !== undefined) return false
    active.terminal = terminal
    await safeTrace(active.trace, record)
    return true
  }

  private registerActive(active: ActiveInvocation): void {
    if (
      this.activeByInvocationId.size >= MAX_ACTIVE_INVOCATIONS ||
      this.activeByCancellationId.has(active.cancellationId)
    ) {
      throw runtimeError(
        'PROCESS_PLUGIN_INVOCATION_LIMIT',
        'plugin',
        'Plugin invocation correlation capacity was exceeded.',
      )
    }
    this.activeByInvocationId.set(active.invocationId, active)
    this.activeByCancellationId.set(active.cancellationId, active)
  }

  private removeActive(active: ActiveInvocation): void {
    if (this.activeByInvocationId.get(active.invocationId) === active) {
      this.activeByInvocationId.delete(active.invocationId)
    }
    if (this.activeByCancellationId.get(active.cancellationId) === active) {
      this.activeByCancellationId.delete(active.cancellationId)
    }
  }

  async shutdown(): Promise<void> {
    if (this.closed) {
      await this.terminate()
      return
    }
    try {
      const response = await this.request({
        jsonrpc: '2.0',
        id: this.nextId(),
        method: 'shutdown',
        params: {},
      })
      if ('error' in response) throw response.error
    } finally {
      this.closed = true
      this.child.stdin.end()
      await waitForProcessExit(this.child, 100)
      await this.terminate()
      await waitForProcessExit(this.child, 1_000)
    }
  }

  private onStdout(chunk: Buffer): void {
    if (this.closed) return
    this.stdout = Buffer.concat([this.stdout, chunk])
    while (true) {
      const newline = this.stdout.indexOf(0x0a)
      if (newline < 0) {
        if (this.stdout.length > this.maximumLineBytes) {
          this.protocolFailure('Plugin emitted an oversized stdout line.')
        }
        return
      }
      if (newline > this.maximumLineBytes) {
        this.protocolFailure('Plugin emitted an oversized stdout line.')
        return
      }
      const frame = this.stdout.subarray(0, newline)
      this.stdout = this.stdout.subarray(newline + 1)
      const line =
        frame.at(-1) === 0x0d ? frame.subarray(0, -1).toString('utf8') : frame.toString('utf8')
      this.onLine(line)
      if (this.closed) return
    }
  }

  private onLine(line: string): void {
    let response: unknown
    try {
      response = JSON.parse(line)
    } catch {
      this.failAll(
        runtimeError(
          'PROCESS_PLUGIN_PROTOCOL_INVALID',
          'plugin',
          'Plugin emitted malformed stdout.',
        ),
      )
      void this.terminate()
      return
    }
    if (isProcessPluginEvent(response)) {
      const active = this.activeByInvocationId.get(response.params.invocationId)
      if (!active) {
        this.protocolFailure('Plugin emitted an event for an inactive invocation.')
        return
      }
      active.onEvent?.(structuredClone(response))
      return
    }
    if (
      !response ||
      typeof response !== 'object' ||
      typeof (response as { id?: unknown }).id !== 'string'
    ) {
      this.protocolFailure('Plugin emitted an invalid protocol message.')
      return
    }
    const pending = this.pending.get((response as { id: string }).id)
    if (!pending || !isProcessPluginResponseFor(pending.request, response, this.capabilities)) {
      this.protocolFailure('Plugin emitted an invalid response envelope.')
      return
    }
    this.pending.delete(pending.request.id)
    pending.timer?.cancel()
    pending.resolve(response as ProcessPluginResponse)
  }

  private protocolFailure(message: string): void {
    this.failAll(runtimeError('PROCESS_PLUGIN_PROTOCOL_INVALID', 'plugin', message))
    void this.terminate()
  }

  private failAll(error: unknown): void {
    if (this.closed) return
    this.closed = true
    for (const pending of this.pending.values()) {
      pending.timer?.cancel()
      pending.reject(error)
    }
    this.pending.clear()
    void this.terminate()
  }

  private terminate(): Promise<void> {
    this.termination ??= terminateProcessTree(this.child.pid)
    return this.termination
  }
}

function assertExpectedPlugin(
  result: ProcessPluginInitializeResult,
  launch: ProcessPluginLaunch,
): void {
  if (launch.version !== undefined && result.manifest.version !== launch.version) {
    throw runtimeError(
      'PROCESS_PLUGIN_PROTOCOL_INVALID',
      'plugin',
      'Plugin version does not match the selected installation.',
    )
  }
  if (!launch.capabilities) return
  const expected = launch.capabilities
    .map(({ id, kind }) => `${kind}:${id}`)
    .sort((left, right) => left.localeCompare(right))
  const actual = result.capabilities
    .map(({ id, kind }) => `${kind}:${id}`)
    .sort((left, right) => left.localeCompare(right))
  if (
    expected.length !== actual.length ||
    expected.some((capability, index) => capability !== actual[index])
  ) {
    throw runtimeError(
      'PROCESS_PLUGIN_PROTOCOL_INVALID',
      'plugin',
      'Plugin capabilities do not match the selected installation manifest.',
    )
  }
}

function isInitializeResponse(
  response: ProcessPluginResponse,
): response is ProcessPluginResponse & { result: ProcessPluginInitializeResult } {
  return (
    !('error' in response) && 'manifest' in response.result && 'capabilities' in response.result
  )
}

function isInvokeResponse(
  response: ProcessPluginResponse,
): response is ProcessPluginResponse & { result: { invocationId: string; output: unknown } } {
  return !('error' in response) && 'invocationId' in response.result && 'output' in response.result
}

type TraceInput = Omit<TraceRecord, 'schemaVersion' | 'timestamp'>

async function safeTrace(
  boundary: ProcessPluginTraceBoundary | undefined,
  record: TraceInput,
): Promise<void> {
  if (!boundary) return
  try {
    await boundary.trace(record)
  } catch {
    // Tracing is diagnostic-only and cannot change plugin invocation behavior.
  }
}

function elapsed(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt)
}

function pluginErrorCode(error: unknown): string {
  const code = isRuntimeError(error) ? error.code : 'PROCESS_PLUGIN_ERROR'
  return /^[A-Z0-9_]{1,64}$/.test(code) ? code : 'PROCESS_PLUGIN_ERROR'
}

function processPluginCancelled(): ReturnType<typeof runtimeError> {
  return runtimeError(
    'PROCESS_PLUGIN_CANCELLED',
    'cancelled',
    'Plugin invocation was cancelled.',
    undefined,
    false,
  )
}
