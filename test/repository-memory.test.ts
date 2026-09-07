import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  repositoryChangedFiles,
  repositoryFileState,
} from '../apps/runtime/src/evaluation/recap/repositoryEvidence.js'
import {
  repositoryFailure,
  repositoryTree,
  runRepository,
} from '../apps/runtime/src/evaluation/recap/repositoryRunner.js'
import { DeterministicSummaryGenerator } from '../apps/runtime/src/memory/compactionService.js'
import { digest } from '../apps/runtime/src/recap/recap.js'

test('repository experiment retains interrupted trials and extraction failures on resume', async () => {
  const output = await mkdtemp(join(tmpdir(), 'praxis-repo-audit-'))
  const baseline = join(output, 'baseline')
  await mkdir(baseline)
  const save = (name: string, data: unknown) => writeFile(join(output, name), JSON.stringify(data))
  await save('ready.json', {})
  await save('prepared.json', {
    baseline,
    workspaceDigest: digest(await repositoryTree(baseline)),
    implementation: {},
    source: { digest: 'frozen' },
    snapshots: {},
    extraction: {},
  })
  const interrupted = { key: '0-none', repeat: 0, arm: 'none', directory: 'retained-old-evidence' }
  await save('0-none.started.json', interrupted)
  await runRepository(output)
  const first = JSON.parse(await readFile(join(output, 'results.json'), 'utf8'))
  assert.equal(first.completedRows, 9)
  assert.equal(first.results[0].status, 'interrupted')
  assert.equal(first.results[0].directory, interrupted.directory)
  assert.equal(
    first.results.filter((r: { status: string }) => r.status === 'extraction_error').length,
    8,
  )
  await runRepository(output)
  assert.deepEqual(JSON.parse(await readFile(join(output, 'results.json'), 'utf8')), first)
  await save('operator-pause.json', { reason: 'audit required' })
  await assert.rejects(runRepository(output), /paused by operator/u)
})

test('repository snapshots reject links and detect changed baseline before any target dispatch', async () => {
  const output = await mkdtemp(join(tmpdir(), 'praxis-repo-tree-'))
  const baseline = join(output, 'baseline'),
    outside = join(output, 'outside')
  await mkdir(baseline)
  await mkdir(outside)
  const initial = digest(await repositoryTree(baseline))
  await writeFile(join(baseline, 'changed.py'), 'changed')
  await writeFile(join(output, 'ready.json'), '{}')
  await writeFile(
    join(output, 'prepared.json'),
    JSON.stringify({ implementation: {}, baseline, workspaceDigest: initial }),
  )
  await assert.rejects(runRepository(output), /Baseline changed/u)
  await symlink(outside, join(baseline, 'escape'), 'junction')
  await assert.rejects(repositoryTree(baseline), /Symlinks/u)
})

test('repository failure records keep diagnostic codes without raw exception messages', () => {
  const error = Object.assign(new Error('sensitive provider response must not be serialized'), {
    code: 'PROVIDER_STREAM_INVALID',
  })
  assert.deepEqual(repositoryFailure(error), {
    errorName: 'Error',
    errorCode: 'PROVIDER_STREAM_INVALID',
    validation: undefined,
  })
  assert.equal(JSON.stringify(repositoryFailure(error)).includes('sensitive'), false)
  assert.equal(repositoryFailure({ code: 'unsafe secret with spaces' }).errorCode, undefined)
})

test('host digest receipts preserve writes and actual verification when shell exits unsuccessfully', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'praxis-repo-receipt-'))
  await mkdir(join(workspace, 'src'))
  await writeFile(join(workspace, 'src', 'fix.py'), 'before')
  const before = await repositoryFileState(workspace)
  await writeFile(join(workspace, 'src', 'fix.py'), 'after')
  const changed = repositoryChangedFiles(before, await repositoryFileState(workspace))
  assert.deepEqual(changed, ['src/fix.py'])
  const summary = await new DeterministicSummaryGenerator().generate({
    messages: [
      {
        role: 'tool',
        name: 'repo_shell',
        toolCallId: 'c1',
        content: JSON.stringify({
          ok: false,
          output: {
            exitCode: 1,
            command: 'python -m pytest tests/test_fix.py',
            stdout: '1 failed, 2 passed',
            repositoryChanges: { source: 'host-file-digests-v1', modifiedFiles: changed },
          },
        }),
      },
    ],
  })
  assert.deepEqual(summary.modifiedFiles, ['src/fix.py'])
  assert.ok(summary.decisions.some((s) => s.includes('exit 1') && s.includes('1 failed, 2 passed')))
  assert.deepEqual(repositoryChangedFiles(before, before), [])
})
