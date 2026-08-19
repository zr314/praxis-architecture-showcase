import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { ChatProvider, RuntimeTool } from '@praxis/core-sdk'
import { ExtensionInstallationService } from '../apps/runtime/src/extensions/installationService.js'
import { TrustedOnlyIsolationBackend } from '../apps/runtime/src/security/isolationBackend.js'
import { ToolRuntime } from '../apps/runtime/src/tools/toolRuntime.js'

test('process activation publishes one digest-pinned Tool and streamed Provider snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-process-activation-home-'))
  const source = await mkdtemp(join(tmpdir(), 'praxis-process-activation-source-'))
  const workspace = await mkdtemp(join(tmpdir(), 'praxis-process-activation-workspace-'))
  let activation:
    | {
        snapshot(workspace: string): Promise<{
          tools: readonly RuntimeTool[]
          providers: ReadonlyMap<string, ChatProvider>
        }>
        deactivate(workspace: string, pluginId: string): Promise<void>
        shutdown(): Promise<void>
      }
    | undefined
  try {
    await writeFile(
      join(source, 'praxis-plugin.json'),
      `${JSON.stringify({
        manifestVersion: 1,
        id: 'example.process-runtime',
        name: 'Process Runtime Fixture',
        version: '1.0.0',
        apiVersion: 1,
        entry: 'server.mjs',
        isolation: 'process',
        capabilities: [
          { id: 'echo', kind: 'tool' },
          { id: 'chat', kind: 'provider' },
        ],
        credentials: ['PLUGIN_TOKEN'],
        grants: [{ type: 'environment', names: ['PLUGIN_TOKEN'] }],
      })}\n`,
      'utf8',
    )
    await writeFile(
      join(source, 'server.mjs'),
      await readFile(join(process.cwd(), 'test', 'fixtures', 'process-runtime-plugin.mjs'), 'utf8'),
      'utf8',
    )
    const installations = new ExtensionInstallationService(root)
    const installed = await installations.install(source)
    await installations.enable(workspace, installed.id, installed.version, [
      { type: 'environment', names: ['PLUGIN_TOKEN'] },
    ])
    const { ProcessActivationService } = await import(
      '../apps/runtime/src/extensions/processActivationService.js'
    )
    activation = new ProcessActivationService(installations, {
      isolationBackend: new TrustedOnlyIsolationBackend(),
      environment: {},
    })

    const snapshot = await activation.snapshot(workspace)

    assert.equal(snapshot.tools.length, 1)
    assert.match(snapshot.tools[0]?.definition.name ?? '', /^process__/)
    const runtime = new ToolRuntime(snapshot.tools, { exposeArtifactTool: false })
    assert.deepEqual(
      await runtime.execute(
        snapshot.tools[0]?.definition.name ?? '',
        { value: 'hello' },
        workspace,
        new AbortController().signal,
      ),
      {
        ok: true,
        summary: 'Process Tool echo completed.',
        output: { value: 'hello' },
      },
    )

    const provider = snapshot.providers.get('example.process-runtime/chat')
    assert.equal(provider?.defaultModel, 'fixture-v1')
    assert.deepEqual(provider?.authState(), { status: 'unauthenticated' })
    const chunks = []
    for await (const chunk of provider?.stream({
      model: 'fixture-v1',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      signal: new AbortController().signal,
    }) ?? []) {
      chunks.push(chunk)
    }
    assert.equal(chunks.find((chunk) => chunk.type === 'text_delta')?.text, 'process provider')
    assert.deepEqual(chunks.at(-1), {
      type: 'completed',
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 2 },
    })

    const cancellation = new AbortController()
    const cancelled = provider
      ?.stream({
        model: 'fixture-v1',
        messages: [{ role: 'user', content: 'cancel' }],
        tools: [],
        signal: cancellation.signal,
      })
      [Symbol.asyncIterator]()
    assert.equal((await cancelled?.next())?.value?.type, 'message_start')
    cancellation.abort()
    await assert.rejects(async () => {
      while (!(await cancelled?.next())?.done) {
        // Drain the already framed prefix until cancellation becomes terminal.
      }
    }, hasCode('PROCESS_PLUGIN_CANCELLED'))
    assert.equal((await activation.snapshot(workspace)).providers.size, 1)
    assert.equal(
      (await installations.list(workspace)).find((plugin) => plugin.id === installed.id)?.health,
      'healthy',
    )

    const staleTool = snapshot.tools[0]
    const crashed = await runtime.execute(
      staleTool?.definition.name ?? '',
      { value: 'crash' },
      workspace,
      new AbortController().signal,
    )
    assert.equal(crashed.ok, false)
    assert.equal(crashed.error?.code, 'PROCESS_PLUGIN_EXITED')
    assert.equal((await activation.snapshot(workspace)).tools.length, 0)
    assert.equal(
      (await installations.list(workspace)).find((plugin) => plugin.id === installed.id)?.health,
      'quarantined',
    )
    await activation.deactivate(workspace, installed.id)
    await assert.rejects(
      staleTool?.execute({
        name: staleTool.definition.name,
        input: { value: 'late' },
        cwd: workspace,
        signal: new AbortController().signal,
      }),
      hasCode('PROCESS_CAPABILITY_STALE'),
    )
  } finally {
    await activation?.shutdown()
    await rm(root, { recursive: true, force: true })
    await rm(source, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  }
})

test('process activation fails closed without explicit trusted-only approval', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-process-trust-home-'))
  const source = await mkdtemp(join(tmpdir(), 'praxis-process-trust-source-'))
  const workspace = await mkdtemp(join(tmpdir(), 'praxis-process-trust-workspace-'))
  let activation:
    | {
        snapshot(workspace: string): Promise<{
          tools: readonly RuntimeTool[]
          providers: ReadonlyMap<string, ChatProvider>
        }>
        shutdown(): Promise<void>
      }
    | undefined
  try {
    await writeFile(
      join(source, 'praxis-plugin.json'),
      `${JSON.stringify({
        manifestVersion: 1,
        id: 'example.process-runtime',
        name: 'Process Runtime Fixture',
        version: '1.0.0',
        apiVersion: 1,
        entry: 'server.mjs',
        isolation: 'process',
        capabilities: [{ id: 'echo', kind: 'tool' }],
        grants: [],
      })}\n`,
      'utf8',
    )
    await writeFile(
      join(source, 'server.mjs'),
      await readFile(join(process.cwd(), 'test', 'fixtures', 'process-runtime-plugin.mjs'), 'utf8'),
      'utf8',
    )
    const installations = new ExtensionInstallationService(root)
    const installed = await installations.install(source)
    await installations.enable(workspace, installed.id, installed.version, [], {
      trustedOnly: false,
    })
    const { ProcessActivationService } = await import(
      '../apps/runtime/src/extensions/processActivationService.js'
    )
    activation = new ProcessActivationService(installations, {
      isolationBackend: new TrustedOnlyIsolationBackend(),
    })

    const snapshot = await activation.snapshot(workspace)

    assert.equal(snapshot.tools.length, 0)
    assert.equal(snapshot.providers.size, 0)
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

function hasCode(code: string) {
  return (error: unknown) =>
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code
}
