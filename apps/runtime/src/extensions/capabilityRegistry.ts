import type { ChatProvider } from '@praxis/core-sdk'
import type { ToolRuntime } from '../tools/toolRuntime.js'
import type { McpActivationService, McpToolSnapshot } from './mcpActivationService.js'
import type {
  ProcessActivationService,
  ProcessCapabilitySnapshot,
} from './processActivationService.js'
import type { RuntimeExtensions } from './extensionService.js'

export type RuntimeCapabilitySnapshot = Readonly<{
  workspace: string
  tools: ToolRuntime
  providerIds: readonly string[]
  provider(id: string): Promise<ChatProvider | undefined>
  mcp: McpToolSnapshot
  process: ProcessCapabilitySnapshot
}>

/**
 * One production lookup surface for built-in, MCP, and Praxis process
 * capabilities. External lifecycle services publish only immutable snapshots.
 */
export class RuntimeCapabilityRegistry {
  readonly #extensions: RuntimeExtensions
  readonly #mcp: McpActivationService
  readonly #process: ProcessActivationService
  #builtinTools?: ToolRuntime

  constructor(
    extensions: RuntimeExtensions,
    mcp: McpActivationService,
    process: ProcessActivationService,
  ) {
    this.#extensions = extensions
    this.#mcp = mcp
    this.#process = process
  }

  initialize(tools: ToolRuntime): void {
    if (this.#builtinTools) throw new Error('Runtime capability registry is already initialized.')
    this.#builtinTools = tools
  }

  async snapshot(workspace: string): Promise<RuntimeCapabilitySnapshot> {
    const builtinTools = this.#builtinTools
    if (!builtinTools) throw new Error('Runtime capability registry is not initialized.')
    const [mcp, process] = await Promise.all([
      this.#mcp.snapshot(workspace),
      this.#process.snapshot(workspace),
    ])
    const providerIds = Object.freeze([
      ...new Set([...this.#extensions.providerIds(), ...process.providers.keys()]),
    ])
    const providers = process.providers
    return Object.freeze({
      workspace: process.workspace,
      tools: builtinTools.fork([...mcp.tools, ...process.tools]),
      providerIds,
      provider: async (id: string) => providers.get(id) ?? (await this.#extensions.provider(id)),
      mcp,
      process,
    })
  }

  async deactivate(
    workspace: string,
    pluginId: string,
    isolation: 'process' | 'mcp-stdio' | 'data-only',
  ): Promise<void> {
    if (isolation === 'mcp-stdio') await this.#mcp.deactivate(workspace, pluginId)
    if (isolation === 'process') await this.#process.deactivate(workspace, pluginId)
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled([this.#mcp.shutdown(), this.#process.shutdown()])
  }
}
