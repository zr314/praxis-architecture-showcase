import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { EditTool } from '../apps/runtime/src/tools/editTool.js'

test('EditTool accepts read-normalized LF input for a CRLF file', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'praxis-edit-crlf-'))
  try {
    const path = join(workspace, 'sample.txt')
    await writeFile(path, 'before\r\nmiddle\r\nafter\r\n', 'utf8')
    const result = await new EditTool().execute({
      name: 'edit',
      input: {
        path: 'sample.txt',
        oldText: 'before\nmiddle',
        newText: 'first\nsecond',
      },
      cwd: workspace,
      signal: new AbortController().signal,
    })

    assert.equal(result.ok, true)
    assert.ok(result.output && typeof result.output === 'object')
    const output = result.output as Record<string, unknown>
    assert.equal(output.path, path)
    assert.equal(output.replacements, 1)
    assert.match(String(output.beforeDigest), /^sha256:[a-f0-9]{64}$/)
    assert.match(String(output.afterDigest), /^sha256:[a-f0-9]{64}$/)
    assert.equal(output.matchMode, 'line-ending-normalized')
    assert.equal(output.lineEnding, 'crlf')
    assert.match(result.summary, /CRLF\/LF-equivalent matching/u)
    assert.match(result.summary, /replacement line ending: CRLF/u)
    assert.match(result.summary, /untouched regions preserved/u)
    assert.match(result.summary, /\d+ -> \d+ bytes/u)
    assert.equal(await readFile(path, 'utf8'), 'first\r\nsecond\r\nafter\r\n')
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('EditTool reports an exact LF occurrence without normalization', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'praxis-edit-lf-'))
  try {
    const path = join(workspace, 'sample.txt')
    await writeFile(path, 'before\nmiddle\nafter\n', 'utf8')
    const result = await new EditTool().execute({
      name: 'edit',
      input: {
        path: 'sample.txt',
        oldText: 'before\nmiddle',
        newText: 'first\nsecond',
      },
      cwd: workspace,
      signal: new AbortController().signal,
    })

    assert.equal(result.ok, true)
    assert.match(result.summary, /exact occurrence/u)
    assert.doesNotMatch(result.summary, /CRLF\/LF-equivalent/u)
    assert.equal(await readFile(path, 'utf8'), 'first\nsecond\nafter\n')
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('EditTool rejects a stale digest before newline-normalized matching', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'praxis-edit-stale-'))
  try {
    const path = join(workspace, 'sample.txt')
    const original = 'before\r\nmiddle\r\n'
    await writeFile(path, original, 'utf8')
    const result = await new EditTool().execute({
      name: 'edit',
      input: {
        path: 'sample.txt',
        oldText: 'before\nmiddle',
        newText: 'changed',
        expectedDigest: `sha256:${'0'.repeat(64)}`,
      },
      cwd: workspace,
      signal: new AbortController().signal,
    })

    assert.equal(result.error?.code, 'TOOL_STALE_INPUT')
    assert.equal(await readFile(path, 'utf8'), original)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('EditTool does not write a CRLF file when cancellation is requested', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'praxis-edit-cancelled-'))
  try {
    const path = join(workspace, 'sample.txt')
    const original = 'before\r\nmiddle\r\n'
    await writeFile(path, original, 'utf8')
    const tool = new EditTool()
    const controller = new AbortController()
    controller.abort('cancelled')
    const result = await tool.execute({
      name: 'edit',
      input: { path: 'sample.txt', oldText: 'before\nmiddle', newText: 'changed' },
      cwd: workspace,
      signal: controller.signal,
    })

    assert.equal(result.summary, 'Edit cancelled.')
    assert.equal(await readFile(path, 'utf8'), original)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('EditTool rejects empty oldText before reading or writing', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'praxis-edit-empty-'))
  try {
    const path = join(workspace, 'sample.txt')
    await writeFile(path, 'unchanged\r\n', 'utf8')
    const result = await new EditTool().execute({
      name: 'edit',
      input: { path: 'sample.txt', oldText: '', newText: 'changed' },
      cwd: workspace,
      signal: new AbortController().signal,
    })

    assert.equal(result.ok, false)
    assert.equal(result.summary, 'edit.oldText cannot be empty.')
    assert.equal(await readFile(path, 'utf8'), 'unchanged\r\n')
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})
