import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionRepositoryV3 } from '../apps/runtime/src/session-db/sessionRepositoryV3.js'
import { ArtifactStore } from '../apps/runtime/src/artifacts/artifactStore.js'
import { ReviewCoordinatorV1 } from '../apps/runtime/src/review-plan/reviewCoordinator.js'
import { PlanControlServiceV1 } from '../apps/runtime/src/review-plan/planControlService.js'
import {
  reviewDecisionSchemaV1,
  validateSemanticReviewDecisionV1,
  ProviderSemanticReviewerV1,
} from '../apps/runtime/src/review-plan/semanticReviewer.js'
import {
  mechanicalProofBoundaryV1,
  reviewScopeContextV1,
} from '../apps/runtime/src/review-plan/reviewSemantics.js'
import type {
  ChatProvider,
  ReviewCriterionProjectionV1,
  ReviewPlanProjectionV1,
} from '@praxis/core-sdk'

const proof = {
  observation: 'The frozen report shows an operation succeeded for version A.',
  inference: 'The requested condition is success for version B, which is not observed.',
  unresolvedAssumptions: ['The report applies unchanged to version B.'],
}
type DecisionSchema = { properties: { findings: { items: { required: string[] } } } }
function candidate(status: string, withProof = true) {
  return {
    verdict: status === 'passed' ? 'accepted' : 'needs_fix',
    summary: 'Assess version applicability.',
    findings: [
      {
        criterionId: 'behavior',
        status,
        reason: 'Evidence applicability check.',
        evidenceRefs: ['report'],
        ...(withProof ? { proof } : {}),
      },
    ],
  }
}

test('new proof audit rejects acceptance with unsupported premises and requires explicit proof', () => {
  assert.throws(() =>
    validateSemanticReviewDecisionV1(candidate('passed'), ['behavior'], ['report'], true),
  )
  assert.throws(() =>
    validateSemanticReviewDecisionV1(candidate('passed', false), ['behavior'], ['report'], true),
  )
  const result = validateSemanticReviewDecisionV1(
    candidate('unverifiable'),
    ['behavior'],
    ['report'],
    true,
  )
  assert.match(result.findings[0]!.reason, /version B/)
  // Normalized decisions remain compatible with the existing journal and replay validator.
  assert.deepEqual(validateSemanticReviewDecisionV1(result, ['behavior'], ['report']), result)
  assert.equal(
    validateSemanticReviewDecisionV1(candidate('passed', false), ['behavior'], ['report']).verdict,
    'accepted',
  )
})

test('versioned schema and Provider require the audit for new coordinator requests', async () => {
  const schema = reviewDecisionSchemaV1(true) as DecisionSchema
  assert.ok(schema.properties.findings.items.required.includes('proof'))
  const provider: ChatProvider = {
    id: 'fixture',
    defaultModel: 'fixture',
    authState: () => ({ status: 'authenticated' }),
    async *stream(request) {
      const tool = request.tools.find((t) => t.name === 'submit_review_plan_decision')!
      assert.ok(
        (tool.parameters as DecisionSchema).properties.findings.items.required.includes('proof'),
      )
      yield {
        type: 'tool_calls',
        calls: [{ id: 'submit', name: tool.name, input: candidate('passed', false) }],
      }
      yield { type: 'completed', usage: { inputTokens: 2 } }
    },
  }
  await assert.rejects(
    new ProviderSemanticReviewerV1(provider, 'fixture').review({
      reviewRequestId: 'review',
      neutralPayload: { reviewContract: { requireProofAudit: true } },
      criterionIds: ['behavior'],
      evidenceRefs: ['report'],
      signal: new AbortController().signal,
    }),
    (error: unknown) => {
      const failure = error as { code: string; reviewUsage: { inputTokens: number } }
      return failure.code === 'REVIEW_RESPONSE_INVALID' && failure.reviewUsage.inputTokens === 2
    },
  )
})

test('mechanical proof boundaries do not inherit broad model-authored descriptions', () => {
  const criterion = {
    id: 'content',
    kind: 'mechanical',
    description: 'All business behavior is correct.',
    check: { checker: 'file_rule', path: 'output', rule: { kind: 'exists' } },
  } as ReviewCriterionProjectionV1
  const boundary = mechanicalProofBoundaryV1(criterion)!
  assert.equal(boundary.proves, 'The prepared workspace path exists.')
  assert.match(boundary.doesNotProve, /beyond this predicate/)
})

test('scope context exposes other item responsibilities without requiring their completion locally', () => {
  const plan = {
    items: [
      { id: 'research', title: 'Gather evidence', state: 'running', criterionIds: ['source'] },
      { id: 'deliver', title: 'Write output', state: 'pending', criterionIds: ['output'] },
    ],
    criteria: [
      { id: 'source', description: 'Identify evidence', status: 'active' },
      { id: 'output', description: 'Write output', status: 'active' },
    ],
  } as unknown as ReviewPlanProjectionV1
  const local = reviewScopeContextV1(plan, 'research')
  assert.equal(local.wholeTaskCompletionRequired, false)
  assert.deepEqual(local.items[1]!.criterionIds, ['output'])
  assert.equal(reviewScopeContextV1(plan).wholeTaskCompletionRequired, true)
})

test('accepted frozen evidence is context only and cannot satisfy a later missing-file predicate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'review-context-'))
  const repository = new SessionRepositoryV3({ root, store: 'jsonl' })
  const invocation = (suffix: string) => ({
    invocationId: `pti_${suffix}` as const,
    sessionId: 's',
    runId: 'r',
    providerTurnId: suffix,
    providerToolCallId: suffix,
  })
  try {
    await repository.initialize()
    await repository.create({
      sessionId: 's',
      state: 'idle',
      cwd: root,
      provider: 'fixture',
      model: 'fixture',
      createdAt: '2026-09-05T00:00:00.000Z',
      updatedAt: '2026-09-05T00:00:00.000Z',
    })
    await repository.appendRequestMessage(
      's',
      'request',
      'r',
      { role: 'user', content: 'Gather evidence then deliver the current output.' },
      'optional',
    )
    const control = new PlanControlServiceV1(repository.journal())
    await control.create({
      sessionId: 's',
      invocation: invocation('create'),
      input: {
        objective: 'Gather evidence then deliver.',
        acceptanceCriteria: [
          {
            id: 'source',
            description: 'Source exists.',
            kind: 'mechanical',
            required: true,
            check: { checker: 'file_rule', path: 'source.txt', rule: { kind: 'exists' } },
          },
          {
            id: 'output',
            description: 'Output exists.',
            kind: 'mechanical',
            required: true,
            check: { checker: 'file_rule', path: 'source.txt', rule: { kind: 'exists' } },
          },
          {
            id: 'behavior',
            description: 'Output meets the task.',
            kind: 'semantic',
            required: true,
          },
        ],
        items: [
          { id: 'research', title: 'Research', criterionIds: ['source'], reviewCheckpoint: false },
          {
            id: 'deliver',
            title: 'Deliver',
            criterionIds: ['output', 'behavior'],
            reviewCheckpoint: true,
          },
        ],
      },
    })
    let semanticCalls = 0
    const coordinator = new ReviewCoordinatorV1({
      journal: repository.journal(),
      control,
      artifacts: new ArtifactStore(join(root, 'artifacts')),
      reviewer: {
        async review(input) {
          semanticCalls++
          const payload = input.neutralPayload as {
            contextEvidenceRefs: string[]
            currentEvidenceRefs: string[]
            evidenceManifest: { entries: { ref: string; content?: string }[] }
            mechanicalProofBoundaries: { proves: string }[]
          }
          assert.ok(payload.contextEvidenceRefs.length > 0)
          assert.ok(
            payload.contextEvidenceRefs.every((ref) => !payload.currentEvidenceRefs.includes(ref)),
          )
          assert.match(
            JSON.stringify(
              payload.evidenceManifest.entries.filter(({ ref }) =>
                payload.contextEvidenceRefs.includes(ref),
              ),
            ),
            /ORIGINAL_SOURCE/,
          )
          assert.ok(
            payload.mechanicalProofBoundaries.some(
              ({ proves }) => proves === 'The prepared workspace path exists.',
            ),
          )
          return {
            decision: {
              verdict: 'needs_fix',
              summary: 'Missing behavioral proof.',
              findings: input.criterionIds.map((criterionId) => ({
                criterionId,
                status: 'unverifiable',
                reason: 'Need current observation.',
                evidenceRefs: [],
              })),
            },
            rawResponse: '{}',
            usage: {},
          }
        },
      },
    })
    const start = (itemId: string, suffix: string) =>
      control.progress({
        sessionId: 's',
        expectedPlanRevision: 1,
        invocation: invocation(suffix),
        action: { kind: 'start', itemId },
      })
    const review = (itemId: string, suffix: string) =>
      coordinator.review(
        {
          sessionId: 's',
          expectedPlanRevision: 1,
          invocation: invocation(suffix),
          scope: { kind: 'item', itemId },
          summary: 'Candidate ready.',
          evidenceRefs: [],
        },
        new AbortController().signal,
      )
    await writeFile(join(root, 'source.txt'), 'ORIGINAL_SOURCE')
    await start('research', 'research-start')
    assert.equal((await review('research', 'research-review')).status, 'accepted')
    await rm(join(root, 'source.txt'))
    await start('deliver', 'deliver-start')
    assert.equal((await review('deliver', 'deliver-missing')).status, 'needs_fix')
    assert.equal(semanticCalls, 0)
    await writeFile(join(root, 'source.txt'), 'NEW_OUTPUT')
    await start('deliver', 'deliver-retry')
    assert.equal((await review('deliver', 'deliver-review')).status, 'needs_fix')
    assert.equal(semanticCalls, 1)
  } finally {
    await repository.close()
    await rm(root, { recursive: true, force: true })
  }
})
