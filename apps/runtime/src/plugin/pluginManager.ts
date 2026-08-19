import {
  runtimeError,
  type CapabilityDescriptor,
  type CapabilityKind,
  type ChatProvider,
  type PluginContext,
  type PluginManifest,
  type PlannerCapability,
  type RuntimeTool,
  type RuntimePlugin,
  type ToolDescriptor,
} from '@praxis/core-sdk'
import { RUNTIME_EXECUTABLE_CAPABILITY_KINDS } from '@praxis/plugin-protocol'

type RegisteredFactory = () => unknown | Promise<unknown>

type RegisteredCapability = {
  pluginId: string
  descriptor: CapabilityDescriptor
  factory: RegisteredFactory
}

type InstalledPlugin = {
  plugin: RuntimePlugin
  manifest: PluginManifest
  capabilities: readonly RegisteredCapability[]
}

/**
 * Built-in bootstrap registrar. External production capabilities are published
 * by RuntimeCapabilityRegistry from supervised immutable workspace snapshots.
 *
 * @deprecated Do not use this manager to activate third-party plugins.
 */
export class PluginManager {
  private readonly plugins = new Map<string, InstalledPlugin>()
  private readonly installed: InstalledPlugin[] = []
  private readonly capabilities = new Map<string, RegisteredCapability>()
  private readonly providers = new Map<string, RegisteredCapability>()
  private readonly tools = new Map<string, RegisteredCapability>()
  private readonly planners = new Map<string, RegisteredCapability>()
  private readonly subagents = new Map<string, RegisteredCapability>()
  private readonly persistence = new Map<string, RegisteredCapability>()

  async install(plugin: RuntimePlugin): Promise<void> {
    const manifest = snapshotManifest(plugin.manifest)
    if (this.plugins.has(manifest.id)) {
      throw runtimeError('PLUGIN_CONFLICT', 'plugin', 'Plugin ID is already installed.', {
        pluginId: manifest.id,
      })
    }

    const staged: RegisteredCapability[] = []
    const declaredKinds = new Set(manifest.capabilities)
    let registrarOpen = true
    const context = this.createContext(manifest, declaredKinds, staged, () => registrarOpen)
    try {
      await plugin.start(context)
      registrarOpen = false
      this.validateStaged(manifest, staged)
      this.commitStaged(staged)
      const installed = { plugin, manifest, capabilities: Object.freeze([...staged]) }
      this.plugins.set(manifest.id, installed)
      this.installed.push(installed)
    } catch (error) {
      registrarOpen = false
      try {
        await plugin.stop()
      } catch {
        // A failed startup cannot leave a live plugin in this manager.
      }
      throw error
    }
  }

  async replace(plugin: RuntimePlugin): Promise<void> {
    const manifest = snapshotManifest(plugin.manifest)
    const previous = this.plugins.get(manifest.id)
    if (!previous) {
      throw runtimeError('PLUGIN_NOT_INSTALLED', 'plugin', 'Plugin ID is not installed.', {
        pluginId: manifest.id,
      })
    }

    const staged: RegisteredCapability[] = []
    const declaredKinds = new Set(manifest.capabilities)
    let registrarOpen = true
    const context = this.createContext(manifest, declaredKinds, staged, () => registrarOpen)
    try {
      await plugin.start(context)
      registrarOpen = false
      this.validateStaged(manifest, staged, previous)
    } catch (error) {
      registrarOpen = false
      await plugin.stop().catch(() => {})
      throw error
    }

    const installedIndex = this.installed.indexOf(previous)
    for (const capability of previous.capabilities) this.removeCapability(capability)
    this.plugins.delete(previous.manifest.id)
    if (installedIndex >= 0) this.installed.splice(installedIndex, 1)

    try {
      await previous.plugin.stop()
    } catch (error) {
      await plugin.stop().catch(() => {})
      throw runtimeError(
        'PLUGIN_STOP_FAILED',
        'plugin',
        'Previous plugin failed to stop during replacement.',
        { pluginId: manifest.id, cause: error instanceof Error ? error.message : String(error) },
      )
    }

    try {
      this.commitStaged(staged)
      const replacement = {
        plugin,
        manifest,
        capabilities: Object.freeze([...staged]),
      }
      this.plugins.set(manifest.id, replacement)
      this.installed.splice(
        installedIndex < 0 ? this.installed.length : installedIndex,
        0,
        replacement,
      )
    } catch (error) {
      await plugin.stop().catch(() => {})
      throw error
    }
  }

  async stop(): Promise<void> {
    const failures: unknown[] = []
    const stopping = [...this.installed].reverse()
    this.installed.length = 0
    this.plugins.clear()
    this.capabilities.clear()
    this.providers.clear()
    this.tools.clear()
    this.planners.clear()
    this.subagents.clear()
    this.persistence.clear()
    for (const installed of stopping) {
      try {
        await installed.plugin.stop()
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length > 0) {
      throw runtimeError('PLUGIN_STOP_FAILED', 'plugin', 'One or more plugins failed to stop.', {
        failureCount: failures.length,
      })
    }
  }

  pluginIds(): string[] {
    return this.installed.map((installed) => installed.manifest.id)
  }

  capabilityIds(kind: CapabilityKind): string[] {
    return [...this.capabilities.values()]
      .filter((capability) => capability.descriptor.kind === kind)
      .map((capability) => capability.descriptor.id)
  }

  toolDescriptor(id: string): ToolDescriptor | undefined {
    const descriptor = this.capabilities.get(id)?.descriptor
    return descriptor?.kind === 'tool'
      ? (snapshotDescriptor(descriptor) as ToolDescriptor)
      : undefined
  }

  async provider(id: string): Promise<ChatProvider | undefined> {
    const provider = await instantiate(this.providers.get(id))
    if (!provider) return undefined
    if (!isRecord(provider) || typeof provider.id !== 'string' || provider.id !== id) {
      throw runtimeError(
        'CAPABILITY_FACTORY_MISMATCH',
        'plugin',
        'Provider factory returned a capability with a different ID.',
        {
          descriptorId: id,
          returnedCapabilityId: isRecord(provider) ? provider.id : undefined,
        },
      )
    }
    return provider as unknown as ChatProvider
  }

  async tool(id: string): Promise<RuntimeTool | undefined> {
    const tool = await instantiate(this.tools.get(id))
    if (!tool) return undefined
    if (
      !isRecord(tool) ||
      !isRecord(tool.definition) ||
      tool.definition.name !== id ||
      typeof tool.execute !== 'function'
    ) {
      throw runtimeError(
        'CAPABILITY_FACTORY_MISMATCH',
        'plugin',
        'Tool factory returned a capability with a different ID.',
        {
          descriptorId: id,
          returnedCapabilityId:
            isRecord(tool) && isRecord(tool.definition) ? tool.definition.name : undefined,
        },
      )
    }
    return tool as unknown as RuntimeTool
  }

  async planner(id: string): Promise<PlannerCapability | undefined> {
    const planner = await instantiate(this.planners.get(id))
    if (!planner) return undefined
    if (!isRecord(planner) || typeof planner.execute !== 'function') {
      throw runtimeError(
        'CAPABILITY_FACTORY_MISMATCH',
        'plugin',
        'Planner factory returned an invalid planner capability.',
        {
          descriptorId: id,
        },
      )
    }
    return planner as unknown as PlannerCapability
  }

  async subagent(id: string): Promise<unknown | undefined> {
    return instantiate(this.subagents.get(id))
  }

  async persistenceCapability(id: string): Promise<unknown | undefined> {
    return instantiate(this.persistence.get(id))
  }

  private createContext(
    manifest: PluginManifest,
    declaredKinds: ReadonlySet<CapabilityKind>,
    staged: RegisteredCapability[],
    isOpen: () => boolean,
  ): PluginContext {
    return {
      registerProvider: (descriptor, factory) =>
        this.stage(manifest, declaredKinds, 'llm-provider', descriptor, factory, staged, isOpen),
      registerTool: (descriptor, factory) =>
        this.stage(manifest, declaredKinds, 'tool', descriptor, factory, staged, isOpen),
      registerPlanner: (descriptor, factory) =>
        this.stage(manifest, declaredKinds, 'planner', descriptor, factory, staged, isOpen),
      registerSubagent: (descriptor, factory) =>
        this.stage(manifest, declaredKinds, 'subagent', descriptor, factory, staged, isOpen),
      registerPersistence: (descriptor, factory) =>
        this.stage(manifest, declaredKinds, 'persistence', descriptor, factory, staged, isOpen),
    }
  }

  private stage(
    manifest: PluginManifest,
    declaredKinds: ReadonlySet<CapabilityKind>,
    expectedKind: CapabilityKind,
    descriptor: CapabilityDescriptor,
    factory: RegisteredFactory,
    staged: RegisteredCapability[],
    isOpen: () => boolean,
  ): void {
    if (!isOpen()) {
      throw runtimeError(
        'REGISTRAR_CLOSED',
        'plugin',
        'Plugin capability registration is only allowed while start() is running.',
        {
          pluginId: manifest.id,
        },
      )
    }
    const snapshot = snapshotDescriptor(descriptor)
    if (snapshot.kind !== expectedKind) {
      throw runtimeError(
        'INVALID_CAPABILITY_DESCRIPTOR',
        'plugin',
        'Capability kind does not match the registrar method.',
        {
          pluginId: manifest.id,
          capabilityId: snapshot.id,
          expectedKind,
          actualKind: snapshot.kind,
        },
      )
    }
    if (!declaredKinds.has(snapshot.kind)) {
      throw runtimeError(
        'UNDECLARED_CAPABILITY_KIND',
        'plugin',
        'Plugin registered a capability kind absent from its manifest.',
        {
          pluginId: manifest.id,
          capabilityId: snapshot.id,
          capabilityKind: snapshot.kind,
        },
      )
    }
    staged.push({ pluginId: manifest.id, descriptor: snapshot, factory })
  }

  private validateStaged(
    manifest: PluginManifest,
    staged: readonly RegisteredCapability[],
    replacing?: InstalledPlugin,
  ): void {
    const replacedIds = new Set(
      replacing?.capabilities.map((capability) => capability.descriptor.id) ?? [],
    )
    const ids = new Set(
      [...this.capabilities.keys()].filter((capabilityId) => !replacedIds.has(capabilityId)),
    )
    for (const capability of staged) {
      validateDescriptor(capability.descriptor)
      if (ids.has(capability.descriptor.id)) {
        throw runtimeError(
          'CAPABILITY_CONFLICT',
          'plugin',
          'Capability ID is already registered.',
          {
            pluginId: manifest.id,
            capabilityId: capability.descriptor.id,
          },
        )
      }
      ids.add(capability.descriptor.id)
    }
  }

  private commitStaged(staged: readonly RegisteredCapability[]): void {
    const committed: RegisteredCapability[] = []
    try {
      for (const capability of staged) {
        this.capabilities.set(capability.descriptor.id, capability)
        committed.push(capability)
        this.registerTypedCapability(capability)
      }
    } catch (error) {
      for (const capability of committed.reverse()) this.removeCapability(capability)
      throw error
    }
  }

  private registerTypedCapability(capability: RegisteredCapability): void {
    switch (capability.descriptor.kind) {
      case 'llm-provider':
        this.providers.set(capability.descriptor.id, capability)
        break
      case 'tool':
        this.tools.set(capability.descriptor.id, capability)
        break
      case 'planner':
        this.planners.set(capability.descriptor.id, capability)
        break
      case 'subagent':
        this.subagents.set(capability.descriptor.id, capability)
        break
      case 'persistence':
        this.persistence.set(capability.descriptor.id, capability)
        break
    }
  }

  private removeCapability(capability: RegisteredCapability): void {
    this.capabilities.delete(capability.descriptor.id)
    switch (capability.descriptor.kind) {
      case 'llm-provider':
        this.providers.delete(capability.descriptor.id)
        break
      case 'tool':
        this.tools.delete(capability.descriptor.id)
        break
      case 'planner':
        this.planners.delete(capability.descriptor.id)
        break
      case 'subagent':
        this.subagents.delete(capability.descriptor.id)
        break
      case 'persistence':
        this.persistence.delete(capability.descriptor.id)
        break
    }
  }
}

function snapshotManifest(manifest: PluginManifest): PluginManifest {
  const value = manifest as unknown
  if (
    !isRecord(value) ||
    !isNonBlankString(value.id) ||
    !isNonBlankString(value.version) ||
    value.apiVersion !== 1 ||
    (value.isolation !== 'in-process' && value.isolation !== 'process') ||
    !Array.isArray(value.capabilities) ||
    value.capabilities.some((kind) => !isCapabilityKind(kind)) ||
    new Set(value.capabilities).size !== value.capabilities.length
  ) {
    throw runtimeError(
      'INVALID_PLUGIN_MANIFEST',
      'plugin',
      'Plugin manifest is invalid or unsupported.',
    )
  }
  return Object.freeze({
    id: value.id,
    version: value.version,
    apiVersion: 1 as const,
    isolation: value.isolation,
    capabilities: Object.freeze([...value.capabilities]) as readonly CapabilityKind[],
  })
}

function snapshotDescriptor(descriptor: CapabilityDescriptor): CapabilityDescriptor {
  validateDescriptor(descriptor)
  return snapshotValue(descriptor) as CapabilityDescriptor
}

function snapshotValue(value: unknown): unknown {
  if (Array.isArray(value)) return Object.freeze(value.map((item) => snapshotValue(item)))
  if (isRecord(value)) {
    const snapshot: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) snapshot[key] = snapshotValue(item)
    return Object.freeze(snapshot)
  }
  return value
}

function validateDescriptor(descriptor: CapabilityDescriptor): void {
  if (!isNonBlankString(descriptor.id) || !isCapabilityKind(descriptor.kind)) {
    throw runtimeError(
      'INVALID_CAPABILITY_DESCRIPTOR',
      'plugin',
      'Capability descriptor is invalid.',
    )
  }
}

function isCapabilityKind(value: unknown): value is CapabilityKind {
  return (
    typeof value === 'string' &&
    RUNTIME_EXECUTABLE_CAPABILITY_KINDS.includes(value as CapabilityKind)
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

async function instantiate(
  capability: RegisteredCapability | undefined,
): Promise<unknown | undefined> {
  return capability ? capability.factory() : undefined
}
