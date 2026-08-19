import { resolve } from 'node:path'
import { createBuiltinTools } from '../../apps/runtime/src/builtin-tools/builtinTools.js'
import {
  compileChildCapabilityBundle,
  type ChildCapabilityBundleV1,
  type ChildCredentialGrant,
  type ChildProviderTarget,
  type ChildSkillCandidate,
  type McpToolGrant,
} from '../../apps/runtime/src/subagent/childCapabilityBundle.js'
import type { ChildBootstrapMethod } from '../../apps/runtime/src/subagent/childBootstrapProfile.js'
import { ToolRuntime } from '../../apps/runtime/src/tools/toolRuntime.js'

export function mockChildCapabilityBundle(options: {
  workspace?: string
  workspaceAccess?: 'read_only' | 'workspace_write'
  methods: readonly ChildBootstrapMethod[]
  skills?: readonly ChildSkillCandidate[]
  toolNames?: readonly string[]
  provider?: ChildProviderTarget
  credential?: ChildCredentialGrant
  mcpToolGrants?: readonly McpToolGrant[]
}): ChildCapabilityBundleV1 {
  const workspace = resolve(options.workspace ?? process.cwd())
  const definitions = new ToolRuntime(createBuiltinTools()).definitions()
  const allowed = definitions.filter((definition) => {
    const sideEffect = definition.execution?.sideEffect
    return options.workspaceAccess === 'workspace_write'
      ? sideEffect !== 'network'
      : sideEffect === 'none' || sideEffect === 'read'
  })
  const toolNames = options.toolNames ?? allowed.map((definition) => definition.name)
  const provider = options.provider ?? { providerId: 'mock', model: 'mock-v1' }
  const credential =
    options.credential ??
    ({ kind: 'none', mode: provider.providerId } as Extract<ChildCredentialGrant, { kind: 'none' }>)
  return compileChildCapabilityBundle({
    bundleId: 'bundle-mock-read-only',
    parent: {
      workspace,
      providerTargets: [provider],
      tools: allowed.map((definition) => ({ source: 'builtin', definition })),
      skills: options.skills ?? [],
      ...(options.mcpToolGrants === undefined
        ? {}
        : { mcp: { mode: 'parent_broker' as const, toolGrants: options.mcpToolGrants } }),
    },
    workspace: { root: workspace, access: options.workspaceAccess ?? 'read_only' },
    provider: {
      target: provider,
      credential,
    },
    step: {
      toolNames,
      skillIds: options.skills?.map((skill) => skill.id) ?? [],
      methodAllowlist: options.methods,
      mcpMode: options.mcpToolGrants === undefined ? 'disabled' : 'parent_broker',
    },
    policy: {
      toolNames,
      skillIds: options.skills?.map((skill) => skill.id) ?? [],
      methodAllowlist: options.methods,
      providerTargets: [provider],
      mcpModes: [options.mcpToolGrants === undefined ? 'disabled' : 'parent_broker'],
    },
    isolation: {
      builtinToolNames: allowed.map((definition) => definition.name),
      allowInlineSkills: true,
      methodAllowlist: options.methods,
      providerTargets: [provider],
      credentialKinds: [credential.kind],
      mcpModes: [options.mcpToolGrants === undefined ? 'disabled' : 'parent_broker'],
    },
  }).bundle
}
