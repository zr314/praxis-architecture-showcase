import assert from 'node:assert/strict'
import test from 'node:test'
import type { SessionEvent } from '@praxis/protocol'
import {
  appendCredentialInput,
  availableModels,
  backToProviders,
  buildProviderOptions,
  catalogModelCounts,
  movePickerSelection,
  nextModel,
  openProviderModels,
  pickerWindow,
  refreshCatalog,
  selectedProvider,
  toggleModelScope,
  updatePickerQuery,
  visibleModels,
} from '../apps/cli/src/ui/catalogPickerModel.js'
import {
  commandCatalogFromSnapshots,
  commandSuggestions,
  commandSuggestionWindow,
  moveCommandSelection,
  selectedCommandSuggestion,
} from '../apps/cli/src/ui/commandCatalog.js'
import { createClientCommandRegistryV1 } from '../apps/cli/src/ui/clientCommandRegistry.js'
import {
  createMockRuntimeCommandRegistryV1,
  MOCK_COMMAND_CAPABILITIES_V1,
} from '../apps/cli/src/bridge/mockCommandRegistry.js'
import { parseMarkdownBlocks } from '../apps/cli/src/ui/MarkdownText.js'
import {
  contextPressure,
  workflowPlanGraph,
  workflowPlanSnapshot,
  summarizeActivity,
  terminalLayout,
  transcriptEvents,
  transcriptWindow,
} from '../apps/cli/src/ui/tuiModel.js'

const TEST_RUNTIME_COMMAND_CATALOG = createMockRuntimeCommandRegistryV1().snapshot({
  workspaceId: 'workspace:test',
  workspaceTrusted: true,
  capabilityIds: MOCK_COMMAND_CAPABILITIES_V1,
})
const TEST_CLIENT_COMMAND_CATALOG = createClientCommandRegistryV1().snapshot({
  workspaceId: TEST_RUNTIME_COMMAND_CATALOG.workspaceId,
  workspaceTrusted: TEST_RUNTIME_COMMAND_CATALOG.workspaceTrusted,
  capabilityIds: TEST_RUNTIME_COMMAND_CATALOG.capabilityIds,
})
const TEST_COMMAND_CATALOG = commandCatalogFromSnapshots([
  TEST_CLIENT_COMMAND_CATALOG,
  TEST_RUNTIME_COMMAND_CATALOG,
])

test('terminal layout adds the context rail only when width and height permit it', () => {
  assert.equal(terminalLayout(120, 36).wide, true)
  assert.equal(terminalLayout(120, 30).wide, false)
  assert.equal(terminalLayout(120, 24).wide, false)
  assert.equal(terminalLayout(80, 30).compact, true)
  assert.equal(terminalLayout(96, 30).compact, false)
  assert.equal(terminalLayout(68, 36).compact, true)
  assert.equal(terminalLayout(120, 36).transcriptWidth, 89)
  assert.equal(terminalLayout(80, 24).columns, 79)
  assert.equal(terminalLayout(10, 6).columns, 9)
})

test('transcript collapses tool lifecycle noise and completed thinking', () => {
  const events: SessionEvent[] = [
    { type: 'prompt_started', sessionId: 'session', runId: 'run', prompt: 'inspect' },
    { type: 'thinking_delta', runId: 'run', text: 'private chain of thought' },
    {
      type: 'tool_planning',
      runId: 'run',
      toolCallId: 'tool',
      name: 'read',
      input: { path: 'README.md' },
    },
    {
      type: 'permission_request',
      runId: 'run',
      requestId: 'permission',
      toolCallId: 'tool',
      tool: 'read',
      input: { path: 'README.md' },
    },
    {
      type: 'tool_start',
      runId: 'run',
      toolCallId: 'tool',
      name: 'read',
      input: { path: 'README.md' },
    },
    {
      type: 'tool_update',
      runId: 'run',
      toolCallId: 'tool',
      message: 'reading',
    },
    {
      type: 'tool_end',
      runId: 'run',
      toolCallId: 'tool',
      ok: true,
      summary: 'Read 20 lines.',
    },
    { type: 'text_delta', runId: 'run', text: 'Done.' },
    { type: 'prompt_completed', runId: 'run' },
  ]

  assert.deepEqual(
    transcriptEvents(events).map((event) => event.type),
    ['prompt_started', 'tool_end', 'text_delta', 'prompt_completed'],
  )
})

test('transcript window clips one aggregated assistant delta to visible terminal rows', () => {
  const source = Array.from({ length: 100 }, (_, index) => `line-${index}`).join('\n')
  const visible = transcriptWindow([{ type: 'text_delta', runId: 'run', text: source }], 80, 5)
  assert.equal(visible.length, 1)
  assert.equal(visible[0]?.type, 'text_delta')
  if (visible[0]?.type === 'text_delta') {
    assert.doesNotMatch(visible[0].text, /line-0(?:\n|$)/u)
    assert.match(visible[0].text, /line-99/u)
    assert.ok(visible[0].text.split('\n').length <= 6)
  }
})

test('transcript window reserves the latest user prompt before a clipped response tail', () => {
  const visible = transcriptWindow(
    [
      { type: 'prompt_started', sessionId: 'session', runId: 'run', prompt: 'latest request' },
      { type: 'text_delta', runId: 'run', text: Array(20).fill('response row').join('\n') },
      { type: 'prompt_completed', runId: 'run' },
    ],
    40,
    5,
  )
  assert.equal(visible[0]?.type, 'prompt_started')
  assert.equal(visible.at(-1)?.type, 'prompt_completed')
})

test('durable plan snapshot renders steps before live deltas and survives missing creation events', () => {
  const snapshot = workflowPlanSnapshot({
    sessionId: 'session',
    plan: {
      planId: 'plan-1',
      state: 'running',
      objective: 'Implement the task',
      steps: [
        { stepId: 'step-2', title: 'Verify', order: 1, state: 'pending' },
        { stepId: 'step-1', title: 'Implement', order: 0, state: 'running' },
      ],
    },
  })
  assert.ok(snapshot)
  assert.deepEqual(
    snapshot.steps.map((step) => step.stepId),
    ['step-1', 'step-2'],
  )

  const graph = workflowPlanGraph(
    [
      {
        type: 'supervisor_update',
        update: {
          schemaVersion: 1,
          parentSequence: 10,
          sessionId: 'session',
          correlation: { parentRunId: 'run', planId: 'plan-1', stepId: 'step-1' },
          source: {
            kind: 'journal',
            journalSequence: 10,
            revision: 3,
            entryId: 'entry-10',
            update: {
              kind: 'step',
              event: 'step.state_changed',
              state: 'succeeded',
            },
          },
        },
      },
    ],
    snapshot,
  )
  assert.equal(graph?.steps[0]?.state, 'succeeded')
  assert.equal(graph?.steps[1]?.state, 'pending')
})

test('replanned graph replaces prior revision steps and hides prior revision errors', () => {
  const events: SessionEvent[] = [
    journalSupervisorEvent(1, {
      kind: 'plan',
      event: 'plan.created',
      state: 'running',
      objective: 'Test the CLI',
    }),
    journalSupervisorEvent(
      2,
      { kind: 'step', event: 'step.created', state: 'pending', title: 'Inspect', order: 0 },
      'step-old-inspect',
    ),
    journalSupervisorEvent(
      3,
      {
        kind: 'step',
        event: 'step.state_changed',
        state: 'failed',
        errorCode: 'OLD_REVISION_FAILURE',
      },
      'step-old-shell',
    ),
    journalSupervisorEvent(4, {
      kind: 'plan',
      event: 'plan.revised',
      state: 'running',
      objective: 'Test the CLI',
    }),
    journalSupervisorEvent(
      5,
      { kind: 'step', event: 'step.created', state: 'succeeded', title: 'Inspect', order: 0 },
      'step-current-inspect',
    ),
    journalSupervisorEvent(
      6,
      {
        kind: 'step',
        event: 'step.state_changed',
        state: 'failed',
        errorCode: 'CURRENT_REVISION_FAILURE',
      },
      'step-current-shell',
    ),
  ]

  const graph = workflowPlanGraph(events)
  assert.deepEqual(
    graph?.steps.map((step) => step.stepId),
    ['step-current-inspect', 'step-current-shell'],
  )
  assert.deepEqual(
    transcriptEvents(events)
      .filter((event) => event.type === 'supervisor_update')
      .map((event) => event.update.source.kind === 'journal' && event.update.source.update)
      .filter((update) => update && 'errorCode' in update)
      .map((update) => update && 'errorCode' in update && update.errorCode),
    ['CURRENT_REVISION_FAILURE'],
  )
})

function journalSupervisorEvent(
  sequence: number,
  update: Extract<
    Extract<SessionEvent, { type: 'supervisor_update' }>['update']['source'],
    { kind: 'journal' }
  >['update'],
  stepId?: string,
): Extract<SessionEvent, { type: 'supervisor_update' }> {
  return {
    type: 'supervisor_update',
    update: {
      schemaVersion: 1,
      parentSequence: sequence,
      sessionId: 'session',
      correlation: {
        parentRunId: 'run',
        planId: 'plan-replanned',
        ...(stepId === undefined ? {} : { stepId }),
      },
      source: {
        kind: 'journal',
        journalSequence: sequence,
        revision: sequence,
        entryId: `entry-${sequence}`,
        update,
      },
    },
  }
}

test('activity summary reports latest usage, tools, failures, warnings, and artifacts', () => {
  const events: SessionEvent[] = [
    {
      type: 'prompt_started',
      sessionId: 'session',
      runId: 'run',
      prompt: 'work',
    },
    { type: 'tool_start', runId: 'run', toolCallId: 'call', name: 'write', input: {} },
    {
      type: 'tool_end',
      runId: 'run',
      toolCallId: 'call',
      ok: false,
      output: { artifacts: [{ artifactId: 'artifact' }] },
    },
    { type: 'runtime_warning', code: 'WARN', message: 'warning' },
    {
      type: 'prompt_completed',
      runId: 'run',
      usage: { inputTokens: 1200, outputTokens: 300 },
    },
  ]
  assert.deepEqual(summarizeActivity(events), {
    prompts: 1,
    tools: 1,
    failedTools: 1,
    warnings: 1,
    artifacts: 1,
    usage: { inputTokens: 1200, outputTokens: 300 },
  })
})

test('context pressure uses the latest completed usage and stays bounded', () => {
  const events: SessionEvent[] = [
    {
      type: 'prompt_completed',
      runId: 'old',
      usage: { inputTokens: 20, outputTokens: 10 },
    },
    {
      type: 'prompt_completed',
      runId: 'latest',
      usage: { inputTokens: 900, outputTokens: 200 },
    },
  ]
  assert.equal(contextPressure(events, 1_000), 1)
  assert.equal(contextPressure([], 1_000), 0)
  assert.equal(contextPressure([], undefined), undefined)
})

test('command palette suggestions and markdown blocks expose structured UI data', () => {
  assert.deepEqual(
    commandSuggestions('/co', TEST_COMMAND_CATALOG).map(({ command }) => command),
    ['/compact', '/context', '/copy'],
  )
  assert.equal(commandSuggestions('/', TEST_COMMAND_CATALOG).length, 14)
  assert.equal(moveCommandSelection('/', 0, 1, TEST_COMMAND_CATALOG), 1)
  assert.equal(moveCommandSelection('/', 0, -1, TEST_COMMAND_CATALOG), 13)
  assert.equal(selectedCommandSuggestion('/', 11, TEST_COMMAND_CATALOG)?.command, '/provider')
  assert.deepEqual(commandSuggestionWindow('/', 12, TEST_COMMAND_CATALOG, 4), {
    items: commandSuggestions('/', TEST_COMMAND_CATALOG).slice(10, 14),
    offset: 10,
    selected: 12,
    total: 14,
  })
  assert.deepEqual(commandSuggestions('/model value', TEST_COMMAND_CATALOG), [])
  assert.deepEqual(parseMarkdownBlocks('before\n```ts\nconst ok = true\n```\nafter'), [
    { type: 'prose', source: 'before\n' },
    { type: 'code', language: 'ts', source: 'const ok = true' },
    { type: 'prose', source: '\nafter' },
  ])
})

test('catalog picker joins Runtime provider health with models and wraps navigation', () => {
  const models = [
    {
      catalogVersion: 1 as const,
      provider: 'anthropic',
      id: 'claude',
      name: 'Claude',
      family: 'anthropic-messages' as const,
      reasoningLevels: ['high'],
      modalities: ['text'],
    },
    {
      catalogVersion: 1 as const,
      provider: 'missing',
      id: 'unavailable',
      name: 'Unavailable',
      family: 'openai-chat' as const,
      reasoningLevels: [],
      modalities: ['text'],
    },
  ]
  const providers = buildProviderOptions(
    [
      {
        id: 'mock',
        status: 'authenticated',
        health: 'healthy',
        accountLabel: 'Stored credential',
      },
      { id: 'anthropic', status: 'unauthenticated', health: 'healthy' },
    ],
    models,
  )
  assert.deepEqual(
    providers.map(({ id, modelCount }) => [id, modelCount]),
    [
      ['mock', 0],
      ['anthropic', 1],
    ],
  )
  assert.deepEqual(
    availableModels(models, providers).map(({ id }) => id),
    ['claude'],
  )

  const state = {
    status: 'ready' as const,
    view: 'providers' as const,
    intent: 'select' as const,
    query: '',
    currentProvider: 'anthropic',
    currentModel: 'claude',
    providers,
    models: availableModels(models, providers),
    selected: 0,
  }
  assert.equal(movePickerSelection(state, -1).selected, 1)
  assert.equal(selectedProvider(state)?.id, 'mock')
  const credentialState = openProviderModels(movePickerSelection(state, -1))
  assert.equal(credentialState.view, 'credentials')
  assert.equal(backToProviders({ ...credentialState, credential: 'secret' }).credential, undefined)
  assert.equal(credentialState.providerFilter, 'anthropic')
  assert.equal(backToProviders(credentialState).view, 'providers')

  const authenticatedProviders = providers.map((provider) =>
    provider.id === 'anthropic' ? { ...provider, status: 'authenticated' as const } : provider,
  )
  const modelState = openProviderModels({
    ...movePickerSelection(state, -1),
    providers: authenticatedProviders,
  })
  assert.equal(modelState.view, 'models')
  assert.equal(modelState.providerFilter, 'anthropic')
  assert.equal(visibleModels(modelState)[0]?.id, 'claude')
  assert.equal(toggleModelScope(modelState).availability, 'all')
  assert.equal(toggleModelScope(toggleModelScope(modelState)).availability, 'available')
  assert.deepEqual(catalogModelCounts(modelState), { shown: 1, available: 1, catalog: 1 })
  const refreshed = refreshCatalog(
    { ...modelState, selected: 0, query: 'cla' },
    authenticatedProviders,
    [...modelState.models].reverse(),
  )
  assert.equal(refreshed.query, 'cla')
  assert.equal(visibleModels(refreshed)[refreshed.selected]?.id, 'claude')
  assert.equal(backToProviders(modelState).view, 'providers')
  assert.equal(updatePickerQuery(modelState, 'cld').query, 'cld')
  assert.equal(
    visibleModels(updatePickerQuery(modelState, 'cld') as typeof modelState)[0]?.id,
    'claude',
  )
  assert.equal(
    visibleModels(updatePickerQuery(modelState, 'Claude') as typeof modelState)[0]?.id,
    'claude',
  )
  assert.equal(
    openProviderModels({
      ...movePickerSelection(state, -1),
      intent: 'login',
      providers: authenticatedProviders,
    }).view,
    'credentials',
  )
  assert.equal(nextModel(models, 'anthropic', 'claude', 1)?.id, 'unavailable')
  assert.equal(appendCredentialInput('sk-', '\u001b[200~secret\r\n\u001b[201~'), 'sk-secret')
  assert.deepEqual(pickerWindow([1, 2, 3, 4, 5], 3, 3), {
    items: [3, 4, 5],
    offset: 2,
  })
})
