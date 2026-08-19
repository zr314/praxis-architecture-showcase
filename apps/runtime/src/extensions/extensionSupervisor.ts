import { runtimeError } from '@praxis/core-sdk'

export type ExtensionHealth = 'stopped' | 'starting' | 'healthy' | 'degraded' | 'quarantined'

export type ExtensionAdapter = {
  start(signal: AbortSignal): Promise<void>
  health(signal: AbortSignal): Promise<boolean>
  invoke(method: string, input: unknown, signal: AbortSignal): Promise<unknown>
  stop(signal: AbortSignal): Promise<void>
}

export type SupervisedExtensionOptions = {
  startupTimeoutMs?: number
  healthTimeoutMs?: number
  invocationTimeoutMs?: number
  shutdownTimeoutMs?: number
  maxConcurrency?: number
  restartLimit?: number
  quarantineThreshold?: number
  maxStderrBytes?: number
}

type Instance = {
  id: string
  adapter: ExtensionAdapter
  options: Required<SupervisedExtensionOptions>
  health: ExtensionHealth
  restarts: number
  failures: number
  stderr: string
  semaphore: Semaphore
  active: Set<AbortController>
  starting?: Promise<void>
}

const DEFAULTS: Required<SupervisedExtensionOptions> = {
  startupTimeoutMs: 5_000,
  healthTimeoutMs: 1_000,
  invocationTimeoutMs: 30_000,
  shutdownTimeoutMs: 3_000,
  maxConcurrency: 4,
  restartLimit: 2,
  quarantineThreshold: 2,
  maxStderrBytes: 16_384,
}

/** Supervises external capabilities without transferring Runtime policy ownership. */
export class ExtensionSupervisor {
  readonly #instances = new Map<string, Instance>()

  register(id: string, adapter: ExtensionAdapter, options: SupervisedExtensionOptions = {}): void {
    if (this.#instances.has(id)) throw extensionFailure('PLUGIN_ALREADY_REGISTERED')
    const resolved = {
      startupTimeoutMs: bounded(options.startupTimeoutMs, DEFAULTS.startupTimeoutMs),
      healthTimeoutMs: bounded(options.healthTimeoutMs, DEFAULTS.healthTimeoutMs),
      invocationTimeoutMs: bounded(options.invocationTimeoutMs, DEFAULTS.invocationTimeoutMs),
      shutdownTimeoutMs: bounded(options.shutdownTimeoutMs, DEFAULTS.shutdownTimeoutMs),
      maxConcurrency: bounded(options.maxConcurrency, DEFAULTS.maxConcurrency, 1, 64),
      restartLimit: bounded(options.restartLimit, DEFAULTS.restartLimit, 0, 20),
      quarantineThreshold: bounded(
        options.quarantineThreshold,
        DEFAULTS.quarantineThreshold,
        1,
        20,
      ),
      maxStderrBytes: bounded(options.maxStderrBytes, DEFAULTS.maxStderrBytes, 1024, 1_048_576),
    }
    this.#instances.set(id, {
      id,
      adapter,
      options: resolved,
      health: 'stopped',
      restarts: 0,
      failures: 0,
      stderr: '',
      semaphore: new Semaphore(resolved.maxConcurrency),
      active: new Set(),
    })
  }

  async start(id: string): Promise<void> {
    const instance = this.require(id)
    if (instance.health === 'quarantined') throw extensionFailure('PLUGIN_QUARANTINED')
    if (instance.health === 'healthy') return
    if (instance.starting) return instance.starting
    instance.starting = this.startInstance(instance)
    try {
      await instance.starting
    } finally {
      delete instance.starting
    }
  }

  async invoke(id: string, method: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
    const instance = this.require(id)
    if (instance.health === 'quarantined') throw extensionFailure('PLUGIN_QUARANTINED')
    if (instance.health !== 'healthy') await this.start(id)
    const release = await instance.semaphore.acquire(signal)
    const controller = new AbortController()
    const forwardAbort = () => controller.abort(signal?.reason)
    signal?.addEventListener('abort', forwardAbort, { once: true })
    instance.active.add(controller)
    try {
      return await withDeadline(instance.options.invocationTimeoutMs, (deadlineSignal) =>
        instance.adapter.invoke(method, input, combineSignals(controller.signal, deadlineSignal)),
      )
    } catch (error) {
      if (this.#instances.get(id) === instance && !isCancellationFailure(error)) {
        await this.recordFailure(instance, error)
      }
      throw error
    } finally {
      signal?.removeEventListener('abort', forwardAbort)
      instance.active.delete(controller)
      release()
    }
  }

  captureStderr(id: string, delta: string): void {
    const instance = this.require(id)
    const combined = `${instance.stderr}${delta}`
    instance.stderr = combined.slice(-instance.options.maxStderrBytes)
  }

  stderr(id: string): string {
    return this.require(id).stderr
  }

  status(id: string): {
    health: ExtensionHealth
    restarts: number
    failures: number
    active: number
  } {
    const instance = this.require(id)
    return {
      health: instance.health,
      restarts: instance.restarts,
      failures: instance.failures,
      active: instance.active.size,
    }
  }

  async quarantine(id: string): Promise<void> {
    const instance = this.require(id)
    instance.health = 'quarantined'
    for (const controller of instance.active) controller.abort('quarantined')
    await withDeadline(instance.options.shutdownTimeoutMs, (signal) =>
      instance.adapter.stop(signal),
    ).catch(() => {})
  }

  async reload(id: string, development: boolean): Promise<void> {
    if (!development) throw extensionFailure('PLUGIN_RELOAD_PRODUCTION_FORBIDDEN')
    const instance = this.require(id)
    for (const controller of instance.active) controller.abort('reload')
    await withDeadline(instance.options.shutdownTimeoutMs, (signal) =>
      instance.adapter.stop(signal),
    ).catch(() => {})
    instance.health = 'stopped'
    instance.failures = 0
    await this.start(id)
  }

  async remove(id: string): Promise<void> {
    const instance = this.require(id)
    this.#instances.delete(id)
    for (const controller of instance.active) controller.abort('removed')
    await instance.starting?.catch(() => undefined)
    await withDeadline(instance.options.shutdownTimeoutMs, (signal) =>
      instance.adapter.stop(signal),
    ).catch(() => {})
    instance.health = 'stopped'
  }

  async shutdown(): Promise<void> {
    await Promise.all(
      [...this.#instances.values()].map(async (instance) => {
        for (const controller of instance.active) controller.abort('shutdown')
        if (instance.health !== 'stopped') {
          await withDeadline(instance.options.shutdownTimeoutMs, (signal) =>
            instance.adapter.stop(signal),
          ).catch(() => {})
        }
        instance.health = 'stopped'
      }),
    )
  }

  private async recordFailure(instance: Instance, error: unknown): Promise<void> {
    instance.failures += 1
    if (isProtocolFailure(error) || instance.failures >= instance.options.quarantineThreshold) {
      await this.quarantine(instance.id)
      return
    }
    instance.health = 'degraded'
    if (instance.restarts >= instance.options.restartLimit) return
    instance.restarts += 1
    await withDeadline(instance.options.shutdownTimeoutMs, (signal) =>
      instance.adapter.stop(signal),
    ).catch(() => {})
    instance.health = 'stopped'
  }

  private async startInstance(instance: Instance): Promise<void> {
    instance.health = 'starting'
    try {
      await withDeadline(instance.options.startupTimeoutMs, (signal) =>
        instance.adapter.start(signal),
      )
      const healthy = await withDeadline(instance.options.healthTimeoutMs, (signal) =>
        instance.adapter.health(signal),
      )
      if (!healthy) throw extensionFailure('PLUGIN_HEALTHCHECK_FAILED')
      instance.health = 'healthy'
      instance.failures = 0
    } catch (error) {
      instance.health = 'degraded'
      await this.recordFailure(instance, error)
      throw error
    }
  }

  private require(id: string): Instance {
    const instance = this.#instances.get(id)
    if (!instance) throw extensionFailure('PLUGIN_NOT_REGISTERED')
    return instance
  }
}

class Semaphore {
  #available: number
  readonly #waiters: Array<{
    resolve: (release: () => void) => void
    reject: (error: unknown) => void
    signal?: AbortSignal
  }> = []

  constructor(available: number) {
    this.#available = available
  }

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(extensionFailure('PLUGIN_CANCELLED'))
    if (this.#available > 0) {
      this.#available -= 1
      return Promise.resolve(() => this.release())
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, ...(signal ? { signal } : {}) }
      this.#waiters.push(waiter)
      signal?.addEventListener(
        'abort',
        () => {
          const index = this.#waiters.indexOf(waiter)
          if (index >= 0) this.#waiters.splice(index, 1)
          reject(extensionFailure('PLUGIN_CANCELLED'))
        },
        { once: true },
      )
    })
  }

  private release(): void {
    const waiter = this.#waiters.shift()
    if (waiter) waiter.resolve(() => this.release())
    else this.#available += 1
  }
}

function withDeadline<T>(
  milliseconds: number,
  action: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController()
  let timeout: NodeJS.Timeout
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort('deadline')
      reject(extensionFailure('PLUGIN_DEADLINE_EXCEEDED'))
    }, milliseconds)
  })
  return Promise.race([action(controller.signal), deadline]).finally(() => clearTimeout(timeout))
}

function combineSignals(left: AbortSignal, right: AbortSignal): AbortSignal {
  if (left.aborted) return left
  if (right.aborted) return right
  const controller = new AbortController()
  left.addEventListener('abort', () => controller.abort(left.reason), { once: true })
  right.addEventListener('abort', () => controller.abort(right.reason), { once: true })
  return controller.signal
}

function bounded(
  value: number | undefined,
  fallback: number,
  minimum = 10,
  maximum = 300_000,
): number {
  return Math.min(maximum, Math.max(minimum, Math.floor(value ?? fallback)))
}

function isProtocolFailure(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    String((error as { code: unknown }).code).includes('PROTOCOL')
  )
}

function isCancellationFailure(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const code = (error as { code?: unknown }).code
  const category = (error as { category?: unknown }).category
  return (
    category === 'cancelled' ||
    code === 'MCP_REQUEST_CANCELLED' ||
    code === 'PLUGIN_CANCELLED' ||
    code === 'PROCESS_PLUGIN_CANCELLED' ||
    code === 'PROVIDER_CANCELLED'
  )
}

function extensionFailure(code: string) {
  return runtimeError(code, code.includes('CANCEL') ? 'cancelled' : 'plugin', 'Extension failed.')
}
