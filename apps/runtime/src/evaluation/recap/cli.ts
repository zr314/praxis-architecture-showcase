import { resolve } from 'node:path'
import { RECAP_KINDS, type RecapKind, type RecapStrategy } from '../../recap/recap.js'
import { runRecapExperiment } from './runner.js'

const args = process.argv.slice(2)
if (args.includes('--help')) {
  process.stdout.write(
    'Usage: npm run eval:recap -- --mode smoke|live --output <new-directory> [--provider <id> --model <id>] [--case <id>] [--repeats 1] [--strategies none,compact,recap,structured] [--omit failure,decision] [--memory-tokens 1500] [--budget-mode unlimited|bounded]\nDefault: unlimited execution turns, tool calls, cumulative tokens and episode/extraction time. Bounded mode supports --max-turns 12 --max-tokens 64000 --timeout-ms 120000. Memory/context and per-response output limits remain. Additional opt-in strategy: extractive. Live mode uses Provider credentials from environment and makes paid calls. Smoke validates transport only.\n',
  )
} else {
  const allowed = new Set([
    'mode',
    'budget-mode',
    'output',
    'provider',
    'model',
    'case',
    'repeats',
    'strategies',
    'omit',
    'memory-tokens',
    'max-turns',
    'max-tokens',
    'timeout-ms',
  ])
  const values = new Map<string, string>()
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!.replace(/^--/u, '')
    if (
      !args[i]!.startsWith('--') ||
      !allowed.has(key) ||
      values.has(key) ||
      !args[i + 1] ||
      args[i + 1]!.startsWith('--')
    )
      throw new TypeError('Unknown, duplicate or incomplete option. Use --help.')
    values.set(key, args[i + 1]!)
  }
  const mode = values.get('mode') ?? 'smoke'
  if (!['smoke', 'live'].includes(mode)) throw new TypeError('Mode must be smoke or live.')
  const smoke = mode === 'smoke'
  const budgetMode = values.get('budget-mode') ?? 'unlimited'
  if (!['unlimited', 'bounded'].includes(budgetMode)) throw new TypeError('Unknown budget mode.')
  if (
    budgetMode === 'unlimited' &&
    ['max-turns', 'max-tokens', 'timeout-ms'].some((k) => values.has(k))
  )
    throw new TypeError('Limit flags require --budget-mode bounded; default runs are unlimited.')
  if (!values.has('output') || (!smoke && (!values.has('provider') || !values.has('model'))))
    throw new TypeError('Explicit output required; live also requires provider and model.')
  const omit = (values.get('omit')?.split(',') ?? []) as RecapKind[]
  if (omit.some((k) => !RECAP_KINDS.includes(k))) throw new TypeError('Unknown recap category.')
  const result = await runRecapExperiment({
    output: resolve(values.get('output')!),
    smoke,
    unlimited: budgetMode === 'unlimited',
    provider: values.get('provider') ?? 'mock',
    model: values.get('model') ?? 'mock-v1',
    repeats: Number(values.get('repeats') ?? 1),
    strategies: (values.get('strategies') ?? 'none,compact,recap,structured').split(
      ',',
    ) as RecapStrategy[],
    memoryTokens: Number(values.get('memory-tokens') ?? 1500),
    maxTurns: Number(values.get('max-turns') ?? 12),
    maxTokens: Number(values.get('max-tokens') ?? 64000),
    timeoutMs: Number(values.get('timeout-ms') ?? 120000),
    omitKinds: omit,
    ...(values.has('case') ? { caseId: values.get('case')! } : {}),
  })
  process.stdout.write(
    `${JSON.stringify({
      mode,
      report: result.reportPath,
      trials: result.trials.length,
      passed: result.trials.filter((t) => t.passed).length,
    })}\n`,
  )
  if (result.trials.some((t) => t.status !== 'completed' || (smoke && !t.passed)))
    process.exitCode = 1
}
