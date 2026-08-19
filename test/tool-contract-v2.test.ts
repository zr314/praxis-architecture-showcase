import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { RuntimeTool } from '@praxis/core-sdk'
import { ArtifactStore } from '../apps/runtime/src/artifacts/artifactStore.js'
import { ToolRuntime } from '../apps/runtime/src/tools/toolRuntime.js'

test('ToolRuntime validates input before invocation and output before delivery', async () => {
  let executions = 0
  const tool: RuntimeTool = {
    definition: {
      name: 'validated',
      description: 'validated',
      parameters: {
        type: 'object',
        properties: { count: { type: 'integer', minimum: 1 } },
        required: ['count'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
        additionalProperties: false,
      },
      execution: {
        sideEffect: 'read',
        target: { kind: 'input_path', field: 'path' },
        parallelSafe: true,
        conflictScope: 'target',
        maxInlineBytes: 1_024,
      },
    },
    async execute() {
      executions += 1
      return { ok: true, summary: 'bad output', output: { value: 1 } }
    },
  }
  const runtime = new ToolRuntime([tool])
  const signal = new AbortController().signal

  const validation = runtime.validateInput('validated', { count: 0 })
  assert.equal(validation?.error?.code, 'TOOL_INPUT_INVALID')
  assert.match(validation?.summary ?? '', /\/count must be >= 1/u)
  const extra = runtime.validateInput('validated', { count: 1, unexpected: 'private-value' })
  assert.match(extra?.summary ?? '', /\/unexpected is not allowed by schema/u)
  assert.doesNotMatch(extra?.summary ?? '', /private-value/u)
  const invalidInput = await runtime.execute('validated', { count: 0 }, process.cwd(), signal)
  assert.equal(invalidInput.error?.code, 'TOOL_INPUT_INVALID')
  assert.match(invalidInput.summary, /\/count must be >= 1/u)
  assert.equal(executions, 0)

  const invalidOutput = await runtime.execute('validated', { count: 1 }, process.cwd(), signal)
  assert.equal(invalidOutput.error?.code, 'TOOL_OUTPUT_INVALID')
  assert.equal(executions, 1)
})

test('Tool descriptors resolve canonical targets and conservative conflict keys', () => {
  const runtime = new ToolRuntime()
  const workspace = join(process.cwd(), 'workspace')

  assert.deepEqual(runtime.executionDescriptor('read', { path: 'a.txt' }, workspace), {
    sideEffect: 'read',
    parallelSafe: true,
    target: join(workspace, 'a.txt'),
    conflictKey: `target:${join(workspace, 'a.txt')}`,
    maxInlineBytes: 65_536,
  })
  assert.equal(
    runtime.executionDescriptor('shell', { command: 'echo hi' }, workspace)?.parallelSafe,
    false,
  )
})

test('oversized Tool output is durable and replaced by a bounded artifact reference', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-artifacts-'))
  try {
    const store = new ArtifactStore(root)
    const tool: RuntimeTool = {
      definition: {
        name: 'large',
        description: 'large',
        parameters: { type: 'object', additionalProperties: false },
        outputSchema: { type: 'object' },
        execution: {
          sideEffect: 'none',
          target: { kind: 'none' },
          parallelSafe: true,
          conflictScope: 'target',
          maxInlineBytes: 32,
        },
      },
      async execute() {
        return { ok: true, summary: 'large output', output: { text: 'x'.repeat(500) } }
      },
    }
    const runtime = new ToolRuntime([tool], { artifactStore: store })

    const result = await runtime.execute('large', {}, process.cwd(), new AbortController().signal)

    assert.equal(result.ok, true)
    assert.equal(result.artifacts?.length, 1)
    assert.equal((result.output as { type?: string }).type, 'artifact_ref')
    assert.deepEqual(await store.read(result.artifacts![0]!.artifactId), {
      text: 'x'.repeat(500),
    })
    assert.ok(JSON.stringify(result.output).length < 500)
    const retrieved = await runtime.execute(
      'artifact_read',
      { artifactId: result.artifacts![0]!.artifactId, offset: 0, limit: 32 },
      process.cwd(),
      new AbortController().signal,
    )
    assert.equal(retrieved.ok, true)
    assert.equal((retrieved.output as { content: string }).content.length, 32)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Tool progress callbacks are typed and forwarded without entering the final output', async () => {
  const updates: string[] = []
  const tool: RuntimeTool = {
    definition: { name: 'progress', description: 'progress', parameters: {} },
    async execute(request) {
      request.onUpdate?.({ message: 'working', stream: 'stdout', delta: 'one' })
      return { ok: true, summary: 'done' }
    },
  }
  const runtime = new ToolRuntime([tool])

  await runtime.execute('progress', {}, process.cwd(), new AbortController().signal, (update) =>
    updates.push(`${update.stream}:${update.message}:${update.delta}`),
  )

  assert.deepEqual(updates, ['stdout:working:one'])
})

test('write descriptors serialize concurrent mutations to the same target', async () => {
  let active = 0
  let maximumActive = 0
  const writer: RuntimeTool = {
    definition: {
      name: 'serialized_writer',
      description: 'serialized writer',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
      execution: {
        sideEffect: 'write',
        target: { kind: 'input_path', field: 'path' },
        parallelSafe: false,
        conflictScope: 'target',
        maxInlineBytes: 1_024,
      },
    },
    async execute() {
      active += 1
      maximumActive = Math.max(maximumActive, active)
      await Promise.resolve()
      active -= 1
      return { ok: true, summary: 'done' }
    },
  }
  const runtime = new ToolRuntime([writer])
  const signal = new AbortController().signal

  await Promise.all([
    runtime.execute('serialized_writer', { path: 'same.txt' }, process.cwd(), signal),
    runtime.execute('serialized_writer', { path: 'same.txt' }, process.cwd(), signal),
  ])

  assert.equal(maximumActive, 1)
})
