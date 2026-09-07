import { randomUUID } from 'node:crypto'
import { cp, mkdir, readFile } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { digest } from '../../recap/recap.js'
import { recapExposure } from './runner.js'
import {
  repositoryTree,
  repositoryFailure,
  saveRepositoryJson as save,
} from './repositoryRunner.js'
import {
  partitionImplementation,
  partitionResumePrompt,
  runPartitionEpisode,
  scorePartitionEpisode,
} from './partitionRunner.js'

const root = fileURLToPath(new URL('../../../../../', import.meta.url))
const json = async (path: string) => JSON.parse(await readFile(path, 'utf8'))
type Usage = Record<string, number>
type Row = {
  key: string
  status: string
  directory: string
  toolCalls: number
  toolEnds?: number
  elapsedMs?: number
  usage?: Usage
  mainLoopUsage?: Usage
  firstPassingTool?: number | null
  toolsAfterFirstPass?: number | null
  primaryUsage?: { before: Usage; after: Usage; note?: string } | null
  completeCheckpointEvidence?: boolean
  exposure?: {
    requests: number
    withMemory: number
    verified: boolean
    firstRequestTokens: number | null
  }
  [key: string]: unknown
}
export function addKnownPartitionUsage(a: Usage = {}, b: Usage = {}): Usage {
  // Missing accounting is unknown, not a free request.
  return Object.fromEntries(
    Object.keys(a)
      .filter((k) => typeof a[k] === 'number' && typeof b[k] === 'number')
      .map((k) => [k, a[k]! + b[k]!]),
  )
}
export function mergePartitionContinuation(previous: Row, next: Row): Row {
  if (!previous.toolCalls)
    return {
      ...next,
      priorZeroTurnAttempt: previous.directory,
      priorAttemptUsage: previous.usage ?? null,
    }
  const totalTools = previous.toolCalls + next.toolCalls
  const hadPass = typeof previous.firstPassingTool === 'number'
  const firstPassingTool = hadPass
    ? previous.firstPassingTool
    : typeof next.firstPassingTool === 'number'
      ? previous.toolCalls + next.firstPassingTool
      : null
  const complete =
    previous.completeCheckpointEvidence === true && next.completeCheckpointEvidence === true
  return {
    ...next,
    resumedFrom: previous.directory,
    resumed: true,
    toolCalls: totalTools,
    toolEnds: (previous.toolEnds ?? 0) + (next.toolEnds ?? 0),
    totalToolCalls:
      Number(previous.totalToolCalls ?? previous.toolCalls) +
      Number(next.totalToolCalls ?? next.toolCalls),
    totalToolEnds:
      Number(previous.totalToolEnds ?? previous.toolEnds ?? 0) +
      Number(next.totalToolEnds ?? next.toolEnds ?? 0),
    elapsedMs: (previous.elapsedMs ?? 0) + (next.elapsedMs ?? 0),
    usage: addKnownPartitionUsage(previous.usage, next.usage),
    completeCheckpointEvidence: complete,
    firstPassingTool: complete ? firstPassingTool : null,
    toolsAfterFirstPass:
      complete && typeof firstPassingTool === 'number' ? totalTools - firstPassingTool : null,
    primaryUsage:
      complete && hadPass && previous.primaryUsage && next.mainLoopUsage
        ? {
            before: previous.primaryUsage.before,
            after: addKnownPartitionUsage(previous.primaryUsage.after, next.mainLoopUsage),
            note: 'Original pre-pass phase preserved. All continuation main-loop usage charged after the existing first pass. The quota waiting gap is excluded from elapsedMs.',
          }
        : null,
    exposure:
      previous.exposure && next.exposure
        ? {
            requests: previous.exposure.requests + next.exposure.requests,
            withMemory: previous.exposure.withMemory + next.exposure.withMemory,
            firstRequestTokens: previous.exposure.firstRequestTokens,
            verified: previous.exposure.verified && next.exposure.verified,
          }
        : next.exposure,
  }
}

export async function continuePartition(
  originalInput: string,
  outputInput: string,
  previousEpochInput?: string,
) {
  const original = resolve(originalInput),
    output = resolve(outputInput)
  const prepared = await json(join(original, 'prepared.json'))
  const previousEpoch = previousEpochInput ? resolve(previousEpochInput) : undefined
  const previousRows = previousEpoch
    ? new Map<string, Row>(
        (await json(join(previousEpoch, 'results.json'))).results.map((row: Row) => [row.key, row]),
      )
    : new Map<string, Row>()
  if (digest(await repositoryTree(join(original, 'baseline'))) !== prepared.baselineDigest)
    throw new Error('Frozen baseline changed')
  const prior: Row[] = []
  const queue: Array<{ key: string; kind: 'resume' | 'start'; previous: Row }> = []
  for (const key of prepared.design.order as string[]) {
    const row = previousRows.get(key) ?? ((await json(join(original, `${key}.json`))) as Row)
    prior.push(row)
    if (row.status === 'completed') continue
    const events = (await readFile(join(row.directory, 'events.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    if (
      events.filter((event: { type: string }) => event.type === 'prompt_failed').at(-1)?.code !==
      'PROVIDER_RATE_LIMITED'
    )
      throw new Error('Only explicitly identified rate-limit interruptions can continue')
    queue.push({ key, kind: row.toolCalls > 0 ? 'resume' : 'start', previous: row })
  }
  await mkdir(output) // Exclusive continuation epoch; never overwrite prior attempts.
  const hashes = await partitionImplementation()
  await save(join(output, 'amendment.json'), {
    createdAt: new Date().toISOString(),
    original,
    previousEpoch,
    reason:
      'User confirms quota restored and authorizes continuation. No solver prompt optimization.',
    hashes,
    previousHashes: prepared.hashes,
    queue: queue.map(({ key, kind }) => ({ key, kind })),
    frozenMemoryDigests: Object.fromEntries(
      Object.entries(prepared.snapshots).map(([arm, value]) => [
        arm,
        (value as { digest: string }).digest,
      ]),
    ),
    resumePrompt: partitionResumePrompt,
    rules: [
      'Keep completed trials unchanged',
      'Same Session and workspace for interrupted work',
      'Archive starting workspace and Session store before continuation',
      'No grading feedback in continuation prompt',
      'Reuse exact memories; no extraction calls',
      'Stop the queue on another provider rate limit',
      'Record resumed measurements separately from uninterrupted trials',
    ],
  })
  for (const path of Object.keys(hashes)) {
    const at = join(output, 'source', path)
    await mkdir(dirname(at), { recursive: true })
    await cp(join(root, path), at)
  }
  const results = new Map(prior.map((row) => [row.key, row]))
  const pending = new Set(queue.map((row) => row.key))
  const persist = async () =>
    save(join(output, 'results.json'), {
      original,
      pending: [...pending],
      results: prepared.design.order.map((key: string) => results.get(key)),
    })
  await persist()
  for (const { key, kind, previous } of queue) {
    if (digest(await partitionImplementation()) !== digest(hashes))
      throw new Error('Continuation implementation changed')
    if (digest(await repositoryTree(join(original, 'baseline'))) !== prepared.baselineDigest)
      throw new Error('Baseline changed')
    const directory = join(output, `trial-${randomUUID()}`)
    const arm = key.split('-')[1]!
    const snapshot = prepared.snapshots[arm]
    if (!snapshot || snapshot.digest !== previous.snapshotDigest)
      throw new Error('Frozen memory changed')
    let resume: { sessionId: string; workspace: string; home: string } | undefined
    if (kind === 'resume') {
      const session = await json(join(previous.directory, 'session.json'))
      resume = {
        sessionId: session.sessionId,
        workspace: session.workspace ?? join(previous.directory, 'workspace'),
        home: session.home ?? join(previous.directory, 'home'),
      }
      const archive = join(output, `${key}-before-continuation`)
      await mkdir(archive)
      await cp(resume.workspace, join(archive, 'workspace'), { recursive: true })
      await cp(resume.home, join(archive, 'home'), { recursive: true })
      await save(join(archive, 'receipt.json'), {
        ...resume,
        workspaceDigest: digest(await repositoryTree(resume.workspace)),
        priorTools: previous.toolCalls,
      })
    }
    await save(join(output, `${key}.started.json`), {
      key,
      kind,
      directory,
      resume,
      previous: previous.directory,
    })
    console.log(JSON.stringify({ phase: 'continuation_started', key, kind, directory }))
    try {
      const episode = await runPartitionEpisode(original, directory, snapshot, resume)
      const scoring = await scorePartitionEpisode(original, directory, episode, resume?.workspace)
      const stage = {
        key,
        arm,
        directory,
        extraction: previous.extraction,
        snapshotDigest: previous.snapshotDigest,
        sourceDigest: previous.sourceDigest,
        ...episode,
        ...scoring,
        exposure: await recapExposure(directory),
      } as Row
      const merged = mergePartitionContinuation(previous, stage)
      await save(join(directory, 'stage-result.json'), stage)
      await save(join(output, `${key}.json`), merged)
      results.set(key, merged)
      pending.delete(key)
      await persist()
      console.log(
        JSON.stringify({
          phase: 'continuation_settled',
          key,
          status: merged.status,
          firstPassingTool: merged.firstPassingTool,
          finalGrade: merged.finalGrade,
          toolCalls: merged.toolCalls,
        }),
      )
      if (episode.failureCode === 'PROVIDER_RATE_LIMITED') {
        pending.add(key)
        await persist()
        await save(join(output, 'paused.json'), {
          reason: 'PROVIDER_RATE_LIMITED',
          key,
          pending: [...pending],
        })
        break
      }
    } catch (error) {
      await save(join(output, `${key}.collection-error.json`), repositoryFailure(error))
      await save(join(output, 'paused.json'), {
        reason: 'Continuation requires evidence review',
        key,
        pending: [...pending],
      })
      throw error
    }
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await continuePartition(process.argv[2]!, process.argv[3]!, process.argv[4])
