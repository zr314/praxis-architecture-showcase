import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PraxisClient } from '@praxis/client'
import {
  canonicalJsonV1,
  contentText,
  type ProviderMessage,
  type ProviderUsage,
  providerToolCalls,
} from '@praxis/core-sdk'
import type { SessionEvent } from '@praxis/protocol'
import { CredentialService } from '../../credentials/credentialService.js'
import { createBuiltinProviders } from '../../llm-provider/builtinProviders.js'
import { RuntimeProtocolConnection } from '../../process/runtimeProtocolConnection.js'
import { generateRecap } from '../../recap/providerRecapGenerator.js'
import {
  digest,
  type RecapKind,
  type RecapSnapshot,
  type RecapStrategy,
  recapSource,
} from '../../recap/recap.js'
import { recapCases } from './cases.js'
import { holdoutRecapCases } from './holdoutCases.js'
import { machineRecapCases } from './machineCases.js'
import { RecapSmokeProvider } from './smokeProvider.js'
import { systemsRecapCases } from './systemsCases.js'
import { transferRecapCases } from './transferCases.js'

export type RecapExperimentOptions = {
  output: string
  smoke: boolean
  provider: string
  model: string
  repeats: number
  unlimited?: boolean
  programMode?: boolean
  repositoryContainer?: string
  recapFormat?: 'compact'
  maxTurns: number
  maxTokens: number
  timeoutMs: number
  memoryTokens: number
  strategies: readonly RecapStrategy[]
  omitKinds?: readonly RecapKind[]
  caseId?: string
}
type Episode = {
  status: string
  usage?: ProviderUsage
  messages: ProviderMessage[]
  elapsedMs: number
  toolCalls: number
  repeatedReads: number
  error?: string
}
export type RecapTrial = {
  caseId: string
  targetId: string
  repeat: number
  strategy: string
  status: string
  passed: boolean
  sourceDigest: string
  workspaceDigest: string
  snapshotDigest?: string
  extractionUsage?: ProviderUsage
  executionUsage?: ProviderUsage
  extractionMs: number
  elapsedMs: number
  toolCalls: number
  repeatedReads: number
  outputDigest?: string
  error?: string
  directory: string
  exposure?: {
    requests: number
    withMemory: number
    firstRequestTokens: number | null
    verified: boolean
  }
}
const sourceRoot = fileURLToPath(new URL('../../../../../', import.meta.url))
const runtimeEntry = fileURLToPath(new URL('./runtime.ts', import.meta.url))

export async function runRecapExperiment(
  options: RecapExperimentOptions,
): Promise<{ trials: RecapTrial[]; reportPath: string }> {
  validateOptions(options)
  const cases = [
    ...recapCases(options.smoke),
    ...(options.smoke || options.caseId === undefined ? [] : transferRecapCases()),
    ...(options.smoke || options.caseId === undefined ? [] : systemsRecapCases()),
    ...(options.smoke || options.caseId === undefined ? [] : holdoutRecapCases()),
    ...(options.smoke || options.caseId === undefined ? [] : machineRecapCases()),
  ].filter((c) => options.caseId === undefined || c.id === options.caseId)
  if (!cases.length) throw new TypeError('Unknown experiment case.')
  const providers = options.smoke ? [new RecapSmokeProvider()] : createBuiltinProviders()
  const provider = providers.find((p) => p.id === options.provider)
  if (!provider) throw new TypeError('Unknown provider; no fallback is selected for experiments.')
  const credentials = new CredentialService((id) => providers.find((p) => p.id === id))
  if ((await credentials.status(provider.id)).status !== 'authenticated')
    throw new Error('Experiment provider is not authenticated through its environment variables.')
  const output = resolve(options.output)
  await mkdir(dirname(output), { recursive: true })
  await mkdir(output) // Fail rather than overwrite any prior experiment, partial or complete.
  await save(join(output, 'manifest.json'), {
    version: 1,
    mode: options.smoke ? 'transport_only' : 'live_model',
    startedAt: new Date().toISOString(),
    options,
    suiteDigest: digest(cases),
    implementation: await implementationDigest(),
    protocol: 'controlled-project-recap-v5',
    executionRoute: options.unlimited ? 'host-solo-agent-loop' : 'unified-workflow',
    executionLimits: options.unlimited
      ? null
      : {
          maxTurns: options.maxTurns,
          maxToolCalls: options.maxTurns * 2,
          maxTokens: options.maxTokens,
          timeoutMs: options.timeoutMs,
        },
    comparison:
      'same frozen learning transcript and target files; new Session per arm; current in-run compaction unchanged',
    note: 'These original data-processing tasks are not Terminal-Bench scores. No future prompt or grader is supplied to the extractor.',
  })
  const trials: RecapTrial[] = []
  const learningEpisodes: {
    caseId: string
    repeat: number
    usage?: ProviderUsage
    elapsedMs: number
    directory: string
  }[] = []
  for (let repeat = 0; repeat < options.repeats; repeat++)
    for (const taskCase of cases) {
      const learningDir = join(output, `learning-${taskCase.id}-${repeat}`)
      const learning = await episode(
        learningDir,
        taskCase.learning.files,
        taskCase.learning.prompt,
        options,
      )
      await save(join(learningDir, 'episode.json'), learning)
      learningEpisodes.push({
        caseId: taskCase.id,
        repeat,
        usage: learning.usage,
        elapsedMs: learning.elapsedMs,
        directory: learningDir,
      })
      if (learning.status !== 'completed')
        throw new Error(`Learning episode failed; partial evidence retained in ${learningDir}`)
      const source = recapSource(taskCase.id, `${taskCase.id}-${repeat}`, learning.messages)
      await save(join(learningDir, 'source.json'), source)
      const snapshots = new Map<RecapStrategy, { snapshot: RecapSnapshot; elapsedMs: number }>()
      const failures = new Map<
        RecapStrategy,
        { error: string; usage?: ProviderUsage; elapsedMs: number }
      >()
      // Extraction sees only the frozen prefix; all outputs are cached before target dispatch.
      for (const strategy of options.strategies) {
        const started = Date.now()
        try {
          const snapshot = await generateRecap({
            source,
            strategy,
            provider,
            model: options.model,
            maxTokens: Math.max(64, Math.floor(options.memoryTokens * 0.65)),
            signal: options.unlimited
              ? new AbortController().signal
              : AbortSignal.timeout(options.timeoutMs),
          })
          snapshots.set(strategy, { snapshot, elapsedMs: Date.now() - started })
          await save(join(learningDir, `${strategy}.json`), snapshot)
        } catch (error) {
          const failure = {
            error: safeError(error),
            usage: (error as { recapUsage?: ProviderUsage } | undefined)?.recapUsage,
            validation: (error as { recapValidation?: string } | undefined)?.recapValidation,
            candidate: (error as { recapCandidate?: unknown } | undefined)?.recapCandidate,
            elapsedMs: Date.now() - started,
          }
          failures.set(strategy, failure)
          await save(join(learningDir, `${strategy}.error.json`), {
            status: 'extraction_error',
            ...failure,
          })
        }
      }
      for (const target of taskCase.targets) {
        // Rotate order across repeats; directory names do not reveal the strategy to the model.
        const arms = options.strategies.map((strategy) => ({
          strategy,
          label: strategy as string,
          omitKinds: [] as readonly RecapKind[],
        }))
        if (options.omitKinds?.length)
          arms.push({
            strategy: 'structured',
            label: `structured-without-${options.omitKinds.join('-')}`,
            omitKinds: options.omitKinds,
          })
        const order = [...arms.slice(repeat % arms.length), ...arms.slice(0, repeat % arms.length)]
        for (const arm of order) {
          const strategy = arm.strategy
          const generated = snapshots.get(strategy)
          const directory = join(output, `trial-${randomUUID()}`)
          const base = {
            caseId: taskCase.id,
            targetId: target.id,
            repeat,
            strategy: arm.label,
            sourceDigest: source.digest,
            workspaceDigest: digest(target.files),
            directory,
          }
          let trial: RecapTrial
          if (!generated)
            trial = {
              ...base,
              status: 'extraction_error',
              passed: false,
              extractionMs: failures.get(strategy)?.elapsedMs ?? 0,
              extractionUsage: failures.get(strategy)?.usage,
              error: failures.get(strategy)?.error,
              elapsedMs: 0,
              toolCalls: 0,
              repeatedReads: 0,
            }
          else {
            const run = await episode(
              directory,
              target.files,
              target.prompt,
              { ...options, omitKinds: arm.omitKinds },
              generated.snapshot,
            )
            const grade = await gradeAnswer(
              join(directory, 'workspace', 'answer.json'),
              target.expected,
            )
            trial = {
              ...base,
              status: run.status,
              snapshotDigest: generated.snapshot.digest,
              extractionUsage: generated.snapshot.usage,
              executionUsage: run.usage,
              extractionMs: generated.elapsedMs,
              elapsedMs: run.elapsedMs,
              toolCalls: run.toolCalls,
              repeatedReads: run.repeatedReads,
              exposure: await recapExposure(directory),
              ...grade,
              ...(run.error ? { error: run.error } : {}),
            }
            // A matching output cannot turn a failed/aborted Runtime into a successful trial.
            trial.passed = run.status === 'completed' && grade.passed
            await save(join(directory, 'episode.json'), run)
            await save(join(directory, 'result.json'), trial)
          }
          trials.push(trial)
          await save(join(output, 'results.json'), {
            mode: options.smoke ? 'transport_only' : 'live_model',
            learningEpisodes,
            trials,
            summary: summarizeTrials(trials),
            paired: pairedTrials(trials),
          })
        }
      }
    }
  return { trials, reportPath: join(output, 'results.json') }
}

export async function episode(
  directory: string,
  files: Readonly<Record<string, string>>,
  prompt: string,
  options: RecapExperimentOptions,
  snapshot?: RecapSnapshot,
): Promise<Episode> {
  const workspace = join(directory, 'workspace')
  await mkdir(workspace, { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    const target = resolve(workspace, name)
    const rel = relative(workspace, target)
    if (isAbsolute(name) || rel.startsWith('..') || isAbsolute(rel))
      throw new TypeError('Fixture path escapes workspace.')
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content, { flag: 'wx' })
  }
  const config = join(directory, 'launch.json')
  await save(config, {
    smoke: options.smoke,
    unlimited: options.unlimited === true,
    ...(options.programMode ? { programMode: true } : {}),
    ...(options.repositoryContainer ? { repositoryContainer: options.repositoryContainer } : {}),
    workspace,
    readableFiles: Object.keys(files),
    telemetry: join(directory, 'context-manifests.jsonl'),
    ...(snapshot
      ? {
          recapContext: {
            projectId: snapshot.projectId,
            snapshot,
            maxTokens: options.memoryTokens,
            omitKinds: options.omitKinds ?? [],
            ...(options.recapFormat ? { format: options.recapFormat } : {}),
          },
        }
      : {}),
  })
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith('PRAXIS_') && !['NODE_OPTIONS', 'TSX_TSCONFIG_PATH'].includes(key),
    ),
  )
  const connection = new RuntimeProtocolConnection(
    process.execPath,
    [
      fileURLToPath(import.meta.resolve('tsx/cli')),
      '--tsconfig',
      join(sourceRoot, 'tsconfig.check.json'),
      runtimeEntry,
      config,
    ],
    {
      cwd: sourceRoot,
      env: { ...environment, PRAXIS_HOME: join(directory, 'home'), PRAXIS_SESSION_STORE: 'sqlite' },
      stderr: 'capture',
      ...(options.unlimited ? {} : { requestTimeoutMs: Math.min(options.timeoutMs, 30000) }),
    },
  )
  const client = new PraxisClient(async () => connection, { reconnectAttempts: 0 })
  const started = Date.now()
  const result: Episode = {
    status: 'infrastructure_error',
    messages: [],
    elapsedMs: 0,
    toolCalls: 0,
    repeatedReads: 0,
  }
  const events: SessionEvent[] = []
  const seenReads = new Set<string>()
  let timedOut = false
  const watchdog = options.unlimited
    ? undefined
    : setTimeout(() => {
        timedOut = true
        void connection.close()
      }, options.timeoutMs + 10000)
  try {
    const session = await client.createSession({
      cwd: workspace,
      provider: options.provider,
      model: options.model,
      plannerMode: 'solo',
      permissionMode: 'interactive',
      // Controlled tiny fixtures keep their historical window. Real repositories
      // use the Runtime's selected-model context capacity, without this override.
      ...(options.repositoryContainer ? {} : { contextLimitTokens: 32768 }),
    })
    for await (const event of client.prompt({
      sessionId: session.sessionId,
      text: options.repositoryContainer
        ? `${prompt}\n\nUse repo_shell for all repository work. Commands run in Linux Bash at /workspace, with Python, pytest, rg, git and patch installed. PYTHONPATH points at /workspace/src. The host Session cwd is not a container path. The full release source and upstream tests are available; no .git history or network. You may edit source and add regression tests. Historical relative paths remain useful but absolute paths may refer to an earlier workspace. Run real checks before finishing; describe the change and any uncertainty.`
        : options.programMode
          ? `${prompt}\n\nFiles: ${JSON.stringify(Object.keys(files).sort())}. Read individual relative paths. Only solution.js may be written. Define synchronous function solve(input, policy) returning JSON-compatible data; no imports, module exports or external APIs. evaluate({path:"solution.js"}) executes it on input.json/policy.json and public tests.json, returning real outputs and public regression feedback. It does not reveal hidden target grading. Each invocation is isolated; use ordinary JavaScript arrays/objects. No shell or directory listing. Historical paths belong to earlier workspaces.`
          : recapEpisodePrompt(prompt, Object.keys(files)),
      ...(options.unlimited
        ? {}
        : {
            budget: {
              maxTurns: options.maxTurns,
              maxToolCalls: options.maxTurns * 2,
              maxTokens: options.maxTokens,
            },
            timeoutMs: options.timeoutMs,
          }),
    })) {
      if (event.type !== 'thinking_delta') {
        events.push(event)
        if (options.repositoryContainer)
          await appendFile(join(directory, 'events.jsonl'), `${JSON.stringify(event)}\n`)
      }
      if (event.type === 'permission_request')
        await client.decidePermission(
          event.requestId,
          (options.repositoryContainer && event.tool === 'repo_shell') ||
            (event.tool === 'write' &&
              event.target === join(workspace, options.programMode ? 'solution.js' : 'answer.json'))
            ? { type: 'allow_once' }
            : {
                type: 'deny',
                reason: 'Experiment only permits fixture reads and answer.json writes.',
              },
        )
      if (event.type === 'tool_planning') {
        result.toolCalls++
        if (event.name === 'read') {
          const key = canonicalJsonV1(event.input)
          if (seenReads.has(key)) result.repeatedReads++
          seenReads.add(key)
        }
      }
      if (event.type === 'prompt_completed') {
        result.status = 'completed'
        result.usage = event.usage
      }
      if (
        event.type === 'prompt_failed' ||
        event.type === 'prompt_blocked' ||
        event.type === 'prompt_aborted'
      ) {
        result.status = event.type
        if ('usage' in event) result.usage = event.usage
      }
    }
    let before: number | undefined
    while (true) {
      const page = await client.transcriptSession(session.sessionId, before, 200)
      result.messages.unshift(...(page.messages as ProviderMessage[]).map(publicMessage))
      if (page.start === 0) break
      before = page.start
    }
  } catch (error) {
    result.status = 'infrastructure_error'
    result.error = safeError(error)
  } finally {
    clearTimeout(watchdog)
    if (timedOut) result.status = 'infrastructure_timeout'
    result.elapsedMs = Date.now() - started
    await client.close()
    await save(join(directory, 'events.json'), events)
  }
  return result
}

function publicMessage(message: ProviderMessage): ProviderMessage {
  const content = contentText(message.content)
  if (message.role === 'assistant')
    return { role: 'assistant', content, toolCalls: providerToolCalls(message) }
  if (message.role === 'tool')
    return { role: 'tool', content, toolCallId: message.toolCallId, name: message.name }
  return { role: 'user', content }
}

/** Every arm knows how to discover current evidence, independent of inherited notes. */
export function recapEpisodePrompt(prompt: string, readableFiles: readonly string[]): string {
  return `${prompt}\n\nEpisode file access: the complete list of readable input files is ${JSON.stringify([...readableFiles].sort())}. Paths are relative to the current workspace. Read individual files with read; directory listing and shell are unavailable. Only answer.json may be written. Historical absolute paths belong to earlier workspaces; use current relative paths.`
}

export async function gradeAnswer(
  path: string,
  expected: unknown,
): Promise<{ passed: boolean; outputDigest?: string; error?: string }> {
  try {
    if ((await stat(path)).size > 100000)
      return { passed: false, error: 'Output exceeds grader limit.' }
    const raw = await readFile(path, 'utf8')
    if (raw.length > 100000) return { passed: false, error: 'Output exceeds grader limit.' }
    const actual: unknown = JSON.parse(raw)
    return {
      passed: canonicalJsonV1(actual) === canonicalJsonV1(expected),
      outputDigest: digest(actual),
    }
  } catch {
    return { passed: false, error: 'Missing or invalid answer.json.' }
  }
}

export function summarizeTrials(trials: readonly RecapTrial[]) {
  return [...new Set(trials.map((t) => t.strategy))].map((strategy) => {
    const rows = trials.filter((t) => t.strategy === strategy)
    // Charge extraction once per source, not once per target that reuses it.
    const extractions = [
      ...new Map(rows.map((r) => [`${r.caseId}:${r.repeat}:${r.sourceDigest}`, r])).values(),
    ]
    return {
      strategy,
      trials: rows.length,
      passed: rows.filter((r) => r.passed).length,
      completed: rows.filter((r) => r.status === 'completed').length,
      executionInputTokens: sumKnown(rows.map((r) => r.executionUsage?.inputTokens)),
      executionOutputTokens: sumKnown(rows.map((r) => r.executionUsage?.outputTokens)),
      extractionInputTokens: sumKnown(extractions.map((r) => r.extractionUsage?.inputTokens)),
      extractionOutputTokens: sumKnown(extractions.map((r) => r.extractionUsage?.outputTokens)),
      executionCostUsd: sumKnown(rows.map((r) => r.executionUsage?.costUsd)),
      extractionCostUsd: sumKnown(extractions.map((r) => r.extractionUsage?.costUsd)),
      cacheReadTokens: sumKnown(rows.map((r) => r.executionUsage?.cacheReadTokens)),
      cacheWriteTokens: sumKnown(rows.map((r) => r.executionUsage?.cacheWriteTokens)),
      elapsedMs:
        rows.reduce((n, r) => n + r.elapsedMs, 0) +
        extractions.reduce((n, r) => n + r.extractionMs, 0),
      repeatedReads: rows.reduce((n, r) => n + r.repeatedReads, 0),
      toolCalls: rows.reduce((n, r) => n + r.toolCalls, 0),
    }
  })
}
export function pairedTrials(trials: readonly RecapTrial[]) {
  const key = (r: RecapTrial) =>
    `${r.caseId}:${r.targetId}:${r.repeat}:${r.workspaceDigest}:${r.sourceDigest}`
  const controls = new Map(trials.filter((r) => r.strategy === 'none').map((r) => [key(r), r]))
  return trials
    .filter((r) => r.strategy !== 'none')
    .map((r) => {
      const control = controls.get(key(r))
      return {
        caseId: r.caseId,
        targetId: r.targetId,
        repeat: r.repeat,
        strategy: r.strategy,
        comparable: Boolean(control),
        successDelta: control ? Number(r.passed) - Number(control.passed) : null,
        toolCallDelta: control ? r.toolCalls - control.toolCalls : null,
        executionInputTokenDelta:
          control?.executionUsage?.inputTokens !== undefined &&
          r.executionUsage?.inputTokens !== undefined
            ? r.executionUsage.inputTokens - control.executionUsage.inputTokens
            : null,
      }
    })
}
/** Count actual model requests, not merely generated snapshots. Unknown telemetry stays unknown. */
export async function recapExposure(
  directory: string,
): Promise<NonNullable<RecapTrial['exposure']>> {
  try {
    const rows = (await readFile(join(directory, 'context-manifests.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
    const verified =
      rows.length > 0 &&
      rows.every(
        (r) =>
          Number.isInteger(r.actualRecapCount) &&
          r.actualRecapCount >= 0 &&
          r.recap?.digest === r.actualRecapDigest,
      )
    return {
      requests: rows.length,
      withMemory: rows.filter((r) => r.actualRecapCount > 0).length,
      firstRequestTokens: rows[0]?.recap?.tokens ?? null,
      verified,
    }
  } catch {
    return { requests: 0, withMemory: 0, firstRequestTokens: null, verified: false }
  }
}

function sumKnown(values: readonly (number | undefined)[]): number | null {
  return values.some((v) => v === undefined) ? null : values.reduce<number>((n, v) => n + v!, 0)
}
function validateOptions(o: RecapExperimentOptions): void {
  for (const [value, min, max] of [
    [o.repeats, 1, 10],
    [o.maxTurns, 2, 100],
    [o.maxTokens, 1000, 1000000],
    [o.timeoutMs, 1000, 600000],
    [o.memoryTokens, 128, 4096],
  ])
    if (!Number.isSafeInteger(value) || value! < min! || value! > max!)
      throw new TypeError('Invalid bounded experiment options.')
  if (
    !o.strategies.length ||
    new Set(o.strategies).size !== o.strategies.length ||
    o.strategies.some((s) => !['none', 'compact', 'recap', 'structured', 'extractive'].includes(s))
  )
    throw new TypeError('Invalid strategies.')
  if (o.smoke && (o.provider !== 'mock' || o.model !== 'mock-v1'))
    throw new TypeError('Smoke requires mock/mock-v1.')
  if (!o.smoke && o.provider === 'mock')
    throw new TypeError('Mock cannot produce a live-model experiment.')
  if (
    o.omitKinds?.some(
      (k) => !['fact', 'decision', 'failure', 'open_question', 'constraint'].includes(k),
    ) ||
    (o.omitKinds?.length && !o.strategies.includes('structured'))
  )
    throw new TypeError('Ablations require structured control and valid categories.')
}
function safeError(error: unknown): string {
  return error instanceof Error
    ? `${error.name}${'code' in error ? ` (${String(error.code)})` : ''}`
    : 'UnknownError'
}
async function save(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' })
  await rename(temporary, path)
}
async function implementationDigest() {
  const paths = [
    'apps/runtime/src/recap/recap.ts',
    'apps/runtime/src/recap/recapContext.ts',
    'apps/runtime/src/recap/providerRecapGenerator.ts',
    'apps/runtime/src/recap/extractiveRecap.ts',
    'apps/runtime/src/evaluation/recap/runner.ts',
    'apps/runtime/src/evaluation/recap/cases.ts',
    'apps/runtime/src/evaluation/recap/transferCases.ts',
    'apps/runtime/src/evaluation/recap/systemsCases.ts',
    'apps/runtime/src/evaluation/recap/holdoutCases.ts',
    'apps/runtime/src/evaluation/recap/machineCases.ts',
    'apps/runtime/src/evaluation/recap/runtime.ts',
    'apps/runtime/src/prompt/promptAssembler.ts',
    'apps/runtime/src/framework/runtimeKernel.ts',
    'package-lock.json',
    'tsconfig.source.json',
  ]
  const files = Object.fromEntries(
    await Promise.all(
      paths.map(async (path) => [path, digest(await readFile(join(sourceRoot, path), 'utf8'))]),
    ),
  )
  return { files, digest: digest(files) }
}
