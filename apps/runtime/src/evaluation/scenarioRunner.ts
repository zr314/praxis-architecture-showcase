import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  contentText,
  createTraceRecord,
  runtimeError,
  type AgentEvent,
  type AgentRun,
  type AgentSession,
  type BudgetUsage,
  type ChatProvider,
  type ProviderMessage,
  type ProviderRequest,
  type RuntimeTool,
  type TraceRecord,
} from '@praxis/core-sdk'
import { createBuiltinTools } from '../builtin-tools/builtinTools.js'
import { AgentLoop, type AgentLoopPorts } from '../loop/index.js'
import { CompactionService, selectContextWindow, tokenizerForProvider } from '../memory/index.js'
import { ProcessPluginHost, type ProcessPluginClient } from '../plugin/processPluginHost.js'
import { PolicyEngine } from '../policy/index.js'
import { ProviderRouter } from '../provider-router/providerRouter.js'
import { JsonlRepository } from '../session-db/jsonlRepository.js'
import { ToolRuntime } from '../tools/toolRuntime.js'
import { isPortableRelativeEvaluationPath } from './portablePath.js'
import { ReplayProvider } from './replayProvider.js'
import type {
  EvaluationFilesystemChange,
  EvaluationScenarioV1,
  EvaluationToolName,
  EvaluationUsageBounds,
} from './scenario.js'
import { EvaluationError, parseEvaluationScenario } from './scenario.js'

export type EvaluationObservation = {
  events: AgentEvent[]
  messages: ProviderMessage[]
  traces: TraceRecord[]
  usage?: BudgetUsage
  filesystem: Array<{ path: string; digest: string }>
}

export type EvaluationScenarioEvidence = {
  contextSelections: Array<{
    messages: ProviderMessage[]
    contextMessages: ProviderMessage[]
  }>
  cancellation?: {
    boundaryReached: boolean
    eventTypesAfterBoundary: AgentEvent['type'][]
    committedRolesAfterBoundary: ProviderMessage['role'][]
  }
  policy: {
    promptedToolCallIds: string[]
    grantCount: number
    auditDecisions: string[]
  }
}

export type EvaluationScenarioResult = {
  id: string
  description: string
  passed: boolean
  failures: string[]
  observation: EvaluationObservation
  workspaceRoot: string
  evidence: EvaluationScenarioEvidence
}

type FilesystemEntry = { path: string; digest: string }

const providerCapabilities = {
  streaming: { text: true, reasoning: false, usage: true },
  tools: { mode: 'native' as const, parallelCalls: true },
  modalities: { text: true, vision: false, audio: false },
  output: { jsonSchema: false, citations: false },
  limits: {},
}

/** Runs one validated, synthetic scenario through the production execution boundaries. */
export async function runEvaluationScenario(
  scenario: EvaluationScenarioV1,
): Promise<EvaluationScenarioResult> {
  const configuredProcessPlugin = scenario.setup.processPlugin
  if (
    configuredProcessPlugin !== undefined &&
    !scenario.setup.tools.includes(configuredProcessPlugin.tool)
  ) {
    throw new EvaluationError(
      'EVAL_SCENARIO_INVALID',
      'Evaluation scenario process plugin tool must be in the selected execution set.',
    )
  }
  scenario = parseEvaluationScenario(scenario)
  const selectedToolNames = new Set<EvaluationToolName>(scenario.setup.tools)
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'praxis-eval-'))
  let policyRoot: string | undefined
  let plugin: ProcessPluginClient | undefined
  try {
    policyRoot = await mkdtemp(join(tmpdir(), 'praxis-eval-policy-'))
    const policyRepository = new JsonlRepository(policyRoot)
    await policyRepository.initialize()
    const policy = new PolicyEngine(policyRepository)
    await policy.initialize()
    await materializeWorkspace(workspaceRoot, scenario)
    const canonicalWorkspaceRoot = await realpath(workspaceRoot)
    const initialFilesystem = await snapshotFilesystem(workspaceRoot)
    const contextSelections: EvaluationScenarioEvidence['contextSelections'] = []
    let checkpoint = scenario.setup.session?.checkpoint
    const events: AgentEvent[] = []
    const committedMessages: ProviderMessage[] = []
    const traces: TraceRecord[] = []
    const replay = new ReplayProvider(scenario.providerReplay)
    const sessionId = `session-${randomUUID()}`
    const runId = `run-${randomUUID()}`
    const runtimeId = `runtime-${randomUUID()}`
    const run: AgentRun = {
      id: runId,
      sessionId,
      trace: {
        traceId: `trace-${randomUUID()}`,
        runtimeId,
        sessionId,
        runId,
      },
      promptKind: scenario.request.promptKind ?? 'prompt',
      text: scenario.request.prompt,
      aborted: false,
      terminal: false,
      controller: new AbortController(),
      steerQueue: [],
      budget: structuredClone(scenario.budget),
    }
    const session: AgentSession = {
      sessionId,
      cwd: workspaceRoot,
      provider: scenario.request.provider,
      model: scenario.request.model,
      messages: [
        ...(scenario.setup.session?.initialMessages ?? []).map((message) =>
          structuredClone(message),
        ),
        { role: 'user', content: scenario.request.prompt },
      ],
    }
    const trace = async (input: Omit<TraceRecord, 'schemaVersion' | 'timestamp'>) => {
      traces.push(
        createTraceRecord({
          ...input,
          timestamp: new Date().toISOString(),
        }),
      )
    }

    if (scenario.setup.processPlugin) {
      const host = new ProcessPluginHost({ enabled: true, requestTimeoutMs: 2_000 })
      plugin = await host.start({
        command: process.execPath,
        args: [processPluginFixture(scenario.setup.processPlugin.fixture)],
        pluginId: scenario.setup.processPlugin.pluginId,
        workspace: workspaceRoot,
      })
    }

    let loop!: AgentLoop
    let activeTurnId: string | undefined
    let turnNumber = 0
    let cancellationBoundary: { eventIndex: number; messageIndex: number } | undefined
    const replayBoundary: ChatProvider = {
      id: replay.id,
      defaultModel: replay.defaultModel,
      capabilities: {
        ...providerCapabilities,
        limits:
          scenario.setup.session?.contextLimitTokens === undefined
            ? {}
            : { maxContextTokens: scenario.setup.session.contextLimitTokens },
      },
      authState: () => replay.authState(),
      async *stream(request: ProviderRequest) {
        contextSelections.push({
          messages: structuredClone(request.messages),
          contextMessages: structuredClone(request.contextMessages ?? []),
        })
        let chunkNumber = 0
        for await (const chunk of replay.stream(request)) {
          chunkNumber += 1
          yield chunk
          if (
            scenario.setup.cancellation?.boundary === 'after_first_provider_chunk' &&
            chunkNumber === 1
          ) {
            cancellationBoundary = {
              eventIndex: events.length,
              messageIndex: committedMessages.length,
            }
            loop.cancel(run, scenario.setup.cancellation.reason)
          }
        }
      },
    }
    const failingPrimary: ChatProvider = {
      id: scenario.request.provider,
      defaultModel: scenario.request.model,
      capabilities: providerCapabilities,
      authState: () => ({ status: 'authenticated' }),
      async *stream() {
        throw runtimeError(
          scenario.setup.providerRouting?.primaryFailure.code ?? 'EVALUATION_PRIMARY_FAILURE',
          'provider',
          'Synthetic primary provider failure.',
          undefined,
          scenario.setup.providerRouting?.primaryFailure.retryable ?? false,
        )
      },
    }
    const providerLookup = async (id: string): Promise<ChatProvider | undefined> => {
      if (scenario.setup.providerRouting && id === scenario.request.provider) return failingPrimary
      if (id === replay.id) return replayBoundary
      return undefined
    }
    const router = new ProviderRouter(providerLookup, {
      retryAttempts: scenario.setup.providerRouting?.retryAttempts ?? 0,
      fallbacks: scenario.setup.providerRouting
        ? { [scenario.request.provider]: [scenario.setup.providerRouting.fallback] }
        : undefined,
    })
    const toolRuntime = evaluationTools(scenario.setup.tools)
    const decisions = new Map(
      scenario.permissionDecisions.map(({ toolCallId, decision }) => [toolCallId, decision]),
    )
    const promptedToolCallIds: string[] = []
    const ports: AgentLoopPorts = {
      providerFor: providerLookup,
      streamProvider: (provider, request, context, prepareRequest) =>
        router.stream(provider.id, request, { context, trace }, prepareRequest),
      tools: () => ({
        definitions: () => toolRuntime.definitions(),
        validateInput: (name, input) => toolRuntime.validateInput(name, input),
        prepare: (name, input, cwd) => toolRuntime.prepare(name, input, cwd),
        executePrepared: async (prepared, signal, onUpdate) => {
          const { name, input } = prepared
          if (!selectedToolNames.has(name as EvaluationToolName)) {
            return { ok: false, summary: 'Evaluation tool is outside the selected execution set.' }
          }
          if (!(await toolTargetIsContained(name, input, workspaceRoot, canonicalWorkspaceRoot))) {
            return {
              ok: false,
              summary: 'Evaluation tool target must stay inside the temporary workspace.',
            }
          }
          if (name !== scenario.setup.processPlugin?.tool) {
            return toolRuntime.executePrepared(prepared, signal, onUpdate)
          }
          if (!plugin) throw new Error('Evaluation process plugin was not started.')
          const output = await plugin.invoke(
            scenario.setup.processPlugin.capabilityId,
            input,
            undefined,
            {
              context: {
                ...run.trace,
                ...(activeTurnId === undefined ? {} : { turnId: activeTurnId }),
                ...(typeof input.toolCallId === 'string' ? { toolCallId: input.toolCallId } : {}),
              },
              trace,
            },
          )
          return { ok: true, summary: 'Plugin unexpectedly completed.', output }
        },
      }),
      commitMessage: async (target, targetRun, message) => {
        if (targetRun.aborted || targetRun.terminal) return
        const committed = structuredClone(message)
        target.messages.push(committed)
        committedMessages.push(structuredClone(committed))
      },
      emit: (event) => {
        events.push(structuredClone(event))
      },
      requestPermission: async (targetSession, _run, toolCall, _input, requirement) => {
        promptedToolCallIds.push(toolCall.id)
        const decision = decisions.get(toolCall.id) ?? {
          type: 'deny',
          reason: 'Evaluation scenario did not authorize this tool call.',
        }
        const request = {
          workspace: targetSession.cwd,
          tool: toolCall.name,
          rule: requirement.rule,
          ...(requirement.target === undefined ? {} : { target: requirement.target }),
        }
        if (decision.type === 'allow_always') await policy.grant(request)
        else await policy.record({ ...request, decision: decision.type })
        return decision
      },
      hasPermissionRule: (name, requirement, cwd) =>
        policy.allows({ workspace: cwd, tool: name, rule: requirement.rule }),
      finishRun: (_session, _run, event) => {
        events.push(structuredClone(event))
        return event
      },
      buildSystemPrompt: () => ({
        instructions: 'Deterministic offline evaluation instructions.',
        contextMessages: [],
        manifest: {
          estimatedTokens: 22,
          maxTokens: 64,
          sections: [],
          program: {
            variant: 'baseline-v1',
            trustedInstructions: {
              id: 'praxis.trusted-instructions',
              version: 'evaluation-v1',
              owner: 'runtime',
              blockCount: 1,
              digest: `sha256:${'0'.repeat(64)}`,
              estimatedTokens: 22,
              componentIds: ['evaluation'],
            },
          },
        },
      }),
      recordPromptManifest: () => {},
      selectContext: (target, _run, provider, promptBuild, tools) =>
        selectContextWindow({
          messages: target.messages,
          checkpoint,
          tokenizer: tokenizerForProvider(provider.id),
          budget: {
            contextWindowTokens: provider.capabilities?.limits.maxContextTokens ?? 4_096,
            systemTokens: promptBuild.manifest.estimatedTokens,
            toolSchemaTokens: tokenizerForProvider(provider.id).countText(JSON.stringify(tools)),
            responseTokens: 16,
            safetyTokens: 8,
          },
          promptVariant: promptBuild.manifest.program.variant,
        }),
      compactContext: async (target) => {
        const next = await new CompactionService({
          tokenizer: tokenizerForProvider(scenario.request.provider),
          retainRecentMessages: 2,
        }).compact({
          sessionId,
          messages: target.messages,
          previous: checkpoint,
        })
        if (!next || next.id === checkpoint?.id) return { compacted: false }
        checkpoint = next
        return {
          compacted: true,
          checkpointTokens: next.estimatedTokens,
          omittedMessages: next.messageEnd,
        }
      },
      nextMessageId: () => `message-${randomUUID()}`,
      nextSteerId: () => `steer-${randomUUID()}`,
      trace,
      nextTurnId: () => {
        turnNumber += 1
        activeTurnId = `${run.id}-turn-${turnNumber}`
        return activeTurnId
      },
    }
    loop = new AgentLoop(ports)
    await loop.execute(session, run)
    await plugin?.shutdown().catch(() => undefined)
    plugin = undefined

    const filesystem = await snapshotFilesystem(workspaceRoot)
    const observation: EvaluationObservation = {
      events,
      messages: committedMessages,
      traces,
      ...(run.usage === undefined ? {} : { usage: structuredClone(run.usage) }),
      filesystem,
    }
    const evidence: EvaluationScenarioEvidence = {
      contextSelections,
      policy: {
        promptedToolCallIds,
        grantCount: (await policyRepository.loadGrants()).length,
        auditDecisions: await loadPolicyAuditDecisions(policyRoot),
      },
      ...(scenario.setup.cancellation === undefined
        ? {}
        : {
            cancellation: {
              boundaryReached: cancellationBoundary !== undefined,
              eventTypesAfterBoundary:
                cancellationBoundary === undefined
                  ? []
                  : events.slice(cancellationBoundary.eventIndex).map((event) => event.type),
              committedRolesAfterBoundary:
                cancellationBoundary === undefined
                  ? []
                  : committedMessages
                      .slice(cancellationBoundary.messageIndex)
                      .map((message) => message.role),
            },
          }),
    }
    const failures = [
      ...evaluateAssertions(
        scenario,
        observation,
        initialFilesystem,
        replay.remainingTurns(),
        evidence,
      ),
      ...evaluatePolicyEvidence(scenario, evidence.policy),
    ]
    return {
      id: scenario.id,
      description: scenario.description,
      passed: failures.length === 0,
      failures,
      observation,
      workspaceRoot,
      evidence,
    }
  } finally {
    await plugin?.shutdown().catch(() => undefined)
    await rm(workspaceRoot, { recursive: true, force: true })
    if (policyRoot !== undefined) await rm(policyRoot, { recursive: true, force: true })
  }
}

function evaluationTools(names: readonly EvaluationToolName[]): ToolRuntime {
  const tools: RuntimeTool[] = [
    ...createBuiltinTools().filter((tool) => tool.definition.name !== 'shell'),
    {
      definition: {
        name: 'record',
        description: 'Records deterministic evaluation input.',
        parameters: { type: 'object' },
      },
      async execute(request) {
        return { ok: true, summary: 'Recorded.', output: request.input }
      },
    },
    {
      definition: {
        name: 'plugin_crash',
        description: 'Invokes the isolated evaluation plugin.',
        parameters: { type: 'object' },
      },
      async execute() {
        return { ok: false, summary: 'The process boundary must own this invocation.' }
      },
    },
    {
      definition: {
        name: 'cancel_probe',
        description: 'Must not run after cancellation.',
        parameters: { type: 'object' },
      },
      async execute() {
        return { ok: false, summary: 'Cancellation failed to stop tool work.' }
      },
    },
  ]
  const available = new Map(tools.map((tool) => [tool.definition.name, tool]))
  return new ToolRuntime(
    names.map((name) => {
      const tool = available.get(name)
      if (!tool) throw new Error(`Evaluation tool is unavailable: ${name}`)
      return tool
    }),
    { exposeArtifactTool: false },
  )
}

function processPluginFixture(fixture: 'crash-on-invoke'): string {
  const fixtures = {
    'crash-on-invoke': new URL('../../../../evals/fixtures/crashing-plugin.mjs', import.meta.url),
  } satisfies Record<typeof fixture, URL>
  return fileURLToPath(fixtures[fixture])
}

async function toolTargetIsContained(
  name: string,
  input: Record<string, unknown>,
  workspaceRoot: string,
  canonicalWorkspaceRoot: string,
): Promise<boolean> {
  if (!['read', 'write', 'edit'].includes(name) || typeof input.path !== 'string') return true
  if (!isPortableRelativeEvaluationPath(input.path)) return false
  const target = resolve(workspaceRoot, input.path)
  if (!isContainedPath(workspaceRoot, target)) return false
  return isContainedPath(canonicalWorkspaceRoot, await canonicalizeTarget(target))
}

async function canonicalizeTarget(target: string): Promise<string> {
  let existing = target
  const missing: string[] = []
  while (true) {
    try {
      return resolve(await realpath(existing), ...missing)
    } catch (error) {
      if (!isMissingPath(error)) throw error
      const parent = dirname(existing)
      if (parent === existing) throw error
      missing.unshift(basename(existing))
      existing = parent
    }
  }
}

function isContainedPath(root: string, target: string): boolean {
  const relation = relative(root, target)
  return (
    relation !== '..' &&
    !relation.startsWith('../') &&
    !relation.startsWith('..\\') &&
    !isAbsolute(relation)
  )
}

function isMissingPath(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  )
}

async function materializeWorkspace(root: string, scenario: EvaluationScenarioV1): Promise<void> {
  for (const directory of scenario.workspaceFixture.directories ?? []) {
    await mkdir(workspacePath(root, directory), { recursive: true })
  }
  for (const file of scenario.workspaceFixture.files) {
    const target = workspacePath(root, file.path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, file.content, 'utf8')
  }
}

function workspacePath(root: string, requested: string): string {
  if (!isPortableRelativeEvaluationPath(requested)) {
    throw new EvaluationError(
      'EVAL_SCENARIO_INVALID',
      'Evaluation workspace fixture path is not a portable relative path.',
    )
  }
  const target = resolve(root, requested)
  const relation = relative(root, target)
  if (
    requested.length === 0 ||
    isAbsolute(requested) ||
    relation === '..' ||
    relation.startsWith('../') ||
    relation.startsWith('..\\') ||
    isAbsolute(relation)
  ) {
    throw new EvaluationError(
      'EVAL_SCENARIO_INVALID',
      'Evaluation workspace fixture path must stay inside its temporary root.',
    )
  }
  return target
}

async function snapshotFilesystem(root: string): Promise<FilesystemEntry[]> {
  const entries: FilesystemEntry[] = []
  await visit(root)
  return entries.sort((left, right) =>
    portablePath(left.path).localeCompare(portablePath(right.path)),
  )

  async function visit(directory: string): Promise<void> {
    const children = await readdir(directory, { withFileTypes: true })
    children.sort((left, right) => left.name.localeCompare(right.name))
    for (const child of children) {
      const absolute = join(directory, child.name)
      if (child.isDirectory()) {
        await visit(absolute)
      } else if (child.isFile()) {
        const content = await readFile(absolute)
        entries.push({
          path: relative(root, absolute),
          digest: `sha256:${createHash('sha256').update(content).digest('hex')}`,
        })
      } else {
        throw new Error('Evaluation workspaces cannot contain filesystem links or special files.')
      }
    }
  }
}

function evaluateAssertions(
  scenario: EvaluationScenarioV1,
  observation: EvaluationObservation,
  initialFilesystem: FilesystemEntry[],
  remainingReplayTurns: number,
  evidence: EvaluationScenarioEvidence,
): string[] {
  const failures: string[] = []
  const expected = scenario.assertions
  const terminals = observation.events.filter(isTerminalEvent)
  if (terminals.length !== 1) {
    failures.push(
      `terminal: expected [${expected.terminalEvent.type}], actual count ${terminals.length}`,
    )
  } else {
    const terminal = terminals[0]!
    const terminalMismatches = Object.entries(expected.terminalEvent).filter(
      ([name, value]) => terminal[name as keyof typeof terminal] !== value,
    )
    if (terminalMismatches.length > 0) {
      failures.push(
        `terminal: expected ${compact(expected.terminalEvent)}, actual ${compact(terminal)}`,
      )
    }
  }

  const actualTypes = observation.events.map((event) => event.type)
  for (const [type, count] of Object.entries(expected.eventCounts)) {
    const actual = actualTypes.filter((candidate) => candidate === type).length
    if (actual !== count) failures.push(`event count ${type}: expected ${count}, actual ${actual}`)
  }
  if (!sameArray(actualTypes, expected.eventOrder)) {
    failures.push(
      `events: expected [${expected.eventOrder.join(' > ')}], actual [${actualTypes.join(' > ')}]`,
    )
  }

  const actualRoles = observation.messages.map((message) => message.role)
  if (!sameArray(actualRoles, expected.committedRoles)) {
    failures.push(
      `messages: expected [${expected.committedRoles.join(', ')}], actual [${actualRoles.join(', ')}]`,
    )
  }
  const actualTraceKinds = observation.traces.map((trace) => trace.kind)
  if (!sameArray(actualTraceKinds, expected.traceKinds)) {
    failures.push(
      `traces: expected [${expected.traceKinds.join(' > ')}], actual [${actualTraceKinds.join(' > ')}]`,
    )
  }

  assertUsage(expected.usageBounds, observation.usage, failures)
  const changes = filesystemChanges(initialFilesystem, observation.filesystem)
  const expectedChanges = [...expected.filesystemChanges].sort(compareChanges)
  if (!sameChanges(changes, expectedChanges)) {
    failures.push(
      `filesystem: expected [${expectedChanges.map(describeChange).join(', ')}], actual [${changes.map(describeChange).join(', ')}]`,
    )
  }
  if (remainingReplayTurns !== expected.remainingReplayTurns) {
    failures.push(
      `replay turns: expected ${expected.remainingReplayTurns}, actual ${remainingReplayTurns}`,
    )
  }
  if (expected.contextSelection) {
    const selectedContext = evidence.contextSelections.flatMap((selection) =>
      selection.contextMessages.map((message) => contentText(message.content)),
    )
    const selectedMessages = evidence.contextSelections.flatMap((selection) =>
      selection.messages.map((message) => contentText(message.content)),
    )
    for (const required of expected.contextSelection.contextMessagesContain) {
      if (!selectedContext.some((content) => content.includes(required))) {
        failures.push(`context selection: required context marker was missing: ${required}`)
      }
    }
    for (const excluded of expected.contextSelection.messagesExclude) {
      if (selectedMessages.some((content) => content.includes(excluded))) {
        failures.push(`context selection: excluded raw marker reached Provider: ${excluded}`)
      }
    }
  }
  if (expected.cancellationEvidence) {
    const actual = evidence.cancellation
    const toolStarts =
      actual?.eventTypesAfterBoundary.filter((type) => type === 'tool_start').length ?? 0
    const commits = actual?.committedRolesAfterBoundary.length ?? 0
    if (actual?.boundaryReached !== expected.cancellationEvidence.boundaryReached) {
      failures.push(
        `cancellation boundary: expected ${expected.cancellationEvidence.boundaryReached}, actual ${actual?.boundaryReached ?? false}`,
      )
    }
    if (toolStarts !== expected.cancellationEvidence.toolStartsAfterBoundary) {
      failures.push(
        `cancellation tool starts: expected ${expected.cancellationEvidence.toolStartsAfterBoundary}, actual ${toolStarts}`,
      )
    }
    if (commits !== expected.cancellationEvidence.committedMessagesAfterBoundary) {
      failures.push(
        `cancellation commits: expected ${expected.cancellationEvidence.committedMessagesAfterBoundary}, actual ${commits}`,
      )
    }
  }
  return failures
}

function evaluatePolicyEvidence(
  scenario: EvaluationScenarioV1,
  evidence: EvaluationScenarioEvidence['policy'],
): string[] {
  const failures: string[] = []
  const expectedToolCallIds = scenario.permissionDecisions.map(({ toolCallId }) => toolCallId)
  if (!sameArray(evidence.promptedToolCallIds, expectedToolCallIds)) {
    failures.push(
      `policy prompts: expected [${expectedToolCallIds.join(', ')}], actual [${evidence.promptedToolCallIds.join(', ')}]`,
    )
  }
  const expectedDecisions = scenario.permissionDecisions.map(({ decision }) => decision.type)
  if (!sameArray(evidence.auditDecisions, expectedDecisions)) {
    failures.push(
      `policy audits: expected [${expectedDecisions.join(', ')}], actual [${evidence.auditDecisions.join(', ')}]`,
    )
  }
  const expectedGrants = expectedDecisions.filter((decision) => decision === 'allow_always').length
  if (evidence.grantCount !== expectedGrants) {
    failures.push(`policy grants: expected ${expectedGrants}, actual ${evidence.grantCount}`)
  }
  return failures
}

async function loadPolicyAuditDecisions(root: string): Promise<string[]> {
  try {
    return (await readFile(join(root, 'policy-audit.jsonl'), 'utf8'))
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { decision?: unknown })
      .map((record) => {
        if (typeof record.decision !== 'string') {
          throw new SyntaxError('Evaluation policy audit record has no decision.')
        }
        return record.decision
      })
  } catch (error) {
    if (isMissingPath(error)) return []
    throw error
  }
}

function assertUsage(
  bounds: EvaluationUsageBounds,
  usage: BudgetUsage | undefined,
  failures: string[],
): void {
  const actual: BudgetUsage = usage ?? { turns: 0, toolCalls: 0, subagents: 0 }
  for (const [name, bound] of Object.entries(bounds)) {
    if (bound === undefined) continue
    const value = actual[name as keyof BudgetUsage] ?? 0
    if (value < bound.min || value > bound.max) {
      failures.push(`usage ${name}: expected ${bound.min}..${bound.max}, actual ${value}`)
    }
  }
}

function filesystemChanges(
  before: FilesystemEntry[],
  after: FilesystemEntry[],
): EvaluationFilesystemChange[] {
  const previous = new Map(before.map((entry) => [portablePath(entry.path), entry.digest]))
  const current = new Map(after.map((entry) => [portablePath(entry.path), entry.digest]))
  const changes: EvaluationFilesystemChange[] = []
  for (const [path, digest] of current) {
    const oldDigest = previous.get(path)
    if (oldDigest === undefined) changes.push({ path, change: 'created', digest })
    else if (oldDigest !== digest) changes.push({ path, change: 'modified', digest })
  }
  for (const [path, digest] of previous) {
    if (!current.has(path)) changes.push({ path, change: 'deleted', digest })
  }
  return changes.sort(compareChanges)
}

function sameChanges(
  actual: EvaluationFilesystemChange[],
  expected: EvaluationFilesystemChange[],
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((change, index) => {
      const candidate = expected[index]
      return (
        candidate !== undefined &&
        portablePath(change.path) === portablePath(candidate.path) &&
        change.change === candidate.change &&
        (candidate.digest === undefined || change.digest === candidate.digest)
      )
    })
  )
}

function compareChanges(
  left: EvaluationFilesystemChange,
  right: EvaluationFilesystemChange,
): number {
  return `${portablePath(left.path)}:${left.change}`.localeCompare(
    `${portablePath(right.path)}:${right.change}`,
  )
}

function describeChange(change: EvaluationFilesystemChange): string {
  return `${portablePath(change.path)}:${change.change}`
}

function portablePath(path: string): string {
  return path.replaceAll('\\', '/')
}

function isTerminalEvent(
  event: AgentEvent,
): event is Extract<AgentEvent, { type: 'prompt_completed' | 'prompt_failed' | 'prompt_aborted' }> {
  return ['prompt_completed', 'prompt_failed', 'prompt_aborted'].includes(event.type)
}

function sameArray<T>(actual: readonly T[], expected: readonly T[]): boolean {
  return (
    actual.length === expected.length && actual.every((value, index) => value === expected[index])
  )
}

function compact(value: unknown): string {
  return JSON.stringify(value)
}
