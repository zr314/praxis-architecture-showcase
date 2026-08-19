import type { ChatProvider, ProviderCapabilities } from './llm.js'
import type { RuntimeTool } from './tool.js'
import type { RuntimeExecutableCapabilityKind } from '@praxis/plugin-protocol'

export type CapabilityKind = RuntimeExecutableCapabilityKind
export type {
  PluginCapabilityIdentity,
  PluginCapabilityOrigin,
  RuntimeCapabilityKind,
} from '@praxis/plugin-protocol'

export type CapabilityDescriptor<K extends CapabilityKind = CapabilityKind> = {
  id: string
  kind: K
  displayName?: string
  version?: string
}

export type ProviderDescriptor = CapabilityDescriptor<'llm-provider'> & {
  capabilities?: ProviderCapabilities
}

export type ToolDescriptor = CapabilityDescriptor<'tool'> & {
  permission?: 'none' | 'conditional' | 'medium' | 'high'
}

export type PlannerDescriptor = CapabilityDescriptor<'planner'>
export type SubagentDescriptor = CapabilityDescriptor<'subagent'>
export type PersistenceDescriptor = CapabilityDescriptor<'persistence'>

export type ProviderFactory = () => ChatProvider | Promise<ChatProvider>
export type ToolFactory = () => RuntimeTool | Promise<RuntimeTool>
export interface PlannerCapability {
  execute(input: unknown): Promise<void>
}

export type PlannerFactory = () => PlannerCapability | Promise<PlannerCapability>
export type SubagentFactory = () => unknown | Promise<unknown>
export type PersistenceFactory = () => unknown | Promise<unknown>

export type PluginManifest = {
  readonly id: string
  readonly version: string
  readonly apiVersion: 1
  readonly isolation: 'in-process' | 'process'
  readonly capabilities: readonly CapabilityKind[]
}

export interface PluginContext {
  registerProvider(descriptor: ProviderDescriptor, factory: ProviderFactory): void
  registerTool(descriptor: ToolDescriptor, factory: ToolFactory): void
  registerPlanner(descriptor: PlannerDescriptor, factory: PlannerFactory): void
  registerSubagent(descriptor: SubagentDescriptor, factory: SubagentFactory): void
  registerPersistence(descriptor: PersistenceDescriptor, factory: PersistenceFactory): void
}

export interface RuntimePlugin {
  readonly manifest: PluginManifest
  start(context: PluginContext): Promise<void>
  stop(): Promise<void>
}
