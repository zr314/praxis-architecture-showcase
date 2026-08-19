import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { RuntimeTool } from '@praxis/core-sdk'
import { ExtensionInstallationService } from '../apps/runtime/src/extensions/installationService.js'
import { ToolRuntime } from '../apps/runtime/src/tools/toolRuntime.js'

test('MCP activation publishes fixed-digest Tools and invalidates stale snapshots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-mcp-activation-home-'))
  const source = await mkdtemp(join(tmpdir(), 'praxis-mcp-activation-source-'))
  const workspace = await mkdtemp(join(tmpdir(), 'praxis-mcp-activation-workspace-'))
  let activation:
    | {
        snapshot(workspace: string): Promise<{ tools: readonly RuntimeTool[] }>
        deactivate(workspace: string, pluginId: string): Promise<void>
        shutdown(): Promise<void>
      }
    | undefined
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
    const installations = new ExtensionInstallationService(root)
    const installed = await installations.install(source)
    await installations.enable(workspace, installed.id, installed.version, [])
    const extensions = (await import('../apps/runtime/src/extensions/index.js')) as Record<
      string,
      unknown
    >
    const Activation = extensions.McpActivationService as
      | (new (
          installationService: ExtensionInstallationService,
        ) => NonNullable<typeof activation>)
      | undefined

    assert.equal(typeof Activation, 'function')
    if (!Activation) assert.fail('McpActivationService is not exported.')
    activation = new Activation(installations)
    const snapshot = await activation.snapshot(workspace)
    assert.equal(snapshot.tools.length, 1)
    assert.equal(
      (await installations.list(workspace)).find((plugin) => plugin.id === installed.id)?.health,
      'healthy',
    )
    const concurrent = await Promise.all([
      activation.snapshot(workspace),
      activation.snapshot(workspace),
    ])
    assert.deepEqual(
      concurrent.map(({ tools }) => tools.length),
      [1, 1],
    )
    const tool = snapshot.tools[0]
    assert.match(tool?.definition.name ?? '', /^mcp__/)
    const runtime = new ToolRuntime(snapshot.tools, { exposeArtifactTool: false })
    const result = await runtime.execute(
      tool?.definition.name ?? '',
      { value: 'hello' },
      workspace,
      new AbortController().signal,
    )
    assert.equal(result.ok, true)
    assert.deepEqual(result.output, { value: 'hello' })

    await activation.deactivate(workspace, installed.id)
    await assert.rejects(
      tool?.execute({
        name: tool.definition.name,
        input: { value: 'late' },
        cwd: workspace,
        signal: new AbortController().signal,
      }),
      hasCode('MCP_CAPABILITY_STALE'),
    )
  } finally {
    await activation?.shutdown()
    await rm(root, { recursive: true, force: true })
    await rm(source, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  }
})

test('MCP activation passes only explicitly granted environment variables', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-mcp-environment-home-'))
  const source = await mkdtemp(join(tmpdir(), 'praxis-mcp-environment-source-'))
  const workspace = await mkdtemp(join(tmpdir(), 'praxis-mcp-environment-workspace-'))
  let activation:
    | {
        snapshot(workspace: string): Promise<{ tools: readonly RuntimeTool[] }>
        shutdown(): Promise<void>
      }
    | undefined
  try {
    const environmentGrant = {
      type: 'environment' as const,
      names: ['PRAXIS_MCP_TEST_VALUE'],
    }
    await writeFile(
      join(source, 'praxis-plugin.json'),
      `${JSON.stringify({
        manifestVersion: 1,
        id: 'example.environment-mcp',
        name: 'Environment MCP',
        version: '1.0.0',
        apiVersion: 1,
        entry: 'server.mjs',
        isolation: 'mcp-stdio',
        capabilities: [{ id: 'workspace', kind: 'mcp' }],
        grants: [environmentGrant],
      })}\n`,
      'utf8',
    )
    await writeFile(
      join(source, 'server.mjs'),
      await readFile(join(process.cwd(), 'test', 'fixtures', 'mcp-environment-server.mjs'), 'utf8'),
      'utf8',
    )
    const installations = new ExtensionInstallationService(root)
    const installed = await installations.install(source)
    await installations.enable(workspace, installed.id, installed.version, [environmentGrant])
    const { McpActivationService } = await import(
      '../apps/runtime/src/extensions/mcpActivationService.js'
    )
    activation = new McpActivationService(installations, {
      environment: {
        PRAXIS_MCP_TEST_VALUE: 'approved',
        PRAXIS_MCP_UNDECLARED_VALUE: 'secret',
      },
    })
    const tool = (await activation.snapshot(workspace)).tools[0]

    const result = await tool?.execute({
      name: tool.definition.name,
      input: {},
      cwd: workspace,
      signal: new AbortController().signal,
    })

    assert.equal(result?.ok, true)
    assert.deepEqual(
      (result?.output as { structuredContent?: unknown } | undefined)?.structuredContent,
      { approved: 'approved', undeclared: null },
    )
  } finally {
    await activation?.shutdown()
    await rm(root, { recursive: true, force: true })
    await rm(source, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  }
})

test('MCP crash quarantine atomically removes Tools without destabilizing the registry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-mcp-crash-home-'))
  const source = await mkdtemp(join(tmpdir(), 'praxis-mcp-crash-source-'))
  const workspace = await mkdtemp(join(tmpdir(), 'praxis-mcp-crash-workspace-'))
  let activation:
    | {
        snapshot(workspace: string): Promise<{ tools: readonly RuntimeTool[] }>
        shutdown(): Promise<void>
      }
    | undefined
  try {
    await writeFile(
      join(source, 'praxis-plugin.json'),
      `${JSON.stringify({
        manifestVersion: 1,
        id: 'example.crashing-mcp',
        name: 'Crashing MCP',
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
      await readFile(join(process.cwd(), 'test', 'fixtures', 'mcp-crash-after-list.mjs'), 'utf8'),
      'utf8',
    )
    const installations = new ExtensionInstallationService(root)
    const installed = await installations.install(source)
    await installations.enable(workspace, installed.id, installed.version, [])
    const { McpActivationService } = await import(
      '../apps/runtime/src/extensions/mcpActivationService.js'
    )
    activation = new McpActivationService(installations)
    const first = await activation.snapshot(workspace)
    const stale = first.tools[0]
    assert.equal(first.tools.length, 1)
    await new Promise((resolve) => setTimeout(resolve, 50))

    const second = await activation.snapshot(workspace)
    assert.equal(second.tools.length, 0)
    assert.equal(
      (await installations.list(workspace)).find((plugin) => plugin.id === installed.id)?.health,
      'quarantined',
    )
    await assert.rejects(
      stale?.execute({
        name: stale.definition.name,
        input: {},
        cwd: workspace,
        signal: new AbortController().signal,
      }),
      hasCode('MCP_CAPABILITY_STALE'),
    )
  } finally {
    await activation?.shutdown()
    await rm(root, { recursive: true, force: true })
    await rm(source, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  }
})

test('MCP activation quarantines a multi-server plugin atomically when one server fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-mcp-atomic-home-'))
  const source = await mkdtemp(join(tmpdir(), 'praxis-mcp-atomic-source-'))
  const workspace = await mkdtemp(join(tmpdir(), 'praxis-mcp-atomic-workspace-'))
  const firstServerMarker = join(source, 'first-server-started')
  let activation:
    | {
        snapshot(workspace: string): Promise<{
          tools: readonly RuntimeTool[]
          servers: readonly { health: 'healthy' | 'quarantined' }[]
        }>
        shutdown(): Promise<void>
      }
    | undefined
  try {
    await writeFile(
      join(source, 'praxis-plugin.json'),
      `${JSON.stringify({
        manifestVersion: 1,
        id: 'example.atomic-mcp',
        name: 'Atomic MCP',
        version: '1.0.0',
        apiVersion: 1,
        entry: 'server.mjs',
        isolation: 'mcp-stdio',
        capabilities: [
          { id: 'one', kind: 'mcp' },
          { id: 'two', kind: 'mcp' },
        ],
        grants: [],
      })}\n`,
      'utf8',
    )
    await writeFile(
      join(source, 'server.mjs'),
      `import { existsSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
const marker = ${JSON.stringify(firstServerMarker)}
const version = '2026-07-28'
createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (line) => {
  const request = JSON.parse(line)
  if (request.method === 'server/discover') {
    if (existsSync(marker)) process.exit(17)
    writeFileSync(marker, String(process.pid))
    respond(request.id, {
      resultType: 'complete',
      supportedVersions: [version],
      capabilities: { tools: {} },
      ttlMs: 0,
      cacheScope: 'private',
    })
    return
  }
  if (request.method === 'tools/list') {
    respond(request.id, {
      resultType: 'complete',
      tools: [{ name: 'echo', inputSchema: { type: 'object' } }],
      ttlMs: 0,
      cacheScope: 'private',
    })
    return
  }
  if (request.method === 'shutdown') {
    respond(request.id, { resultType: 'complete' })
  }
})
function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n')
}
`,
      'utf8',
    )
    const installations = new ExtensionInstallationService(root)
    const installed = await installations.install(source)
    await installations.enable(workspace, installed.id, installed.version, [])
    const { McpActivationService } = await import(
      '../apps/runtime/src/extensions/mcpActivationService.js'
    )
    activation = new McpActivationService(installations)

    const snapshot = await activation.snapshot(workspace)

    assert.equal(snapshot.tools.length, 0)
    assert.deepEqual(
      snapshot.servers.map(({ health }) => health),
      ['quarantined', 'quarantined'],
    )
    assert.equal(
      (await installations.list(workspace)).find((plugin) => plugin.id === installed.id)?.health,
      'quarantined',
    )
  } finally {
    await activation?.shutdown()
    await rm(root, { recursive: true, force: true })
    await rm(source, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  }
})

test('MCP invocation failure unpublishes the quarantined server before returning', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-mcp-call-crash-home-'))
  const source = await mkdtemp(join(tmpdir(), 'praxis-mcp-call-crash-source-'))
  const workspace = await mkdtemp(join(tmpdir(), 'praxis-mcp-call-crash-workspace-'))
  let activation:
    | {
        snapshot(workspace: string): Promise<{ tools: readonly RuntimeTool[] }>
        shutdown(): Promise<void>
      }
    | undefined
  try {
    await writeFile(
      join(source, 'praxis-plugin.json'),
      `${JSON.stringify({
        manifestVersion: 1,
        id: 'example.call-crash-mcp',
        name: 'Call Crash MCP',
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
      await readFile(join(process.cwd(), 'test', 'fixtures', 'mcp-crash-on-call.mjs'), 'utf8'),
      'utf8',
    )
    const installations = new ExtensionInstallationService(root)
    const installed = await installations.install(source)
    await installations.enable(workspace, installed.id, installed.version, [])
    const { McpActivationService } = await import(
      '../apps/runtime/src/extensions/mcpActivationService.js'
    )
    activation = new McpActivationService(installations)
    const tool = (await activation.snapshot(workspace)).tools[0]
    await assert.rejects(
      tool?.execute({
        name: tool.definition.name,
        input: {},
        cwd: workspace,
        signal: new AbortController().signal,
      }),
      hasCode('MCP_PROCESS_EXITED'),
    )
    assert.equal(
      (await installations.list(workspace)).find((plugin) => plugin.id === installed.id)?.health,
      'quarantined',
    )
    assert.equal((await activation.snapshot(workspace)).tools.length, 0)
  } finally {
    await activation?.shutdown()
    await rm(root, { recursive: true, force: true })
    await rm(source, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  }
})

function hasCode(code: string) {
  return (error: unknown) =>
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code
}
