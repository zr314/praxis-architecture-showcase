import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { EvaluationScenarioResult } from './scenarioRunner.js'

export type EvaluationReportObservation = {
  events: Array<{ type: string }>
  messages: Array<{ role: string }>
  traces: EvaluationScenarioResult['observation']['traces']
  usage?: EvaluationScenarioResult['observation']['usage']
  filesystem: EvaluationScenarioResult['observation']['filesystem']
}

export type EvaluationReportScenario = {
  id: string
  description: string
  passed: boolean
  failures: string[]
  observation: EvaluationReportObservation
}

export type EvaluationReport = {
  schemaVersion: 1
  generatedAt: string
  summary: { total: number; passed: number; failed: number }
  scenarios: EvaluationReportScenario[]
}

/** Creates a deterministic report projection without mutating live observations. */
export function createEvaluationReport(
  results: readonly EvaluationScenarioResult[],
): EvaluationReport {
  const scenarios = results.map((result) => {
    const normalized = normalizeForReport(
      {
        id: result.id,
        description: result.description,
        passed: result.passed,
        failures: result.failures.map(failureCategory),
        observation: contentFreeObservation(result.observation),
      },
      result.workspaceRoot,
    ) as EvaluationReportScenario
    return normalized
  })
  const passed = scenarios.filter((scenario) => scenario.passed).length
  return {
    schemaVersion: 1,
    generatedAt: '<timestamp>',
    summary: { total: scenarios.length, passed, failed: scenarios.length - passed },
    scenarios,
  }
}

function failureCategory(failure: string): string {
  const categories: ReadonlyArray<readonly [string, string]> = [
    ['terminal:', 'terminal'],
    ['event count ', 'event_count'],
    ['events:', 'events'],
    ['messages:', 'messages'],
    ['traces:', 'traces'],
    ['usage ', 'usage'],
    ['filesystem:', 'filesystem'],
    ['replay turns:', 'replay_turns'],
    ['context selection:', 'context_selection'],
    ['cancellation boundary:', 'cancellation_boundary'],
    ['cancellation tool starts:', 'cancellation_tool_starts'],
    ['cancellation commits:', 'cancellation_commits'],
    ['policy prompts:', 'policy_prompts'],
    ['policy audits:', 'policy_audits'],
    ['policy grants:', 'policy_grants'],
  ]
  return categories.find(([prefix]) => failure.startsWith(prefix))?.[1] ?? 'assertion'
}

function contentFreeObservation(
  observation: EvaluationScenarioResult['observation'],
): EvaluationReportObservation {
  return {
    events: observation.events.map((event) => ({ type: event.type })),
    messages: observation.messages.map((message) => ({ role: message.role })),
    traces: observation.traces.map((trace) => ({
      schemaVersion: trace.schemaVersion,
      kind: trace.kind,
      timestamp: trace.timestamp,
      context: { ...trace.context },
      ...(trace.attributes === undefined ? {} : { attributes: { ...trace.attributes } }),
      ...(trace.metrics === undefined ? {} : { metrics: { ...trace.metrics } }),
    })),
    ...(observation.usage === undefined ? {} : { usage: { ...observation.usage } }),
    filesystem: observation.filesystem.map((entry) => ({ ...entry })),
  }
}

export function serializeEvaluationReport(report: EvaluationReport): string {
  return `${JSON.stringify(report, undefined, 2)}\n`
}

export async function writeEvaluationReport(path: string, report: EvaluationReport): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, serializeEvaluationReport(report), 'utf8')
}

type NormalizationState = {
  root: string
  ids: Map<string, Map<string, string>>
}

const ID_PREFIXES: Record<string, string> = {
  traceId: 'trace',
  runtimeId: 'runtime',
  sessionId: 'session',
  runId: 'run',
  turnId: 'turn',
  messageId: 'message',
  steerId: 'steer',
  pluginCallId: 'plugin-call',
}

function normalizeForReport(value: unknown, root: string): unknown {
  return normalizeValue(value, undefined, { root, ids: new Map() })
}

function normalizeValue(
  value: unknown,
  key: string | undefined,
  state: NormalizationState,
): unknown {
  if (key === 'timestamp') return '<timestamp>'
  if (key === 'durationMs' && typeof value === 'number') return 0
  if (typeof value === 'string') {
    const prefix = key === undefined ? undefined : ID_PREFIXES[key]
    if (prefix !== undefined) return normalizedId(prefix, value, state)
    if (key === 'path') return normalizePath(value, state.root)
    return normalizeText(value, state.root)
  }
  if (Array.isArray(value)) return value.map((item) => normalizeValue(item, key, state))
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value).map(([name, nested]) => [name, normalizeValue(nested, name, state)]),
  )
}

function normalizedId(prefix: string, value: string, state: NormalizationState): string {
  let values = state.ids.get(prefix)
  if (!values) {
    values = new Map()
    state.ids.set(prefix, values)
  }
  const existing = values.get(value)
  if (existing !== undefined) return existing
  const normalized = `<${prefix}-${values.size + 1}>`
  values.set(value, normalized)
  return normalized
}

function normalizeText(value: string, root: string): string {
  return value.replaceAll(root, '<workspace>')
}

function normalizePath(value: string, root: string): string {
  return normalizeText(value, root).replaceAll('\\', '/')
}
