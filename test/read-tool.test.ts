import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ReadTool } from '../apps/runtime/src/tools/readTool.js'

const cases = [
  {
    name: 'first page',
    input: { offset: 0, limit: 2 },
    content: 'zero\none',
    totalLines: 3,
    returnedLines: 2,
    rangeStart: 0,
    rangeEnd: 2,
    nextOffset: 2,
  },
  {
    name: 'middle page',
    input: { offset: 2, limit: 1 },
    content: 'two',
    totalLines: 3,
    returnedLines: 1,
    rangeStart: 2,
    rangeEnd: 3,
    nextOffset: null,
  },
  {
    name: 'beyond EOF',
    input: { offset: 9, limit: 2 },
    content: '',
    totalLines: 3,
    returnedLines: 0,
    rangeStart: 9,
    rangeEnd: 9,
    nextOffset: null,
  },
] as const

test('ReadTool returns explicit half-open pagination ranges', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'praxis-read-pagination-'))
  try {
    await writeFile(join(workspace, 'sample.txt'), 'zero\none\ntwo\n', 'utf8')
    for (const fixture of cases) {
      const result = await new ReadTool().execute({
        name: 'read',
        input: { path: 'sample.txt', ...fixture.input },
        cwd: workspace,
        signal: new AbortController().signal,
      })

      assert.equal(result.ok, true)
      assert.ok(result.output && typeof result.output === 'object')
      const output = result.output as Record<string, unknown>
      assert.equal(output.content, fixture.content)
      assert.equal(output.totalLines, fixture.totalLines)
      assert.equal(output.returnedLines, fixture.returnedLines)
      assert.equal(output.rangeStart, fixture.rangeStart)
      assert.equal(output.rangeEnd, fixture.rangeEnd)
      assert.equal(output.nextOffset, fixture.nextOffset)
      assert.match(result.summary, new RegExp(`\\[${fixture.rangeStart}, ${fixture.rangeEnd}\\)`))
    }
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('ReadTool reports zero logical lines for an empty file', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'praxis-read-empty-'))
  try {
    await writeFile(join(workspace, 'empty.txt'), '', 'utf8')
    const result = await new ReadTool().execute({
      name: 'read',
      input: { path: 'empty.txt' },
      cwd: workspace,
      signal: new AbortController().signal,
    })

    assert.equal(result.ok, true)
    assert.ok(result.output && typeof result.output === 'object')
    const output = result.output as Record<string, unknown>
    assert.equal(output.totalLines, 0)
    assert.equal(output.returnedLines, 0)
    assert.equal(output.content, '')
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})
