// Reconstruct only the first source-edit command in each settled first-repeat arm.
// This is retrospective offline evidence, not another model attempt or a replacement result.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { mkdir, cp, readFile, writeFile, readdir, lstat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const exec = promisify(execFile)
const [cohort, output] = process.argv.slice(2, 4).map((path) => resolve(path))
const prepared = JSON.parse(await readFile(join(cohort, 'prepared.json'), 'utf8'))
const analysis = JSON.parse(await readFile(join(cohort, 'trajectory-analysis.json'), 'utf8'))
await mkdir(output) // Refuse overwriting a previous audit.
const isolation = [
  '--pull',
  'never',
  '--network',
  'none',
  '--cap-drop',
  'ALL',
  '--security-opt',
  'no-new-privileges',
  '--pids-limit',
  '256',
  '--memory',
  '2g',
  '--cpus',
  '2',
  '--read-only',
  '--tmpfs',
  '/tmp:rw,exec,size=512m',
]
const mount = (path, target, rw = false) => [
  '--mount',
  `type=bind,source=${path},target=${target}${rw ? '' : ',readonly'}`,
]
const sha = (value) => createHash('sha256').update(value).digest('hex')
async function tree(root, prefix = '') {
  const files = {}
  for (const name of (await readdir(join(root, prefix))).sort()) {
    if (name === '__pycache__') continue
    const relative = prefix + name,
      path = join(root, relative),
      stat = await lstat(path)
    if (stat.isSymbolicLink()) throw new Error('Audit refuses symbolic links')
    if (stat.isDirectory()) Object.assign(files, await tree(root, relative + '/'))
    else files[relative] = sha(await readFile(path))
  }
  return files
}
async function docker(args) {
  try {
    const result = await exec('docker', args, {
      windowsHide: true,
      timeout: 210000,
      maxBuffer: 8 * 1024 * 1024,
    })
    return { code: 0, text: result.stdout + result.stderr }
  } catch (e) {
    return {
      code: typeof e.code === 'number' ? e.code : -1,
      text: (e.stdout ?? '') + (e.stderr ?? ''),
      timedOut: e.killed === true,
    }
  }
}
const rows = []
const selections =
  process.argv[4] === 'compact-followup'
    ? [
        ['0-compact', 45],
        ['0-compact', 64],
      ]
    : [['0-none'], ['0-compact'], ['0-structured']]
for (const [key, toolIndex] of selections) {
  const trace = analysis.rows.find((r) => r.key === key)
  if (!trace?.completeFileAudit) throw new Error('Complete source receipts required')
  const result = JSON.parse(await readFile(join(cohort, key + '.json'), 'utf8'))
  const first = toolIndex
    ? trace.sourceMutations.find((c) => c.index === toolIndex)
    : trace.sourceMutations[0]
  if (!first) throw new Error('Requested source mutation absent')
  const at = join(output, key + (toolIndex ? `-tool${toolIndex}` : '')),
    workspace = join(at, 'workspace'),
    replay = join(at, 'replay')
  await mkdir(replay, { recursive: true })
  await cp(prepared.baseline, workspace, { recursive: true, errorOnExist: true })
  await cp(
    join(cohort, 'source/evals/werkzeug/public_b.py'),
    join(workspace, 'reproduce_upload.py'),
  )
  await writeFile(join(replay, 'command.sh'), first.command + '\n')
  const reconstruction = await docker([
    'run',
    '--rm',
    ...isolation,
    ...mount(workspace, '/workspace', true),
    ...mount(replay, '/replay'),
    prepared.image,
    'timeout',
    '180',
    'bash',
    '/replay/command.sh',
  ])
  await writeFile(join(at, 'reconstruction.txt'), reconstruction.text)
  const before = await tree(join(prepared.baseline, 'src'))
  const candidate = await tree(join(workspace, 'src'))
  const final = await tree(join(result.directory, 'grading/workspace/src'))
  const verification = join(at, 'verification')
  await mkdir(verification)
  await cp(
    join(cohort, 'source/evals/werkzeug/private_checks.py'),
    join(verification, 'private_checks.py'),
  )
  const grade = await docker([
    'run',
    '--rm',
    ...isolation,
    ...mount(workspace, '/workspace'),
    ...mount(prepared.baseline, '/upstream'),
    ...mount(verification, '/verification'),
    prepared.image,
    'timeout',
    '180',
    'python',
    '-m',
    'pytest',
    '--timeout=10',
    '-q',
    '-p',
    'no:cacheprovider',
    '-c',
    '/upstream/pyproject.toml',
    '--rootdir=/upstream',
    '/verification/private_checks.py',
    '/upstream/tests/sansio/test_multipart.py',
    '/upstream/tests/test_formparser.py',
  ])
  await writeFile(join(at, 'pytest.txt'), grade.text)
  const count = (label) => Number(new RegExp(`(\\d+) ${label}`).exec(grade.text)?.[1] ?? 0)
  const row = {
    key,
    toolIndex: first.index,
    turn: first.turn,
    commandSha256: sha(first.command),
    reconstructionExitCode: reconstruction.code,
    reconstructionTimedOut: reconstruction.timedOut ?? false,
    sourceChanged: JSON.stringify(before) !== JSON.stringify(candidate),
    matchesGradedFinalSource: JSON.stringify(candidate) === JSON.stringify(final),
    candidateSourceSha256: sha(JSON.stringify(candidate)),
    passed: reconstruction.code === 0 && grade.code === 0 && count('passed') === 226,
    passedChecks: count('passed'),
    failedChecks: count('failed'),
    skippedChecks: count('skipped'),
    mainLoopTokensThroughDispatch: first.mainLoopTokensThroughDispatch,
    mainLoopTokensAfterDispatch: first.mainLoopTokensAfterDispatch,
    toolsAfterDispatch: trace.totalTools - first.index,
  }
  rows.push(row)
  await writeFile(join(at, 'result.json'), JSON.stringify(row, null, 2) + '\n')
  console.log(JSON.stringify(row))
}
await writeFile(
  join(output, 'results.json'),
  JSON.stringify(
    {
      createdAt: new Date().toISOString(),
      cohort,
      modelCalls: 0,
      image: prepared.image,
      limitation:
        'Earlier full workspace snapshots were not recorded. Candidates replay one observed source-edit command against pristine baseline; equality with the independently graded final source is checked. First-write passing time does not establish completion of requested regression tests or explanation. No source command before the first audited mutation changed src at command boundaries.',
      rows,
    },
    null,
    2,
  ) + '\n',
)
