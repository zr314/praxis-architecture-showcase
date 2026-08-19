import { readFile } from 'node:fs/promises'
import {
  adaptLegacyExecutionBudgetV1,
  type LegacyExecutionBudgetV1,
  type AgentEvent,
  type CancellationReason,
  type ExecutionBudget,
  type PermissionDecision,
  type ProviderChunk,
  type ProviderMessage,
  type SummaryCheckpoint,
  type TraceKind,
} from '@praxis/core-sdk'
import Ajv2020 from 'ajv/dist/2020.js'
import type { ErrorObject, ValidateFunction } from 'ajv'
import scenarioSchema from '../../../../evals/schema/scenario-v1.schema.json'

export type ProviderReplayExpectation = {
  model?: string
  tools?: string[]
}

export type ProviderReplayTurn = {
  id: string
  expect?: ProviderReplayExpectation
  chunks: ProviderChunk[]
}

export type ProviderReplay = {
  turns: ProviderReplayTurn[]
}

export type ReplayFixture = ProviderReplay
export type ReplayTurn = ProviderReplayTurn

export type EvaluationWorkspaceFixture = {
  directories?: string[]
  files: Array<{ path: string; content: string }>
}

export type EvaluationRequest = {
  provider: string
  model: string
  prompt: string
  promptKind?: 'prompt' | 'follow_up'
}

export type EvaluationPermissionDecision = {
  toolCallId: string
  decision: PermissionDecision
}

export type EvaluationTerminalAssertion = {
  type: 'prompt_completed' | 'prompt_failed' | 'prompt_aborted'
  code?: string
  stopReason?: string
  reason?: CancellationReason | string
}

export type EvaluationUsageBound = { min: number; max: number }

type EvaluationUsageBoundMap = Record<
  'turns' | 'toolCalls' | 'inputTokens' | 'outputTokens' | 'subagents',
  EvaluationUsageBound
>

export type EvaluationUsageBounds = {
  [Key in keyof EvaluationUsageBoundMap]-?: Pick<EvaluationUsageBoundMap, Key> &
    Partial<Omit<EvaluationUsageBoundMap, Key>>
}[keyof EvaluationUsageBoundMap]

export type EvaluationFilesystemChange = {
  path: string
  change: 'created' | 'modified' | 'deleted'
  digest?: string
}

export type EvaluationToolName =
  | 'read'
  | 'glob'
  | 'grep'
  | 'ls'
  | 'find'
  | 'write'
  | 'edit'
  | 'record'
  | 'plugin_crash'
  | 'cancel_probe'

export type EvaluationProviderRoutingSetup = {
  retryAttempts: number
  fallback: {
    provider: 'replay'
    model: string
  }
  primaryFailure: {
    code: string
    retryable: boolean
  }
}

export type EvaluationProcessPluginSetup = {
  fixture: 'crash-on-invoke'
  pluginId: string
  capabilityId: string
  tool: 'plugin_crash'
}

export type EvaluationSessionSetup = {
  initialMessages: ProviderMessage[]
  checkpoint?: SummaryCheckpoint
  contextLimitTokens?: number
}

export type EvaluationCancellationSetup = {
  boundary: 'after_first_provider_chunk'
  reason: CancellationReason
}

export type EvaluationSetup = {
  tools: EvaluationToolName[]
  providerRouting?: EvaluationProviderRoutingSetup
  processPlugin?: EvaluationProcessPluginSetup
  session?: EvaluationSessionSetup
  cancellation?: EvaluationCancellationSetup
}

export type EvaluationContextSelectionAssertion = {
  contextMessagesContain: string[]
  messagesExclude: string[]
}

export type EvaluationCancellationEvidenceAssertion = {
  boundaryReached: boolean
  toolStartsAfterBoundary: number
  committedMessagesAfterBoundary: number
}

export type EvaluationAssertions = {
  terminalEvent: EvaluationTerminalAssertion
  eventCounts: Partial<Record<AgentEvent['type'], number>>
  eventOrder: AgentEvent['type'][]
  committedRoles: Array<'user' | 'assistant' | 'tool'>
  traceKinds: TraceKind[]
  usageBounds: EvaluationUsageBounds
  filesystemChanges: EvaluationFilesystemChange[]
  remainingReplayTurns: number
  contextSelection?: EvaluationContextSelectionAssertion
  cancellationEvidence?: EvaluationCancellationEvidenceAssertion
}

export type EvaluationScenarioV1 = {
  schemaVersion: 1
  id: string
  description: string
  setup: EvaluationSetup
  workspaceFixture: EvaluationWorkspaceFixture
  request: EvaluationRequest
  budget: ExecutionBudget
  providerReplay: ProviderReplay
  permissionDecisions: EvaluationPermissionDecision[]
  assertions: EvaluationAssertions
}

export type EvaluationErrorCode =
  | 'EVAL_SCENARIO_INVALID'
  | 'EVAL_REPLAY_INVALID'
  | 'EVAL_REPLAY_DUPLICATE_TURN_ID'
  | 'EVAL_REPLAY_EXHAUSTED'
  | 'EVAL_REPLAY_UNCONSUMED'
  | 'EVAL_REPLAY_MODEL_MISMATCH'
  | 'EVAL_REPLAY_TOOLS_MISMATCH'
  | 'EVAL_REPLAY_ABORTED'

export class EvaluationError extends Error {
  readonly category = 'provider' as const
  readonly retryable = false

  constructor(
    readonly code: EvaluationErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'EvaluationError'
  }
}

const ajv = new Ajv2020({ allErrors: true, strict: true })
const validateScenario = ajv.compile(scenarioSchema) as ValidateFunction<unknown>
const validateReplay = ajv.compile({
  $ref: `${scenarioSchema.$id}#/$defs/providerReplay`,
}) as ValidateFunction<unknown>

export function parseEvaluationScenario(input: unknown): EvaluationScenarioV1 {
  try {
    assertJsonValue(input, 'EVAL_SCENARIO_INVALID', 'Evaluation scenario validation failed.')
    if (!validateScenario(input)) {
      throw invalid('EVAL_SCENARIO_INVALID', 'Evaluation scenario', validateScenario.errors)
    }
    const candidate = input as EvaluationScenarioV1 & {
      budget: ExecutionBudget | LegacyExecutionBudgetV1
    }
    const scenario: EvaluationScenarioV1 = {
      ...candidate,
      budget:
        'maxSubagents' in candidate.budget
          ? adaptLegacyExecutionBudgetV1(candidate.budget, { maxParallelChildren: 0 })
          : candidate.budget,
    }
    assertUniqueTurnIds(scenario.providerReplay)
    assertUsageBounds(scenario.assertions.usageBounds)
    assertDeadline(scenario.budget.deadlineAt)
    assertScenarioSemantics(scenario)
    return structuredClone(scenario)
  } catch (error) {
    if (error instanceof EvaluationError) throw error
    throw new EvaluationError('EVAL_SCENARIO_INVALID', 'Evaluation scenario validation failed.')
  }
}

function assertScenarioSemantics(scenario: EvaluationScenarioV1): void {
  if (scenario.budget.maxParallelChildren > scenario.budget.maxChildRuns) {
    throw new EvaluationError(
      'EVAL_SCENARIO_INVALID',
      'Evaluation scenario maxParallelChildren cannot exceed maxChildRuns.',
    )
  }
  const processPlugin = scenario.setup.processPlugin
  if (processPlugin !== undefined && !scenario.setup.tools.includes(processPlugin.tool)) {
    throw new EvaluationError(
      'EVAL_SCENARIO_INVALID',
      'Evaluation scenario process plugin tool must be in the selected execution set.',
    )
  }
  const providerRouting = scenario.setup.providerRouting
  if (
    providerRouting?.fallback.provider === scenario.request.provider &&
    providerRouting.fallback.model === scenario.request.model
  ) {
    throw new EvaluationError(
      'EVAL_SCENARIO_INVALID',
      'Evaluation scenario fallback candidate must differ from the requested provider-model pair.',
    )
  }
}

export function parseProviderReplay(input: unknown): ProviderReplay {
  try {
    assertJsonValue(input, 'EVAL_REPLAY_INVALID', 'Provider replay fixture validation failed.')
    if (!validateReplay(input)) {
      throw invalid('EVAL_REPLAY_INVALID', 'Provider replay fixture', validateReplay.errors)
    }
    assertUniqueTurnIds(input as ProviderReplay)
    return structuredClone(input as ProviderReplay)
  } catch (error) {
    if (error instanceof EvaluationError) throw error
    throw new EvaluationError('EVAL_REPLAY_INVALID', 'Provider replay fixture validation failed.')
  }
}

export async function loadEvaluationScenario(path: string | URL): Promise<EvaluationScenarioV1> {
  return parseEvaluationScenario(await readJson(path, 'EVAL_SCENARIO_INVALID'))
}

export async function loadProviderReplay(path: string | URL): Promise<ProviderReplay> {
  return parseProviderReplay(await readJson(path, 'EVAL_REPLAY_INVALID'))
}

function assertUniqueTurnIds(replay: ProviderReplay): void {
  const turnIds = new Set<string>()
  for (const turn of replay.turns) {
    if (turnIds.has(turn.id)) {
      throw new EvaluationError(
        'EVAL_REPLAY_DUPLICATE_TURN_ID',
        `Provider replay fixture contains duplicate turn ID: ${turn.id}`,
      )
    }
    turnIds.add(turn.id)
  }
}

function assertUsageBounds(bounds: EvaluationUsageBounds): void {
  for (const [name, bound] of Object.entries(bounds)) {
    if (bound !== undefined && bound.min > bound.max) {
      throw new EvaluationError(
        'EVAL_SCENARIO_INVALID',
        `Evaluation usage bound ${name} has a minimum greater than its maximum.`,
      )
    }
  }
}

function assertDeadline(deadlineAt: string | undefined): void {
  if (deadlineAt === undefined || !Number.isNaN(Date.parse(deadlineAt))) return
  throw new EvaluationError(
    'EVAL_SCENARIO_INVALID',
    'Evaluation scenario budget deadline is invalid.',
  )
}

function assertJsonValue(
  value: unknown,
  code: EvaluationErrorCode,
  message: string,
  ancestors = new WeakSet<object>(),
): void {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return
  }
  if (typeof value !== 'object' || ancestors.has(value)) {
    throw new EvaluationError(code, message)
  }

  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw new EvaluationError(code, message)
      }
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
      if (
        lengthDescriptor === undefined ||
        !('value' in lengthDescriptor) ||
        typeof lengthDescriptor.value !== 'number' ||
        !Number.isInteger(lengthDescriptor.value) ||
        lengthDescriptor.value < 0 ||
        lengthDescriptor.writable !== true ||
        lengthDescriptor.enumerable !== false ||
        lengthDescriptor.configurable !== false
      ) {
        throw new EvaluationError(code, message)
      }
      const length = lengthDescriptor.value
      const keys = Reflect.ownKeys(value)
      if (
        keys.length !== length + 1 ||
        keys[length] !== 'length' ||
        keys.slice(0, length).some((key, index) => key !== String(index))
      ) {
        throw new EvaluationError(code, message)
      }
      for (let index = 0; index < length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (
          descriptor === undefined ||
          !('value' in descriptor) ||
          descriptor.writable !== true ||
          descriptor.enumerable !== true ||
          descriptor.configurable !== true
        ) {
          throw new EvaluationError(code, message)
        }
        assertJsonValue(descriptor.value, code, message, ancestors)
      }
      return
    }

    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new EvaluationError(code, message)
    }
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (
        typeof key !== 'string' ||
        descriptor === undefined ||
        !descriptor.enumerable ||
        !('value' in descriptor)
      ) {
        throw new EvaluationError(code, message)
      }
      assertJsonValue(descriptor.value, code, message, ancestors)
    }
  } finally {
    ancestors.delete(value)
  }
}

async function readJson(path: string | URL, code: EvaluationErrorCode): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    throw new EvaluationError(code, 'Evaluation JSON could not be read or parsed.')
  }
}

function invalid(
  code: EvaluationErrorCode,
  label: string,
  errors: ErrorObject[] | null | undefined,
): EvaluationError {
  const summary = (errors ?? [])
    .map((error) => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`)
    .join('; ')
  return new EvaluationError(code, `${label} validation failed: ${summary}`)
}
