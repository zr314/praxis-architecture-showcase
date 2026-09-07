import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { RepositoryTool } from '../../apps/runtime/src/evaluation/recap/repositoryTool.js'
import { PublicVerificationLedger } from '../../apps/runtime/src/evaluation/recap/publicVerification.js'

const exec = promisify(execFile),
  root = resolve(process.argv[2]!)
const workspace = join(root, 'workspace'),
  container = `praxis-repo-${randomUUID()}`
await mkdir(root)
await mkdir(join(workspace, 'tests'), { recursive: true })
await writeFile(join(workspace, 'tests/test_probe.py'), 'def test_probe():\n    assert False\n')
await exec(
  'docker',
  [
    'run',
    '-d',
    '--name',
    container,
    '--pull',
    'never',
    '--network',
    'none',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--read-only',
    '--pids-limit',
    '256',
    '--memory',
    '2g',
    '--cpus',
    '2',
    '--tmpfs',
    '/tmp:rw,exec,size=512m',
    '--mount',
    `type=bind,source=${workspace},target=/workspace`,
    'praxis-werkzeug-eval:20260906',
  ],
  { windowsHide: true },
)
try {
  const ledger = await PublicVerificationLedger.open(workspace, join(root, 'receipts.jsonl'))
  const tool = ledger.wrap(new RepositoryTool(container, workspace))
  const run = (command: string, check?: string) =>
    tool.execute({
      name: 'repo_shell',
      input: { command, ...(check ? { check } : {}) },
      cwd: workspace,
      signal: new AbortController().signal,
    })
  const failure = await run(
    'python -m pytest -q -p no:cacheprovider tests/test_probe.py 2>&1 | tail -5',
    'public fixture',
  )
  assert.equal(failure.ok, false)
  assert.equal((failure.output as { exitCode: number }).exitCode, 1)
  await run(
    "cp tests/test_probe.py /tmp/original.py\nprintf 'def test_probe():\\n    assert True\\n' > tests/test_probe.py",
  )
  const success = await run(
    'python -m pytest -q -p no:cacheprovider tests/test_probe.py 2>&1 | tail -5',
    'public fixture',
  )
  assert.equal(success.ok, true)
  await run('cp /tmp/original.py tests/test_probe.py')
  const context = String((await ledger.message()).content)
  const view = JSON.parse(context.split('\n')[1]!)
  assert.equal(view.checks.at(-1).current, false)
  await writeFile(
    join(root, 'integration.json'),
    JSON.stringify(
      {
        passed: true,
        modelCalls: 0,
        failedPipelineExit: 1,
        passedPipelineExit: 0,
        restoredStateInvalidatesPriorCheck: true,
      },
      null,
      2,
    ),
  )
  console.log('Offline pipeline and restored-version integration passed; model calls: 0')
} finally {
  await exec('docker', ['rm', '-f', container], { windowsHide: true })
}
