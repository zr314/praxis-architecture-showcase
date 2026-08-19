import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  ChatProvider,
  CompactionSummary,
  ProviderMessage,
  ProviderRequest,
} from '@praxis/core-sdk'
import { selectContextWindow } from '../apps/runtime/src/memory/contextWindow.js'
import {
  type CompactionGeneratorInput,
  CompactionService,
  type CompactionSummaryGenerator,
  ConservativeTokenizer,
  ProviderCompactionSummaryGenerator,
  tokenizerForProvider,
} from '../apps/runtime/src/memory/index.js'

test('Provider tokenizer registry selects explicit adapters with a conservative fallback', () => {
  assert.equal(tokenizerForProvider('kimi').id, 'openai-compatible-heuristic')
  assert.equal(tokenizerForProvider('deepseek').id, 'openai-compatible-heuristic')
  assert.equal(tokenizerForProvider('qwen-token-plan-cn').id, 'openai-compatible-heuristic')
  assert.equal(tokenizerForProvider('openai-chat').id, 'openai-compatible-heuristic')
  assert.equal(tokenizerForProvider('minimax').id, 'conservative-utf8')
  assert.equal(tokenizerForProvider('mock').id, 'deterministic-test')
  assert.equal(tokenizerForProvider('unknown').id, 'conservative-utf8')
  assert.ok(new ConservativeTokenizer().countText('中文 and English') > 0)
})

test('context selection reserves independent headroom and reports only aggregate pressure', () => {
  const selection = selectContextWindow({
    messages: [
      { role: 'user', content: 'old fact' },
      { role: 'assistant', content: 'new fact' },
    ],
    tokenizer: new ConservativeTokenizer(),
    budget: {
      contextWindowTokens: 120,
      systemTokens: 10,
      toolSchemaTokens: 20,
      responseTokens: 30,
      safetyTokens: 10,
    },
  })

  assert.deepEqual(selection.report.reserved, {
    systemTokens: 10,
    toolSchemaTokens: 20,
    responseTokens: 30,
    safetyTokens: 10,
  })
  assert.equal(selection.report.availableMessageTokens, 50)
  assert.deepEqual(selection.report.estimation, {
    kind: 'token_estimate',
    tokenizerId: 'conservative-utf8',
  })
  assert.equal('usage' in selection.report, false)
  assert.equal('content' in selection.report, false)
  assert.ok(selection.report.pressure >= 0 && selection.report.pressure <= 1)
})

test('checkpoint coverage prevents summarized messages from being selected twice', () => {
  const messages: ProviderMessage[] = [
    { role: 'user', content: 'covered one' },
    { role: 'assistant', content: 'covered two' },
    { role: 'user', content: 'recent three' },
    { role: 'assistant', content: 'recent four' },
  ]
  const selection = selectContextWindow({
    messages,
    checkpoint: {
      id: 'cp-coverage',
      messageStart: 0,
      messageEnd: 2,
      content: 'Summary of the first two messages.',
      digest: `sha256:${'a'.repeat(64)}`,
      estimatedTokens: 10,
      createdAt: '2026-07-28T00:00:00.000Z',
    },
    maxTokens: 1_000,
  })

  assert.deepEqual(selection.messages, messages.slice(2))
  assert.equal(selection.report.coveredOmittedMessages, 2)
  assert.equal(selection.report.uncoveredOmittedMessages, 0)
})

test('iterative semantic compaction retains critical state across two checkpoints', async () => {
  const compaction = new CompactionService({
    tokenizer: new ConservativeTokenizer(),
    retainRecentMessages: 2,
    compactionPolicy: { minimumGain: 0 },
  })
  const firstMessages: ProviderMessage[] = [
    { role: 'user', content: 'Objective: ship the runtime safely.' },
    { role: 'assistant', content: 'Decision: keep the Runtime process boundary.' },
    {
      role: 'tool',
      toolCallId: 'read-1',
      name: 'read',
      content: JSON.stringify({
        ok: true,
        summary: 'read',
        output: { path: 'src/runtime.ts', content: 'implementation' },
      }),
    },
    { role: 'assistant', content: 'TODO: verify the Windows cancellation test.' },
    { role: 'user', content: 'recent request' },
    { role: 'assistant', content: 'recent response' },
  ]
  const first = await compaction.compact({
    sessionId: 's-compact',
    messages: firstMessages,
    plan: {
      objective: 'Ship the runtime safely',
      revision: 1,
      updatedAt: '2026-07-28T00:00:00.000Z',
      steps: [{ id: 'verify', title: 'Run Windows tests', state: 'in_progress' }],
    },
  })
  assert.ok(first)

  const secondMessages = [
    ...firstMessages,
    {
      role: 'tool' as const,
      toolCallId: 'write-1',
      name: 'write',
      content: JSON.stringify({
        ok: true,
        summary: 'wrote',
        output: { path: 'src/runtime.ts', afterBytes: 20 },
      }),
    },
    { role: 'assistant' as const, content: 'Constraint: traces must remain content-free.' },
    { role: 'user' as const, content: 'new recent request' },
    { role: 'assistant' as const, content: 'new recent response' },
  ]
  const second = await compaction.compact({
    sessionId: 's-compact',
    messages: secondMessages,
    previous: first,
  })

  assert.ok(second)
  assert.ok(second!.messageEnd > first!.messageEnd)
  assert.match(second!.content, /Runtime process boundary/)
  assert.match(second!.content, /src\/runtime\.ts/)
  assert.match(second!.content, /Windows cancellation test|Run Windows tests/)
  assert.match(second!.content, /traces must remain content-free/)

  const selected = selectContextWindow({
    messages: secondMessages,
    checkpoint: second,
    maxTokens: 512,
  })
  assert.ok(selected.estimatedTokens <= 512)
  assert.deepEqual(selected.messages, secondMessages.slice(second!.messageEnd))
  assert.equal(selected.report.uncoveredOmittedMessages, 0)
})

test('a replayed model compaction candidate is bounded and falls back with provenance', async () => {
  const messages: ProviderMessage[] = [
    { role: 'user', content: 'Objective: release without losing state.' },
    { role: 'assistant', content: 'Decision: keep deterministic fallback.' },
    { role: 'assistant', content: 'Constraint: summaries must remain bounded.' },
    { role: 'user', content: 'recent request' },
  ]
  const modelCandidate = new ReplayModelSummaryGenerator({
    objective: 'release without losing state',
    decisions: ['semantic decision'],
    constraints: ['x'.repeat(1_000), ...Array.from({ length: 30 }, (_, index) => `c-${index}`)],
    readFiles: [],
    modifiedFiles: [],
    unresolved: ['verify replay fixture'],
    activePlan: [],
  })
  const modelCheckpoint = await new CompactionService({
    generator: modelCandidate,
    retainRecentMessages: 1,
    compactionPolicy: { minimumGain: 0 },
  }).compact({ sessionId: 'model-candidate', messages })

  assert.ok(modelCheckpoint)
  assert.deepEqual(modelCheckpoint.provenance, {
    schemaVersion: 1,
    generator: {
      kind: 'model',
      id: 'replay-model-summary-v1',
      provider: 'replay',
      model: 'summary-fixture',
    },
  })
  assert.equal(modelCheckpoint.summary?.constraints.length, 24)
  assert.ok(modelCheckpoint.summary!.constraints.every((value) => value.length <= 240))

  const fallbackCheckpoint = await new CompactionService({
    generator: new FailingModelSummaryGenerator(),
    retainRecentMessages: 1,
    compactionPolicy: { minimumGain: 0 },
  }).compact({ sessionId: 'model-fallback', messages })

  assert.ok(fallbackCheckpoint)
  assert.deepEqual(fallbackCheckpoint.provenance, {
    schemaVersion: 1,
    generator: { kind: 'deterministic', id: 'praxis-deterministic-v1' },
    fallbackFrom: {
      kind: 'model',
      id: 'failing-model-summary-v1',
      provider: 'replay',
      model: 'failing-fixture',
    },
  })
  assert.match(fallbackCheckpoint.content, /keep deterministic fallback/u)
  assert.match(fallbackCheckpoint.content, /summaries must remain bounded/u)
})

test('Provider semantic compaction uses structured output and reports auxiliary usage', async () => {
  let received: ProviderRequest | undefined
  const summary: CompactionSummary = {
    objective: 'finish the active task',
    decisions: ['keep exact evidence'],
    constraints: ['do not invent completion'],
    readFiles: ['D:\\praxis\\README.md'],
    modifiedFiles: [],
    unresolved: ['run the final verification'],
    activePlan: ['in_progress: verify'],
  }
  const provider: ChatProvider = {
    id: 'summary-fixture',
    defaultModel: 'summary-model',
    contractVersion: 2,
    capabilities: {
      streaming: { text: true, reasoning: false, usage: true },
      tools: { mode: 'native', parallelCalls: false },
      modalities: { text: true, vision: false, audio: false },
      output: { jsonSchema: true, citations: false },
      limits: { maxContextTokens: 100_000, maxOutputTokens: 4_096 },
    },
    authState: () => ({ status: 'authenticated' }),
    async *stream(request) {
      received = request
      yield { type: 'message_start' }
      yield { type: 'text_start', contentIndex: 0 }
      yield { type: 'text_delta', contentIndex: 0, text: JSON.stringify(summary) }
      yield { type: 'text_end', contentIndex: 0 }
      yield {
        type: 'completed',
        stopReason: 'stop',
        usage: { inputTokens: 120, outputTokens: 30, cacheReadTokens: 10, costUsd: 0.004 },
      }
    },
  }
  const controller = new AbortController()
  const generator = new ProviderCompactionSummaryGenerator(provider, {
    model: provider.defaultModel,
    messages: [],
    tools: [],
    signal: controller.signal,
  })
  const result = await new CompactionService({
    generator,
    retainRecentMessages: 1,
    compactionPolicy: { minimumGain: 0 },
  }).compactDetailed({
    sessionId: 'provider-summary',
    messages: [
      { role: 'user', content: 'Finish the active task and retain evidence.' },
      {
        role: 'assistant',
        content: 'Read evidence first.',
        toolCalls: [{ id: 'read-evidence', name: 'read', input: { path: 'README.md' } }],
      },
      {
        role: 'tool',
        toolCallId: 'read-evidence',
        name: 'read',
        content: '{"ok":true}',
      },
      { role: 'assistant', content: 'Decision: keep exact evidence.' },
      { role: 'user', content: 'Continue.' },
    ],
    signal: controller.signal,
  })

  assert.equal(result.status, 'compacted')
  if (result.status !== 'compacted') return
  assert.equal(received?.responseFormat?.name, 'praxis_compaction_summary')
  assert.equal(received?.tools.length, 0)
  assert.equal(received?.messages.length, 1)
  assert.match(String(received?.messages[0]?.content), /"name":"read"/u)
  assert.deepEqual(result.usage, {
    inputTokens: 120,
    outputTokens: 30,
    cacheReadTokens: 10,
    costUsd: 0.004,
  })
  assert.equal(result.checkpoint.provenance?.generator.kind, 'model')
  assert.match(result.checkpoint.content, /Finish the active task and retain evidence/u)
})

class ReplayModelSummaryGenerator implements CompactionSummaryGenerator {
  readonly identity = {
    kind: 'model' as const,
    id: 'replay-model-summary-v1',
    provider: 'replay',
    model: 'summary-fixture',
  }

  constructor(private readonly summary: CompactionSummary) {}

  async generate(_input: CompactionGeneratorInput): Promise<CompactionSummary> {
    return structuredClone(this.summary)
  }
}

class FailingModelSummaryGenerator implements CompactionSummaryGenerator {
  readonly identity = {
    kind: 'model' as const,
    id: 'failing-model-summary-v1',
    provider: 'replay',
    model: 'failing-fixture',
  }

  async generate(_input: CompactionGeneratorInput): Promise<CompactionSummary> {
    throw new Error('fixture model failure')
  }
}
