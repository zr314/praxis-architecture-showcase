import { realpath } from 'node:fs/promises'
import type { RuntimeTool, ToolProgressUpdate, ToolRequest, ToolResult } from '@praxis/core-sdk'
import { runtimeError } from '@praxis/core-sdk'
import type { ExtensionInstallationService, McpServerSelection } from './installationService.js'
import { ExtensionSupervisor, type ExtensionAdapter } from './extensionSupervisor.js'
import { McpStdioClient } from './mcpStdioClient.js'

type McpInvocation = {
  remoteName: string
  input: Record<string, unknown>
  onUpdate?: (update: ToolProgressUpdate) => void
}

type ActiveServer = {
  selection: McpServerSelection
  adapter: McpServerAdapter
}

export type McpToolSnapshot = Readonly<{
  workspace: string
  tools: readonly RuntimeTool[]
  servers: readonly Readonly<{
    pluginId: string
    serverId: string
    health: 'healthy' | 'quarantined'
  }>[]
}>

export type McpActivationOptions = {
  supervisor?: ExtensionSupervisor
  environment?: NodeJS.ProcessEnv
}

/** Publishes fixed-installation MCP Tools through one supervised Runtime registry. */
export class McpActivationService {
  readonly #installations: ExtensionInstallationService
  readonly #supervisor: ExtensionSupervisor
  readonly #environment: NodeJS.ProcessEnv
  readonly #workspaces = new Map<string, Map<string, ActiveServer>>()
  readonly #workspaceQueues = new Map<string, Promise<unknown>>()

  constructor(installations: ExtensionInstallationService, options: McpActivationOptions = {}) {
    this.#installations = installations
    this.#supervisor = options.supervisor ?? new ExtensionSupervisor()
    this.#environment = options.environment ?? process.env
  }

  async snapshot(workspace: string): Promise<McpToolSnapshot> {
    const canonical = await realpath(workspace)
    return this.#serialize(canonical, () => this.#snapshotCanonical(canonical))
  }

  async #snapshotCanonical(canonical: string): Promise<McpToolSnapshot> {
    const previous = this.#workspaces.get(canonical) ?? new Map<string, ActiveServer>()
    let selections: McpServerSelection[]
    try {
      selections = await this.#installations.mcpServerSelections(canonical)
    } catch {
      this.#workspaces.set(canonical, new Map())
      await removeServers(this.#supervisor, previous.values())
      const affected = (await this.#installations.list(canonical)).filter(
        (plugin) => plugin.enabled && plugin.isolation === 'mcp-stdio',
      )
      await Promise.all(
        affected.map((plugin) =>
          this.#installations.setHealth(canonical, plugin.id, 'quarantined'),
        ),
      )
      return Object.freeze({
        workspace: canonical,
        tools: Object.freeze([]),
        servers: Object.freeze(
          affected.map((plugin) =>
            Object.freeze({
              pluginId: plugin.id,
              serverId: 'unresolved',
              health: 'quarantined' as const,
            }),
          ),
        ),
      })
    }
    const next = new Map<string, ActiveServer>()
    const statuses: Array<{
      pluginId: string
      serverId: string
      health: 'healthy' | 'quarantined'
    }> = []
    for (const selection of selections) {
      const existing = previous.get(selection.instanceId)
      try {
        if (existing && sameSelection(existing.selection, selection)) {
          await this.#supervisor.invoke(selection.instanceId, 'tools/refresh', {})
          next.set(selection.instanceId, existing)
        } else {
          const adapter = new McpServerAdapter(
            selection,
            selectedEnvironment(selection, this.#environment),
          )
          this.#supervisor.register(selection.instanceId, adapter, {
            restartLimit: 0,
            quarantineThreshold: 1,
          })
          await this.#supervisor.start(selection.instanceId)
          next.set(selection.instanceId, { selection, adapter })
        }
        statuses.push({
          pluginId: selection.pluginId,
          serverId: selection.serverId,
          health: 'healthy',
        })
      } catch {
        await this.#supervisor.remove(selection.instanceId).catch(() => undefined)
        statuses.push({
          pluginId: selection.pluginId,
          serverId: selection.serverId,
          health: 'quarantined',
        })
      }
    }
    const quarantinedPlugins = new Set(
      statuses.filter(({ health }) => health === 'quarantined').map(({ pluginId }) => pluginId),
    )
    if (quarantinedPlugins.size > 0) {
      const affected = [...next.values()].filter((active) =>
        quarantinedPlugins.has(active.selection.pluginId),
      )
      for (const active of affected) next.delete(active.selection.instanceId)
      await removeServers(this.#supervisor, affected)
      for (const status of statuses) {
        if (quarantinedPlugins.has(status.pluginId)) status.health = 'quarantined'
      }
    }
    let tools: RuntimeTool[]
    let publicationFailed = false
    try {
      tools = publishTools(
        next,
        this.#supervisor,
        (active) => {
          return this.#workspaces.get(canonical)?.get(active.selection.instanceId) === active
        },
        (active) => this.#handleInvocationFailure(canonical, active),
      )
    } catch {
      publicationFailed = true
      this.#workspaces.set(canonical, new Map())
      await removeServers(this.#supervisor, [...previous.values(), ...next.values()])
      for (const status of statuses) status.health = 'quarantined'
      tools = []
    }
    if (!publicationFailed) {
      this.#workspaces.set(canonical, next)
      await removeServers(
        this.#supervisor,
        [...previous.values()].filter((active) => next.get(active.selection.instanceId) !== active),
      )
    }
    await persistPluginHealth(this.#installations, canonical, statuses)
    return Object.freeze({
      workspace: canonical,
      tools: Object.freeze(tools),
      servers: Object.freeze(statuses.map((status) => Object.freeze({ ...status }))),
    })
  }

  async deactivate(workspace: string, pluginId: string): Promise<void> {
    const canonical = await realpath(workspace)
    await this.#serialize(canonical, () => this.#deactivateCanonical(canonical, pluginId))
  }

  async #deactivateCanonical(canonical: string, pluginId: string): Promise<void> {
    const current = this.#workspaces.get(canonical)
    if (current) {
      const next = new Map(
        [...current].filter(([, active]) => active.selection.pluginId !== pluginId),
      )
      this.#workspaces.set(canonical, next)
      await Promise.all(
        [...current.values()]
          .filter((active) => active.selection.pluginId === pluginId)
          .map((active) => this.#supervisor.remove(active.selection.instanceId)),
      )
    }
    await this.#installations.setHealth(canonical, pluginId, 'stopped').catch(() => undefined)
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled([...this.#workspaceQueues.values()])
    const active = [...this.#workspaces].flatMap(([workspace, servers]) =>
      [...new Set([...servers.values()].map(({ selection }) => selection.pluginId))].map(
        (pluginId) => ({ workspace, pluginId }),
      ),
    )
    this.#workspaces.clear()
    await this.#supervisor.shutdown()
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

  async #handleInvocationFailure(canonical: string, failed: ActiveServer): Promise<void> {
    try {
      if (this.#supervisor.status(failed.selection.instanceId).health !== 'quarantined') return
    } catch {
      return
    }
    await this.#serialize(canonical, async () => {
      const current = this.#workspaces.get(canonical)
      if (current?.get(failed.selection.instanceId) !== failed) return
      const affected = [...current.values()].filter(
        (active) => active.selection.pluginId === failed.selection.pluginId,
      )
      this.#workspaces.set(
        canonical,
        new Map(
          [...current].filter(
            ([, active]) => active.selection.pluginId !== failed.selection.pluginId,
          ),
        ),
      )
      await removeServers(this.#supervisor, affected)
      await this.#installations.setHealth(canonical, failed.selection.pluginId, 'quarantined')
    })
  }
}

class McpServerAdapter implements ExtensionAdapter {
  readonly #selection: McpServerSelection
  readonly #environment: Record<string, string>
  #client?: McpStdioClient

  constructor(selection: McpServerSelection, environment: Record<string, string>) {
    this.#selection = selection
    this.#environment = environment
  }

  async start(signal: AbortSignal): Promise<void> {
    const client = await McpStdioClient.start({
      command: process.execPath,
      args: [this.#selection.entryPath],
      pluginId: this.#selection.pluginId,
      serverId: this.#selection.serverId,
      environment: this.#environment,
      signal,
    })
    if (signal.aborted) {
      await client.shutdown()
      throw staleCapability()
    }
    this.#client = client
  }

  async health(signal: AbortSignal): Promise<boolean> {
    return !signal.aborted && this.#client !== undefined
  }

  async invoke(method: string, input: unknown, signal: AbortSignal): Promise<unknown> {
    const client = this.requireClient()
    if (method === 'tools/refresh') {
      return client.refreshTools()
    }
    if (method !== 'tools/call' || !isMcpInvocation(input)) {
      throw runtimeError('MCP_PROTOCOL_INVALID', 'plugin', 'Invalid MCP adapter invocation.')
    }
    return client.callTool(input.remoteName, input.input, signal, input.onUpdate)
  }

  async stop(_signal: AbortSignal): Promise<void> {
    const client = this.#client
    this.#client = undefined
    await client?.shutdown()
  }

  publications(): Array<{ remoteName: string; tool: RuntimeTool }> {
    const client = this.requireClient()
    const descriptors = client.listTools()
    const tools = client.runtimeTools()
    return tools.map((tool, index) => ({
      remoteName: descriptors[index]?.name ?? '',
      tool,
    }))
  }

  private requireClient(): McpStdioClient {
    if (!this.#client) throw staleCapability()
    return this.#client
  }
}

function selectedEnvironment(
  selection: McpServerSelection,
  environment: NodeJS.ProcessEnv,
): Record<string, string> {
  const approved = new Set(
    selection.grants
      .filter((grant) => grant.type === 'environment')
      .flatMap((grant) => grant.names),
  )
  return Object.fromEntries(
    [...approved].flatMap((name) =>
      environment[name] === undefined ? [] : [[name, environment[name]!]],
    ),
  )
}

function publishTools(
  activeServers: Map<string, ActiveServer>,
  supervisor: ExtensionSupervisor,
  isCurrent: (active: ActiveServer) => boolean,
  onFailure: (active: ActiveServer) => Promise<void>,
): RuntimeTool[] {
  const serviceTools: RuntimeTool[] = []
  const names = new Set<string>()
  for (const active of activeServers.values()) {
    for (const publication of active.adapter.publications()) {
      const definition = structuredClone(publication.tool.definition)
      if (!publication.remoteName || names.has(definition.name)) {
        throw runtimeError('MCP_TOOL_COLLISION', 'plugin', 'MCP Tool identity collision.')
      }
      names.add(definition.name)
      const execute = async (request: ToolRequest): Promise<ToolResult> => {
        if (!isCurrent(active)) throw staleCapability()
        try {
          return (await supervisor.invoke(
            active.selection.instanceId,
            'tools/call',
            {
              remoteName: publication.remoteName,
              input: request.input,
              ...(request.onUpdate ? { onUpdate: request.onUpdate } : {}),
            } satisfies McpInvocation,
            request.signal,
          )) as ToolResult
        } catch (error) {
          await onFailure(active)
          throw error
        }
      }
      serviceTools.push({ definition, execute })
    }
  }
  return serviceTools
}

function sameSelection(left: McpServerSelection, right: McpServerSelection): boolean {
  return (
    left.pluginId === right.pluginId &&
    left.serverId === right.serverId &&
    left.version === right.version &&
    left.digest === right.digest &&
    left.instanceId === right.instanceId &&
    left.entryPath === right.entryPath
  )
}

function isMcpInvocation(value: unknown): value is McpInvocation {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { remoteName?: unknown }).remoteName === 'string' &&
    typeof (value as { input?: unknown }).input === 'object' &&
    (value as { input?: unknown }).input !== null &&
    !Array.isArray((value as { input?: unknown }).input)
  )
}

function staleCapability() {
  return runtimeError(
    'MCP_CAPABILITY_STALE',
    'plugin',
    'The MCP Tool is no longer part of the active Runtime snapshot.',
  )
}

async function removeServers(
  supervisor: ExtensionSupervisor,
  servers: Iterable<ActiveServer>,
): Promise<void> {
  const ids = new Set<string>()
  for (const active of servers) ids.add(active.selection.instanceId)
  await Promise.all([...ids].map((id) => supervisor.remove(id).catch(() => undefined)))
}

async function persistPluginHealth(
  installations: ExtensionInstallationService,
  workspace: string,
  statuses: readonly {
    pluginId: string
    health: 'healthy' | 'quarantined'
  }[],
): Promise<void> {
  const health = new Map<string, 'healthy' | 'quarantined'>()
  for (const status of statuses) {
    if (status.health === 'quarantined' || !health.has(status.pluginId)) {
      health.set(status.pluginId, status.health)
    }
  }
  await Promise.all(
    [...health].map(([pluginId, state]) => installations.setHealth(workspace, pluginId, state)),
  )
}
