import type { ChatProvider, PlannerFactory, RuntimePlugin, RuntimeTool } from '@praxis/core-sdk'
import { createBuiltinTools } from '../builtin-tools/builtinTools.js'
import { createBuiltinProviders } from '../llm-provider/builtinProviders.js'

export class BuiltinPlugin implements RuntimePlugin {
  constructor(
    private readonly agentTaskPlanner: PlannerFactory,
    private readonly options: {
      providers?: readonly ChatProvider[]
      replaceProviders?: boolean
      tools?: readonly RuntimeTool[]
    } = {},
  ) {}

  readonly manifest = {
    id: 'praxis.builtin',
    version: '1.0.0',
    apiVersion: 1,
    isolation: 'in-process',
    capabilities: ['llm-provider', 'tool', 'planner'],
  } as const

  async start(context: Parameters<RuntimePlugin['start']>[0]): Promise<void> {
    const providers = this.options.replaceProviders
      ? (this.options.providers ?? [])
      : [...createBuiltinProviders(), ...(this.options.providers ?? [])]
    for (const provider of providers) {
      context.registerProvider(
        { id: provider.id, kind: 'llm-provider', capabilities: provider.capabilities },
        () => provider,
      )
    }
    for (const tool of this.options.tools ?? createBuiltinTools()) {
      context.registerTool(
        {
          id: tool.definition.name,
          kind: 'tool',
          permission: toolPermission(tool.definition.name),
        },
        () => tool,
      )
    }
    context.registerPlanner(
      { id: 'agent-task', kind: 'planner', displayName: 'Unified agent task executor' },
      this.agentTaskPlanner,
    )
  }

  async stop(): Promise<void> {}
}

function toolPermission(name: string): 'none' | 'conditional' | 'medium' | 'high' {
  if (name === 'write' || name === 'edit' || name === 'shell') return 'high'
  if (name === 'read' || name === 'ls' || name === 'find') return 'conditional'
  return 'none'
}
