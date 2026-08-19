import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { createBuiltinTools } from '../apps/runtime/src/builtin-tools/builtinTools.js'
import {
  compileChildCapabilityBundle,
  digestToolDefinition,
  validateChildCapabilityBundle,
  type ChildCapabilityParentSnapshot,
  type ChildMcpGrant,
  type CompileChildCapabilityBundleInput,
} from '../apps/runtime/src/subagent/childCapabilityBundle.js'
import { ToolRuntime } from '../apps/runtime/src/tools/toolRuntime.js'

const workspace = process.cwd()
const target = { providerId: 'mock', model: 'mock-v1' } as const
const definitions = new ToolRuntime(createBuiltinTools()).definitions()
const read = definitions.find((definition) => definition.name === 'read')!
const write = definitions.find((definition) => definition.name === 'write')!
const skillContent = '---\nname: review\ndescription: Review selected files\n---\nReview safely.'

test('bundle compilation intersects parent, step, policy, and isolation authority', () => {
  const mcpDefinition = { ...read, name: 'mcp__demo__read' }
  const parent: ChildCapabilityParentSnapshot = {
    workspace,
    providerTargets: [target],
    tools: [
      { source: 'builtin', definition: read },
      { source: 'builtin', definition: write },
      { source: 'mcp', definition: mcpDefinition },
    ],
    skills: [
      skill('skill:review', skillContent),
      skill('skill:drifted', 'changed', `sha256:${'0'.repeat(64)}`),
    ],
  }
  const result = compileChildCapabilityBundle(
    baseInput(parent, {
      step: {
        toolNames: ['read', 'write', 'mcp__demo__read', 'missing'],
        skillIds: ['skill:review', 'skill:drifted'],
        methodAllowlist: ['initialize', 'session.prompt', 'shutdown'],
        mcpMode: 'parent_broker',
      },
      policy: {
        toolNames: ['read', 'write', 'mcp__demo__read', 'missing'],
        skillIds: ['skill:review', 'skill:drifted'],
        methodAllowlist: ['initialize', 'session.prompt', 'shutdown'],
        providerTargets: [target],
        mcpModes: ['parent_broker'],
      },
      isolation: {
        builtinToolNames: ['read', 'write'],
        allowInlineSkills: true,
        methodAllowlist: ['initialize', 'shutdown'],
        providerTargets: [target],
        credentialKinds: ['none'],
        mcpModes: ['disabled'],
      },
    }),
  )

  assert.deepEqual(
    result.bundle.tools.map((tool) => tool.name),
    ['read'],
  )
  assert.deepEqual(
    result.bundle.skills.map((item) => item.id),
    ['skill:review'],
  )
  assert.deepEqual(result.bundle.methodAllowlist, ['initialize', 'shutdown'])
  assert.deepEqual(result.bundle.mcp, { mode: 'disabled' })
  assert.deepEqual(
    result.denied.map(({ category, capabilityId, reason }) => [category, capabilityId, reason]),
    [
      ['method', 'session.prompt', 'isolation_unsupported'],
      ['tool', 'write', 'not_read_only'],
      ['tool', 'mcp__demo__read', 'unrealizable'],
      ['tool', 'missing', 'not_in_parent_snapshot'],
      ['skill', 'skill:drifted', 'digest_mismatch'],
      ['mcp', 'parent_broker', 'isolation_unsupported'],
    ],
  )
  assert.equal(Object.isFrozen(result.bundle), true)
  assert.equal(Object.isFrozen(result.bundle.skills[0]?.resource), true)
  assert.deepEqual(validateChildCapabilityBundle(result.bundle), result.bundle)
})

test('writable workspace admits declared write and process tools but never network tools', () => {
  const shell = definitions.find((definition) => definition.name === 'shell')!
  const parent: ChildCapabilityParentSnapshot = {
    workspace,
    providerTargets: [target],
    tools: [
      { source: 'builtin', definition: read },
      { source: 'builtin', definition: write },
      { source: 'builtin', definition: shell },
    ],
    skills: [],
  }
  const result = compileChildCapabilityBundle(
    baseInput(parent, {
      workspace: { root: workspace, access: 'workspace_write' },
      step: {
        ...baseInput().step,
        toolNames: ['read', 'write', 'shell'],
      },
      policy: {
        ...baseInput().policy,
        toolNames: ['read', 'write', 'shell'],
      },
      isolation: {
        ...baseInput().isolation,
        builtinToolNames: ['read', 'write', 'shell'],
      },
    }),
  )

  assert.deepEqual(
    result.bundle.tools.map((tool) => tool.name),
    ['read', 'shell', 'write'],
  )
  assert.deepEqual(result.denied, [])
  assert.equal(result.bundle.workspace.access, 'workspace_write')
})

test('isolated process workspace admits shell but still denies direct write tools', () => {
  const shell = definitions.find((definition) => definition.name === 'shell')!
  const parent: ChildCapabilityParentSnapshot = {
    workspace,
    providerTargets: [target],
    tools: [
      { source: 'builtin', definition: read },
      { source: 'builtin', definition: write },
      { source: 'builtin', definition: shell },
    ],
    skills: [],
  }
  const result = compileChildCapabilityBundle(
    baseInput(parent, {
      workspace: { root: workspace, access: 'isolated_process' },
      step: { ...baseInput().step, toolNames: ['read', 'write', 'shell'] },
      policy: { ...baseInput().policy, toolNames: ['read', 'write', 'shell'] },
      isolation: {
        ...baseInput().isolation,
        builtinToolNames: ['read', 'write', 'shell'],
      },
    }),
  )

  assert.deepEqual(
    result.bundle.tools.map((tool) => tool.name),
    ['read', 'shell'],
  )
  assert.deepEqual(
    result.denied.map(({ capabilityId, reason }) => [capabilityId, reason]),
    [['write', 'not_read_only']],
  )
  assert.equal(result.bundle.workspace.access, 'isolated_process')
  assert.deepEqual(validateChildCapabilityBundle(result.bundle), result.bundle)
})

test('bundle validation rejects tamper, resource drift, unknown fields, and revocation', () => {
  const bundle = compileChildCapabilityBundle(baseInput()).bundle
  const drifted = structuredClone(bundle) as unknown as {
    tools: Array<{ definition: { description: string } }>
  }
  drifted.tools[0]!.definition.description = 'tampered'
  assert.throws(
    () => validateChildCapabilityBundle(drifted),
    (error: unknown) => hasCode(error, 'CHILD_CAPABILITY_RESOURCE_DRIFT'),
  )

  const tampered = structuredClone(bundle) as unknown as { digest: string }
  tampered.digest = 'f'.repeat(64)
  assert.throws(
    () => validateChildCapabilityBundle(tampered),
    (error: unknown) => hasCode(error, 'CHILD_CAPABILITY_TAMPERED'),
  )
  assert.throws(
    () => validateChildCapabilityBundle({ ...bundle, extra: true }),
    (error: unknown) => hasCode(error, 'CHILD_CAPABILITY_INVALID'),
  )
  assert.throws(
    () =>
      validateChildCapabilityBundle(bundle, {
        revokedCapabilityIds: new Set(['read']),
      }),
    (error: unknown) => hasCode(error, 'CHILD_CAPABILITY_REVOKED'),
  )
})

test('MCP modes serialize descriptors or manifests without RuntimeTool objects', () => {
  const mcpDefinition = { ...read, name: 'mcp__demo__read' }
  const brokerGrant = {
    name: mcpDefinition.name,
    definition: mcpDefinition,
    definitionDigest: digestToolDefinition(mcpDefinition),
    brokerCapabilityId: 'broker-demo-read',
  } as const
  const broker = compileChildCapabilityBundle(
    baseInput(
      {
        ...baseParent(),
        mcp: { mode: 'parent_broker', toolGrants: [brokerGrant] },
      },
      mcpOverride('parent_broker'),
    ),
  ).bundle
  assert.equal(broker.mcp.mode, 'parent_broker')
  assert.equal(JSON.stringify(broker).includes('execute'), false)
  validateChildCapabilityBundle(broker)

  const childLaunch = compileChildCapabilityBundle(
    baseInput(
      {
        ...baseParent(),
        mcp: {
          mode: 'child_launch',
          serverManifests: [
            {
              pluginId: 'plugin-demo',
              serverId: 'server-main',
              version: 'v1',
              digest: `sha256:${'a'.repeat(64)}`,
              entryRef: 'entry-main',
            },
          ],
        },
      },
      mcpOverride('child_launch'),
    ),
  ).bundle
  assert.equal(childLaunch.mcp.mode, 'child_launch')
  validateChildCapabilityBundle(childLaunch)

  const unsafeDefinition = { ...write, name: 'mcp__demo__write' }
  const unsafeGrant = {
    name: unsafeDefinition.name,
    definition: unsafeDefinition,
    definitionDigest: digestToolDefinition(unsafeDefinition),
    brokerCapabilityId: 'broker-demo-write',
  } as const
  assert.throws(
    () =>
      compileChildCapabilityBundle(
        baseInput(
          {
            ...baseParent(),
            mcp: { mode: 'parent_broker', toolGrants: [unsafeGrant] },
          },
          mcpOverride('parent_broker'),
        ),
      ),
    (error: unknown) => hasCode(error, 'CHILD_CAPABILITY_RESOURCE_DRIFT'),
  )
})

test('disabled and quarantined Skills are absent from the signed child snapshot', () => {
  const skills = [
    skill('skill:enabled', 'enabled'),
    skill('skill:ungranted', 'ungranted'),
    { ...skill('skill:disabled', 'disabled'), status: 'disabled' as const },
    { ...skill('skill:quarantined', 'quarantined'), status: 'quarantined' as const },
  ]
  const input = baseInput(
    { ...baseParent(), skills },
    {
      step: {
        ...baseInput().step,
        skillIds: skills.map((candidate) => candidate.id),
      },
      policy: {
        ...baseInput().policy,
        skillIds: skills.map((candidate) => candidate.id).filter((id) => id !== 'skill:ungranted'),
      },
      isolation: { ...baseInput().isolation, allowInlineSkills: true },
    },
  )
  const result = compileChildCapabilityBundle(input)

  assert.deepEqual(
    result.bundle.skills.map((candidate) => candidate.id),
    ['skill:enabled'],
  )
  assert.deepEqual(
    result.denied.map(({ capabilityId, reason }) => [capabilityId, reason]),
    [
      ['skill:ungranted', 'policy_denied'],
      ['skill:disabled', 'disabled'],
      ['skill:quarantined', 'quarantined'],
    ],
  )
})

test('bundle compilation rejects Provider, workspace, and credential strategies outside authority', () => {
  assert.throws(
    () =>
      compileChildCapabilityBundle({
        ...baseInput(),
        workspace: { root: `${workspace}-other`, access: 'read_only' },
      }),
    (error: unknown) => hasCode(error, 'CHILD_CAPABILITY_WORKSPACE_DENIED'),
  )
  assert.throws(
    () =>
      compileChildCapabilityBundle({
        ...baseInput(),
        isolation: { ...baseInput().isolation, credentialKinds: [] },
      }),
    (error: unknown) => hasCode(error, 'CHILD_CAPABILITY_CREDENTIAL_INVALID'),
  )
})

function baseInput(
  parent: ChildCapabilityParentSnapshot = baseParent(),
  overrides: Partial<CompileChildCapabilityBundleInput> = {},
): CompileChildCapabilityBundleInput {
  return {
    bundleId: 'bundle-test',
    parent,
    workspace: { root: workspace, access: 'read_only' },
    provider: { target, credential: { kind: 'none', mode: 'mock' } },
    step: {
      toolNames: ['read'],
      skillIds: [],
      methodAllowlist: ['initialize', 'shutdown'],
      mcpMode: 'disabled',
    },
    policy: {
      toolNames: ['read'],
      skillIds: [],
      methodAllowlist: ['initialize', 'shutdown'],
      providerTargets: [target],
      mcpModes: ['disabled'],
    },
    isolation: {
      builtinToolNames: ['read'],
      allowInlineSkills: false,
      methodAllowlist: ['initialize', 'shutdown'],
      providerTargets: [target],
      credentialKinds: ['none'],
      mcpModes: ['disabled'],
    },
    ...overrides,
  }
}

function baseParent(): ChildCapabilityParentSnapshot {
  return {
    workspace,
    providerTargets: [target],
    tools: [{ source: 'builtin', definition: read }],
    skills: [],
  }
}

function mcpOverride(mode: Exclude<ChildMcpGrant['mode'], 'disabled'>) {
  return {
    step: { ...baseInput().step, mcpMode: mode },
    policy: { ...baseInput().policy, mcpModes: [mode] },
    isolation: { ...baseInput().isolation, mcpModes: [mode] },
  } as Partial<CompileChildCapabilityBundleInput>
}

function skill(id: string, content: string, digest = resourceDigest(content)) {
  return {
    id,
    localId: id.slice(id.indexOf(':') + 1),
    name: id.slice(id.indexOf(':') + 1),
    description: 'Bounded skill',
    origin: 'test-origin',
    digest: digest as `sha256:${string}`,
    disableModelInvocation: false,
    content,
  }
}

function resourceDigest(content: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code
}
