import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import type { PluginGrant } from '@praxis/plugin-protocol'
import { ExtensionInstallationService } from '../apps/runtime/src/extensions/installationService.js'

const readGrant: PluginGrant = {
  type: 'filesystem',
  access: 'read',
  paths: ['$' + '{workspace}'],
}

test('plugin installation is inspectable, content-addressed, immutable, and does not execute code', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-extension-home-'))
  const source = await mkdtemp(join(tmpdir(), 'praxis-extension-source-'))
  const workspace = await mkdtemp(join(tmpdir(), 'praxis-extension-workspace-'))
  const marker = join(source, 'executed.txt')
  try {
    await pluginFixture(source, 'example.tool', '1.0.0', marker)
    const service = new ExtensionInstallationService(root)
    const installed = await service.install(source)
    assert.equal(installed.enabled, false)
    assert.equal(installed.lifecycle, 'installed')
    assert.match(installed.digest, /^sha256:[a-f0-9]{64}$/)
    await assert.rejects(access(marker))

    const inspected = await service.inspect('example.tool', '1.0.0')
    assert.equal(inspected.manifest.capabilities[0]?.kind, 'tool')
    assert.equal((await service.doctor())[0]?.ok, true)

    const enabled = await service.enable(workspace, 'example.tool', '1.0.0', [readGrant])
    assert.equal(enabled.enabled, true)
    assert.equal(enabled.lifecycle, 'workspace-enabled')
    assert.equal(enabled.health, 'stopped')
    assert.match(enabled.instanceId ?? '', /^plugin-/)
    assert.deepEqual(await service.permissions(workspace, 'example.tool'), {
      requested: [readGrant],
      approved: [readGrant],
    })
    assert.equal((await service.setHealth(workspace, 'example.tool', 'healthy')).health, 'healthy')
    assert.equal(
      (await service.list(workspace)).find((entry) => entry.id === 'example.tool')?.lifecycle,
      'healthy',
    )
    await service.setHealth(workspace, 'example.tool', 'quarantined')
    assert.equal(
      (await service.list(workspace)).find((entry) => entry.id === 'example.tool')?.health,
      'quarantined',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(source, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  }
})

test('fixed-version workspace enablement supports update, rollback, disable, and uninstall isolation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-extension-lifecycle-'))
  const firstSource = await mkdtemp(join(tmpdir(), 'praxis-extension-v1-'))
  const secondSource = await mkdtemp(join(tmpdir(), 'praxis-extension-v2-'))
  const workspace = await mkdtemp(join(tmpdir(), 'praxis-extension-workspace-a-'))
  const otherWorkspace = await mkdtemp(join(tmpdir(), 'praxis-extension-workspace-b-'))
  try {
    await pluginFixture(firstSource, 'example.lifecycle', '1.0.0')
    await pluginFixture(secondSource, 'example.lifecycle', '2.0.0')
    const service = new ExtensionInstallationService(root)
    await service.install(firstSource)
    await service.enable(workspace, 'example.lifecycle', '1.0.0', [readGrant])
    await service.update(workspace, secondSource, [readGrant])
    assert.equal((await service.list(workspace)).find((entry) => entry.enabled)?.version, '2.0.0')
    assert.equal((await service.rollback(workspace, 'example.lifecycle')).version, '1.0.0')

    await service.enable(otherWorkspace, 'example.lifecycle', '2.0.0', [readGrant])
    await service.disable(workspace, 'example.lifecycle')
    assert.equal(
      (await service.list(workspace)).find((entry) => entry.version === '1.0.0')?.lifecycle,
      'stopped',
    )
    assert.equal(
      (await service.list(workspace)).some((entry) => entry.enabled),
      false,
    )
    assert.equal(
      (await service.list(otherWorkspace)).find((entry) => entry.version === '2.0.0')?.enabled,
      true,
    )
    await assert.rejects(
      service.uninstall('example.lifecycle', '2.0.0'),
      hasCode('PLUGIN_STILL_ENABLED'),
    )
    await service.disable(otherWorkspace, 'example.lifecycle')
    await service.uninstall('example.lifecycle', '2.0.0')
    await assert.rejects(
      service.inspect('example.lifecycle', '2.0.0'),
      hasCode('PLUGIN_NOT_INSTALLED'),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(firstSource, { recursive: true, force: true })
    await rm(secondSource, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
    await rm(otherWorkspace, { recursive: true, force: true })
  }
})

test('plugin entry names beginning with two dots stay inside the source directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-extension-dot-entry-home-'))
  const source = await mkdtemp(join(tmpdir(), 'praxis-extension-dot-entry-source-'))
  try {
    await pluginFixture(source, 'example.dot-entry', '1.0.0', undefined, '..entry/index.mjs')

    const installed = await new ExtensionInstallationService(root).install(source)

    assert.equal(installed.id, 'example.dot-entry')
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(source, { recursive: true, force: true })
  }
})

test('plugin entry traversal to a parent directory remains rejected', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'praxis-extension-parent-entry-'))
  const home = join(fixtureRoot, 'home')
  const source = join(fixtureRoot, 'source')
  try {
    await pluginFixture(source, 'example.parent-entry', '1.0.0', undefined, '../outside.mjs')

    await assert.rejects(
      new ExtensionInstallationService(home).install(source),
      hasCode('PLUGIN_ENTRY_INVALID'),
    )
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})

test('persisted plugin registries reject malformed grants instead of trusting casts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-extension-persistence-'))
  const source = await mkdtemp(join(tmpdir(), 'praxis-extension-persistence-source-'))
  const workspace = await mkdtemp(join(tmpdir(), 'praxis-extension-persistence-workspace-'))
  try {
    await pluginFixture(source, 'example.persistence', '1.0.0')
    const service = new ExtensionInstallationService(root)
    await service.install(source)
    await service.enable(workspace, 'example.persistence', '1.0.0', [readGrant])

    const canonicalWorkspace = await realpath(workspace)
    const workspaceDigest = createHash('sha256').update(canonicalWorkspace).digest('hex')
    const workspaceRegistryPath = join(root, 'extensions', 'workspaces', `${workspaceDigest}.json`)
    const registry = JSON.parse(await readFile(workspaceRegistryPath, 'utf8')) as {
      extensions: Array<{ grants: unknown[] }>
    }
    registry.extensions[0]?.grants.push({
      type: 'network',
      hosts: ['api.example.com'],
      allowPrivate: true,
    })
    await writeFile(workspaceRegistryPath, `${JSON.stringify(registry)}\n`, 'utf8')

    await assert.rejects(service.list(workspace), /Invalid workspace extension registry/)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(source, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  }
})

test('enabled data-only plugins expose only manifest-declared immutable resource sources', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-extension-resource-home-'))
  const source = await mkdtemp(join(tmpdir(), 'praxis-extension-resource-source-'))
  const workspace = await mkdtemp(join(tmpdir(), 'praxis-extension-resource-workspace-'))
  try {
    await mkdir(join(source, 'skills', 'review'), { recursive: true })
    await writeFile(
      join(source, 'skills', 'review', 'SKILL.md'),
      '---\nname: review\ndescription: Review from an immutable plugin store.\n---\nReview safely.\n',
      'utf8',
    )
    await writeFile(
      join(source, 'undeclared.md'),
      'This file must not become a model-visible resource.',
      'utf8',
    )
    await writeFile(
      join(source, 'praxis-plugin.json'),
      `${JSON.stringify(
        {
          manifestVersion: 1,
          id: 'example.skills',
          name: 'Example Skills',
          version: '1.0.0',
          apiVersion: 1,
          isolation: 'data-only',
          capabilities: [{ id: 'review', kind: 'skill', path: 'skills/review/SKILL.md' }],
          grants: [],
        },
        undefined,
        2,
      )}\n`,
      'utf8',
    )

    const service = new ExtensionInstallationService(root)
    const installed = await service.install(source)
    await service.enable(workspace, installed.id, installed.version, [])
    const resources = await service.resourceSources(workspace)

    assert.equal(resources.length, 1)
    assert.equal(resources[0]?.namespace, 'example.skills')
    assert.equal(resources[0]?.origin, `plugin:example.skills@${installed.digest}`)
    assert.deepEqual(resources[0]?.declarations, [
      { id: 'review', kind: 'skill', path: 'skills/review/SKILL.md' },
    ])
    assert.notEqual(resources[0]?.path, source)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(source, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  }
})

test('enabled MCP plugins resolve fixed-digest stdio launch selections', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-extension-mcp-home-'))
  const source = await mkdtemp(join(tmpdir(), 'praxis-extension-mcp-source-'))
  const workspace = await mkdtemp(join(tmpdir(), 'praxis-extension-mcp-workspace-'))
  try {
    await writeFile(
      join(source, 'praxis-plugin.json'),
      `${JSON.stringify({
        manifestVersion: 1,
        id: 'example.mcp-tools',
        name: 'Example MCP Tools',
        version: '1.0.0',
        apiVersion: 1,
        entry: 'server.mjs',
        isolation: 'mcp-stdio',
        capabilities: [{ id: 'workspace', kind: 'mcp' }],
        grants: [],
      })}\n`,
      'utf8',
    )
    await writeFile(
      join(source, 'server.mjs'),
      await readFile(join(process.cwd(), 'test', 'fixtures', 'mcp-modern-server.mjs'), 'utf8'),
      'utf8',
    )
    const service = new ExtensionInstallationService(root)
    const installed = await service.install(source)
    const enabled = await service.enable(workspace, installed.id, installed.version, [])
    const contract = service as ExtensionInstallationService & {
      mcpServerSelections?: (workspace: string) => Promise<
        Array<{
          pluginId: string
          serverId: string
          digest: string
          instanceId: string
          entryPath: string
        }>
      >
    }

    assert.equal(typeof contract.mcpServerSelections, 'function')
    const selections = await contract.mcpServerSelections?.(workspace)
    assert.deepEqual(
      selections?.map(({ pluginId, serverId, digest, instanceId }) => ({
        pluginId,
        serverId,
        digest,
        instanceId,
      })),
      [
        {
          pluginId: 'example.mcp-tools',
          serverId: 'workspace',
          digest: installed.digest,
          instanceId: `${enabled.instanceId}:workspace`,
        },
      ],
    )
    assert.match(selections?.[0]?.entryPath ?? '', /server\.mjs$/)
    assert.notEqual(selections?.[0]?.entryPath, join(source, 'server.mjs'))
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(source, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  }
})

test('external command mappings require healthy enablement and an unchanged installation digest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-extension-command-home-'))
  const source = await mkdtemp(join(tmpdir(), 'praxis-extension-command-source-'))
  const workspace = await mkdtemp(join(tmpdir(), 'praxis-extension-command-workspace-'))
  try {
    await writeFile(
      join(source, 'praxis-plugin.json'),
      `${JSON.stringify({
        manifestVersion: 1,
        id: 'example.commands',
        name: 'Example Commands',
        version: '1.0.0',
        apiVersion: 1,
        entry: 'index.mjs',
        isolation: 'process',
        capabilities: [{ id: 'echo', kind: 'tool' }],
        commands: [
          {
            id: 'echo',
            title: 'Echo',
            description: 'Echo one value.',
            capability: 'echo',
            positional: ['value'],
            sensitiveArguments: [],
            persistence: 'digest',
          },
        ],
        grants: [],
      })}\n`,
      'utf8',
    )
    await writeFile(join(source, 'index.mjs'), 'export const ready = true\n', 'utf8')
    const service = new ExtensionInstallationService(root)
    const installed = await service.install(source)
    await service.enable(workspace, installed.id, installed.version, [])
    assert.deepEqual(await service.commandMappings(workspace), [])

    await service.setHealth(workspace, installed.id, 'healthy')
    assert.equal((await service.commandMappings(workspace))[0]?.mapping.id, 'echo')
    await service.setHealth(workspace, installed.id, 'quarantined')
    assert.deepEqual(await service.commandMappings(workspace), [])

    await service.setHealth(workspace, installed.id, 'healthy')
    const inspected = await service.inspect(installed.id, installed.version)
    await writeFile(join(inspected.storePath, 'tampered.txt'), 'changed\n', 'utf8')
    await assert.rejects(service.commandMappings(workspace), hasCode('PLUGIN_CONTENT_CHANGED'))
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(source, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  }
})

async function pluginFixture(
  root: string,
  id: string,
  version: string,
  marker?: string,
  entry = 'index.mjs',
): Promise<void> {
  await mkdir(root, { recursive: true })
  await writeFile(
    join(root, 'praxis-plugin.json'),
    `${JSON.stringify(
      {
        manifestVersion: 1,
        id,
        name: id,
        version,
        apiVersion: 1,
        entry,
        isolation: 'process',
        capabilities: [{ id: `${id}.read`, kind: 'tool' }],
        grants: [readGrant],
      },
      undefined,
      2,
    )}\n`,
    'utf8',
  )
  await mkdir(dirname(join(root, entry)), { recursive: true })
  await writeFile(
    join(root, entry),
    marker
      ? `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'ran')\n`
      : `export const version = ${JSON.stringify(version)}\n`,
    'utf8',
  )
}

function hasCode(code: string) {
  return (error: unknown) =>
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code
}
