import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { isPluginManifestV1 } from '@praxis/plugin-protocol'
import { scaffoldPlugin } from '@praxis/plugin-sdk'
import { ProcessPluginHost } from '../apps/runtime/src/plugin/processPluginHost.js'

test('example plugin manifests share the public contract on every platform', async () => {
  for (const kind of ['tool', 'mcp-server', 'provider']) {
    const manifest = JSON.parse(
      await readFile(
        new URL(`../examples/plugins/${kind}/praxis-plugin.json`, import.meta.url),
        'utf8',
      ),
    )
    assert.equal(isPluginManifestV1(manifest), true, `${kind} manifest`)
  }
})

test('plugin generator creates executable contract-valid process plugins', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-scaffold-parent-'))
  try {
    for (const kind of ['tool', 'provider'] as const) {
      await t.test(kind, async () => {
        const id = `example.generated.${kind}`
        const destination = join(root, kind)
        await scaffoldPlugin(destination, { id, kind })
        const manifest = JSON.parse(await readFile(join(destination, 'praxis-plugin.json'), 'utf8'))
        assert.equal(isPluginManifestV1(manifest), true)

        const host = new ProcessPluginHost({ enabled: true, requestTimeoutMs: 2_000 })
        const plugin = await host.start({
          command: process.execPath,
          args: [join(destination, 'index.mjs')],
          cwd: destination,
          pluginId: id,
          version: '0.1.0',
          capabilities: [{ id: `example.${kind}`, kind }],
        })
        try {
          assert.equal(plugin.capabilities[0]?.kind, kind)
          const output = await plugin.invoke(`example.${kind}`, { value: 'hello' })
          if (kind === 'tool') assert.deepEqual(output, { value: 'hello' })
          else assert.equal(Array.isArray((output as { chunks?: unknown }).chunks), true)
        } catch (error) {
          throw new Error(`Generated ${kind} invocation failed.`, { cause: error })
        } finally {
          await plugin.shutdown()
        }
      })
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
