import assert from 'node:assert/strict'
import test from 'node:test'
import {
  reduceSessionEntriesV3,
  sessionCompactionSummaryDigestV3,
  validateSessionEntryV3,
  type SessionEntryV3,
} from '@praxis/core-sdk'

const DIGEST = `sha256:${'a'.repeat(64)}`
const COMPACTION_SUMMARY = {
  schemaVersion: 1 as const,
  trust: 'low' as const,
  objective: 'Complete the fixture',
  decisions: ['Use the journal'],
  constraints: ['Retain original entries'],
  readFiles: [],
  modifiedFiles: [],
  unresolved: [],
  activePlan: [],
}
const SUMMARY_DIGEST = sessionCompactionSummaryDigestV3(COMPACTION_SUMMARY)
const PROVENANCE = {
  schemaVersion: 1 as const,
  generator: { kind: 'deterministic' as const, id: 'fixture-v1' },
}
const STEP_DEFINITION = {
  dependencies: [] as string[],
  access: { mode: 'read_only' as const, paths: ['.'] },
  capabilities: ['fixture.read'],
  conflictKeys: [],
  criteria: [{ criterionId: 'criterion-1', kind: 'rule' as const, description: 'Fixture passes.' }],
  budget: {
    maxTurns: 1,
    maxToolCalls: 1,
    maxChildRuns: 0,
    maxParallelChildren: 0,
    maxDepth: 0,
  },
  maxAttempts: 1,
}

test('SessionEntryV3 validates a bounded, immutable, versioned envelope', () => {
  const input = entry(1, 'session.created', {
    cwd: 'D:/workspace',
    provider: 'fixture',
    model: 'fixture-model',
    name: 'Fixture session',
    labels: ['unit'],
  })
  const validated = validateSessionEntryV3(input)
  if (validated.type !== 'session.created') assert.fail('expected session.created')

  ;(input.data as { labels: string[] }).labels.push('mutated-after-validation')
  assert.deepEqual(validated.data.labels, ['unit'])
  assert.equal(Object.isFrozen(validated), true)
  assert.equal(Object.isFrozen(validated.data), true)
  assert.throws(() => (validated.data.labels as string[]).push('forbidden'), TypeError)

  assert.throws(
    () => validateSessionEntryV3({ ...input, schemaVersion: 4 }),
    hasCode('SESSION_ENTRY_VERSION_UNSUPPORTED'),
  )
  assert.throws(
    () => validateSessionEntryV3({ ...input, unexpected: true }),
    hasCode('SESSION_ENTRY_INVALID'),
  )
  // The whole journal event has no byte ceiling; long message bodies remain
  // durable while structural and collection-shape validation stays enforced.
  assert.doesNotThrow(() =>
    validateSessionEntryV3(
      entry(2, 'message.committed', {
        messageId: 'message-large',
        message: { role: 'user', content: 'x'.repeat(1_100_000) },
      }),
    ),
  )
  assert.doesNotThrow(() =>
    validateSessionEntryV3(
      entry(2, 'message.committed', {
        messageId: 'message-wide-provider-output',
        message: {
          role: 'assistant',
          content: [{ type: 'reasoning', text: 'x'.repeat(128 * 1_024) }],
        },
      }),
    ),
  )
  assert.throws(
    () => validateSessionEntryV3(entry(2, 'unknown.entry', {})),
    hasCode('SESSION_ENTRY_INVALID'),
  )
  assert.throws(
    () =>
      validateSessionEntryV3(
        entry(
          2,
          'message.committed',
          {
            messageId: 'message-invalid',
            message: { role: 'user', content: 'hello', secret: 'not-a-message-field' },
          },
          { correlation: { traceId: 'trace-invalid-message' } },
        ),
      ),
    hasCode('SESSION_ENTRY_INVALID'),
  )
  assert.throws(
    () => validateSessionEntryV3(entry(2, 'session.closed', {}, { correlation: {} })),
    hasCode('SESSION_ENTRY_INVALID'),
  )
  assert.throws(
    () =>
      validateSessionEntryV3(
        entry(2, 'message.committed', {
          messageId: 'message-non-json',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_call', id: 'tool-call-1', name: 'fixture', input: undefined }],
          },
        }),
      ),
    hasCode('SESSION_ENTRY_INVALID'),
  )
  assert.throws(
    () =>
      validateSessionEntryV3(
        entry(2, 'usage.recorded', {
          source: 'provider',
          usage: { inputTokens: 4 },
        }),
      ),
    hasCode('SESSION_ENTRY_INVALID'),
  )
  assert.throws(
    () =>
      validateSessionEntryV3(
        entry(2, 'plan.created', {
          planId: 'plan-legacy-sparse',
          objective: 'Sparse V3 plan entries are not accepted.',
          state: 'draft',
        }),
      ),
    hasCode('SESSION_ENTRY_INVALID'),
  )
  assert.throws(
    () =>
      validateSessionEntryV3(
        entry(2, 'step.created', {
          planId: 'plan-1',
          planRevision: 1,
          stepId: 'step-legacy-sparse',
          title: 'Missing authority fields',
          order: 0,
          state: 'pending',
        }),
      ),
    hasCode('SESSION_ENTRY_INVALID'),
  )
})

test('one SessionEntryV3 stream deterministically rebuilds every public projection', () => {
  const entries = completeJournal()
  const first = reduceSessionEntriesV3(entries)
  const replayed = reduceSessionEntriesV3(structuredClone(entries))

  assert.deepEqual(replayed, first)
  assert.deepEqual(first.snapshot, {
    schemaVersion: 3,
    sessionId: 'session-root',
    sequence: 27,
    revision: 7,
    lifecycle: 'deleted',
    plannerMode: 'supervisor',
    createdAt: timestamp(1),
    updatedAt: timestamp(27),
    cwd: 'D:/workspace',
    provider: 'fixture',
    model: 'fixture-model-v2',
    name: 'Renamed session',
    labels: ['unit', 'v3'],
    activeLeafId: 'session-child',
    messages: [{ messageId: 'message-1', message: { role: 'user', content: 'execute' } }],
    runs: [
      {
        runId: 'run-root',
        clientRequestId: 'request-1',
        state: 'completed',
        usage: {
          turns: 1,
          toolCalls: 2,
          subagents: 1,
          inputTokens: 7,
          outputTokens: 3,
        },
      },
    ],
    commandIds: ['command-1'],
    skillInvocationIds: ['skill-invocation-1'],
    permissionRequestIds: ['permission-1'],
    usage: {
      turns: 1,
      toolCalls: 2,
      inputTokens: 7,
      outputTokens: 3,
      subagents: 1,
    },
    checkpointId: 'checkpoint-1',
    artifactIds: ['artifact-1'],
  })
  assert.deepEqual(first.catalog, {
    sessionId: 'session-root',
    name: 'Renamed session',
    workspace: 'D:/workspace',
    provider: 'fixture',
    model: 'fixture-model-v2',
    lifecycle: 'deleted',
    activeLeafId: 'session-child',
    messageCount: 1,
    updatedAt: timestamp(27),
    revision: 7,
  })
  assert.deepEqual(first.contextView, {
    sessionId: 'session-root',
    revision: 7,
    checkpointId: 'checkpoint-1',
    recentEntryRange: { startSequence: 11, endSequence: 27 },
    resultRefs: ['result://command-1', 'result://child-run-1', 'evidence://mechanical'],
    artifactIds: ['artifact-1'],
    omittedEntries: 10,
  })
  assert.deepEqual(first.checkpoint, {
    checkpointId: 'checkpoint-1',
    entryId: 'entry-11',
    createdAt: timestamp(11),
    coveredRange: { startSequence: 1, endSequence: 10 },
    retainedStartSequence: 11,
    summary: COMPACTION_SUMMARY,
    provenance: PROVENANCE,
    summaryDigest: SUMMARY_DIGEST,
    summaryTokens: 24,
    reason: 'threshold',
  })
  assert.deepEqual(first.planGraph, {
    schemaVersion: 1,
    planId: 'plan-1',
    revision: 1,
    objective: 'Complete the fixture',
    state: 'succeeded',
    readyStepIds: [],
    steps: [
      {
        stepId: 'step-1',
        title: 'Execute child work',
        order: 0,
        state: 'succeeded',
        ...STEP_DEFINITION,
        attemptIds: ['attempt-1'],
        attempts: [
          {
            attemptId: 'attempt-1',
            ordinal: 1,
            state: 'verified',
            childRunId: 'child-run-1',
            resultRef: 'result://child-run-1',
            resultDigest: DIGEST,
            verificationRef: 'journal://verification/verification-1',
            verifications: [
              {
                verificationId: 'verification-1',
                verifier: 'mechanical',
                status: 'passed',
                evidenceRefs: ['evidence://mechanical'],
                code: 'MECHANICAL_VERIFICATION_PASSED',
                retryable: false,
              },
            ],
          },
        ],
      },
    ],
  })
  assert.equal(first.compactPlan, undefined)
  assert.equal(Object.isFrozen(first), true)
  assert.equal(Object.isFrozen(first.planGraph?.steps[0]?.attempts[0]), true)
})

test('Supervisor planner generation provenance is durable without synthesizing CompactPlan', () => {
  const projection = reduceSessionEntriesV3([
    entry(1, 'session.created', {
      cwd: 'D:/workspace',
      provider: 'kimi',
      model: 'kimi-k3',
      name: 'Supervisor session',
      labels: [],
      plannerMode: 'supervisor',
    }),
    entry(2, 'run.started', { clientRequestId: 'request-plan' }, { runId: 'run-plan' }),
    entry(
      3,
      'planner.generation_recorded',
      {
        phase: 'initial',
        generatorId: 'kimi/kimi-k3',
        source: 'model',
        status: 'failed',
        fallbackUsed: false,
        failureCode: 'PLAN_GENERATOR_PROVIDER_FAILED',
      },
      { runId: 'run-plan', correlation: { parentRunId: 'run-plan' } },
    ),
    entry(
      4,
      'run.terminal',
      {
        status: 'failed',
        usage: {},
        errorCode: 'PLAN_GENERATOR_PROVIDER_FAILED',
      },
      { runId: 'run-plan' },
    ),
  ])

  assert.deepEqual(projection.plannerGeneration, {
    phase: 'initial',
    generatorId: 'kimi/kimi-k3',
    source: 'model',
    status: 'failed',
    fallbackUsed: false,
    failureCode: 'PLAN_GENERATOR_PROVIDER_FAILED',
    runId: 'run-plan',
    recordedAt: timestamp(3),
  })
  assert.equal(projection.compactPlan, undefined)
  assert.equal(projection.planGraph, undefined)
})

test('planner generation provenance rejects contradictory fallback and failure state', () => {
  const base = [
    ...createdOnly(),
    entry(2, 'run.started', { clientRequestId: 'request-plan' }, { runId: 'run-plan' }),
  ]
  assert.throws(
    () =>
      validateSessionEntryV3(
        entry(
          3,
          'planner.generation_recorded',
          {
            phase: 'initial',
            generatorId: 'fixture/model',
            source: 'fallback',
            status: 'succeeded',
            fallbackUsed: false,
          },
          { runId: 'run-plan' },
        ),
      ),
    hasCode('SESSION_ENTRY_INVALID'),
  )
  assert.doesNotThrow(() =>
    validateSessionEntryV3(
      entry(
        3,
        'planner.generation_recorded',
        {
          phase: 'replan',
          generatorId: 'fixture/model',
          source: 'fallback',
          status: 'succeeded',
          fallbackUsed: true,
          fallbackFromCode: 'PLAN_GENERATOR_SCHEMA_INVALID',
        },
        { runId: 'run-plan' },
      ),
    ),
  )
  assert.throws(
    () =>
      reduceSessionEntriesV3([
        ...base,
        entry(
          3,
          'planner.generation_recorded',
          {
            phase: 'initial',
            generatorId: 'fixture/model',
            source: 'model',
            status: 'failed',
            fallbackUsed: false,
            failureCode: 'PLAN_GENERATOR_PROVIDER_FAILED',
          },
          { runId: 'another-run' },
        ),
      ]),
    hasCode('SESSION_REDUCER_TRANSITION_INVALID'),
  )
})

test('session lifecycle and fork provenance have explicit reconstruction boundaries', () => {
  const child = reduceSessionEntriesV3([
    entry(
      1,
      'session.created',
      {
        cwd: 'D:/workspace',
        provider: 'fixture',
        model: 'fixture-model',
        name: 'Child',
        labels: [],
        fork: { parentSessionId: 'session-parent', sourceEntryId: 'parent-entry-4' },
      },
      { sessionId: 'session-child' },
    ),
    entry(2, 'session.closed', {}, { sessionId: 'session-child' }),
    entry(
      3,
      'session.metadata_updated',
      { name: 'Archived child' },
      { sessionId: 'session-child' },
    ),
    entry(4, 'session.reopened', {}, { sessionId: 'session-child' }),
  ])

  assert.equal(child.snapshot.lifecycle, 'open')
  assert.equal(child.snapshot.parentSessionId, 'session-parent')
  assert.equal(child.snapshot.sourceEntryId, 'parent-entry-4')
  assert.equal(child.catalog.parentSessionId, 'session-parent')
  assert.equal(child.snapshot.name, 'Archived child')

  const closedMutation = [
    ...createdOnly(),
    entry(2, 'session.closed', {}),
    entry(3, 'message.committed', {
      messageId: 'message-after-close',
      message: { role: 'user', content: 'not accepted' },
    }),
  ]
  assert.throws(
    () => reduceSessionEntriesV3(closedMutation),
    hasCode('SESSION_REDUCER_TRANSITION_INVALID'),
  )

  const afterDelete = [
    ...createdOnly(),
    entry(2, 'session.deleted', { mode: 'tombstone' }),
    entry(3, 'session.reopened', {}),
  ]
  assert.throws(
    () => reduceSessionEntriesV3(afterDelete),
    hasCode('SESSION_REDUCER_TRANSITION_INVALID'),
  )
})

test('the shared reducer rejects corrupt ordering, reused identities, and dangling transitions', async (context) => {
  const cases: Array<readonly [string, unknown[], string]> = [
    ['empty stream', [], 'SESSION_REDUCER_FIRST_ENTRY_INVALID'],
    [
      'first entry is not session.created',
      [entry(1, 'session.closed', {})],
      'SESSION_REDUCER_FIRST_ENTRY_INVALID',
    ],
    [
      'mixed session IDs',
      [...createdOnly(), entry(2, 'session.closed', {}, { sessionId: 'session-other' })],
      'SESSION_REDUCER_SESSION_MISMATCH',
    ],
    [
      'sequence gap',
      [...createdOnly(), entry(3, 'session.closed', {})],
      'SESSION_REDUCER_SEQUENCE_INVALID',
    ],
    [
      'revision jump',
      [...createdOnly(), entry(2, 'session.closed', {}, { revision: 3 })],
      'SESSION_REDUCER_REVISION_INVALID',
    ],
    [
      'timestamp moves backward',
      [...createdOnly(), entry(2, 'session.closed', {}, { timestamp: '2025-12-31T23:59:59.000Z' })],
      'SESSION_REDUCER_TIMESTAMP_INVALID',
    ],
    [
      'entry ID reuse',
      [...createdOnly(), entry(2, 'session.closed', {}, { entryId: 'entry-1' })],
      'SESSION_REDUCER_ID_REUSED',
    ],
    [
      'stable message ID reuse',
      [
        ...createdOnly(),
        entry(2, 'message.committed', {
          messageId: 'message-1',
          message: { role: 'user', content: 'first' },
        }),
        entry(3, 'message.committed', {
          messageId: 'message-1',
          message: { role: 'user', content: 'second' },
        }),
      ],
      'SESSION_REDUCER_ID_REUSED',
    ],
    [
      'terminal without active run',
      [
        ...createdOnly(),
        entry(2, 'run.terminal', { status: 'completed', usage: {} }, { runId: 'run-missing' }),
      ],
      'SESSION_REDUCER_TRANSITION_INVALID',
    ],
    [
      'fork source does not exist',
      [
        ...createdOnly(),
        entry(2, 'session.forked', {
          childSessionId: 'session-child',
          sourceEntryId: 'entry-missing',
        }),
      ],
      'SESSION_REDUCER_TRANSITION_INVALID',
    ],
    [
      'checkpoint covers its own entry',
      [
        ...createdOnly(),
        entry(2, 'compaction.created', {
          checkpointId: 'checkpoint-1',
          coveredStartSequence: 1,
          coveredEndSequence: 2,
          retainedStartSequence: 3,
          summary: COMPACTION_SUMMARY,
          provenance: PROVENANCE,
          summaryDigest: SUMMARY_DIGEST,
          summaryTokens: 24,
          reason: 'threshold',
        }),
      ],
      'SESSION_REDUCER_TRANSITION_INVALID',
    ],
    [
      'step references no plan',
      [
        ...createdOnly(),
        entry(2, 'step.created', {
          planId: 'plan-missing',
          planRevision: 1,
          stepId: 'step-1',
          title: 'Dangling',
          order: 0,
          state: 'pending',
          ...STEP_DEFINITION,
        }),
      ],
      'SESSION_REDUCER_TRANSITION_INVALID',
    ],
  ]

  for (const [name, entries, code] of cases) {
    await context.test(name, () => {
      assert.throws(() => reduceSessionEntriesV3(entries), hasCode(code))
    })
  }
})

function completeJournal(): SessionEntryV3[] {
  return [
    entry(1, 'session.created', {
      cwd: 'D:/workspace',
      provider: 'fixture',
      model: 'fixture-model',
      name: 'Fixture session',
      labels: ['unit'],
      plannerMode: 'supervisor',
    }),
    entry(2, 'session.metadata_updated', {
      name: 'Renamed session',
      labels: ['unit', 'v3'],
      model: 'fixture-model-v2',
    }),
    entry(3, 'message.committed', {
      messageId: 'message-1',
      message: { role: 'user', content: 'execute' },
    }),
    entry(4, 'run.started', { clientRequestId: 'request-1' }, { runId: 'run-root' }),
    entry(
      5,
      'permission.decided',
      {
        requestId: 'permission-1',
        toolCallId: 'tool-call-1',
        tool: 'fixture.read',
        decision: 'allow_once',
        ruleDigest: DIGEST,
      },
      { runId: 'run-root', correlation: { traceId: 'trace-1', toolCallId: 'tool-call-1' } },
    ),
    entry(
      6,
      'skill.invoked',
      {
        invocationId: 'skill-invocation-1',
        invocation: {
          type: 'skill_invocation',
          version: 1,
          capabilityId: 'fixture.skill',
          origin: 'builtin',
          digest: DIGEST,
          arguments: '{}',
          content: 'bounded skill content',
        },
      },
      { runId: 'run-root' },
    ),
    entry(
      7,
      'command.invoked',
      {
        commandId: 'command-1',
        descriptorId: 'fixture.command',
        descriptorDigest: DIGEST,
        persistence: 'digest',
        argumentDigest: DIGEST,
        resultRef: 'result://command-1',
      },
      { runId: 'run-root', correlation: { commandId: 'command-1' } },
    ),
    entry(
      8,
      'usage.recorded',
      {
        source: 'provider',
        usage: { turns: 1, toolCalls: 2, inputTokens: 7, outputTokens: 3, subagents: 1 },
      },
      { runId: 'run-root' },
    ),
    entry(
      9,
      'artifact.referenced',
      {
        owner: 'command',
        artifact: { artifactId: 'artifact-1', digest: DIGEST, mimeType: 'text/plain', bytes: 12 },
      },
      { runId: 'run-root' },
    ),
    entry(
      10,
      'run.terminal',
      { status: 'completed', usage: { inputTokens: 7, outputTokens: 3 } },
      { runId: 'run-root' },
    ),
    entry(11, 'compaction.created', {
      checkpointId: 'checkpoint-1',
      coveredStartSequence: 1,
      coveredEndSequence: 10,
      retainedStartSequence: 11,
      summary: COMPACTION_SUMMARY,
      provenance: PROVENANCE,
      summaryDigest: SUMMARY_DIGEST,
      summaryTokens: 24,
      reason: 'threshold',
    }),
    entry(12, 'plan.created', {
      planId: 'plan-1',
      planRevision: 1,
      objective: 'Complete the fixture',
      state: 'running',
    }),
    entry(13, 'step.created', {
      planId: 'plan-1',
      planRevision: 1,
      stepId: 'step-1',
      title: 'Execute child work',
      order: 0,
      state: 'running',
      ...STEP_DEFINITION,
    }),
    entry(
      14,
      'attempt.created',
      {
        planId: 'plan-1',
        planRevision: 1,
        stepId: 'step-1',
        attemptId: 'attempt-1',
        ordinal: 1,
        state: 'reserved',
        childRunId: 'child-run-1',
      },
      { correlation: planCorrelation('child-run-1') },
    ),
    entry(15, 'attempt.state_changed', {
      planId: 'plan-1',
      planRevision: 1,
      stepId: 'step-1',
      attemptId: 'attempt-1',
      state: 'running',
    }),
    entry(
      16,
      'subagent.result_recorded',
      {
        planId: 'plan-1',
        planRevision: 1,
        stepId: 'step-1',
        attemptId: 'attempt-1',
        childRunId: 'child-run-1',
        resultRef: 'result://child-run-1',
        resultDigest: DIGEST,
        status: 'succeeded',
      },
      { correlation: planCorrelation('child-run-1') },
    ),
    entry(17, 'attempt.execution_completed', {
      planId: 'plan-1',
      planRevision: 1,
      stepId: 'step-1',
      attemptId: 'attempt-1',
      status: 'succeeded',
    }),
    entry(18, 'attempt.state_changed', {
      planId: 'plan-1',
      planRevision: 1,
      stepId: 'step-1',
      attemptId: 'attempt-1',
      state: 'verifying',
    }),
    entry(19, 'step.state_changed', {
      planId: 'plan-1',
      planRevision: 1,
      stepId: 'step-1',
      state: 'verifying',
    }),
    entry(
      20,
      'verification.recorded',
      {
        planId: 'plan-1',
        planRevision: 1,
        stepId: 'step-1',
        attemptId: 'attempt-1',
        verificationId: 'verification-1',
        verifier: 'mechanical',
        status: 'passed',
        evidenceRefs: ['evidence://mechanical'],
        code: 'MECHANICAL_VERIFICATION_PASSED',
        retryable: false,
      },
      { correlation: planCorrelation('child-run-1') },
    ),
    entry(21, 'attempt.state_changed', {
      planId: 'plan-1',
      planRevision: 1,
      stepId: 'step-1',
      attemptId: 'attempt-1',
      state: 'verified',
    }),
    entry(22, 'step.state_changed', {
      planId: 'plan-1',
      planRevision: 1,
      stepId: 'step-1',
      state: 'succeeded',
    }),
    entry(23, 'plan.state_changed', {
      planId: 'plan-1',
      planRevision: 1,
      state: 'succeeded',
    }),
    entry(24, 'session.forked', {
      childSessionId: 'session-child',
      sourceEntryId: 'entry-3',
    }),
    entry(25, 'session.closed', { reason: 'fixture complete' }),
    entry(26, 'session.reopened', { reason: 'retention inspection' }),
    entry(27, 'session.deleted', { mode: 'tombstone', reason: 'fixture cleanup' }),
  ].map((candidate) => validateSessionEntryV3(candidate))
}

function createdOnly(): SessionEntryV3[] {
  return [
    validateSessionEntryV3(
      entry(1, 'session.created', {
        cwd: 'D:/workspace',
        provider: 'fixture',
        model: 'fixture-model',
        name: 'Fixture session',
        labels: [],
      }),
    ),
  ]
}

function entry(
  sequence: number,
  type: string,
  data: Record<string, unknown>,
  overrides: {
    sessionId?: string
    entryId?: string
    revision?: number
    runId?: string
    correlation?: Record<string, string>
    timestamp?: string
  } = {},
): Record<string, unknown> {
  return {
    schemaVersion: 3,
    entryId: overrides.entryId ?? `entry-${sequence}`,
    sessionId: overrides.sessionId ?? 'session-root',
    sequence,
    revision: overrides.revision ?? Math.ceil(sequence / 4),
    timestamp: overrides.timestamp ?? timestamp(sequence),
    type,
    ...(overrides.runId === undefined ? {} : { runId: overrides.runId }),
    ...(overrides.correlation === undefined ? {} : { correlation: overrides.correlation }),
    data,
  }
}

function planCorrelation(childRunId: string): Record<string, string> {
  return {
    traceId: 'trace-1',
    childRunId,
    planId: 'plan-1',
    stepId: 'step-1',
    attemptId: 'attempt-1',
  }
}

function timestamp(sequence: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, sequence)).toISOString()
}

function hasCode(code: string) {
  return (error: unknown) =>
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code
}
