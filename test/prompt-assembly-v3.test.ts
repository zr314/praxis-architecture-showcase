import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  createPromptEnvelope,
  promptDigest,
  validatePromptEnvelope,
  type PromptEnvelope,
  type ProviderMessage,
  type SessionProjectionV3,
  type SystemPromptBuild,
} from '@praxis/core-sdk'
import { DeterministicTestTokenizer } from '../apps/runtime/src/memory/index.js'
import {
  compatibilityContextView,
  durablePromptMessage,
  durableSensitiveMessage,
  journalContextView,
  PromptAssembler,
  promptCapabilitySnapshot,
} from '../apps/runtime/src/prompt/index.js'
import { SessionService } from '../apps/runtime/src/session/index.js'
import { JsonlRepository } from '../apps/runtime/src/session-db/index.js'

const SECRET = 'sensitive-command-argument-7f12'
const TOOL = {
  name: 'inspect',
  description: 'Inspect a bounded target.',
  parameters: { type: 'object', additionalProperties: false },
}
const SYSTEM_PROMPT: SystemPromptBuild = {
  instructions: 'Trusted policy that must not appear in a manifest.',
  contextMessages: [{ role: 'user', content: 'low-trust project context' }],
  manifest: {
    estimatedTokens: 12,
    maxTokens: 128,
    program: {
      variant: 'baseline-v1',
      trustedInstructions: {
        id: 'praxis.trusted-instructions',
        version: 'test-v1',
        owner: 'runtime',
        blockCount: 1,
        digest: promptDigest('Trusted policy that must not appear in a manifest.'),
        estimatedTokens: 12,
        componentIds: ['runtime-policy'],
      },
    },
    sections: [
      {
        id: 'runtime-policy',
        source: 'builtin',
        order: 0,
        cacheScope: 'request',
        characters: 48,
        estimatedTokens: 12,
        included: true,
        digest: promptDigest('Trusted policy that must not appear in a manifest.'),
      },
    ],
  },
}

test('PromptEnvelope normalizes text, skill, and future template inputs with strict trust and persistence metadata', () => {
  const ordinary = createPromptEnvelope({
    id: 'prompt-ordinary',
    source: 'user_text',
    effectiveText: 'Inspect the repository',
    rawInput: 'Inspect the repository',
  })
  const skillContent = 'Follow the repository review workflow.'
  const skill = createPromptEnvelope({
    id: 'prompt-skill',
    source: 'skill',
    effectiveText: 'Review this request.',
    rawInput: `$review ${SECRET}\nReview this request.`,
    rawInputPersistence: 'none',
    commandInvocationId: 'skill-command-1',
    additionalParts: [
      {
        kind: 'command_arguments',
        trust: 'user',
        persistence: 'digest',
        origin: 'user:skill-arguments',
        digest: promptDigest(SECRET),
        text: SECRET,
      },
      {
        kind: 'skill_invocation',
        trust: 'low',
        persistence: 'plaintext',
        origin: 'project:.agents/skills/review/SKILL.md',
        digest: promptDigest(skillContent),
        text: skillContent,
        ref: 'project/review',
      },
    ],
  })
  const templateText = 'Expanded future prompt template.'
  const template = createPromptEnvelope({
    id: 'prompt-template',
    source: 'prompt_template',
    effectiveText: '/template review',
    additionalParts: [
      {
        kind: 'template_expansion',
        trust: 'low',
        persistence: 'redacted',
        origin: 'template:review',
        digest: promptDigest(templateText),
        text: templateText,
      },
    ],
  })

  assert.equal(ordinary.parts[0]?.trust, 'user')
  assert.deepEqual(
    skill.parts.map(({ kind, trust, persistence }) => ({ kind, trust, persistence })),
    [
      { kind: 'user_input', trust: 'user', persistence: 'plaintext' },
      { kind: 'command_arguments', trust: 'user', persistence: 'digest' },
      { kind: 'skill_invocation', trust: 'low', persistence: 'plaintext' },
    ],
  )
  assert.equal(template.parts[1]?.origin, 'template:review')
  assert.equal(Object.isFrozen(skill.parts), true)
  assert.throws(() => ((skill.parts as PromptEnvelope['parts'] & unknown[])[0] = skill.parts[1]!))

  assert.throws(
    () => validatePromptEnvelope({ ...structuredClone(skill), capabilityGrants: ['filesystem'] }),
    /PROMPT_ENVELOPE_INVALID/,
  )
  const partWithCredential = { ...structuredClone(skill.parts[1]), apiKey: 'forbidden' }
  assert.throws(
    () =>
      validatePromptEnvelope({
        ...structuredClone(skill),
        parts: [structuredClone(skill.parts[0]), partWithCredential],
      }),
    /PROMPT_ENVELOPE_INVALID/,
  )
  assert.throws(
    () => validatePromptEnvelope({ ...structuredClone(skill), digest: promptDigest('tampered') }),
    /PROMPT_ENVELOPE_INVALID/,
  )
})

test('durable prompt projection keeps sensitive raw command input runtime-only across restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-prompt-persistence-'))
  try {
    const repository = new JsonlRepository(root)
    const sessions = new SessionService<{ id: string }>(repository)
    await sessions.initialize()
    const session = await sessions.createSession({
      sessionId: 'sensitive-session',
      cwd: 'D:/workspace',
      provider: 'mock',
      model: 'mock-v1',
    })
    const envelope = createPromptEnvelope({
      id: 'prompt-sensitive',
      source: 'skill',
      effectiveText: `$review ${SECRET}`,
      rawInput: `$review ${SECRET}`,
      rawInputPersistence: 'none',
      userInputPersistence: 'digest',
    })
    const liveMessage: ProviderMessage = {
      role: 'user',
      content: envelope.effectiveText,
      intent: 'prompt',
      trust: 'user',
    }
    await sessions.beginRun(session, 'request-sensitive', { id: 'run-sensitive' }, liveMessage, {
      durableMessage: durablePromptMessage(envelope, 'prompt'),
    })
    assert.equal(session.messages[0]?.content, `$review ${SECRET}`)
    await sessions.finalizeRun(session, 'run-sensitive', {
      memory: session.memory,
      terminal: 'completed',
    })
    assert.equal(String(session.messages[0]?.content).includes(SECRET), false)

    const liveAssistant: ProviderMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: `provider echoed ${SECRET}` }],
    }
    const durableAssistant = durableSensitiveMessage(liveAssistant, [SECRET])
    assert.equal(JSON.stringify(liveAssistant).includes(SECRET), true)
    assert.equal(JSON.stringify(durableAssistant).includes(SECRET), false)
    assert.match(JSON.stringify(durableAssistant), /redacted:sha256:/)
    const shortSecret = durableSensitiveMessage(
      { role: 'assistant', content: [{ type: 'text', text: 'x' }] },
      ['x'],
    )
    assert.equal(Array.isArray(shortSecret.content) && shortSecret.content[0]?.type, 'text')

    const history = await readFile(join(root, 'history', 'sensitive-session.jsonl'), 'utf8')
    assert.equal(history.includes(SECRET), false)
    assert.match(history, /digest only/)

    const resumedService = new SessionService<{ id: string }>(new JsonlRepository(root))
    await resumedService.initialize()
    const resumed = await resumedService.resumeSession('sensitive-session')
    assert.equal(String(resumed.messages[0]?.content).includes(SECRET), false)
    assert.match(String(resumed.messages[0]?.content), /digest only/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('ContextView exposes compatibility and journal checkpoint, range, plan, result, artifact, and omission projections', () => {
  const compatibility = compatibilityContextView({
    sessionId: 'compat-session',
    messages: [{ role: 'user', content: 'recent' }],
    memory: {
      sessionId: 'compat-session',
      checkpoint: {
        id: 'compat-checkpoint',
        trust: 'low',
        messageStart: 0,
        messageEnd: 1,
        content: 'summary',
        digest: promptDigest('summary'),
        estimatedTokens: 2,
        createdAt: '2026-01-01T00:00:00.000Z',
        summary: {
          objective: 'Continue delegated review',
          relevantRefs: [`artifact://artifact-${'a'.repeat(64)}`],
          decisions: [],
          constraints: [],
          readFiles: [],
          modifiedFiles: [],
          unresolved: [],
          activePlan: [],
        },
      },
      plan: {
        objective: 'Finish compatibility work',
        revision: 3,
        updatedAt: '2026-01-01T00:00:00.000Z',
        steps: [{ id: 'step-1', title: 'Execute', state: 'in_progress' }],
      },
    },
  })
  const journal = journalContextView(journalProjection())

  assert.equal(compatibility.authority, 'compatibility_v2')
  assert.deepEqual(compatibility.checkpoint?.range, {
    unit: 'message_index',
    start: 0,
    end: 1,
  })
  assert.deepEqual(compatibility.prerequisiteResultRefs, [`artifact://artifact-${'a'.repeat(64)}`])
  assert.deepEqual(compatibility.artifactRefs, [`artifact-${'a'.repeat(64)}`])
  assert.equal(journal.authority, 'session_journal_v3')
  assert.deepEqual(journal.recentEntryRange, { unit: 'entry_sequence', start: 5, end: 9 })
  assert.equal(journal.plan?.revision, 1)
  assert.deepEqual(journal.plan?.steps[0]?.prerequisiteResultRefs, ['result://child-1'])
  assert.deepEqual(journal.prerequisiteResultRefs, ['result://command-1', 'result://child-1'])
  assert.deepEqual(journal.artifactRefs, ['artifact-1'])
  assert.deepEqual(journal.omission, { entries: 4, messages: 0, reasons: ['checkpoint'] })
})

test('PromptAssembler is shared, content-free, capability-scoped, and preserves identity across fallback reselection', () => {
  const envelope = createPromptEnvelope({
    id: 'prompt-fallback',
    source: 'user_text',
    effectiveText: `Objective containing ${SECRET}`,
    rawInput: `Objective containing ${SECRET}`,
  })
  const view = journalContextView(journalProjection())
  const capability = promptCapabilitySnapshot({
    snapshotId: 'child-bundle-1',
    bundleDigest: promptDigest('signed child bundle'),
    toolCount: 1,
  })
  const assembler = new PromptAssembler()
  const messages: ProviderMessage[] = [
    { role: 'user', content: 'old '.repeat(300) },
    { role: 'assistant', content: 'middle '.repeat(120) },
    { role: 'user', content: 'new request' },
  ]
  const primary = assembler.assemble({
    envelope,
    contextView: view,
    capabilitySnapshot: capability,
    bundleScoped: true,
    target: { provider: 'primary', model: 'large' },
    systemPrompt: SYSTEM_PROMPT,
    messages,
    tools: [TOOL],
    tokenizer: new DeterministicTestTokenizer(),
    budget: budget(2_048),
  })
  const fallback = assembler.assemble({
    envelope,
    contextView: view,
    capabilitySnapshot: capability,
    bundleScoped: true,
    target: { provider: 'fallback', model: 'small' },
    systemPrompt: SYSTEM_PROMPT,
    messages,
    tools: [TOOL],
    tokenizer: new DeterministicTestTokenizer(),
    budget: budget(640),
  })

  assert.ok(primary.messages.length > fallback.messages.length)
  assert.equal(primary.contextMessages[0]?.role, 'user')
  if (primary.contextMessages[0]?.role !== 'user') assert.fail('expected user context message')
  assert.equal(primary.contextMessages[0].trust, 'low')
  assert.match(String(primary.contextMessages[0]?.content), /praxis-context-view/)
  assert.match(String(primary.contextMessages[0]?.content), /result:\/\/child-1/)
  assert.equal(primary.manifest.envelope.digest, fallback.manifest.envelope.digest)
  assert.equal(primary.manifest.context.revision, fallback.manifest.context.revision)
  assert.equal(primary.manifest.context.plan?.revision, fallback.manifest.context.plan?.revision)
  assert.equal(primary.manifest.context.plan?.digest, fallback.manifest.context.plan?.digest)
  assert.equal(primary.manifest.capability.digest, fallback.manifest.capability.digest)
  assert.deepEqual(primary.manifest.target, { provider: 'primary', model: 'large' })
  assert.deepEqual(fallback.manifest.target, { provider: 'fallback', model: 'small' })
  assert.equal(primary.manifest.capability.bundleScoped, true)
  assert.ok(primary.manifest.budget.contextViewTokens > 0)
  assert.notEqual(primary.manifest.budget.selectedTokens, fallback.manifest.budget.selectedTokens)

  const serializedManifest = JSON.stringify(primary.manifest)
  assert.equal(serializedManifest.includes(SECRET), false)
  assert.equal(serializedManifest.includes(SYSTEM_PROMPT.instructions), false)
  assert.equal(serializedManifest.includes('result://child-1'), false)
  assert.equal(serializedManifest.includes('signed child bundle'), false)
})

test('PromptAssembler pins an authenticated Child task contract outside compactable history', () => {
  const pinned: ProviderMessage = {
    role: 'user',
    content:
      '--- PRAXIS_CONTEXT_PACKET_V1 ---\n{"objective":"Review both artifacts","relevantRefs":["artifact://artifact-a"]}\n--- END_PRAXIS_CONTEXT_PACKET_V1 ---',
  }
  const assembled = new PromptAssembler().assemble({
    envelope: createPromptEnvelope({
      id: 'prompt-pinned-child-contract',
      source: 'workflow',
      effectiveText: String(pinned.content),
    }),
    contextView: compatibilityContextView({
      sessionId: 'pinned-child-session',
      messages: [],
      memory: { sessionId: 'pinned-child-session' },
    }),
    capabilitySnapshot: promptCapabilitySnapshot({ snapshotId: 'pinned-child', toolCount: 1 }),
    bundleScoped: true,
    target: { provider: 'fixture', model: 'child' },
    systemPrompt: SYSTEM_PROMPT,
    messages: [pinned, { role: 'assistant', content: 'Work is in progress.' }],
    pinnedContextMessages: [pinned],
    tools: [TOOL],
    tokenizer: new DeterministicTestTokenizer(),
    budget: budget(2_048),
  })

  assert.deepEqual(assembled.contextMessages[0], pinned)
  assert.equal(
    assembled.messages.some((message) => String(message.content) === pinned.content),
    false,
  )
  assert.ok(assembled.manifest.budget.pinnedContextTokens > 0)
})

test('PromptAssembler replays native context only for its exact Provider, model, and instruction binding', () => {
  const envelope = createPromptEnvelope({
    id: 'prompt-native-context',
    source: 'user_text',
    effectiveText: 'Continue.',
  })
  const messages: ProviderMessage[] = [
    { role: 'user', content: 'old user' },
    { role: 'assistant', content: 'old answer' },
    { role: 'user', content: 'new suffix' },
  ]
  const checkpoint = {
    id: 'checkpoint-native',
    trust: 'low' as const,
    messageStart: 0,
    messageEnd: 2,
    content: 'Portable summary.',
    digest: promptDigest('Portable summary.'),
    estimatedTokens: 8,
    createdAt: '2026-01-01T00:00:00.000Z',
    nativeContext: {
      schemaVersion: 1 as const,
      provider: 'primary',
      model: 'large',
      format: 'openai.responses.compact.v1',
      items: [{ type: 'compaction', encrypted_content: 'opaque' }],
      messageStart: 0,
      messageEnd: 2,
      sourceDigest: promptDigest('source'),
      instructionsDigest: promptDigest(SYSTEM_PROMPT.instructions),
      estimatedTokens: 10,
      createdAt: '2026-01-01T00:00:00.000Z',
    },
  }
  const common = {
    envelope,
    contextView: journalContextView(journalProjection()),
    capabilitySnapshot: promptCapabilitySnapshot({ snapshotId: 'native', toolCount: 1 }),
    bundleScoped: false,
    systemPrompt: SYSTEM_PROMPT,
    messages,
    checkpoint,
    tools: [TOOL],
    tokenizer: new DeterministicTestTokenizer(),
    budget: budget(2_048),
  }
  const primary = new PromptAssembler().assemble({
    ...common,
    target: { provider: 'primary', model: 'large' },
  })
  const fallback = new PromptAssembler().assemble({
    ...common,
    target: { provider: 'fallback', model: 'small' },
  })

  assert.equal(primary.report.contextState, 'provider_native')
  assert.equal(primary.nativeContext?.items[0]?.type, 'compaction')
  assert.equal(primary.manifest.context.state.kind, 'provider_native')
  assert.equal('items' in primary.manifest.context.state, false)
  assert.deepEqual(primary.messages, [{ role: 'user', content: 'new suffix' }])
  assert.equal(fallback.report.contextState, 'semantic_checkpoint')
  assert.equal(fallback.nativeContext, undefined)
  assert.equal(fallback.manifest.context.state.kind, 'semantic_checkpoint')
  assert.match(String(fallback.contextMessages.at(-1)?.content), /Portable summary/)
})

test('iron-law-lean-v1 renders Session and checkpoint replay as neutral context', () => {
  const instructions = '# Praxis Trusted Instructions\n\nRuntime boundaries are final.'
  const leanSystem: SystemPromptBuild = {
    instructions,
    contextMessages: [
      { role: 'user', content: '<praxis-context kind="runtime_facts">\n{}\n</praxis-context>' },
    ],
    manifest: {
      estimatedTokens: 20,
      maxTokens: 512,
      sections: [],
      program: {
        variant: 'iron-law-lean-v1',
        trustedInstructions: {
          id: 'praxis.trusted-instructions',
          version: 'test-v1',
          owner: 'runtime',
          blockCount: 1,
          digest: promptDigest(instructions),
          estimatedTokens: 20,
          componentIds: ['praxis.trusted-instructions'],
        },
      },
    },
  }
  const envelope = createPromptEnvelope({
    id: 'prompt-lean',
    source: 'user_text',
    effectiveText: 'Continue the task.',
  })
  const assembled = new PromptAssembler().assemble({
    envelope,
    contextView: journalContextView(journalProjection()),
    capabilitySnapshot: promptCapabilitySnapshot({ snapshotId: 'lean', toolCount: 1 }),
    bundleScoped: false,
    target: { provider: 'fixture', model: 'lean' },
    systemPrompt: leanSystem,
    messages: [],
    checkpoint: {
      id: 'checkpoint-lean',
      trust: 'low',
      messageStart: 0,
      messageEnd: 0,
      content: 'Earlier work was inspected.',
      digest: promptDigest('Earlier work was inspected.'),
      estimatedTokens: 8,
      createdAt: '2026-01-01T00:00:00.000Z',
      skillInvocations: [
        {
          type: 'skill_invocation',
          version: 1,
          capabilityId: 'fixture/review',
          origin: 'fixture',
          digest: promptDigest('skill'),
          arguments: '',
          content: 'Review the bounded change.',
        },
      ],
    },
    tools: [TOOL],
    tokenizer: new DeterministicTestTokenizer(),
    budget: budget(2_048),
  })
  const visibleContext = [...assembled.systemContextMessages, ...assembled.contextMessages]
    .map(({ content }) => String(content))
    .join('\n')

  assert.equal(assembled.manifest.program.variant, 'iron-law-lean-v1')
  assert.match(visibleContext, /kind="session_view"/u)
  assert.match(visibleContext, /kind="session_checkpoint"/u)
  assert.match(visibleContext, /kind="skill_invocation_replay"/u)
  assert.doesNotMatch(
    visibleContext,
    /system-reminder|low-trust|untrusted guidance|high-trust|low confidence/iu,
  )
})

function budget(contextWindowTokens: number) {
  return {
    contextWindowTokens,
    systemTokens: 12,
    toolSchemaTokens: 12,
    responseTokens: 64,
    safetyTokens: 32,
  }
}

function journalProjection(): SessionProjectionV3 {
  const timestamp = '2026-01-01T00:00:00.000Z'
  return {
    snapshot: {
      schemaVersion: 3,
      sessionId: 'journal-session',
      sequence: 9,
      revision: 4,
      lifecycle: 'open',
      cwd: 'D:/workspace',
      provider: 'fixture',
      model: 'fixture-model',
      name: 'Journal session',
      labels: [],
      activeLeafId: 'journal-session',
      messages: [],
      runs: [],
      commandIds: ['command-1'],
      skillInvocationIds: [],
      permissionRequestIds: [],
      usage: { turns: 0, toolCalls: 0, subagents: 0 },
      checkpointId: 'checkpoint-1',
      artifactIds: ['artifact-1'],
    },
    catalog: {
      sessionId: 'journal-session',
      name: 'Journal session',
      workspace: 'D:/workspace',
      provider: 'fixture',
      model: 'fixture-model',
      lifecycle: 'open',
      activeLeafId: 'journal-session',
      messageCount: 0,
      updatedAt: timestamp,
      revision: 4,
    },
    contextView: {
      sessionId: 'journal-session',
      revision: 4,
      checkpointId: 'checkpoint-1',
      recentEntryRange: { startSequence: 5, endSequence: 9 },
      resultRefs: ['result://command-1', 'result://child-1'],
      artifactIds: ['artifact-1'],
      omittedEntries: 4,
    },
    checkpoint: {
      checkpointId: 'checkpoint-1',
      entryId: 'entry-5',
      createdAt: timestamp,
      coveredRange: { startSequence: 1, endSequence: 4 },
      retainedStartSequence: 5,
      summary: {
        schemaVersion: 1,
        trust: 'low',
        objective: 'Complete journal work',
        decisions: [],
        constraints: [],
        readFiles: [],
        modifiedFiles: [],
        unresolved: [],
        activePlan: [],
      },
      provenance: {
        schemaVersion: 1,
        generator: { kind: 'deterministic', id: 'fixture-v1' },
      },
      summaryDigest: promptDigest('checkpoint summary'),
      summaryTokens: 8,
      reason: 'threshold',
    },
    planGraph: {
      schemaVersion: 1,
      planId: 'plan-1',
      revision: 1,
      objective: 'Complete journal work',
      state: 'running',
      readyStepIds: [],
      steps: [
        {
          stepId: 'step-1',
          title: 'Execute child',
          order: 0,
          state: 'running',
          dependencies: [],
          access: { mode: 'read_only', paths: ['.'] },
          capabilities: [],
          conflictKeys: [],
          criteria: [{ criterionId: 'criterion-1', kind: 'rule', description: 'Fixture passes.' }],
          budget: {
            maxTurns: 1,
            maxToolCalls: 1,
            maxChildRuns: 0,
            maxParallelChildren: 0,
            maxDepth: 0,
          },
          maxAttempts: 1,
          attemptIds: ['attempt-1'],
          attempts: [
            {
              attemptId: 'attempt-1',
              ordinal: 1,
              state: 'verified',
              childRunId: 'child-1',
              resultRef: 'result://child-1',
              resultDigest: promptDigest('child result'),
              verificationRef: 'journal://verification/verification-1',
              verifications: [
                {
                  verificationId: 'verification-1',
                  verifier: 'rule',
                  status: 'passed',
                  evidenceRefs: [],
                },
              ],
            },
          ],
        },
      ],
    },
  }
}
