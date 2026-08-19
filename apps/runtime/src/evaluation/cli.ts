import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { loadEvaluationScenario } from './scenario.js'
import { runEvaluationScenario } from './scenarioRunner.js'
import { createEvaluationReport, writeEvaluationReport } from './report.js'

const scenarioIds = [
  'basic-completion',
  'tool-permission',
  'provider-fallback',
  'plugin-crash',
  'long-session',
  'context-compaction',
  'iterative-compaction',
  'cancellation',
] as const

export async function runEvaluationCli(): Promise<number> {
  const root = fileURLToPath(new URL('../../../../', import.meta.url))
  const results = []
  for (const id of scenarioIds) {
    const scenario = await loadEvaluationScenario(join(root, 'evals', 'scenarios', `${id}.json`))
    const result = await runEvaluationScenario(scenario)
    results.push(result)
    process.stdout.write(`${result.passed ? 'PASS' : 'FAIL'} ${result.id}\n`)
    for (const failure of result.failures) process.stdout.write(`  ${failure}\n`)
  }
  const report = createEvaluationReport(results)
  await writeEvaluationReport(join(root, 'artifacts', 'evaluations', 'report.json'), report)
  process.stdout.write(
    `Evaluation: ${report.summary.passed}/${report.summary.total} passed, ${report.summary.failed} failed\n`,
  )
  return report.summary.failed === 0 ? 0 : 1
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  runEvaluationCli().then(
    (code) => {
      process.exitCode = code
    },
    (error: unknown) => {
      process.stderr.write(
        `Evaluation failed to run: ${error instanceof Error ? error.message : String(error)}\n`,
      )
      process.exitCode = 1
    },
  )
}
