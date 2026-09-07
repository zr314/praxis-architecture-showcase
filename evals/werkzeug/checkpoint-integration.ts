import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { cp, mkdir, readFile, readdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { promisify } from 'node:util'
import { withRepositoryCheckpoints } from '../../apps/runtime/src/evaluation/recap/checkpointTool.js'
import { RepositoryTool } from '../../apps/runtime/src/evaluation/recap/repositoryTool.js'
import { gradePartition } from '../../apps/runtime/src/evaluation/recap/partitionRunner.js'
import { saveRepositoryJson as save } from '../../apps/runtime/src/evaluation/recap/repositoryRunner.js'

const exec = promisify(execFile)
const output = resolve(process.argv[2]!),
  preflight = resolve(process.argv[3]!)
const design = JSON.parse(await readFile(join(preflight, 'protocol.json'), 'utf8'))
await mkdir(output)
await save(join(output, 'prepared.json'), { design })
await cp(design.baseline.path, join(output, 'upstream'), { recursive: true })
await cp(design.baseline.path, join(output, 'workspace'), { recursive: true })
await cp(join(preflight, 'frozen'), join(output, 'verification'), { recursive: true })
const workspace = join(output, 'workspace'),
  checkpoints = join(output, 'checkpoints')
const container = `praxis-repo-${randomUUID()}`
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
    '--mount',
    `type=bind,source=${join(output, 'verification')},target=/verification,readonly`,
    design.image,
  ],
  { windowsHide: true },
)
try {
  const tool = await withRepositoryCheckpoints(
    new RepositoryTool(container, workspace),
    workspace,
    checkpoints,
  )
  const run = (command: string) =>
    tool.execute({
      name: 'repo_shell',
      input: { command },
      cwd: workspace,
      signal: new AbortController().signal,
    })
  assert.equal(
    (
      await run(
        'cp src/werkzeug/sansio/multipart.py /tmp/original.py\npython /verification/partition_reference.py /workspace',
      )
    ).ok,
    true,
  )
  assert.equal(
    (await run('cp /tmp/original.py src/werkzeug/sansio/multipart.py\nexit 1')).ok,
    false,
  )
  assert.equal((await run('python /verification/partition_reference.py /workspace')).ok, true)
  assert.deepEqual((await readdir(checkpoints)).filter((p) => p.startsWith('checkpoint-')).sort(), [
    'checkpoint-0',
    'checkpoint-1',
    'checkpoint-2',
    'checkpoint-3',
  ])
} finally {
  await exec('docker', ['rm', '-f', container], { windowsHide: true })
}
const grades = []
for (let index = 0; index < 4; index++) {
  const grade = await gradePartition(
    output,
    join(checkpoints, `checkpoint-${index}`),
    join(output, `grade-${index}`),
  )
  assert.equal(grade.passed, index === 1 || index === 3)
  grades.push({ toolOrdinal: index, ...grade })
}
await save(join(output, 'integration.json'), {
  modelCalls: 0,
  passed: true,
  note: 'Only this no-model integration container mounts the author reference. Target containers mount workspace only.',
  grades,
})
console.log(JSON.stringify({ passed: true, modelCalls: 0, grades }))
