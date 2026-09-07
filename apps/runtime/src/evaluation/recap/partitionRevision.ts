import { cp, mkdir, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { digest } from '../../recap/recap.js'
import { partitionImplementation } from './partitionRunner.js'
import { repositoryTree, saveRepositoryJson as save } from './repositoryRunner.js'

/** A new paired cohort, never a rewrite or continuation of old solver trajectories. */
export async function preparePartitionRevision(originalInput: string, outputInput: string) {
  const original = resolve(originalInput),
    output = resolve(outputInput)
  const previous = JSON.parse(await readFile(join(original, 'prepared.json'), 'utf8'))
  if (digest(await repositoryTree(join(original, 'baseline'))) !== previous.baselineDigest)
    throw new Error('Frozen baseline changed')
  if (digest(await repositoryTree(join(original, 'upstream'))) !== previous.design.baseline.digest)
    throw new Error('Frozen upstream changed')
  const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
  if (sha(await readFile(join(original, 'target-prompt.txt'))) !== previous.design.promptSha256)
    throw new Error('Frozen task changed')
  for (const name of ['partition_checks.py', 'private_checks.py'])
    if (
      sha(await readFile(join(original, 'verification', name))) !==
      previous.design.fixtureHashes[name]
    )
      throw new Error('Frozen grader changed')
  await mkdir(output)
  for (const name of [
    'baseline',
    'upstream',
    'verification',
    'history.json',
    'source-history.json',
    'target-prompt.txt',
    'none-memory.json',
    'compact-memory.json',
    'structured-memory.json',
  ]) {
    await cp(join(original, name), join(output, name), { recursive: true })
  }
  const design = {
    ...previous.design,
    version: 2,
    status: 'registered_revision',
    repeats: 1,
    order: ['0-none', '0-compact', '0-structured'],
    publicVerification: true,
  }
  const hashes = await partitionImplementation()
  const root = fileURLToPath(new URL('../../../../../', import.meta.url))
  for (const path of Object.keys(hashes)) {
    const at = join(output, 'source', path)
    await mkdir(dirname(at), { recursive: true })
    await cp(join(root, path), at)
  }
  const amendment = {
    createdAt: new Date().toISOString(),
    original,
    reason:
      'User authorizes Plan-path investigation, public validation versioning and pipeline exit repair, followed by a rerun.',
    changes: [
      'Unbudgeted solo exposes existing advisory Working Plan tools',
      'Repository Bash enables pipefail',
      'Public command receipts bind to source, tests and listed configuration endpoints',
      'A persistent dynamic public-evidence view survives compaction and runtime restart',
    ],
    preserved: [
      'Same task, pristine baseline, frozen memory and hidden grading',
      'No total turn/tool/token/time limit',
      'No hidden grading feedback or best-patch selection',
    ],
    measurement:
      'toolCalls counts repo_shell; totalToolCalls includes Plan. Provider usage also includes auxiliary model calls. One exploratory repeat per arm, not a significance test.',
    extraction:
      'Exact previous snapshots reused; no new extraction requests. Historical extraction cost remains separately attributable.',
    hashes,
    previousHashes: previous.hashes,
    frozenMemoryDigests: Object.fromEntries(
      Object.entries(previous.snapshots).map(([arm, s]) => [arm, (s as { digest: string }).digest]),
    ),
  }
  await save(join(output, 'amendment.json'), amendment)
  await save(join(output, 'prepared.json'), {
    ...previous,
    design,
    hashes,
    amendment: 'amendment.json',
  })
  await save(join(output, 'ready.json'), {
    sourceDigest: previous.source.digest,
    snapshots: amendment.frozenMemoryDigests,
  })
  console.log(
    JSON.stringify({
      phase: 'revision_prepared',
      output,
      order: design.order,
      newExtractionCalls: 0,
    }),
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await preparePartitionRevision(process.argv[2]!, process.argv[3]!)
