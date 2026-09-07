import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
const exec = promisify(execFile)
const root = resolve(import.meta.dirname, '../..')
const output = resolve(process.argv[2])
const fixture = join(root, 'evals/werkzeug')
const checked = JSON.parse(
  await readFile(join(root, 'artifacts/werkzeug-preflight-20260906-v3/preflight.json'), 'utf8'),
)
const baseline = checked.releases['3.1.7'].path
await mkdir(output)
const frozen = join(output, 'frozen')
await mkdir(frozen)
const files = [
  'partition_public.py',
  'partition_checks.py',
  'partition_reference.py',
  'private_checks.py',
]
const hashes = {}
for (const file of files) {
  await cp(join(fixture, file), join(frozen, file))
  hashes[file] = createHash('sha256')
    .update(await readFile(join(frozen, file)))
    .digest('hex')
}
await writeFile(
  join(output, 'protocol.json'),
  JSON.stringify(
    {
      createdAt: new Date().toISOString(),
      title: 'Werkzeug partition-invariance follow-up feasibility',
      modelCalls: 0,
      baseline: checked.releases['3.1.7'],
      image: checked.image,
      hashes,
      task: 'Fix incorrect decoded part contents when standard CRLF multipart bytes arrive in small fragments. Preserve exact binary contents, empty parts, existing upstream legacy-line-ending tests, and incremental emission without buffering the entire body.',
      casesFrozenBeforeTargets: true,
      contrasts: ['baseline', 'reference', 'old-repair-only', 'strip-payload'],
      readyRule:
        'Reference passes all new and old checks; baseline and old-repair-only fail new checks; strip-payload fails byte preservation. No failed case removed after model evaluation.',
    },
    null,
    2,
  ) + '\n',
)
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
async function run(workspace, args, rw = false) {
  try {
    const { stdout, stderr } = await exec(
      'docker',
      [
        'run',
        '--rm',
        ...isolation,
        ...mount(workspace, '/workspace', rw),
        ...mount(frozen, '/verification'),
        ...mount(baseline, '/upstream'),
        checked.image,
        'timeout',
        '180',
        ...args,
      ],
      { windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 210000 },
    )
    return { code: 0, text: stdout + stderr }
  } catch (e) {
    return {
      code: typeof e.code === 'number' ? e.code : -1,
      text: (e.stdout ?? '') + (e.stderr ?? ''),
    }
  }
}
const rows = []
for (const variant of ['baseline', 'reference', 'old-repair-only', 'strip-payload']) {
  const at = join(output, variant),
    workspace = join(at, 'workspace')
  await mkdir(at)
  await cp(baseline, workspace, { recursive: true })
  if (variant === 'reference' || variant === 'strip-payload') {
    const patch = await run(
      workspace,
      ['python', '/verification/partition_reference.py', '/workspace'],
      true,
    )
    if (patch.code !== 0) throw new Error('Reference patch failed: ' + patch.text)
  }
  const path = join(workspace, 'src/werkzeug/sansio/multipart.py')
  if (variant === 'old-repair-only' || variant === 'strip-payload') {
    const source = await readFile(path, 'utf8')
    const old = '        return bytes(data[data_start:data_end]), del_index, more_data'
    if (!source.includes(old)) throw new Error('Mutation point missing')
    const replacement =
      variant === 'old-repair-only'
        ? '        del_index = max(del_index, data_start)\n' + old
        : '        return bytes(data[data_start:data_end]).strip(b"\\r\\n"), del_index, more_data'
    await writeFile(path, source.replace(old, replacement))
  }
  const result = await run(workspace, [
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
    '/verification/partition_checks.py',
    '/verification/private_checks.py',
    '/upstream/tests/sansio/test_multipart.py',
    '/upstream/tests/test_formparser.py',
  ])
  await writeFile(join(at, 'pytest.txt'), result.text)
  const count = (label) => Number(new RegExp(`(\\d+) ${label}`).exec(result.text)?.[1] ?? 0)
  const row = {
    variant,
    code: result.code,
    passed: count('passed'),
    failed: count('failed'),
    skipped: count('skipped'),
    errors: count('error'),
  }
  rows.push(row)
  console.log(JSON.stringify(row))
}
const ready =
  rows[1].code === 0 &&
  rows[1].passed === 300 &&
  rows[0].failed > 0 &&
  rows[2].failed > 0 &&
  rows[3].failed > 0
await writeFile(
  join(output, 'results.json'),
  JSON.stringify({ modelCalls: 0, ready, rows }, null, 2) + '\n',
)
if (!ready) process.exitCode = 1
