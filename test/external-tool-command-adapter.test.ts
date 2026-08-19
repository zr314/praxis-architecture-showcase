import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { RuntimeTool, ToolRequest, ToolResult } from '@praxis/core-sdk'
import type { PluginToolCommandMappingV1 } from '@praxis/plugin-protocol'
import { ArtifactStore } from '../apps/runtime/src/artifacts/artifactStore.js'
import {
  ExternalToolCommandAdapterV1,
  ExternalToolCommandExecutorV1,
} from '../apps/runtime/src/commands/externalToolCommandAdapter.js'
import { createRuntimeCommandRegistryV1 } from '../apps/runtime/src/commands/builtinCommandRegistry.js'
import type { ExternalToolCommandSelection } from '../apps/runtime/src/extensions/installationService.js'
import { mcpRuntimeToolName } from '../apps/runtime/src/extensions/mcpStdioClient.js'
import { processRuntimeToolName } from '../apps/runtime/src/extensions/processActivationService.js'
import type { PolicyAuditRecord } from '../apps/runtime/src/policy/index.js'
import { ToolRuntime } from '../apps/runtime/src/tools/toolRuntime.js'

test('MCP Tools remain Tool-only without an explicit manifest mapping', () => {
  const runtime = runtimeWith(tool('mcp', 'read'))
  assert.deepEqual(new ExternalToolCommandAdapterV1([], runtime).descriptors(), [])
})

test('explicit MCP mappings publish namespaced workflows and execute through ToolRuntime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-external-command-'))
  const workspace = await mkdtemp(join(tmpdir(), 'praxis-external-workspace-'))
  try {
    const runtime = runtimeWith(tool('mcp', 'process'))
    const adapter = new ExternalToolCommandAdapterV1([selection('mcp')], runtime)
    const descriptor = adapter.descriptors()[0]
    assert.equal(descriptor?.command, 'mcp:example.tools/echo')
    assert.equal(descriptor?.kind, 'workflow')
    assert.equal(descriptor?.effect, 'job')
    assert.deepEqual(descriptor?.aliases, [])
    if (descriptor === undefined) throw new Error('mapped command missing')

    const records: PolicyAuditRecord[] = []
    const artifacts = new ArtifactStore(root)
    const executor = new ExternalToolCommandExecutorV1(
      {
        allows: () => true,
        record: async (record) => {
          records.push(record)
        },
      },
      artifacts,
    )
    const output = await executor.execute(
      adapter.prepare(descriptor, invocation(descriptor, { value: 'hello' }), workspace),
      { workspace },
    )
    assert.equal(output.kind, 'bounded_job')
    if (output.kind !== 'bounded_job') throw new Error('bounded result missing')
    const stored = (await artifacts.read(output.jobId)) as {
      result: { ok: boolean; output: unknown }
      tool: { name: string }
    }
    assert.equal(stored.result.ok, true)
    assert.deepEqual(stored.result.output, { value: 'hello' })
    assert.equal(stored.tool.name, mcpRuntimeToolName('example.tools', 'server', 'echo'))
    assert.equal(records[0]?.decision, 'allow')
    assert.equal(JSON.stringify(records).includes('hello'), false)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  }
})

test('mapped commands fail closed on unsafe schema, permission, and reserved builtin names', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'praxis-external-workspace-'))
  try {
    const unsafe = tool('plugin', 'read', {
      type: 'object',
      properties: { nested: { type: 'object' } },
      required: ['nested'],
      additionalProperties: false,
    })
    assert.equal(
      new ExternalToolCommandAdapterV1(
        [selection('plugin', { positional: ['nested'] })],
        runtimeWith(unsafe),
      ).descriptors().length,
      0,
    )

    const runtime = runtimeWith(tool('plugin', 'process'))
    const adapter = new ExternalToolCommandAdapterV1(
      [selection('plugin', { id: 'compact' })],
      runtime,
    )
    const descriptor = adapter.descriptors()[0]
    if (descriptor === undefined) throw new Error('mapped command missing')
    const registry = createRuntimeCommandRegistryV1(adapter.descriptors())
    const snapshot = registry.snapshot({
      workspaceId: 'workspace-1',
      workspaceTrusted: true,
      capabilityIds: ['extension.command.invoke', 'session.write'],
    })
    assert.ok(snapshot.entries.some((entry) => entry.descriptor.command === 'compact'))
    assert.ok(
      snapshot.entries.some((entry) => entry.descriptor.command === 'plugin:example.tools/compact'),
    )

    let invoked = false
    const deniedRuntime = runtimeWith({
      ...tool('plugin', 'process'),
      execute: async () => {
        invoked = true
        return { ok: true, summary: 'unexpected' }
      },
    })
    const deniedAdapter = new ExternalToolCommandAdapterV1([selection('plugin')], deniedRuntime)
    const deniedDescriptor = deniedAdapter.descriptors()[0]!
    const records: PolicyAuditRecord[] = []
    await assert.rejects(
      new ExternalToolCommandExecutorV1(
        {
          allows: () => false,
          record: async (record) => {
            records.push(record)
          },
        },
        new ArtifactStore(join(workspace, 'artifacts')),
      ).execute(
        deniedAdapter.prepare(
          deniedDescriptor,
          invocation(deniedDescriptor, { value: 'secret-value' }),
          workspace,
        ),
        { workspace },
      ),
      hasRuntimeFailure('COMMAND_EXTERNAL_PERMISSION_REQUIRED', 'permission', true),
    )
    assert.equal(invoked, false)
    assert.equal(records[0]?.decision, 'ask')
    assert.equal(JSON.stringify(records).includes('secret-value'), false)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('mapped Tool execution has bounded deadline and parent cancellation artifacts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-external-command-'))
  const workspace = await mkdtemp(join(tmpdir(), 'praxis-external-workspace-'))
  try {
    const hanging = tool('plugin', 'read', undefined, 10, async (request) => {
      await new Promise<void>((resolve) =>
        request.signal.addEventListener('abort', () => resolve()),
      )
      return { ok: false, summary: 'cancelled' }
    })
    const runtime = runtimeWith(hanging)
    const adapter = new ExternalToolCommandAdapterV1([selection('plugin')], runtime)
    const descriptor = adapter.descriptors()[0]!
    const artifacts = new ArtifactStore(root)
    const executor = new ExternalToolCommandExecutorV1(
      { allows: () => true, record: async () => {} },
      artifacts,
    )
    await assert.rejects(
      executor.execute(
        adapter.prepare(descriptor, invocation(descriptor, { value: 'late' }), workspace),
        { workspace },
      ),
      hasRuntimeFailure('COMMAND_EXTERNAL_TIMEOUT', 'plugin', true),
    )

    const controller = new AbortController()
    controller.abort('test_cancel')
    await assert.rejects(
      executor.execute(
        adapter.prepare(descriptor, invocation(descriptor, { value: 'cancel' }), workspace),
        { workspace, signal: controller.signal },
      ),
      hasRuntimeFailure('COMMAND_EXTERNAL_CANCELLED', 'cancelled', false),
    )
    const stored = await artifacts.list()
    assert.equal(stored.length, 2)
    assert.ok(stored.every((artifact) => artifact.mimeType.includes('external-command-result')))
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  }
})

function selection(
  source: 'plugin' | 'mcp',
  override: Partial<PluginToolCommandMappingV1> = {},
): ExternalToolCommandSelection {
  return {
    pluginId: 'example.tools',
    source,
    version: '1.0.0',
    digest: `sha256:${'a'.repeat(64)}`,
    mapping: {
      id: 'echo',
      title: 'Echo value',
      description: 'Echo one bounded value.',
      capability: source === 'mcp' ? 'server' : 'echo',
      ...(source === 'mcp' ? { tool: 'echo' } : {}),
      positional: ['value'],
      sensitiveArguments: ['value'],
      persistence: 'digest',
      ...override,
    },
  }
}

function tool(
  source: 'plugin' | 'mcp',
  sideEffect: 'read' | 'process',
  parameters: Record<string, unknown> = {
    type: 'object',
    properties: { value: { type: 'string', minLength: 1, maxLength: 4096 } },
    required: ['value'],
    additionalProperties: false,
  },
  timeoutMs = 5_000,
  execute: (request: ToolRequest) => Promise<ToolResult> = async (request) => ({
    ok: true,
    summary: 'echoed',
    output: request.input,
  }),
): RuntimeTool {
  return {
    definition: {
      name:
        source === 'mcp'
          ? mcpRuntimeToolName('example.tools', 'server', 'echo')
          : processRuntimeToolName('example.tools', 'echo'),
      description: 'Echo a value.',
      parameters,
      outputSchema: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
        additionalProperties: false,
      },
      execution: {
        sideEffect,
        target: sideEffect === 'process' ? { kind: 'workspace' } : { kind: 'none' },
        parallelSafe: sideEffect === 'read',
        conflictScope: sideEffect === 'read' ? 'target' : 'workspace',
        maxInlineBytes: 65_536,
        timeoutMs,
      },
    },
    execute,
  }
}

function runtimeWith(runtimeTool: RuntimeTool): ToolRuntime {
  return new ToolRuntime([runtimeTool], { exposeArtifactTool: false })
}

function invocation(
  descriptor: { id: string; descriptorDigest: string; command: string },
  arguments_: Record<string, string>,
) {
  return {
    schemaVersion: 1 as const,
    invocationId: 'command:test-invocation',
    clientRequestId: 'test-client-request',
    descriptorId: descriptor.id,
    descriptorDigest: descriptor.descriptorDigest as `sha256:${string}`,
    command: descriptor.command,
    arguments: arguments_,
  }
}

function hasRuntimeFailure(code: string, category: string, retryable: boolean) {
  return (error: unknown): boolean =>
    typeof error === 'object' &&
    error !== null &&
    Reflect.get(error, 'code') === code &&
    Reflect.get(error, 'category') === category &&
    Reflect.get(error, 'retryable') === retryable
}
