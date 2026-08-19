import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import {
  isPluginGrant,
  isPluginGrantArray,
  isPluginManifestV1,
  normalizePluginCapability,
  PLUGIN_LIFECYCLE_STATES,
  PROCESS_PLUGIN_EVENT_TYPES,
  PROCESS_PLUGIN_PROTOCOL_VERSION,
  pluginCapabilityPublicationKey,
  type PluginGrant,
} from '@praxis/plugin-protocol'
import { isProtocolMessage } from '@praxis/protocol'
import Ajv2020 from 'ajv/dist/2020.js'

const validGrants: PluginGrant[] = [
  { type: 'filesystem', access: 'read', paths: ['$' + '{workspace}', 'src'] },
  { type: 'network', hosts: ['api.example.com'] },
  { type: 'environment', names: ['EXAMPLE_API_KEY'] },
  { type: 'process', commands: ['node'] },
  { type: 'resource', cpuMs: 5_000, memoryMb: 256, processCount: 2 },
]

const invalidGrants: unknown[] = [
  { type: 'filesystem', access: 'execute', paths: ['src'] },
  { type: 'filesystem', access: 'read', paths: [] },
  { type: 'network', hosts: ['api.example.com'], allowPrivate: true },
  { type: 'environment', names: [''] },
  { type: 'process', commands: ['node', 'node'] },
  { type: 'resource' },
  { type: 'resource', cpuMs: 0 },
  { type: 'unknown' },
]

test('public plugin protocol owns the closed Praxis process RPC revision', () => {
  assert.equal(PROCESS_PLUGIN_PROTOCOL_VERSION, 1)
  assert.deepEqual(PROCESS_PLUGIN_EVENT_TYPES, ['progress', 'output', 'diagnostic'])
})

test('plugin grants form one strict discriminated union', () => {
  for (const grant of validGrants) assert.equal(isPluginGrant(grant), true)
  assert.equal(isPluginGrantArray(validGrants), true)

  for (const grant of invalidGrants) assert.equal(isPluginGrant(grant), false)
  assert.equal(isPluginGrantArray([...validGrants, invalidGrants[0]]), false)
})

test('manifest guard rejects undeclared fields, duplicate capabilities, and unsafe entries', () => {
  const manifest = validManifest()
  assert.equal(isPluginManifestV1(manifest), true)
  assert.equal(isPluginManifestV1({ ...manifest, hook: './hook.mjs' }), false)
  assert.equal(
    isPluginManifestV1({
      ...manifest,
      capabilities: [{ id: 'echo', kind: 'tool', policy: 'ambient' }],
    }),
    false,
  )
  assert.equal(
    isPluginManifestV1({
      ...manifest,
      capabilities: [
        { id: 'echo', kind: 'tool' },
        { id: 'echo', kind: 'tool' },
      ],
    }),
    false,
  )
  assert.equal(isPluginManifestV1({ ...manifest, entry: '../outside.mjs' }), false)
  assert.equal(isPluginManifestV1({ ...manifest, grants: [invalidGrants[2]] }), false)
})

test('manifest command mappings are explicit, capability-bound, and privacy-safe', () => {
  const mapping = {
    id: 'echo',
    title: 'Echo value',
    description: 'Invoke the declared echo Tool.',
    capability: 'echo',
    positional: ['value'],
    sensitiveArguments: [],
    persistence: 'digest',
  }
  assert.equal(isPluginManifestV1({ ...validManifest(), commands: [mapping] }), true)
  assert.equal(
    isPluginManifestV1({
      ...validManifest(),
      commands: [{ ...mapping, capability: 'undeclared' }],
    }),
    false,
  )
  assert.equal(
    isPluginManifestV1({
      ...validManifest(),
      commands: [{ ...mapping, sensitiveArguments: ['value'], persistence: 'plaintext' }],
    }),
    false,
  )
  assert.equal(
    isPluginManifestV1({
      ...validManifest(),
      isolation: 'mcp-stdio',
      capabilities: [{ id: 'echo', kind: 'mcp' }],
      commands: [mapping],
    }),
    false,
  )
  assert.equal(
    isPluginManifestV1({
      ...validManifest(),
      isolation: 'mcp-stdio',
      capabilities: [{ id: 'echo', kind: 'mcp' }],
      commands: [{ ...mapping, tool: 'echo' }],
    }),
    true,
  )
})

test('data-only capabilities require a bounded relative resource path', () => {
  const skillManifest = {
    manifestVersion: 1,
    id: 'example.skills',
    name: 'Example Skills',
    version: '1.0.0',
    apiVersion: 1,
    isolation: 'data-only',
    capabilities: [{ id: 'review', kind: 'skill', path: 'skills/review/SKILL.md' }],
    grants: [],
  }

  assert.equal(isPluginManifestV1(skillManifest), true)
  assert.equal(
    isPluginManifestV1({
      ...skillManifest,
      capabilities: [{ id: 'review', kind: 'skill' }],
    }),
    false,
  )
  assert.equal(
    isPluginManifestV1({
      ...skillManifest,
      capabilities: [{ id: 'review', kind: 'skill', path: '../SKILL.md' }],
    }),
    false,
  )
  assert.equal(
    isPluginManifestV1({
      ...validManifest(),
      capabilities: [{ id: 'echo', kind: 'tool', path: 'echo.json' }],
    }),
    false,
  )
  assert.equal(
    isPluginManifestV1({
      ...skillManifest,
      entry: 'index.mjs',
      capabilities: [
        { id: 'review', kind: 'skill', path: 'skills/review/SKILL.md' },
        { id: 'echo', kind: 'tool' },
      ],
    }),
    false,
  )
})

test('manifest JSON schema and TypeScript guard agree on contract fixtures', async () => {
  const schema = JSON.parse(
    await readFile(
      join(process.cwd(), 'packages', 'plugin-protocol', 'schemas', 'manifest-v1.schema.json'),
      'utf8',
    ),
  ) as object
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema)
  const fixtures = [
    validManifest(),
    { ...validManifest(), extra: true },
    { ...validManifest(), entry: 'C:\\outside.mjs' },
    { ...validManifest(), grants: validGrants },
    { ...validManifest(), grants: [invalidGrants[2]] },
    {
      ...validManifest(),
      commands: [
        {
          id: 'echo',
          title: 'Echo',
          description: 'Echo a value.',
          capability: 'echo',
          positional: ['value'],
          sensitiveArguments: [],
          persistence: 'digest',
        },
      ],
    },
  ]

  for (const fixture of fixtures) {
    assert.equal(Boolean(validate(fixture)), isPluginManifestV1(fixture), JSON.stringify(fixture))
  }
})

test('manifest, handshake, and Runtime schemas enforce the same grant corpus', async () => {
  const schemaPaths = [
    ['plugin-protocol', 'schemas', 'manifest-v1.schema.json', 'pluginGrant'],
    ['plugin-protocol', 'schemas', 'handshake-v1.schema.json', 'pluginGrant'],
    ['protocol', 'schemas', 'methods-v1.schema.json', 'pluginGrant'],
  ] as const

  for (const [packageName, directory, fileName, definition] of schemaPaths) {
    const schema = JSON.parse(
      await readFile(join(process.cwd(), 'packages', packageName, directory, fileName), 'utf8'),
    ) as { $id: string }
    const ajv = new Ajv2020({ allErrors: true, strict: false })
    ajv.addSchema(schema)
    const validate = ajv.compile({ $ref: `${schema.$id}#/$defs/${definition}` })
    for (const grant of validGrants) assert.equal(validate(grant), true, fileName)
    for (const grant of invalidGrants) assert.equal(validate(grant), false, fileName)
  }
})

test('runtime protocol rejects unknown grant variants and fields before approval', () => {
  const request = (grants: unknown[]) => ({
    jsonrpc: '2.0',
    id: 'plugin-enable',
    method: 'plugin.enable',
    params: {
      workspace: process.cwd(),
      id: 'example.tool',
      version: '1.0.0',
      grants,
    },
  })

  assert.equal(isProtocolMessage(request(validGrants)), true)
  assert.equal(isProtocolMessage(request([invalidGrants[2]])), false)
  assert.equal(isProtocolMessage(request([{ type: 'unknown' }])), false)
})

test('plugin lifecycle vocabulary distinguishes management and live states', () => {
  assert.deepEqual(PLUGIN_LIFECYCLE_STATES, [
    'installed',
    'workspace-enabled',
    'starting',
    'healthy',
    'degraded',
    'quarantined',
    'stopped',
  ])
})

test('plugin capabilities have canonical kinds, qualified IDs, and digest publication keys', () => {
  const digest = `sha256:${'a'.repeat(64)}`
  const provider = normalizePluginCapability('example.plugin', digest, {
    id: 'chat',
    kind: 'provider',
  })
  const mcp = normalizePluginCapability('example.plugin', digest, { id: 'workspace', kind: 'mcp' })

  assert.deepEqual(provider, {
    id: 'example.plugin/chat',
    localId: 'chat',
    kind: 'llm-provider',
    origin: { type: 'plugin', pluginId: 'example.plugin', digest },
    publicationKey: `example.plugin/chat@${digest}`,
  })
  assert.equal(mcp.kind, 'mcp-server')
  assert.equal(
    pluginCapabilityPublicationKey('example.plugin', digest, { id: 'chat', kind: 'provider' }),
    provider.publicationKey,
  )
  assert.equal(Object.isFrozen(provider), true)
  assert.equal(Object.isFrozen(provider.origin), true)
  assert.throws(
    () =>
      normalizePluginCapability('example.plugin', 'mutable', {
        id: 'chat',
        kind: 'provider',
      }),
    /digest/,
  )
})

function validManifest() {
  return {
    manifestVersion: 1,
    id: 'example.tool',
    name: 'Example Tool',
    version: '1.0.0',
    apiVersion: 1,
    entry: 'dist/index.mjs',
    isolation: 'process',
    capabilities: [{ id: 'echo', kind: 'tool' }],
    grants: validGrants,
    credentials: ['EXAMPLE_API_KEY'],
    engines: { praxis: '>=0.1.0', node: '>=20' },
  }
}
