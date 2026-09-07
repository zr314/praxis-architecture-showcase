import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { cp, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { ProviderMessage, ProviderUsage } from '@praxis/core-sdk'
import { CredentialService } from '../../credentials/credentialService.js'
import { createBuiltinProviders } from '../../llm-provider/builtinProviders.js'
import { ConservativeTokenizer } from '../../memory/tokenizer.js'
import { generateRecap } from '../../recap/providerRecapGenerator.js'
import {
  digest,
  type RecapSnapshot,
  type RecapSource,
  recapSource,
  validateRecapSource,
} from '../../recap/recap.js'
import { renderRecapContext } from '../../recap/recapContext.js'
import { episode, type RecapExperimentOptions, recapExposure } from './runner.js'

const exec = promisify(execFile)
const root = fileURLToPath(new URL('../../../../../', import.meta.url))
const fixture = join(root, 'evals/werkzeug')
const clone = join(root, 'artifacts/external-repo-selection-20260906/werkzeug')
const imageTag = 'praxis-werkzeug-eval:20260906'
const arms = ['none', 'compact', 'structured'] as const
type Arm = (typeof arms)[number]
const memoryTokens = 4096
const learningPrompt = `Investigate a historical upload corruption report in Werkzeug 3.1.4. A binary file whose final byte is CR comes back one byte short. reproduce_upload.py is the user's reproduction. Reproduce the failure, find the responsible code path and relevant tests, and explain what fails and how you verified it. The project is upgrading to official 3.1.5, available read-only at /reference. Run the same reproduction against that release using PYTHONPATH=/reference/src, and inspect the version difference if helpful. This is a diagnostic and release-verification task: do not repair the source. You may create investigation scripts or tests. Finish with observed facts, useful project navigation and test commands, and the limits of what has been verified. Do not investigate hypothetical future tasks.`
const targetPrompt = `Fix an upload corruption bug in this Werkzeug 3.1.5 checkout. For the same multipart request body, normal reads return the correct file, but a fragmented input stream can cause two extra bytes (CR LF) at the start of the uploaded binary file. reproduce_upload.py contains the user's reproduction. Diagnose and fix the implementation, add appropriate regression tests, and run relevant existing tests. Preserve file contents byte-for-byte, including legitimate CR and LF bytes; preserve normal multipart behavior. This checkout is the canonical upstream 3.1.5 release after a project upgrade; it does not contain a previous agent's patch. Finish by describing the change, actual verification, and remaining uncertainty.`
const sourcePaths = [
  'apps/runtime/src/evaluation/recap/repositoryRunner.ts',
  'apps/runtime/src/evaluation/recap/repositoryTool.ts',
  'apps/runtime/src/evaluation/recap/repositoryEvidence.ts',
  'apps/runtime/src/evaluation/recap/repositoryCli.ts',
  'apps/runtime/src/evaluation/recap/runtime.ts',
  'apps/runtime/src/evaluation/recap/runner.ts',
  'apps/runtime/src/recap/providerRecapGenerator.ts',
  'apps/runtime/src/recap/recap.ts',
  'apps/runtime/src/recap/recapContext.ts',
  'apps/runtime/src/memory/providerCompactionSummaryGenerator.ts',
  'apps/runtime/src/memory/compactionService.ts',
  'apps/runtime/src/memory/compactionPolicy.ts',
  'apps/runtime/src/framework/runtimeKernel.ts',
  'apps/runtime/src/providers/anthropicProvider.ts',
  'apps/runtime/src/providers/modelCatalog.ts',
  'apps/runtime/src/providers/minimaxProvider.ts',
  'evals/werkzeug/Dockerfile',
  'evals/werkzeug/public_a.py',
  'evals/werkzeug/public_b.py',
  'evals/werkzeug/private_checks.py',
  'package-lock.json',
]
export async function saveRepositoryJson(path: string, data: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(data, null, 2) + '\n')
  await rename(temporary, path)
}
async function json<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T
}

export function repositoryFailure(error: unknown) {
  const value = error as { name?: unknown; code?: unknown; recapValidation?: unknown } | null
  const safe = (v: unknown) =>
    typeof v === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,127}$/u.test(v) ? v : undefined
  return {
    errorName: safe(value?.name),
    errorCode: safe(value?.code),
    validation:
      typeof value?.recapValidation === 'string' && value.recapValidation.startsWith('RECAP_')
        ? value.recapValidation.slice(0, 200)
        : undefined,
  }
}
async function command(program: string, args: string[], cwd = root) {
  try {
    const result = await exec(program, args, { cwd, windowsHide: true, maxBuffer: 8 * 1024 * 1024 })
    return { code: 0, stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    const e = error as { code?: number | string; stdout?: string; stderr?: string }
    return {
      code: typeof e.code === 'number' ? e.code : -1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? 'Process failed',
    }
  }
}
async function must(program: string, args: string[], cwd = root) {
  const result = await command(program, args, cwd)
  if (result.code !== 0)
    throw new Error(
      `${program} failed: ${result.stderr.slice(-2000)} ${result.stdout.slice(-2000)}`,
    )
  return result.stdout.trim()
}
export async function repositoryTree(path: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {}
  async function walk(at: string, prefix: string) {
    for (const entry of (await readdir(at, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (['.git', '__pycache__', '.pytest_cache'].includes(entry.name)) continue
      if (entry.isSymbolicLink()) throw new Error('Symlinks are not accepted in an evaluation tree')
      const name = prefix + entry.name
      if (entry.isDirectory()) await walk(join(at, entry.name), name + '/')
      else if (entry.isFile())
        files[name] = digest((await readFile(join(at, entry.name))).toString('base64'))
    }
  }
  await walk(path, '')
  return files
}
const mount = (source: string, target: string, readonly = true) => [
  '--mount',
  `type=bind,source=${source},target=${target}${readonly ? ',readonly' : ''}`,
]
const isolation = [
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

async function exportRelease(output: string, tag: string) {
  const path = join(output, `upstream-${tag}`)
  await mkdir(path)
  const archive = join(output, `${tag}.tar`)
  await must('git', ['archive', '--format=tar', '-o', archive, tag], clone)
  await must('tar', ['-xf', archive, '-C', path])
  return {
    path,
    commit: await must('git', ['rev-parse', `${tag}^{commit}`], clone),
    digest: digest(await repositoryTree(path)),
  }
}
async function grade(sourceWorkspace: string, output: string, baseline: string, image: string) {
  await mkdir(output)
  await repositoryTree(join(sourceWorkspace, 'src')) // reject symbolic links before copying
  const workspace = join(output, 'workspace')
  await mkdir(workspace)
  await cp(join(sourceWorkspace, 'src'), join(workspace, 'src'), { recursive: true })
  const verification = join(output, 'verification')
  await mkdir(verification)
  await cp(join(fixture, 'private_checks.py'), join(verification, 'private_checks.py'))
  const result = await command('docker', [
    'run',
    '--rm',
    ...isolation,
    ...mount(workspace, '/workspace'),
    ...mount(baseline, '/upstream'),
    ...mount(verification, '/verification'),
    image,
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
  await writeFile(join(output, 'pytest.txt'), result.stdout + result.stderr)
  const count = (kind: string) => Number(new RegExp(`(\\d+) ${kind}`).exec(result.stdout)?.[1] ?? 0)
  const value = {
    passed: result.code === 0 && count('passed') > 0,
    code: result.code,
    passedChecks: count('passed'),
    failedChecks: count('failed'),
    errors: count('error'),
    sourceDigest: digest(await repositoryTree(join(workspace, 'src'))),
  }
  await saveRepositoryJson(join(output, 'grade.json'), value)
  return value
}

export async function preflightRepository(outputInput: string) {
  const output = resolve(outputInput)
  await mkdir(dirname(output), { recursive: true })
  await mkdir(output)
  const image = await must('docker', ['image', 'inspect', imageTag, '--format', '{{.Id}}'])
  const releases: Record<string, Awaited<ReturnType<typeof exportRelease>>> = {}
  for (const tag of ['3.1.4', '3.1.5', '3.1.7']) releases[tag] = await exportRelease(output, tag)
  const rows = []
  for (const tag of ['3.1.4', '3.1.5', '3.1.7']) {
    const path = releases[tag]!.path
    const grading = await grade(path, join(output, `grade-${tag}`), releases['3.1.5']!.path, image)
    const publicChecks: Record<string, unknown> = {}
    for (const id of ['a', 'b'])
      publicChecks[id] = await command('docker', [
        'run',
        '--rm',
        ...isolation,
        ...mount(path, '/workspace'),
        ...mount(fixture, '/reproductions'),
        image,
        'python',
        `/reproductions/public_${id}.py`,
      ])
    rows.push({ tag, grading, publicChecks })
    process.stdout.write(JSON.stringify({ phase: 'preflight', tag, grading }) + '\n')
  }
  const result = {
    image,
    releases,
    rows,
    modelCalls: 0,
    ready: rows[2]!.grading.passed && !rows[1]!.grading.passed && !rows[0]!.grading.passed,
  }
  await saveRepositoryJson(join(output, 'preflight.json'), result)
  if (!result.ready) throw new Error('Official release preflight did not meet acceptance criteria')
  return result
}

type Prepared = {
  preflight: string
  image: string
  source: RecapSource
  provider: string
  model: string
  implementation: Record<string, string>
  snapshots: Partial<Record<Arm, RecapSnapshot>>
  extraction: Partial<Record<Arm, { elapsedMs: number; usage?: ProviderUsage; error?: string }>>
  baseline: string
  workspaceDigest: string
}
const options = (
  output: string,
  provider: string,
  model: string,
  container: string,
): RecapExperimentOptions => ({
  output,
  provider,
  model,
  smoke: false,
  repeats: 1,
  unlimited: true,
  repositoryContainer: container,
  maxTurns: 12,
  maxTokens: 64000,
  timeoutMs: 120000,
  memoryTokens,
  strategies: ['none'],
})
async function runEpisode(
  directory: string,
  baseline: string,
  image: string,
  prompt: string,
  reproduction: 'a' | 'b',
  provider: string,
  model: string,
  snapshot?: RecapSnapshot,
  reference?: string,
) {
  await mkdir(directory)
  const workspace = join(directory, 'workspace')
  await cp(baseline, workspace, { recursive: true, errorOnExist: true })
  await cp(join(fixture, `public_${reproduction}.py`), join(workspace, 'reproduce_upload.py'))
  const initial = await repositoryTree(workspace)
  await saveRepositoryJson(join(directory, 'initial-tree.json'), initial)
  const container = `praxis-repo-${randomUUID()}`
  await must('docker', [
    'run',
    '-d',
    '--name',
    container,
    ...isolation,
    ...mount(workspace, '/workspace', false),
    ...(reference ? mount(reference, '/reference') : []),
    image,
  ])
  try {
    const result = await episode(
      directory,
      {},
      prompt,
      options(directory, provider, model, container),
      snapshot,
    )
    await saveRepositoryJson(join(directory, 'episode.json'), result)
    return { ...result, workspaceDigest: digest(initial) }
  } finally {
    await must('docker', ['rm', '-f', container])
    const final = await repositoryTree(workspace)
    await saveRepositoryJson(join(directory, 'final-tree.json'), final)
    await saveRepositoryJson(
      join(directory, 'changed-files.json'),
      [...new Set([...Object.keys(initial), ...Object.keys(final)])].filter(
        (p) => initial[p] !== final[p],
      ),
    )
  }
}

export async function prepareRepository(
  outputInput: string,
  preflightInput: string,
  providerId: string,
  model: string,
  reuseLearning?: string,
) {
  const output = resolve(outputInput),
    preflight = resolve(preflightInput)
  const providers = createBuiltinProviders(),
    provider = providers.find((p) => p.id === providerId)
  if (
    !provider ||
    (await new CredentialService((id) => providers.find((p) => p.id === id)).status(providerId))
      .status !== 'authenticated'
  )
    throw new Error('Requested provider is not authenticated; no fallback')
  const checked = await json<Awaited<ReturnType<typeof preflightRepository>>>(
    join(preflight, 'preflight.json'),
  )
  if (!checked.ready) throw new Error('Preflight is not ready')
  await mkdir(output)
  const implementation: Record<string, string> = {}
  for (const path of sourcePaths) {
    const contents = await readFile(join(root, path))
    implementation[path] = digest(contents.toString('base64'))
    const target = join(output, 'source', path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, contents)
  }
  await saveRepositoryJson(join(output, 'preregistered.json'), {
    protocol: 'werkzeug-release-experience-v2',
    contextWindow:
      'selected model capacity; no Session context override; Runtime default 64 Ki-token replay compaction policy remains',
    ...(reuseLearning ? { reusedHistoryDirectory: resolve(reuseLearning) } : {}),
    createdAt: new Date().toISOString(),
    provider: providerId,
    model,
    image: checked.image,
    releases: checked.releases,
    implementation,
    arms,
    repeats: 3,
    targetTrials: 9,
    order: [
      ['none', 'compact', 'structured'],
      ['compact', 'structured', 'none'],
      ['structured', 'none', 'compact'],
    ],
    memoryTokens,
    extractionTargetTokens: 1200,
    executionLimits: null,
    commandWatchdogSeconds: 180,
    learningPrompt,
    targetPrompt,
    hiddenGraderDigest: implementation['evals/werkzeug/private_checks.py'],
    primary:
      'Runtime completed and fresh-container hidden byte checks plus pristine upstream multipart/formparser tests all pass',
    scope:
      'Single frozen diagnostic/release-verification history; same-subsystem transfer, no inherited agent patch. Same-target repetitions are not independent business tasks.',
    failurePolicy:
      'No automatic model retry or replacement. Failed extraction blocks its arm and stays in results. Interrupted trial is recorded, never overwritten.',
  })
  const learningDir = join(output, 'learning')
  const baseline = checked.releases['3.1.5']!.path
  const learning = reuseLearning
    ? await json<Awaited<ReturnType<typeof runEpisode>>>(
        join(resolve(reuseLearning), 'episode.json'),
      )
    : await runEpisode(
        learningDir,
        checked.releases['3.1.4']!.path,
        checked.image,
        learningPrompt,
        'a',
        providerId,
        model,
        undefined,
        baseline,
      )
  if (learning.status !== 'completed')
    throw new Error('Learning did not complete; evidence retained')
  // Host receipt only describes historical A, never target B or its private grading.
  const receipt = {
    type: 'host_historical_release_verification',
    reproduction: 'public_a.py',
    upstream_3_1_4: checked.rows[0]!.publicChecks.a,
    upstream_3_1_5: checked.rows[1]!.publicChecks.a,
    scope:
      'Historical trailing-CR reproduction only. Future defects and partition patterns have not been verified.',
  }
  const source = reuseLearning
    ? validateRecapSource(await json(join(resolve(reuseLearning), 'source.json')))
    : recapSource('werkzeug', 'frozen-diagnostic-A', [
        ...learning.messages,
        { role: 'user', content: JSON.stringify(receipt) } as ProviderMessage,
      ])
  if (
    source.projectId !== 'werkzeug' ||
    !source.entries.at(-1)?.text.includes('host_historical_release_verification')
  )
    throw new Error('Learning source lacks the historical release-verification receipt')
  if (reuseLearning) {
    await mkdir(learningDir)
    await saveRepositoryJson(join(learningDir, 'episode.json'), learning)
  }
  await saveRepositoryJson(join(learningDir, 'source.json'), source)
  const prepared: Prepared = {
    preflight,
    image: checked.image,
    source,
    provider: providerId,
    model,
    implementation,
    snapshots: {},
    extraction: {},
    baseline,
    workspaceDigest: checked.releases['3.1.5']!.digest,
  }
  for (const arm of arms) {
    const started = Date.now()
    try {
      const snapshot = await generateRecap({
        source,
        strategy: arm,
        provider,
        model,
        maxTokens: 1200,
        signal: new AbortController().signal,
      })
      const rendered = renderRecapContext(
        { projectId: source.projectId, snapshot, maxTokens: memoryTokens },
        new ConservativeTokenizer(),
        memoryTokens,
      )
      await saveRepositoryJson(join(learningDir, `${arm}-exposure.json`), rendered)
      if (arm !== 'none' && rendered.manifest.tokens === 0)
        throw Object.assign(new Error('No memory fits injection cap'), {
          recapUsage: snapshot.usage,
        })
      prepared.snapshots[arm] = snapshot
      prepared.extraction[arm] = { elapsedMs: Date.now() - started, usage: snapshot.usage }
      await saveRepositoryJson(join(learningDir, `${arm}.json`), snapshot)
    } catch (error) {
      prepared.extraction[arm] = {
        elapsedMs: Date.now() - started,
        error: 'Extraction failed; inspect retained validation',
        usage: (error as { recapUsage?: ProviderUsage }).recapUsage,
      }
      await saveRepositoryJson(join(learningDir, `${arm}.error.json`), {
        ...prepared.extraction[arm],
        ...repositoryFailure(error),
        candidate:
          (error as { recapCandidate?: unknown }).recapCandidate ??
          (error as { compactionCandidate?: unknown }).compactionCandidate,
        compactionStopReason: (error as { compactionStopReason?: unknown }).compactionStopReason,
      })
    }
    await saveRepositoryJson(join(output, 'prepared.json'), prepared)
    process.stdout.write(
      JSON.stringify({ phase: 'extraction', arm, ready: !!prepared.snapshots[arm] }) + '\n',
    )
  }
  await saveRepositoryJson(join(output, 'ready.json'), {
    sourceDigest: source.digest,
    snapshots: Object.fromEntries(
      arms.map((arm) => [arm, prepared.snapshots[arm]?.digest ?? null]),
    ),
  })
}

export async function runRepository(outputInput: string) {
  const output = resolve(outputInput)
  try {
    await readFile(join(output, 'operator-pause.json'))
    throw new Error(
      'Cohort was paused by operator; start a newly registered cohort after diagnosis',
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await json(join(output, 'ready.json'))
  const prepared = await json<Prepared>(join(output, 'prepared.json'))
  for (const [path, expected] of Object.entries(prepared.implementation))
    if (digest((await readFile(join(root, path))).toString('base64')) !== expected)
      throw new Error(`Experiment implementation changed: ${path}`)
  if (digest(await repositoryTree(prepared.baseline)) !== prepared.workspaceDigest)
    throw new Error('Baseline changed')
  const results: Record<string, unknown>[] = []
  for (let repeat = 0; repeat < 3; repeat++) {
    for (let index = 0; index < arms.length; index++) {
      const arm = arms[(index + repeat) % arms.length]!
      const key = `${repeat}-${arm}`,
        resultPath = join(output, `${key}.json`)
      try {
        results.push(await json(resultPath))
        continue
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      try {
        const interrupted = await json<Record<string, unknown>>(join(output, `${key}.started.json`))
        const result = { ...interrupted, status: 'interrupted', passed: false }
        await saveRepositoryJson(resultPath, result)
        results.push(result)
        continue
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      const snapshot = prepared.snapshots[arm],
        directory = join(output, `trial-${randomUUID()}`)
      const base = {
        key,
        repeat,
        arm,
        directory,
        sourceDigest: prepared.source.digest,
        snapshotDigest: snapshot?.digest,
        extraction: prepared.extraction[arm],
      }
      let result: Record<string, unknown>
      if (!snapshot) result = { ...base, status: 'extraction_error', passed: false }
      else {
        process.stdout.write(JSON.stringify({ phase: 'target_started', key, directory }) + '\n')
        await saveRepositoryJson(join(output, `${key}.started.json`), base)
        try {
          const run = await runEpisode(
            directory,
            prepared.baseline,
            prepared.image,
            targetPrompt,
            'b',
            prepared.provider,
            prepared.model,
            snapshot,
          )
          const grading = await grade(
            join(directory, 'workspace'),
            join(directory, 'grading'),
            prepared.baseline,
            prepared.image,
          )
          result = {
            ...base,
            status: run.status,
            passed: run.status === 'completed' && grading.passed,
            usage: run.usage,
            elapsedMs: run.elapsedMs,
            toolCalls: run.toolCalls,
            workspaceDigest: run.workspaceDigest,
            grading,
            exposure: await recapExposure(directory),
          }
        } catch (error) {
          result = {
            ...base,
            status: 'infrastructure_error',
            passed: false,
            ...repositoryFailure(error),
          }
        }
      }
      await saveRepositoryJson(resultPath, result)
      results.push(result)
      await saveRepositoryJson(join(output, 'results.json'), {
        completedRows: results.length,
        expectedRows: 9,
        results,
      })
      process.stdout.write(
        JSON.stringify({
          phase: 'target_settled',
          key,
          status: result.status,
          passed: result.passed,
          usage: result.usage,
          toolCalls: result.toolCalls,
        }) + '\n',
      )
    }
  }
  await saveRepositoryJson(join(output, 'results.json'), {
    completedRows: results.length,
    expectedRows: 9,
    results,
  })
}
