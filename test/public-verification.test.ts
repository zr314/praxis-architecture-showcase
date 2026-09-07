import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { RuntimeTool } from '@praxis/core-sdk'
import { PublicVerificationLedger } from '../apps/runtime/src/evaluation/recap/publicVerification.js'

test('public checks retain version scope across changes, restores, failures and reopening', async () => {
  const root = await mkdtemp(join(tmpdir(), 'public-checks-')),
    workspace = join(root, 'workspace')
  await mkdir(join(workspace, 'src'), { recursive: true })
  await writeFile(join(workspace, 'src/code.py'), 'original')
  const path = join(root, 'host/receipts.jsonl')
  const inner: RuntimeTool = {
    definition: { name: 'repo_shell', description: 'fixture', parameters: { type: 'object' } },
    async execute(r) {
      if (r.input.source) await writeFile(join(workspace, 'src/code.py'), String(r.input.source))
      if (r.input.config) await writeFile(join(workspace, 'pyproject.toml'), String(r.input.config))
      if (r.input.fail) throw new Error('interrupted command')
      return { ok: true, summary: 'exit', output: { exitCode: 0 } }
    },
  }
  let ledger = await PublicVerificationLedger.open(workspace, path),
    tool = ledger.wrap(inner)
  const run = (input: Record<string, unknown>) =>
    tool.execute({
      name: 'repo_shell',
      input,
      cwd: workspace,
      signal: new AbortController().signal,
    })
  const state = async () => JSON.parse(String((await ledger.message()).content).split('\n')[1]!)
  await run({ command: 'pytest', check: 'public tests' })
  assert.equal((await state()).checks[0].current, true)
  await run({ command: 'edit', source: 'changed' })
  await run({ command: 'restore', source: 'original' })
  assert.equal(
    (await state()).checks[0].current,
    false,
    'restoration must not resurrect past checks',
  )
  ledger = await PublicVerificationLedger.open(workspace, path)
  tool = ledger.wrap(inner)
  assert.equal((await state()).checks[0].current, false)
  await run({ command: 'pytest', check: 'recheck restored version' })
  assert.equal((await state()).checks.at(-1).current, true)
  await assert.rejects(run({ command: 'edit then fail', config: 'new config', fail: true }))
  assert.equal((await state()).checks.at(-1).current, false)
  await run({ command: 'edit and test', source: 'mixed', check: 'not a stable verification' })
  assert.equal((await state()).checks.at(-1).current, false)
})
