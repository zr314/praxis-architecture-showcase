import { createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import {
  runtimeError,
  type ChatProvider,
  type RuntimeTool,
  type ToolProgressUpdate,
  type ToolRequest,
  type ToolResult,
} from '@praxis/core-sdk'
import type { IsolationBackend } from '../security/isolationBackend.js'
import { platformIsolationBackend } from '../security/isolationBackend.js'
import { ProcessPluginHost, type ProcessPluginClient } from '../plugin/processPluginHost.js'
import type {
  ProcessPluginCapabilityManifest,
  ProcessPluginEvent,
  ProcessPluginToolCapabilityManifest,
} from '../plugin/processPluginProtocol.js'
import type { ExtensionInstallationService, ProcessPluginSelection } from './installationService.js'
import {
  ExtensionSupervisor,
  type ExtensionAdapter,
  type SupervisedExtensionOptions,
} from './extensionSupervisor.js'
import { ProcessProvider } from './processProvider.js'

type ActivePlugin = {
  selection: ProcessPluginSelection
  adapter: ProcessPluginAdapter
}

export type ProcessCapabilitySnapshot = Readonly<{
  workspace: string
  tools: readonly RuntimeTool[]
  providers: ReadonlyMap<string, ChatProvider>
  plugins: readonly Readonly<{
    pluginId: string
    health: 'healthy' | 'quarantined'
  }>[]
}>

export type ProcessActivationOptions = {
  supervisor?: ExtensionSupervisor
  isolationBackend?: IsolationBackend
  environment?: NodeJS.ProcessEnv
  supervisorOptions?: SupervisedExtensionOptions
}

/** Activates digest-pinned Praxis process Tool and Provider capabilities. */
export class ProcessActivationService {
  readonly #installations: ExtensionInstallationService
  readonly #supervisor: ExtensionSupervisor
  readonly #isolationBackend: IsolationBackend
  readonly #environment: NodeJS.ProcessEnv
  readonly #supervisorOptions: SupervisedExtensionOptions
  readonly #workspaces = new Map<string, Map<string, ActivePlugin>>()
  readonly #workspaceQueues = new Map<string, Promise<unknown>>()

  constructor(installations: ExtensionInstallationService, options: ProcessActivationOptions = {}) {
    this.#installations = installations
    this.#supervisor = options.supervisor ?? new ExtensionSupervisor()
    this.#isolationBackend = options.isolationBackend ?? platformIsolationBackend()
    this.#environment = options.environment ?? process.env
    this.#supervisorOptions = options.supervisorOptions ?? {}
  }

  async snapshot(workspace: string): Promise<ProcessCapabilitySnapshot> {
    const canonical = await realpath(workspace)
    return this.#serialize(canonical, () => this.#snapshotCanonical(canonical))
  }

  async #snapshotCanonical(canonical: string): Promise<ProcessCapabilitySnapshot> {
    const previous = this.#workspaces.get(canonical) ?? new Map<string, ActivePlugin>()
    let selections: ProcessPluginSelection[]
    try {
      selections = await this.#installations.processPluginSelections(canonical)
    } catch {
      this.#workspaces.set(canonical, new Map())
      await removePlugins(this.#supervisor, previous.values())
      const affected = (await this.#installations.list(canonical)).filter(
        (plugin) => plugin.enabled && plugin.isolation === 'process',
      )
      await Promise.all(
        affected.map((plugin) =>
          this.#installations.setHealth(canonical, plugin.id, 'quarantined'),
        ),
      )
      return frozenSnapshot(
        canonical,
        [],
        new Map(),
        affected.map(({ id }) => ({ pluginId: id, health: 'quarantined' as const })),
      )
    }

    const next = new Map<string, ActivePlugin>()
    const statuses: Array<{
      pluginId: string
      health: 'healthy' | 'quarantined'
    }> = []
    for (const selection of selections) {
      const existing = previous.get(selection.instanceId)
      try {
        if (existing && sameSelection(existing.selection, selection)) {
          await this.#supervisor.invoke(selection.instanceId, 'capabilities/refresh', {})
          next.set(selection.instanceId, existing)
        } else {
          const adapter = new ProcessPluginAdapter(
            selection,
            canonical,
            this.#isolationBackend,
            selectedEnvironment(selection, this.#environment),
          )
          this.#supervisor.register(selection.instanceId, adapter, {
            restartLimit: 0,
            quarantineThreshold: 1,
            ...this.#supervisorOptions,
          })
          await this.#supervisor.start(selection.instanceId)
          next.set(selection.instanceId, { selection, adapter })
        }
        statuses.push({ pluginId: selection.pluginId, health: 'healthy' })
      } catch {
        await this.#supervisor.remove(selection.instanceId).catch(() => undefined)
        statuses.push({ pluginId: selection.pluginId, health: 'quarantined' })
      }
    }

    let publications: ReturnType<typeof publishCapabilities>
    try {
      publications = publishCapabilities(
        next,
        this.#supervisor,
        (active) => this.#workspaces.get(canonical)?.get(active.selection.instanceId) === active,
        (active) => this.#handleInvocationFailure(canonical, active),
      )
      this.#workspaces.set(canonical, next)
      await removePlugins(
        this.#supervisor,
        [...previous.values()].filter((active) => next.get(active.selection.instanceId) !== active),
      )
    } catch {
      this.#workspaces.set(canonical, new Map())
      await removePlugins(this.#supervisor, [...previous.values(), ...next.values()])
      for (const status of statuses) status.health = 'quarantined'
      publications = { tools: [], providers: new Map() }
    }
    await Promise.all(
      statuses.map(({ pluginId, health }) =>
        this.#installations.setHealth(canonical, pluginId, health),
      ),
    )
    return frozenSnapshot(canonical, publications.tools, publications.providers, statuses)
  }

  async deactivate(workspace: string, pluginId: string): Promise<void> {
    const canonical = await realpath(workspace)
    await this.#serialize(canonical, async () => {
      const current = this.#workspaces.get(canonical)
      if (current) {
        const affected = [...current.values()].filter(
          (active) => active.selection.pluginId === pluginId,
        )
        this.#workspaces.set(
          canonical,
          new Map([...current].filter(([, active]) => active.selection.pluginId !== pluginId)),
        )
        await removePlugins(this.#supervisor, affected)
      }
      await this.#installations.setHealth(canonical, pluginId, 'stopped').catch(() => undefined)
    })
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled([...this.#workspaceQueues.values()])
    const active = [...this.#workspaces].flatMap(([workspace, plugins]) =>
      [...plugins.values()].map(({ selection }) => ({
        workspace,
        pluginId: selection.pluginId,
        instanceId: selection.instanceId,
      })),
    )
    this.#workspaces.clear()
    await Promise.all(
      active.map(({ instanceId }) => this.#supervisor.remove(instanceId).catch(() => undefined)),
    )
    await Promise.all(
      active.map(({ workspace, pluginId }) =>
        this.#installations.setHealth(workspace, pluginId, 'stopped').catch(() => undefined),
      ),
    )
  }

  #serialize<T>(workspace: string, action: () => Promise<T>): Promise<T> {
    const previous = this.#workspaceQueues.get(workspace) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(action)
    this.#workspaceQueues.set(workspace, current)
    return current.finally(() => {
      if (this.#workspaceQueues.get(workspace) === current) {
        this.#workspaceQueues.delete(workspace)
      }
    })
  }

  async #handleInvocationFailure(canonical: string, failed: ActivePlugin): Promise<void> {
    try {
      if (this.#supervisor.status(failed.selection.instanceId).health !== 'quarantined') return
    } catch {
      return
    }
    await this.#serialize(canonical, async () => {
      const current = this.#workspaces.get(canonical)
      if (current?.get(failed.selection.instanceId) !== failed) return
      this.#workspaces.set(
        canonical,
        new Map(
          [...current].filter(
            ([, active]) => active.selection.pluginId !== failed.selection.pluginId,
          ),
        ),
      )
      await this.#supervisor.remove(failed.selection.instanceId).catch(() => undefined)
      await this.#installations.setHealth(canonical, failed.selection.pluginId, 'quarantined')
    })
  }
}

class ProcessPluginAdapter implements ExtensionAdapter {
  readonly #selection: ProcessPluginSelection
  readonly #workspace: string
  readonly #host: ProcessPluginHost
  readonly #isolationBackend: IsolationBackend
  readonly #environment: Record<string, string>
  #client?: ProcessPluginClient

  constructor(
    selection: ProcessPluginSelection,
    workspace: string,
    isolationBackend: IsolationBackend,
    environment: Record<string, string>,
  ) {
    this.#selection = selection
    this.#workspace = workspace
    this.#host = new ProcessPluginHost({ enabled: true })
    this.#isolationBackend = isolationBackend
    this.#environment = environment
  }

  async start(signal: AbortSignal): Promise<void> {
    const client = await this.#host.start({
      command: process.execPath,
      args: [this.#selection.entryPath],
      cwd: this.#selection.pluginRoot,
      pluginId: this.#selection.pluginId,
      workspace: this.#workspace,
      grants: this.#selection.grants,
      version: this.#selection.version,
      capabilities: this.#selection.capabilities,
      isolation: {
        backend: this.#isolationBackend,
        pluginRoot: this.#selection.pluginRoot,
        grants: this.#selection.grants,
        environment: this.#environment,
        allowTrustedOnly: this.#selection.trustedOnly,
      },
    })
    if (signal.aborted) {
      await client.shutdown()
      throw staleCapability()
    }
    this.#client = client
  }

  async health(signal: AbortSignal): Promise<boolean> {
    return !signal.aborted && this.#client !== undefined && (await this.#client.health())
  }

  async invoke(method: string, input: unknown, signal: AbortSignal): Promise<unknown> {
    const client = this.requireClient()
    if (method === 'capabilities/refresh') return client.health()
    if (method === 'capability.cancel' && isCancellation(input)) {
      await client.cancel(input.cancellationId, input.reason)
      return { accepted: true }
    }
    if (method !== 'capability.invoke' || !isInvocation(input)) {
      throw runtimeError(
        'PROCESS_PLUGIN_PROTOCOL_INVALID',
        'plugin',
        'Invalid process plugin adapter invocation.',
      )
    }
    const cancellationId = input.cancellationId ?? `process-${crypto.randomUUID()}`
    const abort = () => {
      void client.cancel(cancellationId, 'user_abort').catch(() => undefined)
    }
    signal.addEventListener('abort', abort, { once: true })
    try {
      return await client.invoke(
        input.capabilityId,
        input.input,
        cancellationId,
        undefined,
        input.onEvent,
      )
    } finally {
      signal.removeEventListener('abort', abort)
    }
  }

  async stop(_signal: AbortSignal): Promise<void> {
    const client = this.#client
    this.#client = undefined
    await client?.shutdown()
  }

  capabilities(): readonly ProcessPluginCapabilityManifest[] {
    return this.requireClient().capabilities
  }

  credentialsReady(): boolean {
    return this.#selection.credentials.every((name) => Object.hasOwn(this.#environment, name))
  }

  private requireClient(): ProcessPluginClient {
    if (!this.#client) throw staleCapability()
    return this.#client
  }
}

function publishCapabilities(
  plugins: Map<string, ActivePlugin>,
  supervisor: ExtensionSupervisor,
  isCurrent: (active: ActivePlugin) => boolean,
  onFailure: (active: ActivePlugin) => Promise<void>,
): { tools: RuntimeTool[]; providers: Map<string, ChatProvider> } {
  const tools: RuntimeTool[] = []
  const providers = new Map<string, ChatProvider>()
  const toolNames = new Set<string>()
  for (const active of plugins.values()) {
    for (const capability of active.adapter.capabilities()) {
      if (capability.kind === 'tool') {
        const tool = processTool(active, capability, supervisor, isCurrent, onFailure)
        if (toolNames.has(tool.definition.name)) throw capabilityCollision()
        toolNames.add(tool.definition.name)
        tools.push(tool)
      } else {
        const id = processProviderId(active.selection.pluginId, capability.id)
        if (providers.has(id)) throw capabilityCollision()
        providers.set(
          id,
          new ProcessProvider({
            id,
            defaultModel: capability.provider.defaultModel,
            capabilityId: capability.id,
            capabilities: capability.provider.capabilities,
            authState: () =>
              active.adapter.credentialsReady()
                ? { status: 'authenticated', accountLabel: id }
                : { status: 'unauthenticated' },
            onProtocolFailure: async () => {
              await supervisor.quarantine(active.selection.instanceId).catch(() => undefined)
              await onFailure(active)
            },
            client: {
              invoke: async (capabilityId, input, cancellationId, onEvent) => {
                if (!isCurrent(active)) throw staleCapability()
                try {
                  return await supervisor.invoke(active.selection.instanceId, 'capability.invoke', {
                    capabilityId,
                    input,
                    cancellationId,
                    ...(onEvent
                      ? {
                          onEvent: (event: ProcessPluginEvent) =>
                            onEvent({ type: event.params.type, payload: event.params.payload }),
                        }
                      : {}),
                  })
                } catch (error) {
                  await onFailure(active)
                  throw error
                }
              },
              cancel: async (cancellationId, reason) => {
                await supervisor
                  .invoke(active.selection.instanceId, 'capability.cancel', {
                    cancellationId,
                    reason,
                  })
                  .catch(() => undefined)
              },
            },
          }),
        )
      }
    }
  }
  return { tools, providers }
}

function processTool(
  active: ActivePlugin,
  descriptor: ProcessPluginToolCapabilityManifest,
  supervisor: ExtensionSupervisor,
  isCurrent: (active: ActivePlugin) => boolean,
  onFailure: (active: ActivePlugin) => Promise<void>,
): RuntimeTool {
  const definition = {
    name: processRuntimeToolName(active.selection.pluginId, descriptor.id),
    description: `Process Tool ${descriptor.id}.`,
    parameters: structuredClone(descriptor.inputSchema),
    outputSchema: structuredClone(descriptor.outputSchema),
    execution: structuredClone(descriptor.execution),
  }
  return {
    definition,
    execute: async (request: ToolRequest): Promise<ToolResult> => {
      if (!isCurrent(active)) throw staleCapability()
      try {
        const output = await supervisor.invoke(
          active.selection.instanceId,
          'capability.invoke',
          {
            capabilityId: descriptor.id,
            input: request.input,
            onEvent: (event: ProcessPluginEvent) => forwardProgress(request, event),
          },
          request.signal,
        )
        return {
          ok: true,
          summary: `Process Tool ${descriptor.id} completed.`,
          output,
        }
      } catch (error) {
        await onFailure(active)
        throw error
      }
    },
  }
}

function forwardProgress(request: ToolRequest, event: ProcessPluginEvent): void {
  if (event.params.type !== 'progress') return
  const payload = event.params.payload
  if (typeof payload.message !== 'string' || payload.message.length === 0) return
  const update: ToolProgressUpdate = {
    message: payload.message,
    ...(payload.stream === 'stdout' || payload.stream === 'stderr'
      ? { stream: payload.stream }
      : {}),
    ...(typeof payload.delta === 'string' ? { delta: payload.delta } : {}),
    ...(typeof payload.bytes === 'number' ? { bytes: payload.bytes } : {}),
  }
  request.onUpdate?.(update)
}

function selectedEnvironment(
  selection: ProcessPluginSelection,
  environment: NodeJS.ProcessEnv,
): Record<string, string> {
  const approved = new Set(
    selection.grants
      .filter((grant) => grant.type === 'environment')
      .flatMap((grant) => grant.names),
  )
  const declared = new Set(selection.credentials)
  return Object.fromEntries(
    [...approved]
      .filter((name) => declared.size === 0 || declared.has(name))
      .flatMap((name) => (environment[name] === undefined ? [] : [[name, environment[name]!]])),
  )
}

function isInvocation(value: unknown): value is {
  capabilityId: string
  input: unknown
  cancellationId?: string
  onEvent?: (event: ProcessPluginEvent) => void
} {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { capabilityId?: unknown }).capabilityId === 'string' &&
    Object.hasOwn(value, 'input') &&
    ((value as { cancellationId?: unknown }).cancellationId === undefined ||
      typeof (value as { cancellationId?: unknown }).cancellationId === 'string') &&
    ((value as { onEvent?: unknown }).onEvent === undefined ||
      typeof (value as { onEvent?: unknown }).onEvent === 'function')
  )
}

function isCancellation(value: unknown): value is {
  cancellationId: string
  reason:
    | 'user_abort'
    | 'deadline_exceeded'
    | 'budget_exhausted'
    | 'parent_cancelled'
    | 'plugin_failure'
    | 'runtime_shutdown'
} {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { cancellationId?: unknown }).cancellationId === 'string' &&
    [
      'user_abort',
      'deadline_exceeded',
      'budget_exhausted',
      'parent_cancelled',
      'plugin_failure',
      'runtime_shutdown',
    ].includes(String((value as { reason?: unknown }).reason))
  )
}

function sameSelection(left: ProcessPluginSelection, right: ProcessPluginSelection): boolean {
  return (
    left.pluginId === right.pluginId &&
    left.version === right.version &&
    left.digest === right.digest &&
    left.instanceId === right.instanceId &&
    left.entryPath === right.entryPath &&
    left.trustedOnly === right.trustedOnly
  )
}

function frozenSnapshot(
  workspace: string,
  tools: RuntimeTool[],
  providers: Map<string, ChatProvider>,
  plugins: Array<{ pluginId: string; health: 'healthy' | 'quarantined' }>,
): ProcessCapabilitySnapshot {
  return Object.freeze({
    workspace,
    tools: Object.freeze([...tools]),
    providers: new ReadonlyMapView(providers),
    plugins: Object.freeze(plugins.map((plugin) => Object.freeze({ ...plugin }))),
  })
}

class ReadonlyMapView<K, V> implements ReadonlyMap<K, V> {
  readonly #values: Map<K, V>

  constructor(values: ReadonlyMap<K, V>) {
    this.#values = new Map(values)
  }

  get size(): number {
    return this.#values.size
  }

  get(key: K): V | undefined {
    return this.#values.get(key)
  }

  has(key: K): boolean {
    return this.#values.has(key)
  }

  entries(): MapIterator<[K, V]> {
    return this.#values.entries()
  }

  keys(): MapIterator<K> {
    return this.#values.keys()
  }

  values(): MapIterator<V> {
    return this.#values.values()
  }

  forEach(callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
    for (const [key, value] of this.#values) callbackfn.call(thisArg, value, key, this)
  }

  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.entries()
  }
}

function processProviderId(pluginId: string, capabilityId: string): string {
  return `${pluginId}/${capabilityId}`
}

export function processRuntimeToolName(pluginId: string, capabilityId: string): string {
  return `process__${boundedNamePart(pluginId, 12)}__${boundedNamePart(capabilityId, 16)}`
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

async function removePlugins(
  supervisor: ExtensionSupervisor,
  plugins: Iterable<ActivePlugin>,
): Promise<void> {
  const ids = new Set([...plugins].map(({ selection }) => selection.instanceId))
  await Promise.all([...ids].map((id) => supervisor.remove(id).catch(() => undefined)))
}

function staleCapability() {
  return runtimeError(
    'PROCESS_CAPABILITY_STALE',
    'plugin',
    'The process capability is no longer part of the active Runtime snapshot.',
  )
}

function capabilityCollision() {
  return runtimeError(
    'CAPABILITY_CONFLICT',
    'plugin',
    'Process plugin capability identity collision.',
  )
}
