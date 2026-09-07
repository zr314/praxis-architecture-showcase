import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { appendFile, cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { PraxisClient } from '@praxis/client'
import type { ProviderMessage, ProviderUsage } from '@praxis/core-sdk'
import type { SessionEvent } from '@praxis/protocol'
import { CredentialService } from '../../credentials/credentialService.js'
import { createBuiltinProviders } from '../../llm-provider/builtinProviders.js'
import { ConservativeTokenizer } from '../../memory/tokenizer.js'
import { RuntimeProtocolConnection } from '../../process/runtimeProtocolConnection.js'
import { generateRecap } from '../../recap/providerRecapGenerator.js'
import { digest, recapSource, type RecapSnapshot } from '../../recap/recap.js'
import { renderRecapContext } from '../../recap/recapContext.js'
import { repositoryFileState } from './repositoryEvidence.js'
import {
  repositoryTree,
  repositoryFailure,
  saveRepositoryJson as save,
} from './repositoryRunner.js'
import { recapExposure } from './runner.js'

const root = fileURLToPath(new URL('../../../../../', import.meta.url))
const exec = promisify(execFile)
const arms = ['none', 'compact', 'structured'] as const
type Arm = (typeof arms)[number]
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex')
const json = async (path: string) => JSON.parse(await readFile(path, 'utf8'))
const lines = async (path: string) =>
  (await readFile(path, 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
export async function optionalPartitionLines(path: string) {
  try {
    return await lines(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}
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
const mount = (path: string, at: string, rw = false) => [
  '--mount',
  `type=bind,source=${path},target=${at}${rw ? '' : ',readonly'}`,
]
async function docker(args: string[]) {
  try {
    const r = await exec('docker', args, {
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      timeout: 210000,
    })
    return { code: 0, text: r.stdout + r.stderr }
  } catch (error) {
    const e = error as { code?: unknown; stdout?: string; stderr?: string }
    return {
      code: typeof e.code === 'number' ? e.code : -1,
      text: (e.stdout ?? '') + (e.stderr ?? ''),
    }
  }
}
export async function partitionImplementation() {
  const files: Record<string, string> = {}
  for (const dir of [
    'apps/runtime/src',
    'packages/core-sdk/src',
    'packages/client/src',
    'packages/protocol/src',
    'packages/protocol/schemas',
  ]) {
    for (const path of Object.keys(await repositoryTree(join(root, dir))))
      files[`${dir}/${path}`] = sha(await readFile(join(root, dir, path)))
  }
  for (const path of [
    'package-lock.json',
    'tsconfig.check.json',
    'tsconfig.source.json',
    'tsconfig.json',
    'evals/werkzeug/partition_checks.py',
    'evals/werkzeug/private_checks.py',
  ])
    files[path] = sha(await readFile(join(root, path)))
  return files
}

export async function preparePartition(studyInput: string, outputInput: string) {
  const study = resolve(studyInput),
    output = resolve(outputInput)
  const design = await json(join(study, 'design.json'))
  const historyBytes = await readFile(join(study, 'history.json'))
  if (sha(historyBytes) !== design.historySha256) throw new Error('Frozen history changed')
  const target = await readFile(join(study, 'target-prompt.txt'), 'utf8')
  if (sha(target) !== design.promptSha256) throw new Error('Frozen task changed')
  for (const [path, expected] of Object.entries(design.implementationHashes))
    if (sha(await readFile(join(root, path))) !== expected)
      throw new Error(`Prepared implementation changed: ${path}`)
  const providers = createBuiltinProviders(),
    provider = providers.find((p) => p.id === design.provider)
  if (
    !provider ||
    (
      await new CredentialService((id) => providers.find((p) => p.id === id)).status(
        design.provider,
      )
    ).status !== 'authenticated'
  )
    throw new Error('MiniMax credentials unavailable; no fallback')
  await mkdir(output)
  await cp(join(study, 'baseline'), join(output, 'baseline'), { recursive: true })
  await cp(join(study, 'history.json'), join(output, 'history.json'))
  await writeFile(join(output, 'target-prompt.txt'), target)
  await cp(design.baseline.path, join(output, 'upstream'), { recursive: true })
  if (digest(await repositoryTree(join(output, 'upstream'))) !== design.baseline.digest)
    throw new Error('Canonical upstream changed')
  const baselineFiles = await repositoryTree(join(output, 'baseline'))
  delete baselineFiles['reproduce_upload.py']
  if (digest(baselineFiles) !== design.baseline.digest)
    throw new Error('Prepared target is not canonical upstream')
  const frozen = join(output, 'verification')
  await mkdir(frozen)
  for (const file of ['partition_checks.py', 'private_checks.py']) {
    const bytes = await readFile(join(design.preflight, 'frozen', file))
    if (sha(bytes) !== design.fixtureHashes[file]) throw new Error('Frozen grader changed')
    await writeFile(join(frozen, file), bytes)
  }
  const source = recapSource(
    'werkzeug',
    'fixed-prior-repair-A',
    JSON.parse(historyBytes.toString()).messages as ProviderMessage[],
  )
  const hashes = await partitionImplementation()
  for (const path of Object.keys(hashes)) {
    const destination = join(output, 'source', path)
    await mkdir(dirname(destination), { recursive: true })
    await cp(join(root, path), destination)
  }
  const prepared = {
    design,
    source,
    hashes,
    baselineDigest: digest(await repositoryTree(join(output, 'baseline'))),
    snapshots: {} as Partial<Record<Arm, RecapSnapshot>>,
    extraction: {} as Record<string, unknown>,
  }
  await save(join(output, 'preregistered.json'), {
    ...design,
    status: 'extracting',
    createdAt: new Date().toISOString(),
    hashes,
    sourceDigest: source.digest,
    collection:
      'Public events streamed to disk; terminal model status and evidence collection status separate. No transcript RPC.',
    limits: { run: null, commandWatchdogSeconds: 180, gradingWatchdogSeconds: 180 },
  })
  await save(join(output, 'source-history.json'), source)
  for (const arm of arms) {
    const started = Date.now()
    try {
      const snapshot = await generateRecap({
        source,
        strategy: arm,
        provider,
        model: design.model,
        maxTokens: design.extractionTargetTokens,
        signal: new AbortController().signal,
      })
      const rendered = renderRecapContext(
        { projectId: 'werkzeug', snapshot, maxTokens: design.memoryTokens },
        new ConservativeTokenizer(),
        design.memoryTokens,
      )
      await save(join(output, `${arm}-exposure.json`), rendered)
      if (arm !== 'none' && rendered.manifest.tokens === 0)
        throw Object.assign(new Error('No notes selected'), { recapUsage: snapshot.usage })
      prepared.snapshots[arm] = snapshot
      prepared.extraction[arm] = { usage: snapshot.usage, elapsedMs: Date.now() - started }
      await save(join(output, `${arm}-memory.json`), snapshot)
    } catch (error) {
      const detail = error as {
        recapUsage?: ProviderUsage
        recapCandidate?: unknown
        compactionCandidate?: unknown
      }
      prepared.extraction[arm] = {
        ...repositoryFailure(error),
        usage: detail.recapUsage,
        elapsedMs: Date.now() - started,
      }
      await save(join(output, `${arm}-extraction-error.json`), {
        ...repositoryFailure(error),
        candidate: detail.recapCandidate ?? detail.compactionCandidate,
      })
    }
    await save(join(output, 'prepared.json'), prepared)
    console.log(JSON.stringify({ phase: 'extraction', arm, ready: !!prepared.snapshots[arm] }))
  }
  await save(join(output, 'ready.json'), {
    sourceDigest: source.digest,
    snapshots: Object.fromEntries(
      arms.map((arm) => [arm, prepared.snapshots[arm]?.digest ?? null]),
    ),
  })
}

export type CollectedEpisode = {
  status: string
  failureCode?: string
  usage?: unknown
  toolCalls: number
  toolEnds: number
  totalToolCalls?: number
  totalToolEnds?: number
  evidenceErrors: unknown[]
  elapsedMs: number
}
const episodeTools = new WeakMap<CollectedEpisode, Map<string, string>>()
export function observePartitionEvent(result: CollectedEpisode, event: SessionEvent) {
  if (event.type === 'tool_planning') {
    const names = episodeTools.get(result) ?? new Map<string, string>()
    names.set(event.toolCallId, event.name)
    episodeTools.set(result, names)
    result.totalToolCalls = (result.totalToolCalls ?? 0) + 1
    if (event.name === 'repo_shell') result.toolCalls++
  }
  if (event.type === 'tool_end') {
    result.totalToolEnds = (result.totalToolEnds ?? 0) + 1
    if (episodeTools.get(result)?.get(event.toolCallId) === 'repo_shell') result.toolEnds++
  }
  if (event.type === 'prompt_completed') {
    result.status = 'completed'
    result.usage = event.usage
  }
  if (['prompt_failed', 'prompt_blocked', 'prompt_aborted'].includes(event.type)) {
    result.status = event.type
    if (event.type === 'prompt_failed') result.failureCode = event.code
    if ('usage' in event) result.usage = event.usage
  }
}
export const partitionResumePrompt =
  'The previous run was interrupted by a provider rate limit. Continue the same task from the existing work and conversation. Complete the remaining verification and final response.'
export async function runPartitionEpisode(
  output: string,
  directory: string,
  snapshot: RecapSnapshot,
  resume?: { sessionId: string; workspace: string; home: string },
) {
  const prepared = await json(join(output, 'prepared.json')),
    design = prepared.design
  await mkdir(directory)
  const workspace = resume?.workspace ?? join(directory, 'workspace'),
    checkpoints = join(directory, 'checkpoints')
  if (!resume) await cp(join(output, 'baseline'), workspace, { recursive: true })
  const container = `praxis-repo-${randomUUID()}`
  const launched = await docker([
    'run',
    '-d',
    '--name',
    container,
    ...isolation,
    ...mount(workspace, '/workspace', true),
    design.image,
  ])
  if (launched.code !== 0) throw new Error('Offline container failed to start')
  const result: CollectedEpisode = {
    status: 'infrastructure_error',
    toolCalls: 0,
    toolEnds: 0,
    evidenceErrors: [],
    elapsedMs: 0,
  }
  const started = Date.now()
  let client: PraxisClient | undefined
  try {
    const config = join(directory, 'launch.json')
    await save(config, {
      repositoryContainer: container,
      workspace,
      checkpoints,
      telemetry: join(directory, 'context-manifests.jsonl'),
      ...(design.publicVerification
        ? {
            publicVerification: join(
              resume?.home ?? join(directory, 'home'),
              'public-verification.jsonl',
            ),
          }
        : {}),
      recapContext: { projectId: 'werkzeug', snapshot, maxTokens: design.memoryTokens },
    })
    const environment = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) =>
          !key.startsWith('PRAXIS_') && !['NODE_OPTIONS', 'TSX_TSCONFIG_PATH'].includes(key),
      ),
    )
    const connection = new RuntimeProtocolConnection(
      process.execPath,
      [
        fileURLToPath(import.meta.resolve('tsx/cli')),
        '--tsconfig',
        join(root, 'tsconfig.check.json'),
        join(root, 'apps/runtime/src/evaluation/recap/checkpointRuntime.ts'),
        config,
      ],
      {
        cwd: root,
        env: {
          ...environment,
          PRAXIS_HOME: resume?.home ?? join(directory, 'home'),
          PRAXIS_SESSION_STORE: 'sqlite',
        },
        stderr: 'capture',
      },
    )
    client = new PraxisClient(async () => connection, { reconnectAttempts: 0 })
    const session = resume
      ? await client.resumeSession(resume.sessionId)
      : await client.createSession({
          cwd: workspace,
          provider: design.provider,
          model: design.model,
          plannerMode: 'solo',
          permissionMode: 'interactive',
        })
    await save(join(directory, 'session.json'), {
      sessionId: session.sessionId,
      container,
      workspace,
      home: resume?.home ?? join(directory, 'home'),
      resumed: !!resume,
    })
    const prompt = resume
      ? partitionResumePrompt
      : (await readFile(join(output, 'target-prompt.txt'), 'utf8')) +
        '\nUse repo_shell for repository work. Commands run in Linux Bash at /workspace; PYTHONPATH=/workspace/src. Python, pytest, git and rg are installed. Full upstream source and tests are available. No .git history or network. Historical absolute paths belong to an earlier workspace. Run relevant checks before finishing.'
    for await (const event of client.prompt({ sessionId: session.sessionId, text: prompt })) {
      if (event.type !== 'thinking_delta')
        await appendFile(
          join(directory, 'events.jsonl'),
          JSON.stringify({ ...event, observedAt: new Date().toISOString() }) + '\n',
        )
      observePartitionEvent(result, event)
      if (event.type === 'permission_request')
        await client.decidePermission(
          event.requestId,
          event.tool === 'repo_shell' ||
            ['plan.create', 'plan.update', 'plan.progress', 'plan.abandon', 'plan.review'].includes(
              event.tool,
            )
            ? { type: 'allow_once' }
            : {
                type: 'deny',
                reason:
                  'Only offline repository and local Plan tools are available in this experiment.',
              },
        )
    }
  } catch (error) {
    // Do not replace an observed model terminal event with a later collection failure.
    result.evidenceErrors.push({ phase: 'event_collection', ...repositoryFailure(error) })
  } finally {
    try {
      await client?.close()
    } catch (error) {
      result.evidenceErrors.push({ phase: 'connection_close', ...repositoryFailure(error) })
    }
    const removed = await docker(['rm', '-f', container])
    if (removed.code !== 0) result.evidenceErrors.push({ phase: 'container_cleanup' })
    result.elapsedMs = Date.now() - started
    await save(join(directory, 'episode.json'), result)
  }
  return result
}

export async function gradePartition(output: string, source: string, directory: string) {
  const { design } = await json(join(output, 'prepared.json'))
  await mkdir(directory)
  const r = await docker([
    'run',
    '--rm',
    ...isolation,
    ...mount(source, '/workspace'),
    ...mount(join(output, 'upstream'), '/upstream'),
    ...mount(join(output, 'verification'), '/verification'),
    design.image,
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
    '/verification/partition_checks.py',
    '/verification/private_checks.py',
    '/upstream/tests/sansio/test_multipart.py',
    '/upstream/tests/test_formparser.py',
  ])
  await writeFile(join(directory, 'pytest.txt'), r.text)
  const count = (label: string) => Number(new RegExp(`(\\d+) ${label}`).exec(r.text)?.[1] ?? 0)
  const grade = {
    passed: r.code === 0 && count('passed') === 300,
    code: r.code,
    passedChecks: count('passed'),
    failedChecks: count('failed'),
    skippedChecks: count('skipped'),
    errors: count('error'),
  }
  await save(join(directory, 'grade.json'), grade)
  return grade
}

export async function scorePartitionEpisode(
  output: string,
  directory: string,
  result: CollectedEpisode,
  workspace = join(directory, 'workspace'),
) {
  const checkpointRoot = join(directory, 'checkpoints')
  const checkpoints = (await readdir(checkpointRoot))
    .filter((p) => /^checkpoint-\d+$/.test(p))
    .sort((a, b) => Number(a.split('-')[1]) - Number(b.split('-')[1]))
  const timeline = await optionalPartitionLines(join(checkpointRoot, 'timeline.jsonl'))
  const rows = []
  const cache = new Map<string, Awaited<ReturnType<typeof gradePartition>>>()
  for (const name of checkpoints) {
    const at = join(checkpointRoot, name),
      receipt = await json(join(at, 'receipt.json'))
    const actual = Object.fromEntries(
      Object.entries(await repositoryFileState(at)).filter(([p]) => p.startsWith('src/')),
    )
    if (digest(actual) !== receipt.sourceDigest) throw new Error('Captured source changed')
    let grade = cache.get(receipt.sourceDigest)
    if (!grade) {
      grade = await gradePartition(output, at, join(directory, `grade-${name}`))
      cache.set(receipt.sourceDigest, grade)
    }
    rows.push({ toolOrdinal: receipt.toolOrdinal, sourceDigest: receipt.sourceDigest, grade })
    console.log(
      JSON.stringify({
        phase: 'checkpoint_graded',
        trial: directory,
        toolOrdinal: receipt.toolOrdinal,
        passed: grade.passed,
      }),
    )
  }
  const finalGrade = await gradePartition(output, workspace, join(directory, 'grade-final'))
  const finalFiles = Object.fromEntries(
    Object.entries(await repositoryFileState(workspace)).filter(([p]) => p.startsWith('src/')),
  )
  const complete =
    result.evidenceErrors.length === 0 &&
    result.toolCalls === result.toolEnds &&
    timeline.length === result.toolEnds &&
    rows.at(-1)?.sourceDigest === digest(finalFiles)
  const first = complete ? rows.find((row) => row.grade.passed) : undefined
  const events = await optionalPartitionLines(join(directory, 'events.jsonl'))
  const usage = await optionalPartitionLines(join(directory, 'context-manifests.jsonl.usage.jsonl'))
  let turn = 0,
    ordinal = 0,
    firstTurn: number | undefined
  for (const event of events) {
    if (event.type === 'message_committed' && event.role === 'assistant') turn++
    if (
      event.type === 'tool_planning' &&
      event.name === 'repo_shell' &&
      ++ordinal === first?.toolOrdinal
    )
      firstTurn = turn
  }
  const sum = (start: number, end: number) => {
    const values: Record<string, number> = {}
    for (const row of usage.slice(start, end))
      for (const [key, value] of Object.entries(row.usage ?? {}))
        if (typeof value === 'number') values[key] = (values[key] ?? 0) + value
    return values
  }
  const scoring = {
    completeCheckpointEvidence: complete,
    finalGrade,
    checkpoints: rows,
    mainLoopUsage: sum(0, usage.length),
    firstPassingTool: first?.toolOrdinal ?? null,
    toolsAfterFirstPass: first ? result.toolCalls - first.toolOrdinal : null,
    primaryUsage:
      firstTurn !== undefined && turn === usage.length
        ? {
            before: sum(0, firstTurn),
            after: sum(firstTurn, usage.length),
            note: 'Successful main-loop returns split at patch dispatch; excludes auxiliary calls and failed streams.',
          }
        : null,
    timeline,
  }
  await save(join(directory, 'scoring.json'), scoring)
  return scoring
}

export async function runPartition(outputInput: string) {
  const output = resolve(outputInput)
  await json(join(output, 'ready.json'))
  const prepared = await json(join(output, 'prepared.json'))
  const providers = createBuiltinProviders()
  if (
    (
      await new CredentialService((id) => providers.find((p) => p.id === id)).status(
        prepared.design.provider,
      )
    ).status !== 'authenticated'
  )
    throw new Error('MiniMax credentials unavailable in launcher environment; no trials started')
  // Exclusive launch marker prevents accidental duplicate spend; interrupted cohorts require audit.
  await writeFile(
    join(output, 'run-started.json'),
    JSON.stringify({ at: new Date().toISOString() }),
    { flag: 'wx' },
  )
  const results = []
  for (const key of prepared.design.order as string[]) {
    if (digest(await partitionImplementation()) !== digest(prepared.hashes))
      throw new Error('Implementation changed since registration')
    if (digest(await repositoryTree(join(output, 'baseline'))) !== prepared.baselineDigest)
      throw new Error('Baseline changed')
    const arm = key.split('-')[1] as Arm,
      snapshot = prepared.snapshots[arm] as RecapSnapshot | undefined
    const directory = join(output, `trial-${randomUUID()}`)
    const base = {
      key,
      arm,
      directory,
      extraction: prepared.extraction[arm],
      sourceDigest: prepared.source.digest,
      snapshotDigest: snapshot?.digest,
    }
    await save(join(output, `${key}.started.json`), base)
    console.log(JSON.stringify({ phase: 'target_started', key, directory }))
    let row: Record<string, unknown>
    if (!snapshot) row = { ...base, status: 'extraction_error' }
    else {
      try {
        const episode = await runPartitionEpisode(output, directory, snapshot)
        const scoring = await scorePartitionEpisode(output, directory, episode)
        row = { ...base, ...episode, ...scoring, exposure: await recapExposure(directory) }
      } catch (error) {
        // Preserve already-written episode.json and all snapshots if scoring fails.
        const episode = await json(join(directory, 'episode.json')).catch(() => ({
          status: 'infrastructure_error',
        }))
        row = { ...base, ...episode, scoringError: repositoryFailure(error) }
      }
    }
    results.push(row)
    await save(join(output, `${key}.json`), row)
    await save(join(output, 'results.json'), {
      settledRows: results.length,
      expectedRows: prepared.design.order.length,
      pending: prepared.design.order.slice(results.length),
      results,
    })
    console.log(
      JSON.stringify({
        phase: 'target_settled',
        key,
        status: row.status,
        firstPassingTool: row.firstPassingTool,
        finalGrade: row.finalGrade,
        usage: row.usage,
      }),
    )
    if (row.failureCode === 'PROVIDER_RATE_LIMITED' || row.status === 'infrastructure_error') {
      await save(join(output, 'paused.json'), {
        reason: row.failureCode ?? 'infrastructure_error',
        key,
      })
      break
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === 'prepare') await preparePartition(process.argv[3]!, process.argv[4]!)
  else if (process.argv[2] === 'run') await runPartition(process.argv[3]!)
  else throw new Error('Expected prepare STUDY OUTPUT or run OUTPUT')
}
