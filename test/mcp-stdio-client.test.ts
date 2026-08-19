import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { McpStdioClient } from '../apps/runtime/src/extensions/mcpStdioClient.js'
import { ToolRuntime } from '../apps/runtime/src/tools/toolRuntime.js'

const server = fileURLToPath(new URL('../examples/plugins/mcp-server/server.mjs', import.meta.url))
const modernServer = fileURLToPath(new URL('./fixtures/mcp-modern-server.mjs', import.meta.url))
const wrongLegacyServer = fileURLToPath(
  new URL('./fixtures/mcp-legacy-wrong-version.mjs', import.meta.url),
)

test('MCP stdio adapter exposes tools/list and tools/call through Runtime Tool contracts', async () => {
  const client = await McpStdioClient.start({
    command: process.execPath,
    args: [server],
    requestTimeoutMs: 2_000,
  })
  try {
    assert.deepEqual(
      client.listTools().map((tool) => tool.name),
      ['echo'],
    )
    const [tool] = client.runtimeTools()
    assert.equal(tool?.definition.execution?.sideEffect, 'process')
    const result = await tool?.execute({
      name: 'echo',
      input: { value: 'hello' },
      cwd: process.cwd(),
      signal: new AbortController().signal,
    })
    assert.ok(result)
    assert.equal(result.ok, true)
    assert.deepEqual(result.output, { value: 'hello' })
    await assert.rejects(client.unsupported('resources/list'), hasCode('MCP_SURFACE_UNSUPPORTED'))
  } finally {
    await client.shutdown()
  }
})

test('MCP stdio adapter negotiates the final 2026-07-28 protocol revision', async () => {
  const client = await McpStdioClient.start({
    command: process.execPath,
    args: [modernServer],
    requestTimeoutMs: 2_000,
  })
  try {
    assert.equal(client.protocolVersion, '2026-07-28')
    assert.deepEqual(
      client.listTools().map((tool) => tool.name),
      ['echo'],
    )
  } finally {
    await client.shutdown()
  }
})

test('MCP legacy fallback accepts only the selected compatibility revision', async () => {
  await assert.rejects(
    McpStdioClient.start({
      command: process.execPath,
      args: [wrongLegacyServer],
      requestTimeoutMs: 2_000,
    }),
    hasCode('MCP_PROTOCOL_INVALID'),
  )
})

test('MCP stdio adapter exhausts tools/list pagination before publishing a snapshot', async () => {
  const client = await McpStdioClient.start({
    command: process.execPath,
    args: [modernServer, 'paginated'],
    requestTimeoutMs: 2_000,
  })
  try {
    assert.deepEqual(
      client.listTools().map((tool) => tool.name),
      ['first', 'second'],
    )
  } finally {
    await client.shutdown()
  }
})

test('MCP Runtime Tool names are origin-qualified, stable, and Provider bounded', async () => {
  const client = await McpStdioClient.start({
    command: process.execPath,
    args: [modernServer],
    pluginId: 'example.mcp-tools',
    serverId: 'workspace.server',
    requestTimeoutMs: 2_000,
  })
  try {
    const first = client.runtimeTools()[0]?.definition.name
    const second = client.runtimeTools()[0]?.definition.name
    assert.equal(first, second)
    assert.match(first ?? '', /^mcp__[A-Za-z0-9_]+$/)
    assert.notEqual(first, 'echo')
    assert.ok((first?.length ?? Number.POSITIVE_INFINITY) <= 64)
  } finally {
    await client.shutdown()
  }
})

test('MCP stdio adapter rejects an oversized frame before a newline arrives', async () => {
  await assert.rejects(
    McpStdioClient.start({
      command: process.execPath,
      args: [modernServer, 'oversized-frame'],
      requestTimeoutMs: 2_000,
      maxLineBytes: 1_024,
    }),
    hasCode('MCP_PROTOCOL_INVALID'),
  )
})

test('MCP progress survives a multibyte split and reaches Runtime Tool updates', async () => {
  const client = await McpStdioClient.start({
    command: process.execPath,
    args: [modernServer, 'progress'],
    requestTimeoutMs: 2_000,
  })
  try {
    const updates: string[] = []
    const result = await client.runtimeTools()[0]?.execute({
      name: 'ignored-by-adapter',
      input: { value: 'hello' },
      cwd: process.cwd(),
      signal: new AbortController().signal,
      onUpdate: (update) => updates.push(update.message),
    })
    assert.equal(result?.ok, true)
    assert.deepEqual(updates, ['处理中'])
  } finally {
    await client.shutdown()
  }
})

test('MCP request timeout notifies the modern server before rejecting', async () => {
  const client = await McpStdioClient.start({
    command: process.execPath,
    args: [modernServer, 'timeout'],
    requestTimeoutMs: 1_000,
  })
  try {
    await assert.rejects(
      client.callTool('echo', { value: 'hello' }),
      hasCode('MCP_REQUEST_TIMEOUT'),
    )
    await waitUntil(() => client.stderr.includes('cancelled:'), 1_000)
  } finally {
    await client.shutdown()
  }
})

test('MCP Tool publication rejects external schema references', async () => {
  let client: McpStdioClient | undefined
  try {
    client = await McpStdioClient.start({
      command: process.execPath,
      args: [modernServer, 'hostile-schema'],
      requestTimeoutMs: 2_000,
    })
    assert.fail('Expected the hostile MCP schema to be rejected.')
  } catch (error) {
    assert.equal(hasCode('MCP_PROTOCOL_INVALID')(error), true)
  } finally {
    await client?.shutdown()
  }
})

test('MCP Tool publication rejects duplicate descriptors and excessive schema depth', async () => {
  for (const mode of ['duplicate-tools', 'recursive-schema']) {
    await assert.rejects(
      McpStdioClient.start({
        command: process.execPath,
        args: [modernServer, mode],
        requestTimeoutMs: 2_000,
      }),
      hasCode(mode === 'duplicate-tools' ? 'MCP_TOOL_COLLISION' : 'MCP_PROTOCOL_INVALID'),
    )
  }
})

test('MCP stderr is byte-bounded and preserves split UTF-8 diagnostics', async () => {
  const flooded = await McpStdioClient.start({
    command: process.execPath,
    args: [modernServer, 'stderr-flood'],
    requestTimeoutMs: 2_000,
    maxStderrBytes: 1_024,
  })
  try {
    assert.equal(Buffer.byteLength(flooded.stderr, 'utf8'), 1_024)
  } finally {
    await flooded.shutdown()
  }

  const split = await McpStdioClient.start({
    command: process.execPath,
    args: [modernServer, 'stderr-split'],
    requestTimeoutMs: 2_000,
  })
  try {
    assert.equal(split.stderr, '诊断中文')
  } finally {
    await split.shutdown()
  }
})

test('MCP structuredContent is the Runtime output validated by outputSchema', async () => {
  const client = await McpStdioClient.start({
    command: process.execPath,
    args: [modernServer],
    requestTimeoutMs: 2_000,
  })
  try {
    const runtime = new ToolRuntime(client.runtimeTools(), { exposeArtifactTool: false })
    const name = runtime.definitions()[0]?.name
    assert.ok(name)
    const result = await runtime.execute(
      name,
      { value: 'hello' },
      process.cwd(),
      new AbortController().signal,
    )
    assert.equal(result.ok, true)
    assert.deepEqual(result.output, { value: 'hello' })
  } finally {
    await client.shutdown()
  }
})

test('MCP Tool-list changes publish only after a complete refreshed snapshot', async () => {
  const client = await McpStdioClient.start({
    command: process.execPath,
    args: [modernServer, 'list-change'],
    requestTimeoutMs: 2_000,
  })
  try {
    assert.deepEqual(
      client.listTools().map((tool) => tool.name),
      ['first'],
    )
    await client.refreshTools()
    assert.deepEqual(
      client.listTools().map((tool) => tool.name),
      ['second'],
    )
  } finally {
    await client.shutdown()
  }
})

test('MCP invalid structured output is rejected by the Runtime Tool boundary', async () => {
  const client = await McpStdioClient.start({
    command: process.execPath,
    args: [modernServer, 'invalid-output'],
    requestTimeoutMs: 2_000,
  })
  try {
    const runtime = new ToolRuntime(client.runtimeTools(), { exposeArtifactTool: false })
    const result = await runtime.execute(
      runtime.definitions()[0]?.name ?? '',
      { value: 'hello' },
      process.cwd(),
      new AbortController().signal,
    )
    assert.equal(result.ok, false)
    assert.equal(result.error?.code, 'TOOL_OUTPUT_INVALID')
  } finally {
    await client.shutdown()
  }
})

test('MCP rejects unknown and duplicate response IDs but ignores a late cancelled response', async () => {
  await assert.rejects(
    McpStdioClient.start({
      command: process.execPath,
      args: [modernServer, 'unknown-response'],
      requestTimeoutMs: 2_000,
    }),
    hasCode('MCP_PROTOCOL_INVALID'),
  )

  const duplicate = await McpStdioClient.start({
    command: process.execPath,
    args: [modernServer, 'duplicate-response'],
    requestTimeoutMs: 2_000,
  })
  try {
    assert.equal((await duplicate.callTool('echo', { value: 'first' })).ok, true)
    await assert.rejects(
      duplicate.callTool('echo', { value: 'second' }),
      (error: unknown) =>
        hasCode('MCP_PROTOCOL_INVALID')(error) || hasCode('MCP_PROCESS_EXITED')(error),
    )
  } finally {
    await duplicate.shutdown()
  }

  const late = await McpStdioClient.start({
    command: process.execPath,
    args: [modernServer, 'late-response'],
    requestTimeoutMs: 2_000,
  })
  try {
    const controller = new AbortController()
    setTimeout(() => controller.abort('test-cancel'), 100)
    await assert.rejects(
      late.callTool('echo', { value: 'late' }, controller.signal),
      hasCode('MCP_REQUEST_CANCELLED'),
    )
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal((await late.callTool('echo', { value: 'next' })).ok, true)
  } finally {
    await late.shutdown()
  }
})

test('MCP rejects stdout contamination and unsupported server-initiated surfaces', async () => {
  await assert.rejects(
    McpStdioClient.start({
      command: process.execPath,
      args: [modernServer, 'stdout-contamination'],
      requestTimeoutMs: 2_000,
    }),
    hasCode('MCP_PROTOCOL_INVALID'),
  )
  const client = await McpStdioClient.start({
    command: process.execPath,
    args: [modernServer, 'unsupported-request'],
    requestTimeoutMs: 2_000,
  })
  try {
    await assert.rejects(
      client.callTool('echo', {}),
      (error: unknown) =>
        hasCode('MCP_SURFACE_UNSUPPORTED')(error) || hasCode('MCP_PROCESS_EXITED')(error),
    )
  } finally {
    await client.shutdown()
  }
})

test('MCP shutdown reclaims descendants before they can survive the server', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-mcp-tree-'))
  const pidPath = join(root, 'descendant.pid')
  const markerPath = join(root, 'descendant-survived.txt')
  let client: McpStdioClient | undefined
  let completed = false
  try {
    client = await McpStdioClient.start({
      command: process.execPath,
      args: [modernServer, 'descendant'],
      requestTimeoutMs: 2_000,
      environment: {
        PRAXIS_MCP_DESCENDANT_PID: pidPath,
        PRAXIS_MCP_DESCENDANT_MARKER: markerPath,
      },
    })
    await waitUntil(async () => {
      try {
        await access(pidPath)
        return true
      } catch {
        return false
      }
    }, 1_000)
    await client.shutdown()
    await new Promise((resolve) => setTimeout(resolve, 1_100))
    await assert.rejects(access(markerPath))
    completed = true
  } finally {
    await client?.shutdown()
    if (!completed) {
      try {
        process.kill(Number.parseInt(await readFile(pidPath, 'utf8'), 10), 'SIGKILL')
      } catch {
        // The descendant was reclaimed or never started.
      }
    }
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

function hasCode(code: string) {
  return (error: unknown) =>
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code
}

async function waitUntil(
  condition: () => boolean | Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await condition()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail('Timed out waiting for the MCP fixture condition.')
}
