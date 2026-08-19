import type { ChatProvider, PlannerFactory, RuntimePlugin, RuntimeTool } from '@praxis/core-sdk'
import type { ArtifactStore } from '../artifacts/artifactStore.js'
import type { Planner } from '../planner-api/index.js'
import { BuiltinPlugin } from '../plugin/builtinPlugin.js'
import { PluginManager } from '../plugin/pluginManager.js'
import { ToolRuntime } from '../tools/toolRuntime.js'

export interface RuntimeExtensions {
  initialize(): Promise<{ tools: ToolRuntime; planner: Planner }>
  provider(id: string): Promise<ChatProvider | undefined>
  providerIds(): readonly string[]
  shutdown(): Promise<void>
}

export type ExtensionServiceOptions = {
  manager?: PluginManager
  builtin?: RuntimePlugin
  planner?: PlannerFactory
  providers?: readonly ChatProvider[]
  replaceProviders?: boolean
  tools?: readonly RuntimeTool[]
  artifactStore?: ArtifactStore
  exposeArtifactTool?: boolean
}

type ExtensionSnapshot = {
  providerIds: readonly string[]
  tools: ToolRuntime
  planner: Planner
}

type LifecycleState = 'idle' | 'initializing' | 'ready' | 'shutting-down' | 'stopped'

const noProviderIds: readonly string[] = Object.freeze([])

export class ExtensionService implements RuntimeExtensions {
  private readonly manager: PluginManager
  private readonly builtin: RuntimePlugin
  private initializePromise?: Promise<ExtensionSnapshot>
  private shutdownPromise?: Promise<void>
  private stopPromise?: Promise<void>
  private snapshot?: ExtensionSnapshot
  private state: LifecycleState = 'idle'
  private readonly artifactStore?: ArtifactStore
  private readonly exposeArtifactTool: boolean

  constructor(options: ExtensionServiceOptions) {
    this.artifactStore = options.artifactStore
    this.exposeArtifactTool = options.exposeArtifactTool ?? true
    this.manager = options.manager ?? new PluginManager()
    if (!options.builtin && !options.planner) {
      throw new Error('ExtensionService requires a built-in plugin or planner factory.')
    }
    this.builtin =
      options.builtin ??
      new BuiltinPlugin(options.planner as PlannerFactory, {
        providers: options.providers,
        replaceProviders: options.replaceProviders,
        tools: options.tools,
      })
  }

  initialize(): Promise<ExtensionSnapshot> {
    if (this.state === 'shutting-down' || this.state === 'stopped') {
      return Promise.reject(new Error('ExtensionService has been shut down.'))
    }
    if (this.initializePromise) return this.initializePromise
    this.state = 'initializing'
    this.stopPromise = undefined
    this.initializePromise = Promise.resolve().then(() => this.performInitialize())
    return this.initializePromise
  }

  async provider(id: string): Promise<ChatProvider | undefined> {
    if (!this.snapshot?.providerIds.includes(id)) return undefined
    return this.manager.provider(id)
  }

  providerIds(): readonly string[] {
    return this.snapshot?.providerIds ?? noProviderIds
  }

  shutdown(): Promise<void> {
    this.snapshot = undefined
    if (this.shutdownPromise) return this.shutdownPromise
    this.state = 'shutting-down'
    this.shutdownPromise = this.performShutdown(this.initializePromise)
    return this.shutdownPromise
  }

  private async performInitialize(): Promise<ExtensionSnapshot> {
    try {
      await this.manager.install(this.builtin)
      this.assertInitializing()
      const providerIds = Object.freeze([...this.manager.capabilityIds('llm-provider')])
      const tools = await Promise.all(
        this.manager.capabilityIds('tool').map(async (id) => {
          const tool = await this.manager.tool(id)
          if (!tool) throw new Error(`Tool was not registered: ${id}`)
          return tool
        }),
      )
      this.assertInitializing()
      const planner = await this.manager.planner('agent-task')
      if (!planner) throw new Error('Unified agent-task executor was not registered.')
      this.assertInitializing()
      const snapshot = Object.freeze({
        providerIds,
        tools: new ToolRuntime(tools, {
          artifactStore: this.artifactStore,
          exposeArtifactTool: this.exposeArtifactTool,
        }),
        planner: planner as Planner,
      })
      this.snapshot = snapshot
      this.state = 'ready'
      return snapshot
    } catch (error) {
      this.snapshot = undefined
      await this.stopManager().catch(() => undefined)
      this.initializePromise = undefined
      if (this.state === 'shutting-down' || this.state === 'stopped') {
        throw new Error('ExtensionService was shut down during initialization.')
      }
      this.state = 'idle'
      throw error
    }
  }

  private async performShutdown(initialization: Promise<ExtensionSnapshot> | undefined) {
    await initialization?.catch(() => undefined)
    await this.stopManager()
    this.snapshot = undefined
    this.state = 'stopped'
  }

  private stopManager(): Promise<void> {
    this.stopPromise ??= this.manager.stop()
    return this.stopPromise
  }

  private assertInitializing(): void {
    if (this.state !== 'initializing') {
      throw new Error('ExtensionService was shut down during initialization.')
    }
  }
}
