import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  type ChatProvider,
  type PlanCreateInputV1,
  type ProviderRequest,
  runtimeError,
} from '@praxis/core-sdk'
import { ArtifactStore } from '../apps/runtime/src/artifacts/artifactStore.js'
import {
  criterionRequiresSemanticReviewV1,
  PlanControlServiceV1,
  ProviderSemanticReviewerV1,
  REVIEWER_INSTRUCTIONS_V1,
  REVIEWER_TOOL_INSTRUCTIONS_V1,
  ReviewBudgetServiceV1,
  ReviewCallStoreV1,
  ReviewCoordinatorV1,
  retainReviewEvidenceBoundariesV1,
  validateSemanticReviewDecisionV1,
} from '../apps/runtime/src/review-plan/index.js'
import { allocateReviewEvidenceBudgetsV1 } from '../apps/runtime/src/review-plan/reviewCoordinator.js'
import { SessionRepositoryV3 } from '../apps/runtime/src/session-db/sessionRepositoryV3.js'

const DEFINITION: PlanCreateInputV1 = {
  objective: 'Implement a reviewed change.',
  acceptanceCriteria: [
    {
      id: 'complete',
      description: 'The requested behavior is fully implemented.',
      kind: 'semantic',
      required: true,
    },
  ],
  items: [
    {
      id: 'implementation',
      title: 'Implement behavior',
      criterionIds: ['complete'],
      reviewCheckpoint: true,
    },
  ],
}

test('evidence budgets reuse short receipts quota and honor global and explicit per-item limits', () => {
  assert.deepEqual(allocateReviewEvidenceBudgetsV1([8, 1, 1], 10, 10), [8, 1, 1])
  const sizes = [6_000, ...Array.from({ length: 24 }, () => 400)]
  assert.deepEqual(allocateReviewEvidenceBudgetsV1(sizes), sizes)
  assert.deepEqual(allocateReviewEvidenceBudgetsV1(sizes, 64 * 1024, 16 * 1024), sizes)
  const bounded = allocateReviewEvidenceBudgetsV1([0, 100_000, 90_000, 4], 1_000, 600)
  assert.equal(
    bounded.reduce((sum, value) => sum + value, 0),
    1_000,
  )
  assert.ok(bounded.every((value) => value >= 0 && value <= 600))
  assert.deepEqual(allocateReviewEvidenceBudgetsV1([], 100, 10), [])
  assert.deepEqual(allocateReviewEvidenceBudgetsV1([100, 100], 1_000, 30), [30, 30])
})

test('both Reviewer transports prioritize external blockers over unrepairable retries', () => {
  for (const instructions of [REVIEWER_INSTRUCTIONS_V1, REVIEWER_TOOL_INSTRUCTIONS_V1]) {
    assert.match(instructions, /blocked takes precedence/u)
    assert.match(instructions, /Do not return needs_fix or replan while explaining/u)
    assert.match(instructions, /Your verdict and explanation must agree/u)
  }
})

test('long Attempt evidence keeps setup and latest verification facts deterministically', () => {
  const evidence = Array.from({ length: 600 }, (_, index) => `artifact-${index}`)
  const retained = retainReviewEvidenceBoundariesV1(evidence, 255)
  assert.equal(retained.length, 255)
  assert.deepEqual(retained.slice(0, 16), evidence.slice(0, 16))
  assert.deepEqual(retained.slice(-239), evidence.slice(-239))
  assert.deepEqual(retainReviewEvidenceBoundariesV1(evidence, 255), retained)
})

test('generic receipts require semantic inspection while exact file and digest checks can self-accept', () => {
  const base = {
    id: 'criterion',
    description: 'Verify the intended outcome, not merely that some Tool returned success.',
    required: true,
    status: 'active' as const,
    definitionDigest: `sha256:${'a'.repeat(64)}` as const,
  }
  assert.equal(
    criterionRequiresSemanticReviewV1({
      ...base,
      kind: 'mechanical',
      check: { checker: 'tool_receipt', toolName: 'shell', expectedState: 'succeeded' },
    }),
    true,
  )
  assert.equal(
    criterionRequiresSemanticReviewV1({
      ...base,
      kind: 'mechanical',
      check: { checker: 'file_rule', path: 'result.txt', rule: { kind: 'exists' } },
    }),
    false,
  )
  assert.equal(criterionRequiresSemanticReviewV1({ ...base, kind: 'semantic' }), true)
})

test('ReviewCoordinator freezes the candidate and commits an isolated semantic decision', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-review-coordinator-'))
  const repository = new SessionRepositoryV3({ root, store: 'jsonl' })
  const reviewCalls = new ReviewCallStoreV1(join(root, 'review-calls'))
  let request: ProviderRequest | undefined
  let providerCalls = 0
  const measured: { callId: string; usage: unknown }[] = []
  const provider: ChatProvider = {
    id: 'review-fixture',
    defaultModel: 'review-model',
    capabilities: capabilities(true),
    authState: () => ({ status: 'authenticated' }),
    async *stream(input) {
      providerCalls += 1
      request = input
      if (providerCalls === 1) {
        yield { type: 'text_delta' as const, text: '{"invalid":true}' }
        yield { type: 'completed' as const, usage: { inputTokens: 5, outputTokens: 2 } }
        return
      }
      const payload = JSON.parse(String(input.messages[0]?.content)) as {
        criteria: readonly { id: string }[]
        evidenceRefs: readonly string[]
        priorResponseFailure?: { code: string; validationPath: string }
      }
      if (providerCalls === 2) {
        assert.equal(payload.priorResponseFailure?.code, 'REVIEW_RESPONSE_INVALID')
        assert.equal(payload.priorResponseFailure?.validationPath, '$')
      }
      yield {
        type: 'text_delta' as const,
        text: JSON.stringify({
          verdict: 'accepted',
          summary: 'The supplied result proves the criterion.',
          findings: payload.criteria.map(({ id }) => ({
            criterionId: id,
            status: 'passed',
            reason: 'The candidate summary and evidence are consistent.',
            evidenceRefs: [payload.evidenceRefs[0]!],
            proof: {
              observation: 'The fixture supplies a matching result.',
              inference: 'This fixture result establishes the scoped behavior.',
              unresolvedAssumptions: [],
            },
          })),
        }),
      }
      yield {
        type: 'completed' as const,
        usage: { inputTokens: 10, outputTokens: 10, cacheWriteTokens: undefined },
      }
    },
  }
  try {
    await repository.initialize()
    await reviewCalls.initialize()
    await repository.create({
      sessionId: 'session-review',
      state: 'idle',
      cwd: process.cwd(),
      provider: provider.id,
      model: 'review-model',
      createdAt: '2026-09-02T00:00:00.000Z',
      updatedAt: '2026-09-02T00:00:00.000Z',
    })
    await repository.appendRequestMessage(
      'session-review',
      'request-review',
      'run-review',
      { role: 'user', content: 'Implement.' },
      'optional',
    )
    const control = new PlanControlServiceV1(repository.journal(), {
      now: () => '2026-09-02T00:00:01.000Z',
    })
    await control.create({
      sessionId: 'session-review',
      invocation: invocation('create'),
      input: DEFINITION,
    })
    const started = await control.progress({
      sessionId: 'session-review',
      expectedPlanRevision: 1,
      invocation: invocation('start'),
      action: { kind: 'start', itemId: 'implementation' },
    })
    assert.equal(started.projection.items[0]?.state, 'running')
    const coordinator = new ReviewCoordinatorV1({
      journal: repository.journal(),
      control,
      artifacts: new ArtifactStore(join(root, 'artifacts')),
      reviewer: new ProviderSemanticReviewerV1(provider, 'review-model'),
      reviewCalls,
      reviewBudget: new ReviewBudgetServiceV1(repository.journal()),
      onProviderUsage: (callId, usage) => measured.push({ callId, usage }),
    })
    await assert.rejects(
      coordinator.review(
        {
          sessionId: 'session-review',
          expectedPlanRevision: 1,
          invocation: invocation('premature-final'),
          scope: { kind: 'final' },
          summary: 'Premature final.',
          evidenceRefs: [],
        },
        new AbortController().signal,
      ),
      (error: unknown) => {
        assert.equal((error as { code: string }).code, 'PLAN_FINAL_REVIEW_NOT_READY')
        assert.match(
          (error as { message: string }).message,
          /Final Review requires every Item to be accepted/u,
        )
        return true
      },
    )
    await assert.rejects(
      coordinator.review(
        {
          sessionId: 'session-review',
          expectedPlanRevision: 1,
          invocation: invocation('foreign-review'),
          scope: { kind: 'item', itemId: 'implementation' },
          summary: 'Trust an unrelated artifact.',
          evidenceRefs: ['artifact-not-owned-by-this-attempt'],
        },
        new AbortController().signal,
      ),
      hasCode('REVIEW_EVIDENCE_NOT_ATTEMPT_OWNED'),
    )
    const reviewed = await coordinator.review(
      {
        sessionId: 'session-review',
        expectedPlanRevision: 1,
        invocation: invocation('review'),
        scope: { kind: 'item', itemId: 'implementation' },
        summary: 'Implemented the behavior.',
        evidenceRefs: [],
      },
      new AbortController().signal,
    )
    assert.equal(reviewed.status, 'accepted')
    assert.equal(reviewed.findings?.[0]?.criterionId, 'complete')
    const itemPayload = JSON.parse(String(request?.messages[0]?.content))
    assert.equal(itemPayload.originalTaskContract.text, 'Implement.')
    assert.equal(itemPayload.deterministicResults[0].status, 'deferred')
    assert.equal(itemPayload.reviewContract.requireProofAudit, true)
    assert.equal(itemPayload.scopeContext.wholeTaskCompletionRequired, false)
    assert.equal(itemPayload.scopeContext.currentItemId, 'implementation')
    assert.equal(reviewed.projection.items[0]?.state, 'accepted')
    assert.equal(reviewed.projection.items[0]?.currentAttempt, undefined)
    assert.ok((reviewed.projection.items[0]?.acceptedEvidenceRefs?.length ?? 0) >= 1)
    const final = await coordinator.review(
      {
        sessionId: 'session-review',
        expectedPlanRevision: 1,
        invocation: invocation('final-review'),
        scope: { kind: 'final' },
        summary: 'All accepted work is ready for final delivery.',
        evidenceRefs: [],
      },
      new AbortController().signal,
    )
    assert.equal(final.status, 'accepted')
    assert.equal(final.projection.state, 'completed')
    assert.equal(providerCalls, 3)
    assert.equal(request?.instructions, REVIEWER_INSTRUCTIONS_V1)
    assert.deepEqual(request?.contextMessages, [])
    assert.deepEqual(request?.tools, [])
    assert.equal(request?.messages.length, 1)
    const finalPayload = JSON.parse(String(request?.messages[0]?.content)) as {
      originalTaskContract: { text: string; digest: string }
      criteria: readonly { id: string }[]
      evidenceManifest: {
        entries: readonly {
          ref: string
          owner: string
          available: boolean
          contentPreview?: string
        }[]
      }
    }
    assert.equal(finalPayload.originalTaskContract.text, 'Implement.')
    assert.match(finalPayload.originalTaskContract.digest, /^sha256:[a-f0-9]{64}$/u)
    assert.ok(
      finalPayload.criteria.some(({ id }) => id.startsWith('runtime.task_contract_coverage.')),
    )
    assert.ok(finalPayload.evidenceManifest.entries.length >= 2)
    assert.ok(
      finalPayload.evidenceManifest.entries.every(
        ({ owner, available, contentPreview }) =>
          owner === 'runtime' && available && typeof contentPreview === 'string',
      ),
    )
    const projection = await repository.journal().loadProjection('session-review')
    assert.equal(projection.reviewBudgets?.length, 3)
    assert.ok(
      projection.reviewBudgets
        ?.slice(1)
        .every(({ usage }) => usage?.inputTokens === 10 && usage.outputTokens === 10),
    )
    assert.equal(projection.reviewBudgets?.[0]?.disposition, 'actual')
    assert.equal(projection.reviewBudgets?.[0]?.usage?.outputTokens, 2)
    assert.equal(measured.length, 3)
    assert.equal(new Set(measured.map(({ callId }) => callId)).size, 3)
    const reviewRequestId = reviewed.reviewRequestId
    assert.ok(reviewRequestId)
    assert.equal((await reviewCalls.get(reviewRequestId, 1))?.state, 'provider_invalid')
    assert.equal((await reviewCalls.get(reviewRequestId, 1))?.failure?.validationPath, '$')
    assert.equal((await reviewCalls.get(reviewRequestId, 1))?.usage?.inputTokens, 5)
    assert.equal((await reviewCalls.get(reviewRequestId, 2))?.state, 'decision_committed')
    assert.equal(projection.snapshot.usage.turns, 0)
  } finally {
    reviewCalls.close()
    await repository.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('ProviderSemanticReviewer uses a forced Tool result when native JSON Schema is unavailable', async () => {
  let request: ProviderRequest | undefined
  const decision = {
    verdict: 'accepted' as const,
    summary: 'The supplied evidence proves the criterion.',
    findings: [
      {
        criterionId: 'complete',
        status: 'passed' as const,
        reason: 'The evidence is sufficient.',
        evidenceRefs: ['artifact-1'],
      },
    ],
  }
  const provider: ChatProvider = {
    id: 'review-tool-fixture',
    defaultModel: 'review-model',
    capabilities: capabilities(false),
    authState: () => ({ status: 'authenticated' }),
    async *stream(input) {
      request = input
      yield {
        type: 'tool_call_start' as const,
        index: 0,
        id: 'review-call',
        name: 'submit_review_plan_decision',
      }
      yield {
        type: 'tool_call_delta' as const,
        index: 0,
        argumentsDelta: JSON.stringify(decision),
      }
      yield { type: 'tool_call_end' as const, index: 0 }
      yield {
        type: 'completed' as const,
        usage: { inputTokens: 8, outputTokens: 12, cacheWriteTokens: undefined },
      }
    },
  }

  const reviewed = await new ProviderSemanticReviewerV1(provider, 'review-model').review({
    reviewRequestId: 'review-request',
    neutralPayload: { schemaVersion: 1 },
    criterionIds: ['complete'],
    evidenceRefs: ['artifact-1'],
    signal: new AbortController().signal,
  })

  assert.deepEqual(reviewed.decision, decision)
  assert.deepEqual(reviewed.usage, { inputTokens: 8, outputTokens: 12 })
  assert.equal(request?.responseFormat, undefined)
  assert.deepEqual(request?.toolChoice, { name: 'submit_review_plan_decision' })
  assert.deepEqual(
    request?.tools.map(({ name }) => name),
    ['submit_review_plan_decision'],
  )
  assert.equal(request?.instructions, REVIEWER_TOOL_INSTRUCTIONS_V1)
})

test('semantic accepted findings must cite Runtime-readable evidence', () => {
  assert.throws(
    () =>
      validateSemanticReviewDecisionV1(
        {
          verdict: 'accepted',
          summary: 'Claimed complete.',
          findings: [
            {
              criterionId: 'complete',
              status: 'passed',
              reason: 'No evidence was cited.',
              evidenceRefs: [],
            },
          ],
        },
        ['complete'],
        ['artifact-readable'],
      ),
    hasCode('REVIEW_RESPONSE_INVALID'),
  )
})

test('ReviewCoordinator freezes and verifies a workspace file rule without a semantic call', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-review-file-rule-'))
  const repository = new SessionRepositoryV3({ root: join(root, 'sessions'), store: 'jsonl' })
  const content = 'runtime-owned file evidence\n'
  await writeFile(join(root, 'proof.txt'), content, 'utf8')
  try {
    await repository.initialize()
    await repository.create({
      sessionId: 'session-review',
      state: 'idle',
      cwd: root,
      provider: 'fixture',
      model: 'review-model',
      createdAt: '2026-09-02T00:00:00.000Z',
      updatedAt: '2026-09-02T00:00:00.000Z',
    })
    await repository.appendRequestMessage(
      'session-review',
      'request-review',
      'run-review',
      { role: 'user', content: 'Verify proof.txt.' },
      'required',
    )
    const control = new PlanControlServiceV1(repository.journal())
    await control.create({
      sessionId: 'session-review',
      invocation: invocation('create-file'),
      input: {
        objective: 'Verify proof.txt.',
        acceptanceCriteria: [
          {
            id: 'file-digest',
            description: 'proof.txt has the expected content digest.',
            kind: 'mechanical',
            required: true,
            check: {
              checker: 'file_rule',
              path: 'proof.txt',
              rule: {
                kind: 'sha256',
                expectedDigest: `sha256:${createHash('sha256').update(content).digest('hex')}`,
              },
            },
          },
        ],
        items: [
          {
            id: 'verify-file',
            title: 'Verify the file',
            criterionIds: ['file-digest'],
            reviewCheckpoint: true,
          },
        ],
      },
    })
    await control.progress({
      sessionId: 'session-review',
      expectedPlanRevision: 1,
      invocation: invocation('start-file'),
      action: { kind: 'start', itemId: 'verify-file' },
    })
    const reviewed = await new ReviewCoordinatorV1({
      journal: repository.journal(),
      control,
      artifacts: new ArtifactStore(join(root, 'artifacts')),
      reviewer: { review: () => Promise.reject(new Error('semantic reviewer must not run')) },
    }).review(
      {
        sessionId: 'session-review',
        expectedPlanRevision: 1,
        invocation: invocation('review-file'),
        scope: { kind: 'item', itemId: 'verify-file' },
        summary: 'proof.txt was checked.',
        evidenceRefs: [],
      },
      new AbortController().signal,
    )
    assert.equal(reviewed.status, 'accepted')
    assert.equal(reviewed.projection.items[0]?.state, 'accepted')
    assert.ok((reviewed.projection.items[0]?.acceptedEvidenceRefs?.length ?? 0) >= 2)
  } finally {
    await repository.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('ReviewCoordinator exposes the last isolated Reviewer failure code after exhaustion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-review-exhausted-'))
  const repository = new SessionRepositoryV3({ root, store: 'jsonl' })
  try {
    await repository.initialize()
    await repository.create({
      sessionId: 'session-review',
      state: 'idle',
      cwd: process.cwd(),
      provider: 'fixture',
      model: 'review-model',
      createdAt: '2026-09-02T00:00:00.000Z',
      updatedAt: '2026-09-02T00:00:00.000Z',
    })
    await repository.appendRequestMessage(
      'session-review',
      'request-review',
      'run-review',
      { role: 'user', content: 'Implement.' },
      'optional',
    )
    const control = new PlanControlServiceV1(repository.journal())
    await control.create({
      sessionId: 'session-review',
      invocation: invocation('create-exhausted'),
      input: {
        ...DEFINITION,
        reviewPolicy: {
          semantic: 'final_and_checkpoints',
          maxRepairAttemptsPerItem: 1,
          maxReplans: 1,
          maxReviewAttempts: 1,
          maxNoProgressAttempts: 1,
        },
      },
    })
    await control.progress({
      sessionId: 'session-review',
      expectedPlanRevision: 1,
      invocation: invocation('start-exhausted'),
      action: { kind: 'start', itemId: 'implementation' },
    })
    const coordinator = new ReviewCoordinatorV1({
      journal: repository.journal(),
      control,
      artifacts: new ArtifactStore(join(root, 'artifacts')),
      reviewer: {
        review: () =>
          Promise.reject(
            runtimeError('REVIEW_FIXTURE_FAILURE', 'provider', 'Fixture Reviewer failed.'),
          ),
      },
    })
    const reviewed = await coordinator.review(
      {
        sessionId: 'session-review',
        expectedPlanRevision: 1,
        invocation: invocation('review-exhausted'),
        scope: { kind: 'item', itemId: 'implementation' },
        summary: 'Candidate.',
        evidenceRefs: [],
      },
      new AbortController().signal,
    )
    assert.equal(reviewed.status, 'blocked')
    assert.match(reviewed.summary, /Last failure: REVIEW_FIXTURE_FAILURE/u)
  } finally {
    await repository.close()
    await rm(root, { recursive: true, force: true })
  }
})

function invocation(suffix: string) {
  return {
    invocationId: `pti_${suffix}` as const,
    sessionId: 'session-review',
    runId: 'run-review',
    providerTurnId: `turn-${suffix}`,
    providerToolCallId: `call-${suffix}`,
  }
}

function capabilities(jsonSchema: boolean) {
  return {
    streaming: { text: true, reasoning: true, usage: true },
    tools: { mode: 'native' as const, parallelCalls: false },
    modalities: { text: true, vision: false, audio: false },
    output: { jsonSchema, citations: false },
    limits: { maxContextTokens: 100_000, maxOutputTokens: 4_096 },
  }
}

function hasCode(code: string) {
  return (error: unknown) =>
    typeof error === 'object' && error !== null && Reflect.get(error, 'code') === code
}
