import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { RuntimeTool } from '@praxis/core-sdk'
import { withRepositoryCheckpoints } from '../apps/runtime/src/evaluation/recap/checkpointTool.js'

test('private checkpoints preserve early correct, reverted, and restored source despite tool failure', async () => {
  const at = await mkdtemp(join(tmpdir(), 'repo-checkpoints-'))
  const workspace = join(at, 'workspace'),
    output = join(at, 'checkpoints')
  await mkdir(join(workspace, 'src'), { recursive: true })
  await writeFile(join(workspace, 'src/fix.py'), 'baseline')
  const inner: RuntimeTool = {
    definition: { name: 'fixture', description: 'fixture', parameters: { type: 'object' } },
    async execute(request) {
      if (request.input.text)
        await writeFile(join(workspace, 'src/fix.py'), String(request.input.text))
      if (request.input.fail) throw new Error('command failed after writing')
      return { ok: true, summary: 'done' }
    },
  }
  const tool = await withRepositoryCheckpoints(inner, workspace, output)
  const run = (input: Record<string, unknown>) =>
    tool.execute({ name: 'fixture', input, cwd: workspace, signal: new AbortController().signal })
  await run({ text: 'correct' })
  await run({})
  await assert.rejects(run({ text: 'baseline', fail: true }), /after writing/)
  await run({ text: 'correct' })
  assert.deepEqual((await readdir(output)).filter((p) => p.startsWith('checkpoint-')).sort(), [
    'checkpoint-0',
    'checkpoint-1',
    'checkpoint-3',
    'checkpoint-4',
  ])
  assert.equal(await readFile(join(output, 'checkpoint-1/src/fix.py'), 'utf8'), 'correct')
  assert.equal(await readFile(join(output, 'checkpoint-3/src/fix.py'), 'utf8'), 'baseline')
  assert.equal(await readFile(join(output, 'checkpoint-4/src/fix.py'), 'utf8'), 'correct')
  const timeline = (await readFile(join(output, 'timeline.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  assert.equal(timeline.length, 4)
  assert.equal(timeline[1].created, false)
  await assert.rejects(
    withRepositoryCheckpoints(inner, workspace, join(workspace, 'visible')),
    /outside/,
  )
  await assert.rejects(
    withRepositoryCheckpoints(inner, workspace, join(workspace, '..visible')),
    /outside/,
  )
})
