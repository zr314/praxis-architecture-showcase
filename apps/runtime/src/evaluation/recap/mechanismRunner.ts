import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalJsonV1, type ProviderMessage } from '@praxis/core-sdk'
import { CredentialService } from '../../credentials/credentialService.js'
import { createBuiltinProviders } from '../../llm-provider/builtinProviders.js'
import { ConservativeTokenizer } from '../../memory/tokenizer.js'
import { digest, makeRecapSnapshot, type RecapSnapshot, recapSource } from '../../recap/recap.js'
import { renderRecapContext } from '../../recap/recapContext.js'
import { mechanismCases, programFiles, UNRELATED_NOTE } from './mechanismCases.js'
import { placeboSnapshot, procedureSnapshot, ruleSnapshot } from './procedureMemory.js'
import { executeProgram, type ProgramCase } from './programTool.js'
import { episode, type RecapExperimentOptions, recapExposure } from './runner.js'

export const MECHANISM_ARMS = ['none', 'rules', 'procedure_a', 'irrelevant', 'procedure_b'] as const
export type MechanismOptions = {
  output: string
  provider: string
  model: string
  repeats: number
  concurrency: 1 | 2
}
type PreparedCase = {
  id: string
  sourceDigest: string
  learningStatus: string
  snapshots: Partial<Record<(typeof MECHANISM_ARMS)[number], RecapSnapshot>>
}
export type MechanismTrial = {
  caseId: string
  repeat: number
  arm: string
  directory: string
  status: string
  passed: boolean
  sourceDigest: string
  workspaceDigest: string
  snapshotDigest?: string
  usage?: unknown
  elapsedMs: number
  toolCalls: number
  exposure?: Awaited<ReturnType<typeof recapExposure>>
  grading?: unknown
}
const root = fileURLToPath(new URL('../../../../../', import.meta.url))
const memoryTokens = 1200
const runtimeOptions = (options: MechanismOptions): RecapExperimentOptions => ({
  output: options.output,
  provider: options.provider,
  model: options.model,
  smoke: false,
  repeats: 1,
  unlimited: true,
  programMode: true,
  recapFormat: 'compact',
  maxTurns: 12,
  maxTokens: 64000,
  timeoutMs: 120000,
  memoryTokens,
  strategies: ['none'],
})
async function save(path: string, value: unknown) {
  const temp = `${path}.${randomUUID()}.tmp`
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`)
  await rename(temp, path)
}
async function load<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T
}
const implementationPaths = [
  'apps/runtime/src/evaluation/recap/mechanismRunner.ts',
  'apps/runtime/src/evaluation/recap/mechanismCli.ts',
  'apps/runtime/src/evaluation/recap/mechanismCases.ts',
  'apps/runtime/src/evaluation/recap/procedureMemory.ts',
  'apps/runtime/src/evaluation/recap/procedureSubmission.ts',
  'apps/runtime/src/evaluation/recap/programTool.ts',
  'apps/runtime/src/evaluation/recap/programWorker.ts',
  'apps/runtime/src/evaluation/recap/runner.ts',
  'apps/runtime/src/evaluation/recap/runtime.ts',
  'apps/runtime/src/evaluation/recap/holdoutCases.ts',
  'apps/runtime/src/evaluation/recap/machineCases.ts',
  'apps/runtime/src/recap/recap.ts',
  'apps/runtime/src/recap/recapContext.ts',
  'apps/runtime/src/prompt/promptAssembler.ts',
  'apps/runtime/src/framework/runtimeKernel.ts',
  'package-lock.json',
]
async function implementation() {
  return Object.fromEntries(
    await Promise.all(
      implementationPaths.map(async (path) => [
        path,
        digest(await readFile(join(root, path), 'utf8')),
      ]),
    ),
  )
}

export async function scoreProgram(
  path: string,
  cases: readonly (ProgramCase & { expected: unknown })[],
) {
  const outputs = await executeProgram(
    path,
    cases.map(({ input, policy }) => ({ input, policy })),
  )
  const checks = cases.map((c, i) => ({
    index: i,
    passed:
      outputs[i]?.ok === true && canonicalJsonV1(outputs[i]!.value) === canonicalJsonV1(c.expected),
    actual: outputs[i],
    expected: c.expected,
  }))
  return {
    allPassed: checks.every((c) => c.passed),
    passedChecks: checks.filter((c) => c.passed).length,
    totalChecks: checks.length,
    checks,
  }
}

export async function prepareMechanism(options: MechanismOptions) {
  if (!Number.isSafeInteger(options.repeats) || options.repeats < 1 || options.repeats > 20)
    throw new Error('Invalid repetition count')
  const providers = createBuiltinProviders(),
    provider = providers.find((p) => p.id === options.provider)
  if (!provider) throw new Error('Unknown provider; no fallback')
  const credentials = new CredentialService((id) => providers.find((p) => p.id === id))
  if ((await credentials.status(provider.id)).status !== 'authenticated')
    throw new Error('Provider is not authenticated')
  const output = resolve(options.output)
  await mkdir(dirname(output), { recursive: true })
  await mkdir(output)
  const tasks = mechanismCases(),
    hashes = await implementation()
  await save(join(output, 'preregistered.json'), {
    protocol: 'project-memory-mechanism-v1',
    createdAt: new Date().toISOString(),
    options,
    executionLimits: null,
    memoryTokens,
    format: 'compact',
    suiteDigest: digest(tasks),
    implementation: hashes,
    cases: tasks.map((t) => t.id),
    arms: MECHANISM_ARMS,
    primaryArms: ['none', 'rules', 'procedure_a', 'irrelevant'],
    primaryTrials: tasks.length * options.repeats * 4,
    replicaProbeTrials: tasks.length * options.repeats,
    primary:
      'Runtime completed and final program passes public regressions and unseen input/policy checks',
    notes: [
      'Original seeded code-repair projects, not public benchmark scores.',
      'Training and all memory snapshots frozen once before any target; new Session and program per target repetition.',
      'All arms have the same code execution tool and public regression tests. Hidden target data/answers never enter model requests or extraction.',
      'Rules are deterministic excerpts; procedures A/B are independent calls on the same real learning history. Irrelevant synthetic text matches procedure A rendered bytes under the current tokenizer.',
      'Rules/procedures share an injection cap, not necessarily an identical actual length.',
      'No automatic retries or success-based replacement. Context/output sizes and a 10-second per-program-test compute watchdog remain; no Run turn/tool/token/deadline limits.',
      'No model seed control is assumed. Cyclic arm order over three repeats is partial counterbalancing.',
    ],
  })
  for (const path of implementationPaths) {
    const target = join(output, 'source', path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, await readFile(join(root, path)), { flag: 'wx' })
  }
  const prepared: PreparedCase[] = []
  for (const task of tasks) {
    const baselineDir = join(output, `baseline-${task.id}`)
    await mkdir(baselineDir)
    await writeFile(join(baselineDir, 'solution.js'), task.starter)
    const before = await scoreProgram(join(baselineDir, 'solution.js'), task.tests)
    if (before.allPassed) throw new Error('Seeded defect did not fail its real regression check')
    await save(join(baselineDir, 'verification.json'), before)
    const learningDir = join(output, `learning-${task.id}`)
    const files = {
      ...programFiles(task, true),
      'initial-feedback.json': JSON.stringify(before, null, 2),
    }
    const prompt = `Repair the supplied solution.js to implement this project contract. The Host actually executed the seeded starter: ${before.passedChecks}/${before.totalChecks} public regressions passed. Read initial-feedback.json for actual results. Run evaluate, fix the implementation, and run evaluate again. Finish with the public checks you verified and any uncertainty. Do not invent prior failures.\n\nProject rules (also in rules.txt):\n${task.rules}\n\nUnrelated archival calibration text, not part of this repair:\n${UNRELATED_NOTE}`
    const learning = await episode(learningDir, files, prompt, runtimeOptions(options))
    await save(join(learningDir, 'episode.json'), learning)
    const final = await scoreProgram(join(learningDir, 'workspace', 'solution.js'), task.tests)
    const receipt = {
      type: 'host_verified_public_regressions',
      scriptDigest: digest(await readFile(join(learningDir, 'workspace', 'solution.js'), 'utf8')),
      scope: 'Only the listed historical public regression inputs; no claim about future inputs.',
      ...final,
    }
    await save(join(learningDir, 'verification.json'), receipt)
    const source = recapSource(task.id, 'fixed-learning-prefix', [
      ...learning.messages,
      { role: 'user', content: JSON.stringify(receipt) } as ProviderMessage,
    ])
    await save(join(learningDir, 'source.json'), source)
    const item: PreparedCase = {
      id: task.id,
      sourceDigest: source.digest,
      learningStatus:
        learning.status === 'completed' && final.allPassed ? 'verified' : 'learning_failed',
      snapshots: {},
    }
    prepared.push(item)
    if (item.learningStatus === 'verified') {
      item.snapshots.none = makeRecapSnapshot(source, 'none', 'none', { notes: [] })
      item.snapshots.rules = ruleSnapshot(source, task.rules)
      for (const arm of ['procedure_a', 'procedure_b'] as const) {
        const started = Date.now()
        try {
          item.snapshots[arm] = await procedureSnapshot(source, provider, options.model)
          await save(join(learningDir, `${arm}-extraction.json`), {
            status: 'completed',
            elapsedMs: Date.now() - started,
            usage: item.snapshots[arm]!.usage,
          })
        } catch (error) {
          const e = error as {
            recapCandidate?: unknown
            recapRawText?: string
            recapUsage?: unknown
            recapValidation?: string
          }
          await save(join(learningDir, `${arm}-extraction.json`), {
            status: 'extraction_error',
            elapsedMs: Date.now() - started,
            error: error instanceof Error ? error.name : 'UnknownError',
            candidate: e.recapCandidate,
            rawText: e.recapRawText,
            usage: e.recapUsage,
            validation: e.recapValidation,
          })
        }
      }
      if (item.snapshots.procedure_a)
        item.snapshots.irrelevant = placeboSnapshot(
          source,
          item.snapshots.procedure_a,
          memoryTokens,
        )
      for (const [arm, snapshot] of Object.entries(item.snapshots)) {
        await save(join(learningDir, `${arm}.json`), snapshot)
        await save(
          join(learningDir, `${arm}-injection.json`),
          renderRecapContext(
            { projectId: task.id, snapshot, maxTokens: memoryTokens, format: 'compact' },
            new ConservativeTokenizer(),
            memoryTokens,
          ),
        )
      }
    }
    await save(join(output, 'prepared.json'), prepared)
    process.stdout.write(
      `${JSON.stringify({
        phase: 'prepared',
        case: task.id,
        learningStatus: item.learningStatus,
        arms: Object.keys(item.snapshots),
      })}\n`,
    )
  }
  await save(join(output, 'frozen.json'), {
    createdAt: new Date().toISOString(),
    preparedDigest: digest(prepared),
    cases: prepared.map((p) => ({
      id: p.id,
      sourceDigest: p.sourceDigest,
      snapshotDigests: Object.fromEntries(
        Object.entries(p.snapshots).map(([k, v]) => [k, v.digest]),
      ),
    })),
  })
}

export async function runMechanism(outputInput: string) {
  const output = resolve(outputInput)
  const prereg = await load<{
    options: MechanismOptions
    implementation: Record<string, string>
    suiteDigest: string
  }>(join(output, 'preregistered.json'))
  const options = prereg.options
  const prepared = await load<PreparedCase[]>(join(output, 'prepared.json'))
  const frozen = await load<{ preparedDigest: string }>(join(output, 'frozen.json'))
  if (
    digest(prepared) !== frozen.preparedDigest ||
    canonicalJsonV1(await implementation()) !== canonicalJsonV1(prereg.implementation) ||
    digest(mechanismCases()) !== prereg.suiteDigest
  )
    throw new Error(
      'Frozen implementation, suite or memory changed; start a separately registered batch',
    )
  const rows: MechanismTrial[] = []
  try {
    rows.push(...(await load<{ trials: MechanismTrial[] }>(join(output, 'results.json'))).trials)
  } catch (e) {
    if ((e as { code?: string }).code !== 'ENOENT') throw e
  }
  let pendingSave = Promise.resolve()
  const persist = () => {
    pendingSave = pendingSave.then(() =>
      save(join(output, 'results.json'), {
        protocol: 'project-memory-mechanism-v1',
        planned: prepared.length * options.repeats * MECHANISM_ARMS.length,
        primaryArms: ['none', 'rules', 'procedure_a', 'irrelevant'],
        trials: [...rows],
      }),
    )
    return pendingSave
  }
  const runCase = async (item: PreparedCase, caseIndex: number) => {
    const task = mechanismCases().find((t) => t.id === item.id)!,
      files = programFiles(task, false)
    for (let repeat = 0; repeat < options.repeats; repeat++) {
      const offset = (repeat + caseIndex) % MECHANISM_ARMS.length
      for (const arm of [...MECHANISM_ARMS.slice(offset), ...MECHANISM_ARMS.slice(0, offset)]) {
        if (rows.some((r) => r.caseId === item.id && r.repeat === repeat && r.arm === arm)) continue
        const snapshot = item.snapshots[arm],
          directory = join(output, `trial-${digest({ caseId: item.id, repeat, arm }).slice(7, 31)}`)
        const row: MechanismTrial = {
          caseId: item.id,
          repeat,
          arm,
          directory,
          status: item.learningStatus === 'verified' ? 'extraction_error' : 'learning_failed',
          passed: false,
          sourceDigest: item.sourceDigest,
          workspaceDigest: digest(files),
          elapsedMs: 0,
          toolCalls: 0,
        }
        if (snapshot) {
          const execution = await episode(
            directory,
            files,
            'Implement a reusable solve(input, policy) function from the current project rules. Use evaluate to run the current input and public regression tests. Current input/policy differ from the historical repair; validate your implementation and finish when ready.',
            runtimeOptions(options),
            snapshot,
          )
          await save(join(directory, 'episode.json'), execution)
          row.status = execution.status
          row.elapsedMs = execution.elapsedMs
          row.toolCalls = execution.toolCalls
          row.usage = execution.usage
          row.snapshotDigest = snapshot.digest
          row.exposure = await recapExposure(directory)
          try {
            const score = await scoreProgram(join(directory, 'workspace', 'solution.js'), [
              ...task.tests,
              ...task.hidden,
            ])
            row.grading = score
            row.passed = execution.status === 'completed' && score.allPassed
          } catch (error) {
            row.grading = { error: error instanceof Error ? error.message : 'Unscorable program' }
          }
          await save(join(directory, 'result.json'), row)
        }
        rows.push(row)
        await persist()
        process.stdout.write(
          `${JSON.stringify({
            case: item.id,
            repeat,
            arm,
            status: row.status,
            passed: row.passed,
            settled: rows.length,
          })}\n`,
        )
      }
    }
  }
  if (options.concurrency === 2) await Promise.all(prepared.map(runCase))
  else for (const [index, item] of prepared.entries()) await runCase(item, index)
  await pendingSave
}
