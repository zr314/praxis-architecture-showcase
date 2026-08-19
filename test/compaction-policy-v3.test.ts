import assert from 'node:assert/strict'
import test from 'node:test'
import type { CompactionSummary, ProviderMessage } from '@praxis/core-sdk'
import {
  type CompactionGeneratorInput,
  CompactionService,
  type CompactionSummaryGenerator,
  compactionPolicy,
  contextPolicy,
  DeterministicSummaryGenerator,
  shouldCompactAtThreshold,
  type TokenizerAdapter,
  thresholdCompactionRearmed,
} from '../apps/runtime/src/memory/index.js'

test('ContextPolicy and CompactionPolicy expose bounded explicit configuration', () => {
  assert.deepEqual(
    contextPolicy({
      threshold: 0.8,
      compactionScope: 'total',
      maxUncompactedTokens: 32_768,
      hysteresis: 0.15,
      reserve: 0.08,
      keepRecentTokens: 96,
    }),
    {
      threshold: 0.8,
      compactionScope: 'total',
      maxUncompactedTokens: 32_768,
      hysteresis: 0.15,
      reserve: 0.08,
      keepRecentTokens: 96,
    },
  )
  assert.deepEqual(
    compactionPolicy({
      minimumGain: 12,
      maxSummaryTokens: 80,
      overflowRetryLimit: 0,
      generatorDeadlineMs: 50,
      generatorMaxCostUsd: 0.01,
    }),
    {
      minimumGain: 12,
      maxSummaryTokens: 80,
      overflowRetryLimit: 0,
      generatorDeadlineMs: 50,
      generatorMaxCostUsd: 0.01,
    },
  )
  assert.throws(() => contextPolicy({ hysteresis: 0.9 }), hasCode('COMPACTION_POLICY_INVALID'))
  assert.throws(
    () => contextPolicy({ maxUncompactedTokens: 0 }),
    hasCode('COMPACTION_POLICY_INVALID'),
  )
  assert.throws(() => contextPolicy({ keepRecentTokens: 0 }), hasCode('COMPACTION_POLICY_INVALID'))
  assert.throws(
    () => compactionPolicy({ overflowRetryLimit: 2 as 1 }),
    hasCode('COMPACTION_POLICY_INVALID'),
  )
  const policy = contextPolicy({ threshold: 0.8, hysteresis: 0.15 })
  assert.equal(
    shouldCompactAtThreshold(
      { pressure: 0.81, selectedTokens: 10, checkpointTokens: 0, uncoveredOmittedMessages: 0 },
      policy,
    ),
    true,
  )
  assert.equal(
    thresholdCompactionRearmed(
      { pressure: 0.7, selectedTokens: 10, checkpointTokens: 0, uncoveredOmittedMessages: 0 },
      policy,
    ),
    false,
  )
  assert.equal(
    thresholdCompactionRearmed(
      { pressure: 0.6, selectedTokens: 10, checkpointTokens: 0, uncoveredOmittedMessages: 0 },
      policy,
    ),
    true,
  )
  const softCeiling = contextPolicy({
    threshold: 0.99,
    maxUncompactedTokens: 100,
    hysteresis: 0.1,
  })
  assert.equal(
    shouldCompactAtThreshold(
      { pressure: 0.1, selectedTokens: 100, checkpointTokens: 0, uncoveredOmittedMessages: 0 },
      softCeiling,
    ),
    true,
  )
  assert.equal(
    shouldCompactAtThreshold(
      {
        pressure: 0.1,
        selectedTokens: 40,
        uncompactedTokens: 101,
        checkpointTokens: 0,
        uncoveredOmittedMessages: 0,
      },
      softCeiling,
    ),
    true,
    'lossy prompt editing must not hide canonical replay pressure',
  )
  assert.equal(
    thresholdCompactionRearmed(
      { pressure: 0.1, selectedTokens: 91, checkpointTokens: 0, uncoveredOmittedMessages: 0 },
      softCeiling,
    ),
    false,
  )
  assert.equal(
    thresholdCompactionRearmed(
      { pressure: 0.1, selectedTokens: 90, checkpointTokens: 0, uncoveredOmittedMessages: 0 },
      softCeiling,
    ),
    true,
  )
  assert.equal(
    thresholdCompactionRearmed(
      {
        pressure: 0.1,
        selectedTokens: 20,
        uncompactedTokens: 91,
        checkpointTokens: 0,
        uncoveredOmittedMessages: 0,
      },
      softCeiling,
    ),
    false,
  )
  const incremental = contextPolicy({
    threshold: 0.99,
    maxUncompactedTokens: 100,
    hysteresis: 0.1,
  })
  assert.equal(
    shouldCompactAtThreshold(
      { pressure: 0.2, selectedTokens: 150, checkpointTokens: 75, uncoveredOmittedMessages: 0 },
      incremental,
    ),
    false,
  )
  assert.equal(
    shouldCompactAtThreshold(
      { pressure: 0.2, selectedTokens: 175, checkpointTokens: 75, uncoveredOmittedMessages: 0 },
      incremental,
    ),
    true,
  )
  assert.throws(
    () => contextPolicy({ compactionScope: 'invalid' as 'total' }),
    hasCode('COMPACTION_POLICY_INVALID'),
  )
})

test('token cuts retain complete turns, tool call/results, Skills, and the unfinished suffix', async () => {
  const tokenizer = new CharacterTokenizer()
  const messages = boundaryMessages()
  const latestOnly = await new CompactionService({
    tokenizer,
    contextPolicy: { keepRecentTokens: 5 },
    compactionPolicy: { minimumGain: 0, maxSummaryTokens: 200 },
  }).compact({ sessionId: 'session-parent', messages })

  assert.ok(latestOnly)
  assert.equal(latestOnly.messageEnd, 6)
  assert.equal(latestOnly.trust, 'low')
  assert.deepEqual(latestOnly.scope, { kind: 'parent', sessionId: 'session-parent' })
  assert.ok((latestOnly.estimatedGainTokens ?? -1) >= 0)
  assert.equal(latestOnly.provenance?.generator.kind, 'deterministic')

  const keepSkillTurn = await new CompactionService({
    tokenizer,
    contextPolicy: { keepRecentTokens: 50 },
    compactionPolicy: { minimumGain: 0, maxSummaryTokens: 200 },
  }).compact({ sessionId: 'session-child', scope: 'child', messages })
  assert.ok(keepSkillTurn)
  assert.equal(keepSkillTurn.messageEnd, 4)
  assert.deepEqual(keepSkillTurn.scope, { kind: 'child', sessionId: 'session-child' })

  const completedToolRound = await new CompactionService({
    tokenizer,
    retainRecentMessages: 2,
    compactionPolicy: { minimumGain: 0, maxSummaryTokens: 200 },
  }).compact({
    sessionId: 'session-tool-round',
    messages: [
      ...messages.slice(0, 3),
      { role: 'assistant', content: 'completed follow-up' },
      { role: 'user', content: 'latest unfinished request' },
    ],
  })
  assert.ok(completedToolRound)
  assert.equal(completedToolRound.messageEnd, 3)

  await assert.rejects(
    new CompactionService({
      tokenizer,
      compactionPolicy: { minimumGain: 0 },
      retainRecentMessages: 1,
    }).compact({ sessionId: 'session-child', scope: 'parent', messages, previous: keepSkillTurn }),
    hasCode('COMPACTION_SCOPE_MISMATCH'),
  )
})

test('model generators are optional and bounded by deadline, cost, schema, and fallback', async () => {
  const messages: ProviderMessage[] = [
    { role: 'user', content: 'Decision: keep a deterministic fallback.' },
    { role: 'assistant', content: 'Constraint: generator output is low trust.' },
    { role: 'user', content: 'recent unfinished turn' },
  ]
  const generators: CompactionSummaryGenerator[] = [
    new DeadlineGenerator(),
    new CostlyGenerator(),
    new InvalidSchemaGenerator(),
  ]
  for (const generator of generators) {
    const checkpoint = await new CompactionService({
      generator,
      retainRecentMessages: 1,
      compactionPolicy: {
        minimumGain: 0,
        maxSummaryTokens: 32,
        generatorDeadlineMs: 10,
        generatorMaxCostUsd: 0.01,
      },
    }).compact({ sessionId: `session-${generator.identity.id}`, messages })
    assert.ok(checkpoint)
    assert.equal(checkpoint.trust, 'low')
    assert.deepEqual(checkpoint.provenance, {
      schemaVersion: 1,
      generator: { kind: 'deterministic', id: 'praxis-deterministic-v1' },
      fallbackFrom: generator.identity,
    })
  }

  const oversized = new OversizedGenerator()
  const fitted = await new CompactionService({
    generator: oversized,
    retainRecentMessages: 1,
    compactionPolicy: {
      minimumGain: 0,
      maxSummaryTokens: 32,
      generatorDeadlineMs: 10,
      generatorMaxCostUsd: 0.01,
    },
  }).compact({ sessionId: 'session-oversized-model-summary', messages })
  assert.ok(fitted)
  assert.deepEqual(fitted.provenance, {
    schemaVersion: 1,
    generator: oversized.identity,
  })
  assert.ok(fitted.estimatedTokens <= 32)
})

test('token estimates stay diagnostic and never masquerade as Provider billing usage', async () => {
  const checkpoint = await new CompactionService({
    tokenizer: new CharacterTokenizer(),
    retainRecentMessages: 1,
    compactionPolicy: { minimumGain: 0 },
  }).compact({
    sessionId: 'session-estimate',
    messages: [
      { role: 'user', content: 'old turn' },
      { role: 'assistant', content: 'old result' },
      { role: 'user', content: 'recent turn' },
    ],
  })
  assert.ok(checkpoint)
  assert.equal(Number.isSafeInteger(checkpoint.estimatedTokens), true)
  assert.equal(Number.isSafeInteger(checkpoint.estimatedGainTokens), true)
  assert.equal('usage' in checkpoint, false)
  assert.equal('inputTokens' in checkpoint, false)
  assert.equal('costUsd' in checkpoint, false)

  const noGain = await new CompactionService({
    tokenizer: new CharacterTokenizer(),
    retainRecentMessages: 1,
    compactionPolicy: { minimumGain: 10_000 },
  }).compact({
    sessionId: 'session-no-gain',
    messages: [
      { role: 'user', content: 'old turn' },
      { role: 'assistant', content: 'old result' },
      { role: 'user', content: 'recent turn' },
    ],
  })
  assert.equal(noGain, undefined)
})

test('semantic compaction preserves a non-English active task contract across Tool turns', async () => {
  const task = [
    '你正在验证长会话压缩。必须严格按顺序读取三个文件。',
    '第一步读取 memory 文档，第二步读取 prompt audit，第三步读取 compactionPolicy.ts。',
    '最终回答必须以 COMPACT_OK 开头，并写出 threshold、maxUncompactedTokens、keepRecentTokens。',
    '不得猜测，必须完成三次读取后作答。',
  ].join('\n')
  const messages: ProviderMessage[] = [
    { role: 'user', content: task },
    {
      role: 'assistant',
      content: 'reading first file',
      toolCalls: [{ id: 'read-1', name: 'read', input: { path: 'memory.md' } }],
    },
    { role: 'tool', toolCallId: 'read-1', name: 'read', content: '{"ok":true}' },
    {
      role: 'assistant',
      content: 'reading second file',
      toolCalls: [{ id: 'read-2', name: 'read', input: { path: 'audit.md' } }],
    },
    { role: 'tool', toolCallId: 'read-2', name: 'read', content: '{"ok":true}' },
  ]
  const checkpoint = await new CompactionService({
    tokenizer: new CharacterTokenizer(),
    retainRecentMessages: 2,
    compactionPolicy: { minimumGain: 0, maxSummaryTokens: 1_024 },
  }).compact({ sessionId: 'session-task-contract', messages })

  assert.ok(checkpoint)
  assert.equal(checkpoint.messageEnd, 3)
  assert.equal(checkpoint.summary?.objective, task)
  assert.match(checkpoint.content, /COMPACT_OK/u)
  assert.match(checkpoint.content, /不得猜测/u)

  const modelWithoutObjective: CompactionSummaryGenerator = {
    identity: modelIdentity('drops-objective'),
    async generate() {
      return emptySummary()
    },
  }
  const modelCheckpoint = await new CompactionService({
    generator: modelWithoutObjective,
    tokenizer: new CharacterTokenizer(),
    retainRecentMessages: 2,
    compactionPolicy: { minimumGain: 0, maxSummaryTokens: 1_024 },
  }).compact({ sessionId: 'session-model-task-contract', messages })
  assert.equal(modelCheckpoint?.summary?.objective, task)
})

test('semantic compaction cannot erase Runtime-extracted mutation and rebuild state', async () => {
  const messages: ProviderMessage[] = [
    { role: 'user', content: 'Patch and install the package system-wide.' },
    {
      role: 'assistant',
      content: 'Applying the source fix.',
      toolCalls: [
        {
          id: 'edit-source',
          name: 'edit',
          input: { path: '/app/pkg/source.py', oldText: 'dtype=long', newText: 'dtype=int' },
        },
      ],
    },
    {
      role: 'tool',
      toolCallId: 'edit-source',
      name: 'edit',
      content: JSON.stringify({ ok: true, output: { path: '/app/pkg/source.py' } }),
    },
    {
      role: 'assistant',
      content:
        'The source is fixed. Need to rebuild and verify the system-wide installation before finishing.',
    },
    { role: 'user', content: 'Continue.' },
  ]
  const checkpoint = await new CompactionService({
    generator: {
      identity: modelIdentity('empty-but-valid'),
      async generate(input) {
        assert.ok(input.baseline?.modifiedFiles.includes('/app/pkg/source.py'))
        return emptySummary()
      },
    },
    tokenizer: new CharacterTokenizer(),
    retainRecentMessages: 1,
    compactionPolicy: { minimumGain: 0, maxSummaryTokens: 1_024 },
  }).compact({ sessionId: 'session-runtime-baseline', messages })

  assert.ok(checkpoint?.summary?.modifiedFiles.includes('/app/pkg/source.py'))
  assert.ok(checkpoint?.summary?.unresolved.some((item) => /Need to rebuild/iu.test(item)))
  assert.ok(checkpoint?.summary?.activePlan.some((item) => /rebuild/iu.test(item)))
})

test('semantic compaction cannot promote model guesses into authority or mutation evidence', async () => {
  const task = [
    'Fix the release-only crash.',
    'You shall not modify any file except /app/user.cpp.',
    'There must be no Valgrind leaks.',
  ].join('\n')
  const messages: ProviderMessage[] = [
    { role: 'user', content: task },
    {
      role: 'assistant',
      content:
        'Constraint: perhaps the allocator must never free locale nodes. Need to inspect the binary.',
      toolCalls: [{ id: 'read-user', name: 'read', input: { path: '/app/user.cpp' } }],
    },
    {
      role: 'tool',
      toolCallId: 'read-user',
      name: 'read',
      content: JSON.stringify({ ok: true, output: { path: '/app/user.cpp', content: 'stubs' } }),
    },
    { role: 'user', content: 'Continue.' },
  ]
  const checkpoint = await new CompactionService({
    generator: {
      identity: modelIdentity('hallucinates-authority-and-mutation'),
      async generate() {
        return {
          ...emptySummary(),
          objective: 'Replace the task with a speculative allocator redesign.',
          relevantRefs: ['artifact://invented'],
          constraints: ['Never free locale nodes.'],
          readFiles: ['/root/secret.txt'],
          modifiedFiles: ['/app/user.cpp (read only; not modified yet)'],
          unresolved: ['Need to inspect the binary.'],
          activePlan: ['Inspect the binary.'],
        }
      },
    },
    tokenizer: new CharacterTokenizer(),
    retainRecentMessages: 1,
    compactionPolicy: { minimumGain: 0, maxSummaryTokens: 1_024 },
  }).compact({ sessionId: 'session-field-ownership', messages })

  assert.ok(checkpoint)
  assert.equal(checkpoint.summary?.objective, task)
  assert.deepEqual(checkpoint.summary?.relevantRefs, undefined)
  assert.deepEqual(checkpoint.summary?.readFiles, ['/app/user.cpp'])
  assert.deepEqual(checkpoint.summary?.modifiedFiles, [])
  assert.ok(
    checkpoint.summary?.constraints.includes('You shall not modify any file except /app/user.cpp.'),
  )
  assert.ok(checkpoint.summary?.constraints.includes('There must be no Valgrind leaks.'))
  assert.equal(checkpoint.summary?.constraints.includes('Never free locale nodes.'), false)
  assert.ok(checkpoint.summary?.unresolved.includes('Need to inspect the binary.'))
})

test('summary token fitting preserves the continuation frontier before verbose evidence', async () => {
  const objective = `Install the patched package system-wide and verify it. ${'Detailed contract. '.repeat(90)}`
  const messages: ProviderMessage[] = [
    { role: 'user', content: objective },
    {
      role: 'assistant',
      content: 'Applying the source fix.',
      toolCalls: [
        {
          id: 'edit-source',
          name: 'edit',
          input: { path: '/app/pkg/source.py', oldText: 'dtype=long', newText: 'dtype=int' },
        },
      ],
    },
    {
      role: 'tool',
      toolCallId: 'edit-source',
      name: 'edit',
      content: JSON.stringify({ ok: true, output: { path: '/app/pkg/source.py' } }),
    },
    {
      role: 'assistant',
      content:
        'The source is fixed. Need to rebuild and verify the system-wide installation before finishing.',
    },
    { role: 'user', content: 'Continue.' },
  ]
  const checkpoint = await new CompactionService({
    generator: {
      identity: modelIdentity('verbose-evidence'),
      async generate() {
        return {
          ...emptySummary(),
          objective,
          relevantRefs: Array.from(
            { length: 12 },
            (_, index) => `/app/reference-${index}-${'x'.repeat(80)}`,
          ),
          decisions: Array.from(
            { length: 12 },
            (_, index) => `Historical decision ${index}: ${'detail '.repeat(20)}`,
          ),
          readFiles: Array.from({ length: 12 }, (_, index) => `/app/read-${index}.txt`),
        }
      },
    },
    tokenizer: new CharacterTokenizer(),
    retainRecentMessages: 1,
    compactionPolicy: { minimumGain: 0, maxSummaryTokens: 1_024 },
  }).compact({ sessionId: 'session-frontier-priority', messages })

  assert.ok(checkpoint)
  assert.ok(checkpoint.estimatedTokens <= 1_024)
  assert.ok(checkpoint.summary?.modifiedFiles.includes('/app/pkg/source.py'))
  assert.ok(checkpoint.summary?.unresolved.some((item) => /Need to rebuild/iu.test(item)))
  assert.ok(checkpoint.summary?.activePlan.some((item) => /rebuild/iu.test(item)))
})

test('successful shell source edits contribute paths to the Runtime compaction baseline', async () => {
  const messages: ProviderMessage[] = [
    { role: 'user', content: 'Make the Cython extension compatible and install it.' },
    {
      role: 'assistant',
      content: 'The structured edit is ambiguous.',
      toolCalls: [
        {
          id: 'ambiguous-edit',
          name: 'edit',
          input: {
            path: '/app/pkg/ccomplexity.pyx',
            oldText: 'dtype=np.int',
            newText: 'dtype=np.int64',
          },
        },
      ],
    },
    {
      role: 'tool',
      toolCallId: 'ambiguous-edit',
      name: 'edit',
      content: JSON.stringify({ ok: false, error: { code: 'EDIT_AMBIGUOUS' } }),
    },
    {
      role: 'assistant',
      content: 'Apply the replacement with a shell edit.',
      toolCalls: [
        {
          id: 'shell-edit',
          name: 'shell',
          input: {
            command:
              "cd /app/pkg && sed -i 's/dtype=np\\.int)/dtype=np.int64)/g' src/ccomplexity.pyx",
          },
        },
      ],
    },
    {
      role: 'tool',
      toolCallId: 'shell-edit',
      name: 'shell',
      content: JSON.stringify({
        ok: true,
        output: { stdout: '', stderr: '', exitCode: 0 },
      }),
    },
    {
      role: 'assistant',
      content: 'Run a read-only verification command.',
      toolCalls: [
        {
          id: 'shell-verify',
          name: 'shell',
          input: { command: 'python3 /tmp/test_filter.py 2>&1 | tail -5' },
        },
      ],
    },
    {
      role: 'tool',
      toolCallId: 'shell-verify',
      name: 'shell',
      content: JSON.stringify({
        ok: true,
        output: { stdout: 'tests passed', stderr: '', exitCode: 0 },
      }),
    },
    { role: 'assistant', content: 'Now inspect the remaining compatibility issues.' },
    { role: 'user', content: 'Continue.' },
  ]
  const checkpoint = await new CompactionService({
    generator: {
      identity: modelIdentity('omits-shell-mutation'),
      async generate() {
        return emptySummary()
      },
    },
    tokenizer: new CharacterTokenizer(),
    retainRecentMessages: 1,
    compactionPolicy: { minimumGain: 0, maxSummaryTokens: 1_024 },
  }).compact({ sessionId: 'session-shell-mutation', messages })

  assert.ok(checkpoint)
  assert.equal(checkpoint.summary?.modifiedFiles.includes('/app/pkg/ccomplexity.pyx'), false)
  assert.deepEqual(checkpoint.summary?.modifiedFiles, ['src/ccomplexity.pyx'])
})

test('child compaction extracts the real task contract from its context packet', async () => {
  const packet = {
    schemaVersion: 1,
    objective: 'Audit the workflow implementation and return evidence.',
    constraints: ['Stay inside the declared workspace.'],
    prohibitions: ['Do not spawn descendants.'],
    workspace: { access: 'read_only', root: 'D:\\praxis' },
    step: {
      instructions: 'Inspect at least eight files.\nReturn numbered conclusions with exact paths.',
    },
    successCriteria: [
      { id: 'audit.files', description: 'At least eight distinct files are cited.' },
    ],
    relevantRefs: [
      {
        kind: 'result',
        ref: `artifact://artifact-${'a'.repeat(64)}`,
        digest: `sha256:${'a'.repeat(64)}`,
      },
      {
        kind: 'result',
        ref: `artifact://artifact-${'b'.repeat(64)}`,
        digest: `sha256:${'b'.repeat(64)}`,
      },
    ],
  }
  const bootstrap = [
    'Execute the bounded task described by the Praxis context packet.',
    '--- PRAXIS_CONTEXT_PACKET_V1 ---',
    JSON.stringify(packet),
    '--- END_PRAXIS_CONTEXT_PACKET_V1 ---',
  ].join('\n')
  const checkpoint = await new CompactionService({
    tokenizer: new CharacterTokenizer(),
    retainRecentMessages: 1,
    compactionPolicy: { minimumGain: 0, maxSummaryTokens: 2_048 },
  }).compact({
    sessionId: 'session-child-packet',
    scope: 'child',
    messages: [
      { role: 'user', content: bootstrap },
      { role: 'assistant', content: 'Beginning the audit.' },
      { role: 'user', content: 'Continue.' },
    ],
  })

  assert.equal(checkpoint?.summary?.objective, packet.objective)
  assert.ok(checkpoint?.summary?.constraints.includes('Workspace access: read_only'))
  assert.ok(checkpoint?.summary?.constraints.includes('Do not spawn descendants.'))
  assert.ok(checkpoint?.summary?.activePlan.some((item) => item.includes('pending: audit.files')))
  assert.deepEqual(
    checkpoint?.summary?.relevantRefs,
    packet.relevantRefs.map(({ ref }) => ref),
  )

  const modelCheckpoint = await new CompactionService({
    generator: {
      identity: modelIdentity('drops-child-contract'),
      async generate() {
        return emptySummary()
      },
    },
    tokenizer: new CharacterTokenizer(),
    retainRecentMessages: 1,
    compactionPolicy: { minimumGain: 0, maxSummaryTokens: 2_048 },
  }).compact({
    sessionId: 'session-child-packet-model',
    scope: 'child',
    messages: [
      { role: 'user', content: bootstrap },
      { role: 'assistant', content: 'Beginning the audit.' },
      { role: 'user', content: 'Continue.' },
    ],
  })
  assert.equal(modelCheckpoint?.summary?.objective, packet.objective)
  assert.deepEqual(
    modelCheckpoint?.summary?.relevantRefs,
    packet.relevantRefs.map(({ ref }) => ref),
  )
})

test('manual compaction reports no-range, low-gain, bounded focus, and cancellation distinctly', async () => {
  const messages: ProviderMessage[] = [
    { role: 'user', content: 'Decision: retain the cancellation boundary.' },
    { role: 'assistant', content: 'Constraint: do not persist raw focus metadata.' },
    { role: 'user', content: 'recent unfinished turn' },
  ]
  const noRange = await new CompactionService({ retainRecentMessages: 1 }).compactDetailed({
    sessionId: 'session-no-range',
    messages: [],
  })
  assert.deepEqual(noRange, { status: 'no_range', previousEnd: 0, candidateEnd: 0 })

  const manualShortHistory = await new CompactionService({
    tokenizer: new CharacterTokenizer(),
    contextPolicy: { keepRecentTokens: 8_192 },
    compactionPolicy: { minimumGain: 0 },
  }).compactDetailed({
    sessionId: 'session-manual-short-history',
    messages,
    reason: 'manual',
  })
  assert.equal(manualShortHistory.status, 'compacted')
  assert.equal(manualShortHistory.checkpoint?.messageEnd, 2)

  const lowGain = await new CompactionService({
    tokenizer: new CharacterTokenizer(),
    retainRecentMessages: 1,
    compactionPolicy: { minimumGain: 10_000 },
  }).compactDetailed({ sessionId: 'session-low-gain', messages })
  assert.equal(lowGain.status, 'low_gain')
  if (lowGain.status !== 'low_gain') throw new Error('expected low-gain result')
  assert.equal(lowGain.minimumGainTokens, 10_000)
  assert.equal(Number.isSafeInteger(lowGain.estimatedGainTokens), true)

  let receivedFocus: string | undefined
  const focusGenerator: CompactionSummaryGenerator = {
    identity: modelIdentity('focus-generator'),
    async generate(input) {
      receivedFocus = input.focus
      return emptySummary()
    },
  }
  const focused = await new CompactionService({
    generator: focusGenerator,
    tokenizer: new CharacterTokenizer(),
    retainRecentMessages: 1,
    compactionPolicy: { minimumGain: 0 },
  }).compactDetailed({
    sessionId: 'session-focus',
    messages,
    focus: 'prioritize cancellation evidence',
  })
  assert.equal(focused.status, 'compacted')
  assert.equal(receivedFocus, 'prioritize cancellation evidence')
  const deterministicFocused = await new DeterministicSummaryGenerator().generate({
    messages: [
      { role: 'user', content: 'Decision: retain needle evidence.' },
      {
        role: 'assistant',
        content: Array.from({ length: 30 }, (_, index) => `Decision: filler ${index}.`).join('\n'),
      },
    ],
    focus: 'needle',
  })
  assert.ok(deterministicFocused.decisions.includes('Decision: retain needle evidence.'))
  await assert.rejects(
    new CompactionService().compactDetailed({
      sessionId: 'session-focus-invalid',
      messages,
      focus: 'x'.repeat(1_025),
    }),
    hasCode('COMPACTION_FOCUS_INVALID'),
  )

  let markStarted: (() => void) | undefined
  const started = new Promise<void>((resolve) => {
    markStarted = resolve
  })
  const cancellable: CompactionSummaryGenerator = {
    identity: modelIdentity('cancellable-generator'),
    async generate(input) {
      markStarted?.()
      return new Promise<CompactionSummary>((_resolve, reject) => {
        input.signal?.addEventListener('abort', () => reject(new Error('cancelled')), {
          once: true,
        })
      })
    },
  }
  const controller = new AbortController()
  const cancelled = new CompactionService({
    generator: cancellable,
    retainRecentMessages: 1,
  }).compactDetailed({
    sessionId: 'session-cancelled',
    messages,
    signal: controller.signal,
  })
  await started
  controller.abort()
  await assert.rejects(cancelled, hasCode('COMPACTION_CANCELLED'))
})

class CharacterTokenizer implements TokenizerAdapter {
  readonly id = 'character-fixture'

  countText(value: string): number {
    return value.length
  }

  countMessage(message: ProviderMessage): number {
    return this.countText(
      typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
    )
  }
}

class DeadlineGenerator implements CompactionSummaryGenerator {
  readonly identity = modelIdentity('deadline-generator')

  async generate(input: CompactionGeneratorInput): Promise<CompactionSummary> {
    return new Promise((_resolve, reject) => {
      input.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    })
  }
}

class CostlyGenerator implements CompactionSummaryGenerator {
  readonly identity = modelIdentity('costly-generator')

  async generate() {
    return { summary: emptySummary(), usage: { inputTokens: 4, outputTokens: 2, costUsd: 1 } }
  }
}

class InvalidSchemaGenerator implements CompactionSummaryGenerator {
  readonly identity = modelIdentity('invalid-schema-generator')

  async generate(): Promise<CompactionSummary> {
    return { decisions: [] } as unknown as CompactionSummary
  }
}

class OversizedGenerator implements CompactionSummaryGenerator {
  readonly identity = modelIdentity('oversized-generator')

  async generate(): Promise<CompactionSummary> {
    return {
      ...emptySummary(),
      decisions: Array.from({ length: 12 }, (_, index) => `${index}:${'x'.repeat(240)}`),
    }
  }
}

function modelIdentity(id: string) {
  return {
    kind: 'model' as const,
    id,
    provider: 'fixture',
    model: 'fixture-summary',
  }
}

function emptySummary(): CompactionSummary {
  return {
    decisions: [],
    constraints: [],
    readFiles: [],
    modifiedFiles: [],
    unresolved: [],
    activePlan: [],
  }
}

function boundaryMessages(): ProviderMessage[] {
  return [
    { role: 'user', content: 'old objective' },
    {
      role: 'assistant',
      content: 'calling tool',
      toolCalls: [{ id: 'tool-1', name: 'read', input: { path: 'README.md' } }],
    },
    { role: 'tool', toolCallId: 'tool-1', name: 'read', content: '{"ok":true}' },
    { role: 'assistant', content: 'tool completed' },
    {
      role: 'user',
      content: 'invoke bounded skill',
      skillInvocation: {
        type: 'skill_invocation',
        version: 1,
        capabilityId: 'fixture-skill',
        origin: 'fixture://skill',
        digest: `sha256:${'a'.repeat(64)}`,
        arguments: '',
        content: 'low-trust skill content',
      },
    },
    { role: 'assistant', content: 'skill completed' },
    { role: 'user', content: 'latest unfinished request' },
  ]
}

function hasCode(code: string) {
  return (error: unknown) =>
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code
}
