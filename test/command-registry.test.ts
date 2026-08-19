import assert from 'node:assert/strict'
import test from 'node:test'
import {
  type CommandDescriptorV1,
  type CommandKindV1,
  CommandRegistryV1,
  commandSourceDigestV1,
  createCommandDescriptorV1,
  validateCommandCatalogSnapshotV1,
  validateCommandDescriptorV1,
} from '@praxis/core-sdk'
import { createClientCommandRegistryV1 } from '../apps/cli/src/ui/clientCommandRegistry.js'
import { createRuntimeCommandRegistryV1 } from '../apps/runtime/src/commands/builtinCommandRegistry.js'

test('command descriptors are strict, immutable, digest-bound contracts', () => {
  const descriptor = builtinDescriptor('context', 'runtime_query')
  assert.deepEqual(validateCommandDescriptorV1(descriptor), descriptor)
  assert.throws(() => ((descriptor.aliases as string[])[0] = 'tampered'))
  assert.throws(
    () => validateCommandDescriptorV1({ ...structuredClone(descriptor), command: 'plan' }),
    hasCode('COMMAND_DESCRIPTOR_INVALID'),
  )
  assert.throws(
    () => validateCommandDescriptorV1({ ...structuredClone(descriptor), unknown: true }),
    hasCode('COMMAND_DESCRIPTOR_INVALID'),
  )
})

test('sensitive arguments cannot default to plaintext persistence', () => {
  assert.throws(
    () =>
      createCommandDescriptorV1({
        ...descriptorInput('login-token', 'runtime_mutation'),
        schema: schema('token', true),
        sensitiveArguments: ['/token'],
        persistence: 'plaintext',
      }),
    hasCode('COMMAND_DESCRIPTOR_INVALID'),
  )
  const redacted = createCommandDescriptorV1({
    ...descriptorInput('login-token', 'runtime_mutation'),
    schema: schema('token', true),
    sensitiveArguments: ['/token'],
    persistence: 'redacted',
  })
  assert.deepEqual(redacted.sensitiveArguments, ['/token'])
})

test('client and Runtime registries enforce disjoint ownership', () => {
  const client = new CommandRegistryV1({ owner: 'client' })
  const runtime = new CommandRegistryV1({ owner: 'runtime' })
  assert.throws(
    () => client.register(builtinDescriptor('plan', 'runtime_query')),
    hasCode('COMMAND_REGISTRY_OWNER_VIOLATION'),
  )
  assert.throws(
    () => runtime.register(builtinDescriptor('copy', 'client_local')),
    hasCode('COMMAND_REGISTRY_OWNER_VIOLATION'),
  )
})

test('external sources require namespaces and cannot claim reserved aliases', () => {
  const runtime = new CommandRegistryV1({ owner: 'runtime' })
  const skill = externalDescriptor('skill', 'review', 'skill:review', ['review'])
  runtime.register(skill)
  assert.throws(
    () =>
      runtime.register(externalDescriptor('plugin', 'alpha', 'plugin:alpha/check', ['compact'])),
    hasCode('COMMAND_RESERVED_NAME_COLLISION'),
  )
  assert.throws(
    () =>
      createCommandDescriptorV1({
        ...descriptorInput('review', 'skill_invocation'),
        source: {
          kind: 'skill',
          origin: 'workspace:skill/review',
          namespace: 'review',
          digest: commandSourceDigestV1('skill-review'),
        },
      }),
    hasCode('COMMAND_DESCRIPTOR_INVALID'),
  )
})

test('plugin and MCP sources cannot register high-trust Runtime mutations', () => {
  for (const source of ['plugin', 'mcp'] as const) {
    assert.throws(
      () =>
        createCommandDescriptorV1({
          ...descriptorInput('external-write', 'runtime_mutation'),
          id: `${source}:alpha/external-write`,
          command: `${source}:alpha/external-write`,
          source: {
            kind: source,
            origin: `${source}:alpha`,
            namespace: 'alpha',
            digest: commandSourceDigestV1(`${source}-alpha`),
          },
        }),
      hasCode('COMMAND_DESCRIPTOR_INVALID'),
    )
  }
})

test('catalog snapshots are capability- and workspace-trust-bound', () => {
  const runtime = new CommandRegistryV1({ owner: 'runtime' })
  runtime.register(
    createCommandDescriptorV1({
      ...descriptorInput('doctor', 'runtime_query'),
      capabilities: ['runtime.diagnostics'],
      availability: { session: 'none', run: 'any', requiresWorkspaceTrust: true },
    }),
  )
  const untrusted = runtime.snapshot({
    workspaceId: 'workspace-1',
    workspaceTrusted: false,
    capabilityIds: ['runtime.diagnostics'],
  })
  assert.equal(untrusted.entries.length, 0)
  const trusted = runtime.snapshot({
    workspaceId: 'workspace-1',
    workspaceTrusted: true,
    capabilityIds: ['runtime.diagnostics'],
  })
  assert.equal(trusted.entries.length, 1)
  assert.notEqual(trusted.capabilityDigest, untrusted.capabilityDigest)
  assert.deepEqual(validateCommandCatalogSnapshotV1(trusted), trusted)
  assert.throws(
    () =>
      validateCommandCatalogSnapshotV1({
        ...structuredClone(trusted),
        workspaceId: 'workspace-2',
      }),
    hasCode('COMMAND_CATALOG_SNAPSHOT_INVALID'),
  )
})

test('ambiguous external aliases disappear while namespaced commands remain', () => {
  const runtime = new CommandRegistryV1({ owner: 'runtime' })
  runtime.register(externalDescriptor('plugin', 'alpha', 'plugin:alpha/review', ['review']))
  runtime.register(externalDescriptor('plugin', 'beta', 'plugin:beta/review', ['review']))
  const snapshot = runtime.snapshot({
    workspaceId: 'workspace-1',
    workspaceTrusted: true,
    capabilityIds: [],
  })
  assert.deepEqual(
    snapshot.entries.map((entry) => entry.descriptor.command),
    ['plugin:alpha/review', 'plugin:beta/review'],
  )
  assert.deepEqual(
    snapshot.entries.map((entry) => entry.availableAliases),
    [[], []],
  )
})

test('shipping registries expose only their owned command kinds', () => {
  const client = createClientCommandRegistryV1().snapshot({
    workspaceId: 'workspace-1',
    workspaceTrusted: false,
    capabilityIds: [],
  })
  assert.deepEqual(
    client.entries.map((entry) => entry.descriptor.command),
    ['copy'],
  )
  assert.ok(client.entries.every((entry) => entry.descriptor.kind === 'client_local'))

  const runtime = createRuntimeCommandRegistryV1().snapshot({
    workspaceId: 'workspace-1',
    workspaceTrusted: true,
    capabilityIds: [
      'artifact.read',
      'credential.write',
      'provider.read',
      'runtime.diagnostics',
      'session.read',
      'session.write',
    ],
  })
  assert.ok(runtime.entries.length >= 13)
  assert.ok(runtime.entries.every((entry) => entry.descriptor.kind !== 'client_local'))
  assert.equal(
    runtime.entries.find((entry) => entry.descriptor.command === 'export')?.descriptor.persistence,
    'redacted',
  )
})

function builtinDescriptor(command: string, kind: CommandKindV1): CommandDescriptorV1 {
  return createCommandDescriptorV1(descriptorInput(command, kind))
}

function descriptorInput(command: string, kind: CommandKindV1) {
  const runtime = kind !== 'client_local'
  return {
    id: `builtin:${runtime ? 'runtime' : 'client'}/${command}`,
    command,
    aliases: [],
    title: command,
    description: `${command} command`,
    usage: `/${command}`,
    kind,
    schema: schema(),
    source: {
      kind: 'builtin' as const,
      origin: runtime ? 'praxis:runtime' : 'praxis:client',
      digest: commandSourceDigestV1(`builtin-${command}`),
    },
    effect:
      kind === 'client_local'
        ? ('none' as const)
        : kind === 'runtime_query'
          ? ('read' as const)
          : ('mutation' as const),
    capabilities: [],
    availability: {
      session: 'required' as const,
      run: 'any' as const,
      requiresWorkspaceTrust: false,
    },
    output: {
      kind: kind === 'client_local' ? ('ui_action' as const) : ('runtime_result' as const),
      maxBytes: 4_096,
    },
    sensitiveArguments: [],
    persistence: 'digest' as const,
  }
}

function externalDescriptor(
  kind: 'plugin' | 'skill',
  namespace: string,
  command: string,
  aliases: readonly string[],
): CommandDescriptorV1 {
  return createCommandDescriptorV1({
    ...descriptorInput(command, kind === 'skill' ? 'skill_invocation' : 'workflow'),
    id: `${kind}:${namespace}/review`,
    command,
    aliases,
    source: {
      kind,
      origin: `workspace:${kind}/${namespace}`,
      namespace,
      digest: commandSourceDigestV1(`${kind}-${namespace}`),
    },
    effect: kind === 'skill' ? 'prompt' : 'job',
    output: {
      kind: kind === 'skill' ? 'prompt_envelope' : 'bounded_job',
      maxBytes: 4_096,
    },
  })
}

function schema(argument?: string, required = false) {
  return {
    type: 'object' as const,
    additionalProperties: false as const,
    properties:
      argument === undefined ? {} : { [argument]: { type: 'string' as const, maxLength: 256 } },
    required: argument !== undefined && required ? [argument] : [],
    positional: argument === undefined ? [] : [argument],
  }
}

function hasCode(code: string) {
  return (error: unknown): boolean =>
    typeof error === 'object' && error !== null && Reflect.get(error, 'code') === code
}
