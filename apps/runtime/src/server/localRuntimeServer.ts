import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type Server, type Socket } from 'node:net'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { runtimeError } from '@praxis/core-sdk'
import { terminateProcessTree, waitForProcessExit } from '../process/processTree.js'

export type LocalRuntimeServerOptions = {
  command: string
  args?: string[]
  cwd?: string
  host?: '127.0.0.1' | '::1'
  port?: number
  token?: string
  maxClients?: number
  maxLineBytes?: number
}

export type LocalRuntimeServerAddress = {
  host: string
  port: number
  token: string
}

/**
 * Loopback-only, authenticated, single-user transport. Each connection owns a
 * Runtime child; the server does not interpret or acquire Runtime authority.
 */
export class LocalRuntimeServer {
  readonly #server: Server
  readonly #options: Required<
    Pick<LocalRuntimeServerOptions, 'host' | 'port' | 'token' | 'maxClients' | 'maxLineBytes'>
  > &
    Omit<LocalRuntimeServerOptions, 'host' | 'port' | 'token' | 'maxClients' | 'maxLineBytes'>
  readonly #children = new Set<ChildProcessWithoutNullStreams>()
  readonly #childTerminations = new Map<ChildProcessWithoutNullStreams, Promise<void>>()
  readonly #sockets = new Set<Socket>()
  #clients = 0
  #shutdownPromise: Promise<void> | undefined

  constructor(options: LocalRuntimeServerOptions) {
    this.#options = {
      ...options,
      host: options.host ?? '127.0.0.1',
      port: options.port ?? 0,
      token: options.token ?? randomBytes(32).toString('base64url'),
      maxClients: bounded(options.maxClients, 1, 1, 16),
      maxLineBytes: bounded(options.maxLineBytes, 256 * 1024, 1024, 4 * 1024 * 1024),
    }
    this.#server = createServer((socket) => this.#accept(socket))
  }

  async start(): Promise<LocalRuntimeServerAddress> {
    await new Promise<void>((resolve, reject) => {
      this.#server.once('error', reject)
      this.#server.listen(this.#options.port, this.#options.host, () => {
        this.#server.removeListener('error', reject)
        resolve()
      })
    })
    const address = this.#server.address()
    if (!address || typeof address === 'string') throw serverError('LOCAL_SERVER_ADDRESS_INVALID')
    return { host: address.address, port: address.port, token: this.#options.token }
  }

  async shutdown(): Promise<void> {
    this.#shutdownPromise ??= this.#performShutdown()
    await this.#shutdownPromise
  }

  #accept(socket: Socket): void {
    this.#sockets.add(socket)
    socket.setNoDelay(true)
    const lines = createInterface({ input: socket, crlfDelay: Infinity })
    let authenticated = false
    let child: ChildProcessWithoutNullStreams | undefined
    let cleanedUp = false
    const cleanup = () => {
      if (cleanedUp) return
      cleanedUp = true
      lines.close()
      this.#sockets.delete(socket)
      if (child) void this.#terminateChild(child)
      if (authenticated) this.#clients = Math.max(0, this.#clients - 1)
    }
    socket.once('close', cleanup)
    socket.once('error', cleanup)
    lines.on('line', (line) => {
      if (Buffer.byteLength(line, 'utf8') > this.#options.maxLineBytes) {
        socket.destroy(socketError('LOCAL_SERVER_LINE_TOO_LARGE'))
        return
      }
      if (!authenticated) {
        if (
          !validAuthentication(line, this.#options.token) ||
          this.#clients >= this.#options.maxClients
        ) {
          socket.destroy(socketError('LOCAL_SERVER_AUTH_FAILED'))
          return
        }
        authenticated = true
        this.#clients += 1
        child = spawn(this.#options.command, this.#options.args ?? [], {
          cwd: this.#options.cwd,
          env: bootstrapEnvironment(),
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          detached: process.platform !== 'win32',
        })
        this.#children.add(child)
        child.stdout.pipe(socket, { end: false })
        child.stderr.resume()
        child.once('exit', () => {
          this.#children.delete(child!)
          socket.end()
        })
        child.once('error', () => socket.destroy(socketError('LOCAL_SERVER_RUNTIME_FAILED')))
        socket.write('{"authenticated":true}\n')
        return
      }
      child?.stdin.write(`${line}\n`)
    })
  }

  async #performShutdown(): Promise<void> {
    const serverClosed = this.#closeServer()
    for (const socket of this.#sockets) socket.destroy()
    await Promise.all([...this.#children].map((child) => this.#terminateChild(child)))
    await serverClosed
    this.#sockets.clear()
    this.#children.clear()
  }

  #closeServer(): Promise<void> {
    if (!this.#server.listening) return Promise.resolve()
    return new Promise<void>((resolve, reject) =>
      this.#server.close((error) => {
        if (!error || (error as NodeJS.ErrnoException).code === 'ERR_SERVER_NOT_RUNNING') resolve()
        else reject(error)
      }),
    )
  }

  #terminateChild(child: ChildProcessWithoutNullStreams): Promise<void> {
    const existing = this.#childTerminations.get(child)
    if (existing) return existing
    const termination = (async () => {
      if (child.exitCode === null && child.signalCode === null) {
        await terminateProcessTree(child.pid)
        await waitForProcessExit(child, 1_000)
      }
      this.#children.delete(child)
      this.#childTerminations.delete(child)
    })()
    this.#childTerminations.set(child, termination)
    return termination
  }
}

function validAuthentication(line: string, expected: string): boolean {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return false
  }
  if (
    !value ||
    typeof value !== 'object' ||
    typeof (value as { token?: unknown }).token !== 'string'
  ) {
    return false
  }
  const actual = Buffer.from((value as { token: string }).token)
  const wanted = Buffer.from(expected)
  return actual.byteLength === wanted.byteLength && timingSafeEqual(actual, wanted)
}

function bootstrapEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([name, value]) =>
        value !== undefined &&
        ['comspec', 'path', 'pathext', 'systemdrive', 'systemroot', 'windir'].includes(
          name.toLowerCase(),
        ),
    ),
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

function serverError(code: string) {
  return runtimeError(code, 'configuration', `Local Runtime server failed (${code}).`)
}

function socketError(code: string): Error {
  const error = new Error(`Local Runtime server failed (${code}).`)
  error.name = code
  return error
}
