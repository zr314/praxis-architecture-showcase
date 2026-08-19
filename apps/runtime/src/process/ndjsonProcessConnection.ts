import { spawn, type ChildProcessWithoutNullStreams, type Serializable } from 'node:child_process'
import type { Writable } from 'node:stream'
import { TextDecoder } from 'node:util'
import type { JsonRpcRequest } from '@praxis/protocol'
import { terminateProcessTree, waitForProcessExit } from './processTree.js'

export type DecodedProcessMessage<TNotification> =
  | { type: 'notification'; notification: TNotification }
  | { type: 'response'; id: string; result: unknown }
  | { type: 'response'; id: string; error: unknown }

export type ProcessMessageDecodeContext = {
  pendingMethod(id: string): string | undefined
}

export type ProcessMessageCodec<TNotification> = {
  decode(
    value: unknown,
    source: string,
    context: ProcessMessageDecodeContext,
  ): DecodedProcessMessage<TNotification>
}

export type ProcessConnectionFailureKind =
  | 'closed'
  | 'spawn_failed'
  | 'launch_input_failed'
  | 'write_failed'
  | 'timeout'
  | 'malformed_stdout'
  | 'oversized_stdout'
  | 'stdout_closed'
  | 'exited'

export type ProcessConnectionFailureContext = {
  method?: string
  code?: number | null
  signal?: NodeJS.Signals | null
  cause?: Error
}

export type NdjsonProcessConnectionOptions<TNotification> = {
  cwd?: string
  env?: NodeJS.ProcessEnv
  codec: ProcessMessageCodec<TNotification>
  failure(kind: ProcessConnectionFailureKind, context: ProcessConnectionFailureContext): Error
  requestTimeoutMs?: number
  closeTimeoutMs?: number
  maxLineBytes?: number
  maxStderrBytes?: number
  stderr?: 'inherit' | 'capture' | 'ignore'
  dedicatedInput?: {
    environment: Readonly<Record<string, string>>
    payloadForPid(pid: number): string | Buffer
  }
  ipc?: ProcessIpcController
}

export type ProcessIpcController = Readonly<{
  attach(send: (message: Serializable) => Promise<void>): void
  receive(message: unknown): void
  close(): void
}>

/** Multiplexes prefix-discriminated private protocols over one Node IPC channel. */
export class CompositeProcessIpcController implements ProcessIpcController {
  constructor(private readonly controllers: readonly ProcessIpcController[]) {}

  attach(send: (message: Serializable) => Promise<void>): void {
    for (const controller of this.controllers) controller.attach(send)
  }

  receive(message: unknown): void {
    for (const controller of this.controllers) controller.receive(message)
  }

  close(): void {
    for (const controller of this.controllers) controller.close()
  }
}

type PendingRequest = {
  method: string
  resolve(result: unknown): void
  reject(error: unknown): void
  timer?: NodeJS.Timeout
}

const DEFAULT_MAX_LINE_BYTES = 256 * 1024
const DEFAULT_MAX_STDERR_BYTES = 16 * 1024

/** Bounded NDJSON request/response transport shared by CLI and child Runtime hosts. */
export class NdjsonProcessConnection<TNotification> {
  readonly #child: ChildProcessWithoutNullStreams
  readonly #pending = new Map<string, PendingRequest>()
  readonly #notifications = new AsyncQueue<TNotification>()
  readonly #decoder = new TextDecoder('utf-8', { fatal: true })
  readonly #maxLineBytes: number
  readonly #maxStderrBytes: number
  readonly #requestTimeoutMs?: number
  readonly #closeTimeoutMs: number
  #stdoutParts: Buffer[] = []
  #stdoutBytes = 0
  #stderrBytes = Buffer.alloc(0)
  #stderrTotalBytes = 0
  #closed = false
  #failure?: Error
  #closing?: Promise<void>

  constructor(
    command: string,
    args: readonly string[],
    private readonly options: NdjsonProcessConnectionOptions<TNotification>,
  ) {
    this.#maxLineBytes = boundedInteger(
      options.maxLineBytes,
      DEFAULT_MAX_LINE_BYTES,
      1_024,
      4 * 1024 * 1024,
    )
    this.#maxStderrBytes = boundedInteger(
      options.maxStderrBytes,
      DEFAULT_MAX_STDERR_BYTES,
      1_024,
      256 * 1024,
    )
    this.#requestTimeoutMs = positiveInteger(options.requestTimeoutMs)
    this.#closeTimeoutMs = boundedInteger(options.closeTimeoutMs, 1_000, 50, 30_000)
    const dedicatedInput = options.dedicatedInput
    this.#child = spawn(command, [...args], {
      cwd: options.cwd,
      env: dedicatedInput
        ? { ...(options.env ?? process.env), ...dedicatedInput.environment }
        : options.env,
      stdio: dedicatedInput
        ? options.ipc
          ? ['pipe', 'pipe', 'pipe', 'pipe', 'ipc']
          : ['pipe', 'pipe', 'pipe', 'pipe']
        : options.ipc
          ? ['pipe', 'pipe', 'pipe', 'ipc']
          : ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    }) as ChildProcessWithoutNullStreams
    this.#child.stdout.on('data', (chunk: Buffer) => this.onStdout(chunk))
    this.#child.stdout.once('close', () => {
      if (!this.#closed && !this.#failure) {
        this.fail(options.failure('stdout_closed', {}))
      }
    })
    this.#child.stderr.on('data', (chunk: Buffer) => this.onStderr(chunk))
    if (options.ipc) {
      options.ipc.attach((message) => this.sendIpc(message))
      this.#child.on('message', (message) => {
        if (!this.#closed && !this.#failure) options.ipc?.receive(message)
      })
    }
    this.#child.once('error', (cause) => {
      this.fail(options.failure('spawn_failed', { cause }))
    })
    this.#child.once('exit', (code, signal) => {
      if (!this.#closed && !this.#failure) {
        this.fail(options.failure('exited', { code, signal }))
      }
    })
    if (dedicatedInput) this.writeDedicatedInput(dedicatedInput)
  }

  get pid(): number | undefined {
    return this.#child.pid
  }

  get stderr(): string {
    return new TextDecoder().decode(this.#stderrBytes)
  }

  get stderrCapturedBytes(): number {
    return this.#stderrBytes.length
  }

  get stderrTotalBytes(): number {
    return this.#stderrTotalBytes
  }

  get stderrTruncated(): boolean {
    return this.#stderrTotalBytes > this.#stderrBytes.length
  }

  request<T>(request: JsonRpcRequest): Promise<T> {
    if (this.#failure) return Promise.reject(this.#failure)
    if (this.#closed) return Promise.reject(this.options.failure('closed', {}))
    if (this.#pending.has(request.id)) {
      return Promise.reject(new Error(`Duplicate process request id: ${request.id}`))
    }
    return new Promise<T>((resolve, reject) => {
      const pending: PendingRequest = {
        method: request.method,
        resolve: (result) => resolve(result as T),
        reject,
      }
      if (this.#requestTimeoutMs !== undefined) {
        pending.timer = setTimeout(() => {
          if (!this.#pending.delete(request.id)) return
          const error = this.options.failure('timeout', { method: request.method })
          pending.reject(error)
          this.fail(error)
        }, this.#requestTimeoutMs)
      }
      this.#pending.set(request.id, pending)
      this.#child.stdin.write(`${JSON.stringify(request)}\n`, (cause) => {
        if (!cause) return
        const active = this.#pending.get(request.id)
        if (!active) return
        this.#pending.delete(request.id)
        if (active.timer) clearTimeout(active.timer)
        const error = this.options.failure('write_failed', { method: request.method, cause })
        active.reject(error)
        this.fail(error)
      })
    })
  }

  async *notifications(): AsyncIterable<TNotification> {
    for (;;) {
      const next = await this.#notifications.next()
      if (next.done) return
      yield next.value
    }
  }

  close(): Promise<void> {
    this.#closing ??= this.closeOnce()
    return this.#closing
  }

  private async closeOnce(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    this.options.ipc?.close()
    if (this.#child.connected) this.#child.disconnect()
    this.#child.stdin.end()
    if (this.#child.exitCode === null && this.#child.signalCode === null) {
      const exitedGracefully = await waitForProcessExit(this.#child, this.#closeTimeoutMs)
      if (!exitedGracefully) {
        await terminateProcessTree(this.#child.pid)
        await waitForProcessExit(this.#child, this.#closeTimeoutMs)
      }
    }
    const error = this.options.failure('closed', {})
    this.rejectPending(error)
    this.#notifications.close()
  }

  private sendIpc(message: Serializable): Promise<void> {
    if (this.#failure) return Promise.reject(this.#failure)
    if (this.#closed || !this.#child.connected || !this.#child.send) {
      return Promise.reject(this.options.failure('closed', {}))
    }
    return new Promise<void>((resolve, reject) => {
      this.#child.send?.(message, (cause) => {
        if (cause) reject(cause)
        else resolve()
      })
    })
  }

  private onStdout(chunk: Buffer): void {
    if (this.#closed || this.#failure) return
    let offset = 0
    while (offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset)
      const end = newline < 0 ? chunk.length : newline
      const segment = chunk.subarray(offset, end)
      if (this.#stdoutBytes + segment.length > this.#maxLineBytes) {
        this.fail(this.options.failure('oversized_stdout', {}))
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
        line = this.#decoder.decode(normalized)
      } catch {
        this.fail(this.options.failure('malformed_stdout', {}))
        return
      }
      this.onLine(line)
      if (this.#closed || this.#failure) return
      offset = newline + 1
    }
  }

  private onStderr(chunk: Buffer): void {
    const mode = this.options.stderr ?? 'inherit'
    if (mode === 'inherit') process.stderr.write(chunk)
    if (mode === 'ignore') return
    this.#stderrTotalBytes += chunk.length
    this.#stderrBytes = Buffer.from(
      chunk.length >= this.#maxStderrBytes
        ? chunk.subarray(chunk.length - this.#maxStderrBytes)
        : Buffer.concat([this.#stderrBytes, chunk]).subarray(-this.#maxStderrBytes),
    )
  }

  private writeDedicatedInput(
    input: NonNullable<NdjsonProcessConnectionOptions<TNotification>['dedicatedInput']>,
  ): void {
    const channel = this.#child.stdio[3] as Writable | null
    if (!channel) {
      this.fail(this.options.failure('launch_input_failed', {}))
      return
    }
    channel.once('error', (cause) => {
      this.fail(this.options.failure('launch_input_failed', { cause }))
    })
    this.#child.once('spawn', () => {
      try {
        const pid = this.#child.pid
        if (!pid) throw new Error('Child process did not expose a PID.')
        channel.end(input.payloadForPid(pid))
      } catch (error) {
        const cause =
          error instanceof Error ? error : new Error('Launch input could not be encoded.')
        this.fail(this.options.failure('launch_input_failed', { cause }))
      }
    })
  }

  private onLine(line: string): void {
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      this.fail(this.options.failure('malformed_stdout', {}))
      return
    }
    let message: DecodedProcessMessage<TNotification>
    try {
      message = this.options.codec.decode(value, line, {
        pendingMethod: (id) => this.#pending.get(id)?.method,
      })
    } catch (error) {
      this.fail(error instanceof Error ? error : this.options.failure('malformed_stdout', {}))
      return
    }
    if (message.type === 'notification') {
      this.#notifications.push(message.notification)
      return
    }
    const pending = this.#pending.get(message.id)
    if (!pending) return
    this.#pending.delete(message.id)
    if (pending.timer) clearTimeout(pending.timer)
    if ('error' in message) pending.reject(message.error)
    else pending.resolve(message.result)
  }

  private fail(error: Error): void {
    if (this.#failure || this.#closed) return
    this.#failure = error
    this.rejectPending(error)
    this.#notifications.fail(error)
    void this.close()
  }

  private rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      if (pending.timer) clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.#pending.clear()
  }
}

class AsyncQueue<T> {
  readonly #values: T[] = []
  readonly #waiters: Array<{
    resolve(result: IteratorResult<T>): void
    reject(error: Error): void
  }> = []
  #closed = false
  #failure?: Error

  push(value: T): void {
    if (this.#closed) return
    const waiter = this.#waiters.shift()
    if (waiter) waiter.resolve({ value, done: false })
    else this.#values.push(value)
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    for (const waiter of this.#waiters.splice(0)) {
      waiter.resolve({ value: undefined, done: true })
    }
  }

  fail(error: Error): void {
    if (this.#closed) return
    this.#failure = error
    this.#closed = true
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error)
  }

  async next(): Promise<IteratorResult<T>> {
    if (this.#values.length > 0) return { value: this.#values.shift()!, done: false }
    if (this.#failure) throw this.#failure
    if (this.#closed) return { value: undefined, done: true }
    return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }))
  }
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(maximum, Math.max(minimum, Math.floor(Number(value))))
}

function positiveInteger(value: number | undefined): number | undefined {
  return Number.isFinite(value) && Number(value) > 0 ? Math.floor(Number(value)) : undefined
}
