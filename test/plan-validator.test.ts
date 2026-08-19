import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  createSessionCommitV3,
  ReducingSessionJournalV3,
  reduceSessionEntriesV3,
  validateSessionEntryV3,
  type SessionEntryV3,
} from '@praxis/core-sdk'
import {
  initialPlanJournalPayloadsV3,
  PlanValidator,
  type FixedPlanProposalV1,
} from '../apps/runtime/src/planner/planValidator.js'
import { JsonlSessionJournalV3 } from '../apps/runtime/src/session-db/jsonlSessionJournalV3.js'

const DIGEST = `sha256:${'a'.repeat(64)}` as `sha256:${string}`

const OPTIONS = {
  parentBudget: {
    maxTurns: 8,
    maxToolCalls: 10,
    maxTokens: 4_000,
    maxChildRuns: 3,
    maxParallelChildren: 1,
    maxDepth: 1,
    deadlineAt: '2026-09-01T00:00:00.000Z',
  },
  defaultStepBudget: { maxTurns: 2, maxToolCalls: 3, maxTokens: 1_000 },
  accessGrant: { mode: 'read_only' as const, paths: ['.'] },
  allowedCapabilities: ['builtin.read', 'skill.fixture'],
  createId: (kind: 'plan' | 'step' | 'criterion', source: string) =>
    `${kind}-${source.replaceAll(':', '-')}`,
}

test('PlanValidator admits proposal keys but assigns IDs, defaults, grants, and immutable graph state', () => {
  const graph = new PlanValidator(OPTIONS).validate(proposal())

  assert.equal(graph.planId, 'plan-root')
  assert.equal(graph.revision, 1)
  assert.equal(graph.state, 'draft')
  assert.deepEqual(
    graph.steps.map((step) => step.stepId),
    ['step-read', 'step-summarize'],
  )
  assert.deepEqual(graph.steps[1]?.dependencies, ['step-read'])
  assert.deepEqual(graph.steps[0]?.budget, {
    maxTurns: 2,
    maxToolCalls: 3,
    maxTokens: 1_000,
    maxChildRuns: 0,
    maxParallelChildren: 0,
    maxDepth: 0,
    deadlineAt: '2026-09-01T00:00:00.000Z',
  })
  assert.equal(graph.steps[1]?.maxAttempts, 2)
  assert.equal(graph.steps[0]?.criteria[0]?.criterionId, 'criterion-read-1')
  assert.equal(Object.isFrozen(graph), true)
  assert.equal(Object.isFrozen(graph.steps[0]?.criteria), true)
  assert.throws(() => (graph.steps as unknown[]).push({}), TypeError)
})

test('PlanValidator treats isolated process authority between read-only and workspace write', () => {
  const candidate = structuredClone(proposal()) as unknown as {
    steps: Array<{ access: { mode: 'isolated_process'; paths: string[] } }>
  }
  candidate.steps[0]!.access = { mode: 'isolated_process', paths: ['.'] }
  const admitted = new PlanValidator({
    ...OPTIONS,
    accessGrant: { mode: 'workspace_write', paths: ['.'] },
  }).validate(candidate)
  assert.equal(admitted.steps[0]?.access.mode, 'isolated_process')

  assert.throws(
    () => new PlanValidator(OPTIONS).validate(candidate),
    hasCode('PLAN_PROPOSAL_ACCESS_DENIED'),
  )
})

test('PlanValidator fails closed for graph, access, capability, budget, size, and unknown-field violations', () => {
  const validator = new PlanValidator(OPTIONS)
  const cases: Array<readonly [string, (value: Record<string, unknown>) => void, string]> = [
    [
      'missing dependency',
      (value) => (step(value, 1).dependencies = ['missing']),
      'PLAN_PROPOSAL_DEPENDENCY_MISSING',
    ],
    [
      'self dependency',
      (value) => (step(value, 0).dependencies = ['read']),
      'PLAN_PROPOSAL_SELF_DEPENDENCY',
    ],
    ['cycle', (value) => (step(value, 0).dependencies = ['summarize']), 'PLAN_PROPOSAL_CYCLE'],
    [
      'write escalation',
      (value) => (step(value, 0).access = { mode: 'workspace_write', paths: ['src'] }),
      'PLAN_PROPOSAL_ACCESS_DENIED',
    ],
    [
      'path escape',
      (value) => (step(value, 0).access = { mode: 'read_only', paths: ['../secret'] }),
      'PLAN_PROPOSAL_ACCESS_INVALID',
    ],
    [
      'capability escalation',
      (value) => (step(value, 0).capabilities = ['builtin.write']),
      'PLAN_PROPOSAL_CAPABILITY_DENIED',
    ],
    [
      'step budget escalation',
      (value) => (step(value, 0).budget = { maxTurns: 9 }),
      'PLAN_PROPOSAL_BUDGET_EXCEEDED',
    ],
    [
      'cumulative attempts escalation',
      (value) => (step(value, 0).maxAttempts = 2),
      'PLAN_PROPOSAL_CHILD_BUDGET_EXCEEDED',
    ],
    [
      'unknown field',
      (value) => (step(value, 0).modelAssignedId = 'step-model-owned'),
      'PLAN_PROPOSAL_INVALID',
    ],
  ]

  for (const [name, mutate, code] of cases) {
    const candidate = structuredClone(proposal()) as unknown as Record<string, unknown>
    mutate(candidate)
    assert.throws(() => validator.validate(candidate), hasCode(code), name)
  }
  assert.throws(
    () => validator.validate({ objective: 'x'.repeat(300_000), steps: [] }),
    hasCode('PLAN_PROPOSAL_OVERSIZED'),
  )
})

test('PlanValidator denies criterion kinds that the product admission policy cannot execute', () => {
  const validator = new PlanValidator({
    ...OPTIONS,
    allowedCriterionKinds: ['schema', 'file', 'digest', 'rule', 'semantic'],
  })
  const candidate = structuredClone(proposal()) as unknown as {
    steps: Array<{ criteria: FixedPlanProposalV1['steps'][number]['criteria'] }>
  }
  candidate.steps[0]!.criteria = [
    {
      kind: 'check',
      description: 'Run an unregistered model-authored check.',
      ref: 'npm-test',
    },
  ]
  assert.throws(() => validator.validate(candidate), hasCode('PLAN_PROPOSAL_CRITERION_DENIED'))
})

test('admitted fixed plan is one strict CAS commit and replays full PlanGraph fields from JSONL', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-plan-validator-'))
  try {
    const store = new JsonlSessionJournalV3(root)
    await store.initialize()
    const journal = new ReducingSessionJournalV3(store)
    await journal.appendCommit(
      createSessionCommitV3({
        sessionId: 'session-plan',
        commitId: 'commit-session',
        expectedRevision: 0,
        idempotencyKey: 'idem-session',
        entries: [
          entry(1, 1, 'session.created', {
            cwd: 'D:/workspace',
            provider: 'fixture',
            model: 'fixture-model',
            name: 'Plan admission',
            labels: [],
          }),
        ],
      }),
    )

    const graph = new PlanValidator(OPTIONS).validate(proposal())
    const payloads = initialPlanJournalPayloadsV3(graph)
    const firstStepPayload = payloads[1]
    if (firstStepPayload?.type !== 'step.created') assert.fail('expected step.created payload')
    assert.equal(Object.isFrozen(firstStepPayload.data), true)
    assert.equal(Object.isFrozen(firstStepPayload.data.criteria), true)
    await journal.appendCommit(
      createSessionCommitV3({
        sessionId: 'session-plan',
        commitId: 'commit-plan',
        expectedRevision: 1,
        idempotencyKey: 'idem-plan',
        entries: payloads.map((payload, index) =>
          entry(index + 2, 2, payload.type, payload.data as Record<string, unknown>),
        ),
      }),
    )

    const admitted = await journal.loadProjection('session-plan')
    assert.equal(admitted.planGraph?.revision, 1)
    assert.deepEqual(admitted.planGraph?.steps[1]?.dependencies, ['step-read'])
    assert.deepEqual(admitted.planGraph?.steps[0]?.access, {
      mode: 'read_only',
      paths: ['src'],
    })
    assert.deepEqual(admitted.planGraph?.readyStepIds, [])

    await journal.appendCommit(
      createSessionCommitV3({
        sessionId: 'session-plan',
        commitId: 'commit-plan-running',
        expectedRevision: 2,
        idempotencyKey: 'idem-plan-running',
        entries: [
          entry(payloads.length + 2, 3, 'plan.state_changed', {
            planId: graph.planId,
            planRevision: graph.revision,
            state: 'running',
          }),
        ],
      }),
    )
    assert.deepEqual((await journal.loadProjection('session-plan')).planGraph?.readyStepIds, [
      'step-read',
    ])

    await assert.rejects(
      journal.appendCommit(
        createSessionCommitV3({
          sessionId: 'session-plan',
          commitId: 'commit-stale',
          expectedRevision: 2,
          idempotencyKey: 'idem-stale',
          entries: [
            entry(payloads.length + 3, 3, 'plan.state_changed', {
              planId: graph.planId,
              planRevision: graph.revision,
              state: 'blocked',
            }),
          ],
        }),
      ),
      hasCode('SESSION_COMMIT_REVISION_CONFLICT'),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('shared reducer rejects direct journal bypasses and forbidden step shortcuts', () => {
  const graph = new PlanValidator(OPTIONS).validate(proposal())
  const payloads = initialPlanJournalPayloadsV3(graph)
  const base = [
    entry(1, 1, 'session.created', {
      cwd: 'D:/workspace',
      provider: 'fixture',
      model: 'fixture-model',
      name: 'Reducer fixture',
      labels: [],
    }),
    ...payloads.map((payload, index) =>
      entry(index + 2, 2, payload.type, payload.data as Record<string, unknown>),
    ),
  ]
  assert.throws(
    () =>
      reduceSessionEntriesV3([
        ...base,
        entry(payloads.length + 2, 3, 'plan.state_changed', {
          planId: graph.planId,
          planRevision: 1,
          state: 'running',
        }),
        entry(payloads.length + 3, 4, 'step.state_changed', {
          planId: graph.planId,
          planRevision: 1,
          stepId: graph.steps[0]!.stepId,
          state: 'succeeded',
        }),
      ]),
    hasCode('SESSION_REDUCER_TRANSITION_INVALID'),
  )

  const invalidStep = structuredClone(payloads[1]!.data) as Record<string, unknown>
  invalidStep.dependencies = ['step-missing']
  assert.throws(
    () =>
      reduceSessionEntriesV3([
        base[0]!,
        entry(2, 2, 'plan.created', payloads[0]!.data as Record<string, unknown>),
        entry(3, 2, 'step.created', invalidStep),
        entry(4, 2, 'step.created', payloads[2]!.data as Record<string, unknown>),
      ]),
    hasCode('SESSION_REDUCER_TRANSITION_INVALID'),
  )

  assert.throws(
    () =>
      reduceSessionEntriesV3([
        base[0]!,
        entry(2, 2, 'plan.created', {
          ...(payloads[0]!.data as Record<string, unknown>),
          state: 'running',
        }),
        entry(3, 2, 'step.created', {
          ...(payloads[1]!.data as Record<string, unknown>),
          state: 'running',
        }),
        entry(4, 2, 'attempt.created', {
          planId: graph.planId,
          planRevision: graph.revision,
          stepId: graph.steps[0]!.stepId,
          attemptId: 'attempt-orphan-result',
          ordinal: 1,
          state: 'running',
          childRunId: 'child-orphan-result',
        }),
        entry(5, 2, 'subagent.result_recorded', {
          planId: graph.planId,
          planRevision: graph.revision,
          stepId: graph.steps[0]!.stepId,
          attemptId: 'attempt-orphan-result',
          childRunId: 'child-orphan-result',
          resultRef: 'artifact://artifact-orphan-result',
          resultDigest: DIGEST,
          status: 'succeeded',
        }),
      ]),
    hasCode('SESSION_REDUCER_TRANSITION_INVALID'),
  )
})

function proposal(): FixedPlanProposalV1 {
  return {
    objective: 'Read the workspace and summarize findings.',
    steps: [
      {
        key: 'read',
        title: 'Read source files',
        access: { mode: 'read_only', paths: ['src'] },
        capabilities: ['builtin.read'],
        criteria: [{ kind: 'file', description: 'Source evidence exists.', ref: 'src' }],
      },
      {
        key: 'summarize',
        title: 'Summarize evidence',
        dependencies: ['read'],
        capabilities: ['skill.fixture'],
        criteria: [{ kind: 'rule', description: 'Summary cites the source evidence.' }],
        maxAttempts: 2,
      },
    ],
  }
}

function step(value: Record<string, unknown>, index: number): Record<string, unknown> {
  return (value.steps as Record<string, unknown>[])[index]!
}

function entry(
  sequence: number,
  revision: number,
  type: string,
  data: Record<string, unknown>,
): SessionEntryV3 {
  return validateSessionEntryV3({
    schemaVersion: 3,
    entryId: `entry-${sequence}-${type.replaceAll('.', '-')}`,
    sessionId: 'session-plan',
    sequence,
    revision,
    timestamp: new Date(Date.UTC(2026, 7, 3, 0, 0, sequence)).toISOString(),
    type,
    data,
  })
}

function hasCode(code: string) {
  return (error: unknown) =>
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code
}
