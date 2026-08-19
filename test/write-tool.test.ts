import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ToolRuntime } from '../apps/runtime/src/tools/toolRuntime.js'
import { WriteTool } from '../apps/runtime/src/tools/writeTool.js'

const sha256 = (content: string | Uint8Array) =>
  `sha256:${createHash('sha256').update(content).digest('hex')}`

async function withWorkspace(
  name: string,
  run: (workspace: string) => Promise<void>,
): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), `praxis-write-${name}-`))
  try {
    await run(workspace)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
}

function execute(
  workspace: string,
  input: Record<string, unknown>,
  signal: AbortSignal = new AbortController().signal,
) {
  return new WriteTool().execute({ name: 'write', input, cwd: workspace, signal })
}

test('WriteTool creates exclusively and reports digest evidence', async () => {
  await withWorkspace('create', async (workspace) => {
    const path = join(workspace, 'new.txt')
    const result = await execute(workspace, {
      path: 'new.txt',
      content: 'hello',
      createOnly: true,
    })

    assert.equal(result.ok, true)
    assert.deepEqual(result.output, {
      path,
      beforeBytes: 0,
      afterBytes: 5,
      created: true,
      beforeDigest: null,
      afterDigest: sha256('hello'),
    })
    assert.equal(await readFile(path, 'utf8'), 'hello')
  })
})

test('WriteTool rejects createOnly when the target exists', async () => {
  await withWorkspace('exists', async (workspace) => {
    const path = join(workspace, 'file.txt')
    await writeFile(path, 'original', 'utf8')
    const result = await execute(workspace, {
      path: 'file.txt',
      content: 'replacement',
      createOnly: true,
    })

    assert.deepEqual(result, {
      ok: false,
      summary: 'Target already exists; create-only write was not applied.',
      error: { code: 'TOOL_ALREADY_EXISTS', category: 'validation', retryable: true },
    })
    assert.equal(await readFile(path, 'utf8'), 'original')
  })
})

test('WriteTool digests invalid existing content as raw bytes', async () => {
  await withWorkspace('raw-digest', async (workspace) => {
    const path = join(workspace, 'invalid.txt')
    const invalidBytes = Buffer.from([0xff, 0xfe, 0xfd])
    await writeFile(path, invalidBytes)

    const result = await execute(workspace, {
      path: 'invalid.txt',
      content: 'valid',
      expectedDigest: 'sha256:8ca9f8c269c0a4b1d8bf0efc67d97df8ad5e0ea93630fd9099860d36c0fe75ea',
    })

    assert.equal(result.ok, true)
    assert.deepEqual(result.output, {
      path,
      beforeBytes: 3,
      afterBytes: 5,
      created: false,
      beforeDigest: 'sha256:8ca9f8c269c0a4b1d8bf0efc67d97df8ad5e0ea93630fd9099860d36c0fe75ea',
      afterDigest: 'sha256:ec654fac9599f62e79e2706abef23dfb7c07c08185aa86db4d8695f0b718d1b3',
    })
    assert.deepEqual(await readFile(path), Buffer.from([0x76, 0x61, 0x6c, 0x69, 0x64]))
  })
})

test('WriteTool counts and digests outgoing content as UTF-8 bytes', async () => {
  await withWorkspace('utf8-output', async (workspace) => {
    const path = join(workspace, 'multibyte.txt')
    const result = await execute(workspace, {
      path: 'multibyte.txt',
      content: '雪🙂',
      createOnly: true,
    })

    assert.equal(result.ok, true)
    assert.deepEqual(result.output, {
      path,
      beforeBytes: 0,
      afterBytes: 7,
      created: true,
      beforeDigest: null,
      afterDigest: 'sha256:af07c091a13864aeb36ac8425f7935c9a691cf82e3ea94d9a3f98659046b81e0',
    })
    assert.deepEqual(await readFile(path), Buffer.from([0xe9, 0x9b, 0xaa, 0xf0, 0x9f, 0x99, 0x82]))
  })
})

test('WriteTool replaces only an expected digest', async () => {
  await withWorkspace('digest', async (workspace) => {
    const path = join(workspace, 'file.txt')
    await writeFile(path, 'before', 'utf8')
    const accepted = await execute(workspace, {
      path: 'file.txt',
      content: 'after',
      expectedDigest: sha256('before'),
    })

    assert.equal(accepted.ok, true)
    assert.deepEqual(accepted.output, {
      path,
      beforeBytes: 6,
      afterBytes: 5,
      created: false,
      beforeDigest: sha256('before'),
      afterDigest: sha256('after'),
    })

    const stale = await execute(workspace, {
      path: 'file.txt',
      content: 'wrong',
      expectedDigest: sha256('before'),
    })
    assert.deepEqual(stale, {
      ok: false,
      summary: 'File changed after it was read; write input is stale.',
      error: { code: 'TOOL_STALE_INPUT', category: 'validation', retryable: true },
    })
    assert.equal(await readFile(path, 'utf8'), 'after')
  })
})

test('WriteTool rejects incompatible preconditions and a missing expected target', async () => {
  await withWorkspace('preconditions', async (workspace) => {
    const incompatible = await execute(workspace, {
      path: 'file.txt',
      content: 'value',
      expectedDigest: sha256('before'),
      createOnly: true,
    })
    assert.deepEqual(incompatible, {
      ok: false,
      summary: 'write.expectedDigest cannot be combined with write.createOnly.',
      error: { code: 'TOOL_INPUT_INVALID', category: 'validation', retryable: true },
    })

    const missing = await execute(workspace, {
      path: 'missing.txt',
      content: 'value',
      expectedDigest: sha256('before'),
    })
    assert.deepEqual(missing, {
      ok: false,
      summary: 'File changed after it was read; write input is stale.',
      error: { code: 'TOOL_STALE_INPUT', category: 'validation', retryable: true },
    })
    await assert.rejects(access(join(workspace, 'missing.txt')))
  })
})

test('WriteTool does not create directories after pre-cancellation', async () => {
  await withWorkspace('cancel', async (workspace) => {
    const controller = new AbortController()
    controller.abort('cancelled')
    const result = await execute(
      workspace,
      { path: 'nested/file.txt', content: 'value' },
      controller.signal,
    )

    assert.equal(result.summary, 'Write cancelled.')
    await assert.rejects(access(join(workspace, 'nested')))
  })
})

test('WriteTool does not create directories when cancelled during target inspection', async () => {
  await withWorkspace('cancel-inspection', async (workspace) => {
    const controller = new AbortController()
    const resultPromise = execute(
      workspace,
      { path: 'nested/file.txt', content: 'value' },
      controller.signal,
    )
    controller.abort('cancelled')

    const result = await resultPromise

    assert.deepEqual(result, { ok: false, summary: 'Write cancelled.' })
    await assert.rejects(access(join(workspace, 'nested')))
  })
})

test('WriteTool exclusive creation resolves a real race without overwriting', async () => {
  await withWorkspace('race', async (workspace) => {
    const results = await Promise.all([
      execute(workspace, { path: 'race.txt', content: 'first', createOnly: true }),
      execute(workspace, { path: 'race.txt', content: 'second', createOnly: true }),
    ])

    assert.equal(results.filter(({ ok }) => ok).length, 1)
    assert.deepEqual(
      results.find(({ ok }) => !ok),
      {
        ok: false,
        summary: 'Target already exists; create-only write was not applied.',
        error: { code: 'TOOL_ALREADY_EXISTS', category: 'validation', retryable: true },
      },
    )
    assert.match(await readFile(join(workspace, 'race.txt'), 'utf8'), /^(first|second)$/u)
  })
})

test('WriteTool does not treat a directory as a missing target', async () => {
  await withWorkspace('read-error', async (workspace) => {
    await mkdir(join(workspace, 'target'))
    const result = await new ToolRuntime().execute(
      'write',
      { path: 'target', content: 'value' },
      workspace,
      new AbortController().signal,
    )
    assert.deepEqual(result, {
      ok: false,
      summary: 'Target has the wrong filesystem type.',
      error: { code: 'TOOL_TARGET_TYPE_INVALID', category: 'validation', retryable: true },
    })
  })
})
