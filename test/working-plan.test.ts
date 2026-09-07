import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  type PlanToolInvocationContextV1,
  type ProviderUsage,
  type ProviderMessage,
  runtimeError,
  canonicalDigestV1,
  createSessionCommitV3,
  validateSessionEntryV3,
} from '@praxis/core-sdk'
import { SessionRepositoryV3 } from '../apps/runtime/src/session-db/sessionRepositoryV3.js'
import { ArtifactStore } from '../apps/runtime/src/artifacts/artifactStore.js'
import { ReviewCallStoreV1 } from '../apps/runtime/src/review-plan/reviewCallStore.js'
import { RuntimeKernel } from '../apps/runtime/src/framework/runtimeKernel.js'
import type { SemanticReviewerPortV1 } from '../apps/runtime/src/review-plan/semanticReviewer.js'
import { WorkingPlanServiceV1 } from '../apps/runtime/src/working-plan/workingPlanService.js'
import {
  createWorkingPlanToolsV1,
  workingPlanSnapshotMessageV1,
} from '../apps/runtime/src/working-plan/tools.js'

const signal = () => new AbortController().signal
const definition = {
  objective: 'Deliver the requested result',
  items: [
    { id: 'a', title: 'Investigate' },
    { id: 'b', title: 'Deliver' },
  ],
}
function invocation(id: string): PlanToolInvocationContextV1 {
  return {
    invocationId: `pti_${id}`,
    sessionId: 'working-test',
    runId: 'working-run',
    providerTurnId: `turn-${id}`,
    providerToolCallId: `call-${id}`,
  }
}

for (const store of ['sqlite', 'jsonl'] as const) {
  test(`working Plan ${store}: edit during work, reorder, reopen, abandon, restart and replay without Attempts`, async () => {
    await fixture(store, async (h) => {
      const s = h.service()
      const created = await s.mutate('create', definition, invocation('create'))
      assert.equal(created.projection.revision, 1)
      await s.mutate('progress', { itemId: 'a', status: 'in_progress' }, invocation('start'))
      await s.mutate(
        'update',
        {
          items: [
            { id: 'b', title: 'Deliver first' },
            { id: 'a', title: 'Inspect later' },
          ],
        },
        invocation('reorder'),
      )
      await s.mutate('progress', { itemId: 'b', status: 'done' }, invocation('done'))
      await s.mutate('progress', { itemId: 'b', status: 'pending' }, invocation('reopen'))
      await s.mutate('update', { state: 'done' }, invocation('finish'))
      await s.mutate('abandon', {}, invocation('abandon'))
      let p = await h.repository.journal().loadProjection('working-test')
      assert.equal(p.workingPlan?.state, 'abandoned')
      assert.equal(p.reviewPlan, undefined)
      assert.equal(p.workingPlan?.revision, 7)
      await h.repository.close()
      await h.repository.initialize()
      const replay = await h.service().mutate('create', definition, invocation('create'))
      assert.equal(replay.projection.revision, 1)
      p = await h.repository.journal().loadProjection('working-test')
      assert.equal(p.workingPlan?.revision, 7)
      await assert.rejects(
        h.service().mutate('create', { ...definition, objective: 'changed' }, invocation('create')),
        { code: 'PLAN_OPERATION_CONFLICT' },
      )
      await assert.rejects(
        h
          .service()
          .mutate(
            'update',
            { expectedPlanRevision: 2, objective: 'conflict' },
            invocation('stale'),
          ),
        { code: 'PLAN_REVISION_CONFLICT' },
      )
      assert.match(String(workingPlanSnapshotMessageV1(p)?.content), /self-reported/)
      assert.ok(!JSON.stringify(p.workingPlan).includes('Attempt'))
    })
  })

  test(`working Plan ${store}: advisory review without a Plan freezes evidence, accounts usage and replays without Provider`, async () => {
    let calls = 0
    const reviewer: SemanticReviewerPortV1 = {
      async review(request) {
        calls++
        assert.ok(request.evidenceRefs.length > 0)
        assert.equal(request.neutralPayload.scopeContext !== undefined, true)
        assert.match(
          JSON.stringify(request.neutralPayload.originalTaskContract),
          /Deliver the requested result/,
        )
        const decision = {
          verdict: 'accepted' as const,
          summary: 'Observed expected result.',
          findings: request.criterionIds.map((criterionId) => ({
            criterionId,
            status: 'passed' as const,
            reason: 'Frozen result matches.',
            evidenceRefs: [request.evidenceRefs[0]!],
          })),
        }
        return {
          decision,
          rawResponse: JSON.stringify(decision),
          usage: { inputTokens: 20, outputTokens: 5 },
        }
      },
    }
    await fixture(
      store,
      async (h) => {
        await h.repository.appendMessage('working-test', {
          role: 'tool',
          toolCallId: 'tool-1',
          name: 'read',
          content: 'expected result',
        })
        const result = (await h
          .service()
          .review(
            { question: 'Does the observed output match?' },
            invocation('review'),
            signal(),
          )) as { verdict: string }
        assert.equal(result.verdict, 'accepted')
        let p = await h.repository.journal().loadProjection('working-test')
        assert.equal(p.workingPlan, undefined)
        assert.equal(p.reviewPlan, undefined)
        assert.equal(p.workingReviews?.[0]?.verdict, 'accepted')
        assert.equal(p.reviewBudgets?.[0]?.usage?.outputTokens, 5)
        await h.repository.appendMessage('working-test', {
          role: 'tool',
          toolCallId: 'tool-2',
          name: 'write',
          content: 'changed output',
        })
        await h.repository.close()
        await h.repository.initialize()
        const replay = await h
          .service()
          .review({ question: 'Does the observed output match?' }, invocation('review'), signal())
        assert.deepEqual(replay, result)
        assert.equal(calls, 1)
        p = await h.repository.journal().loadProjection('working-test')
        assert.ok(p.workingReviews![0]!.evidenceSequence < p.snapshot.sequence)
        assert.equal(h.usage.length, 1)
      },
      reviewer,
    )
  })
}

for (const store of ['sqlite', 'jsonl'] as const) {
  test(`working Plan ${store}: frozen evidence pairs persisted calls and results, never reasoning or orphan requests`, async () => {
    await fixture(
      store,
      async (h) => {
        const messages: ProviderMessage[] = [
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Unverified claim: everything is fine.' },
              {
                type: 'tool_call',
                id: 'write-source',
                name: 'write',
                input: { path: 'settings.json', content: '{"timeoutSeconds":30}' },
              },
              {
                type: 'tool_call',
                id: 'run-check',
                name: 'shell',
                input: { command: 'inspect settings.json' },
              },
              {
                type: 'tool_call',
                id: 'orphan',
                name: 'shell',
                input: { command: 'never executed' },
              },
            ],
          },
          {
            role: 'tool',
            toolCallId: 'write-source',
            name: 'write',
            content: '{"ok":true,"output":{"afterBytes":21}}',
          },
          {
            role: 'tool',
            toolCallId: 'run-check',
            name: 'shell',
            content: '{"ok":false,"error":{"code":"UNAVAILABLE"}}',
          },
          { role: 'tool', toolCallId: 'no-request', name: 'read', content: 'orphan result' },
        ]
        for (const m of messages) await h.repository.appendMessage('working-test', m)
        await h.repository.close()
        await h.repository.initialize()
        await h
          .service()
          .review(
            { question: 'Check the declared timeout unit.' },
            invocation('paired-review'),
            signal(),
          )
      },
      {
        async review(input) {
          assert.deepEqual(input.neutralPayload.reviewContract, { version: 1, kind: 'advisory-v1' })
          const manifest = input.neutralPayload.evidenceManifest as {
            entries: { contentPreview: string }[]
          }
          assert.equal(manifest.entries.length, 3)
          const paired = manifest.entries.map((e) => JSON.parse(e.contentPreview))
          assert.equal(paired[0].request.input.content, '{"timeoutSeconds":30}')
          assert.equal(paired[0].requestAvailable, true)
          assert.equal(paired[1].request.input.command, 'inspect settings.json')
          assert.match(paired[1].observation.content, /"ok":false/)
          assert.equal(paired[2].requestAvailable, false)
          assert.equal(paired[2].request, undefined)
          assert.doesNotMatch(JSON.stringify(manifest), /never executed|everything is fine/)
          const decision = {
            verdict: 'needs_fix' as const,
            summary: 'Need a valid check.',
            findings: [],
          }
          return { decision, rawResponse: JSON.stringify(decision), usage: { inputTokens: 4 } }
        },
      },
    )
  })
}

test('advisory Reviewer exhaustion records unavailable, leaves Plan editable, and never fabricates verified progress', async () => {
  let calls = 0
  await fixture(
    'jsonl',
    async (h) => {
      const service = h.service()
      await service.mutate('create', definition, invocation('create'))
      const report = (await service.review({}, invocation('review'), signal())) as {
        verdict: string
      }
      assert.equal(report.verdict, 'unavailable')
      assert.equal(calls, 3)
      const p = await h.repository.journal().loadProjection('working-test')
      assert.equal(p.workingPlan?.state, 'active')
      assert.ok(p.workingPlan?.items.every((i) => i.status === 'pending'))
      await h.service().review({}, invocation('review'), signal())
      assert.equal(calls, 3)
      await service.mutate('abandon', {}, invocation('abandon'))
    },
    {
      async review() {
        calls++
        throw Object.assign(runtimeError('REVIEW_RESPONSE_INVALID', 'planner', 'Invalid fixture'), {
          reviewFailure: {
            code: 'REVIEW_RESPONSE_INVALID',
            stage: 'validation',
            usageComplete: true,
          },
          reviewUsage: { inputTokens: 2, outputTokens: 1 },
        })
      },
    },
  )
})

test('Host required policy cannot be downgraded by a working Plan tool', async () => {
  await fixture('jsonl', async (h) => {
    await h.repository.updateTerminal('working-test', 'completed', {}, 0)
    await h.repository.appendRequestMessage(
      'working-test',
      'required-request',
      'required-run',
      { role: 'user', content: 'Must verify.' },
      'required',
    )
    await assert.rejects(
      h.service().mutate('create', definition, { ...invocation('bypass'), runId: 'required-run' }),
      { code: 'PLAN_POLICY_MISMATCH' },
    )
  })
})

test('frozen pre-upgrade review resumes its legacy contract, while new requests use advisory-v1', async () => {
  let legacyCalls = 0
  let advisoryCalls = 0
  const input = { question: 'Review the recorded output.' }
  await fixture(
    'sqlite',
    async (h) => {
      const journal = h.repository.journal()
      const p = await journal.loadProjection('working-test')
      const payload = {
        reviewRequestId: 'legacy-review',
        reviewContract: { version: 2, requireProofAudit: true },
        criteria: [{ id: 'legacy-criterion' }],
        evidenceRefs: [],
      }
      const artifact = await h.artifacts.put(payload)
      await journal.appendCommit(
        createSessionCommitV3({
          sessionId: 'working-test',
          commitId: 'legacy-review-frozen',
          idempotencyKey: 'legacy-review-frozen',
          expectedRevision: p.snapshot.revision,
          entries: [
            validateSessionEntryV3({
              schemaVersion: 3,
              entryId: 'legacy-review-request',
              sessionId: 'working-test',
              sequence: p.snapshot.sequence + 1,
              revision: p.snapshot.revision + 1,
              timestamp: new Date().toISOString(),
              type: 'working_plan.review_requested',
              runId: 'working-run',
              data: {
                review: {
                  reviewRequestId: 'legacy-review',
                  operationId: invocation('legacy').invocationId,
                  inputDigest: canonicalDigestV1(input),
                  inputRef: artifact.artifactId,
                  requestDigest: canonicalDigestV1(payload),
                  planRevision: null,
                  snapshotSequence: p.snapshot.sequence,
                  evidenceSequence: 0,
                },
              },
            }),
          ],
        }),
      )
      const service = h.service({
        legacyReviewer: {
          async review(request) {
            legacyCalls++
            assert.deepEqual(request.neutralPayload, payload)
            const decision = {
              verdict: 'needs_fix' as const,
              summary: 'Legacy frozen evidence incomplete.',
              findings: [],
            }
            return { decision, rawResponse: JSON.stringify(decision), usage: { inputTokens: 3 } }
          },
        },
      })
      await service.review(input, invocation('legacy'), signal())
      await service.review(input, invocation('new-advisory'), signal())
      assert.equal(legacyCalls, 1)
      assert.equal(advisoryCalls, 1)
    },
    {
      async review(request) {
        advisoryCalls++
        assert.deepEqual(request.neutralPayload.reviewContract, { version: 1, kind: 'advisory-v1' })
        const decision = {
          verdict: 'needs_fix' as const,
          summary: 'Advisory unknown.',
          findings: [],
        }
        return { decision, rawResponse: JSON.stringify(decision), usage: { inputTokens: 3 } }
      },
    },
  )
})

test('working Plan schemas require neither criteria mapping nor an Attempt, and expose no policy escape hatch', async () => {
  await fixture('jsonl', async (h) => {
    const tools = createWorkingPlanToolsV1(h.service())
    assert.equal(tools.length, 5)
    assert.doesNotMatch(
      JSON.stringify(tools.map((t) => t.definition.parameters)),
      /acceptanceCriteria|criterionIds|itemAttemptId|reviewPolicy|planPolicy/,
    )
    assert.match(
      tools.find((t) => t.definition.name === 'plan.progress')!.definition.description,
      /reopening/,
    )
  })
})

test('advisory review does not fence concurrent Plan edits; its report remains bound to the old revision', async () => {
  let entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  let release!: () => void
  const resume = new Promise<void>((resolve) => {
    release = resolve
  })
  await fixture(
    'jsonl',
    async (h) => {
      const service = h.service()
      await service.mutate('create', definition, invocation('create'))
      const reviewing = service.review({}, invocation('review'), signal())
      await started
      try {
        await service.mutate(
          'update',
          { objective: 'A revised route' },
          invocation('during-review'),
        )
      } finally {
        release()
      }
      const report = (await reviewing) as { planRevision: number }
      assert.equal(report.planRevision, 1)
      const p = await h.repository.journal().loadProjection('working-test')
      assert.equal(p.workingPlan?.revision, 2)
      assert.equal(p.workingPlan?.objective, 'A revised route')
    },
    {
      async review(request) {
        entered()
        await resume
        const decision = {
          verdict: 'needs_fix' as const,
          summary: 'Additional evidence needed.',
          findings: request.criterionIds.map((criterionId) => ({
            criterionId,
            status: 'unverifiable' as const,
            reason: 'No observation.',
            evidenceRefs: [],
          })),
        }
        return {
          decision,
          rawResponse: JSON.stringify(decision),
          usage: { inputTokens: 2, outputTokens: 1 },
        }
      },
    },
  )
})

test('interrupted advisory review resumes its frozen request without replaying the uncertain Provider attempt', async () => {
  const controller = new AbortController()
  let calls = 0
  await fixture(
    'sqlite',
    async (h) => {
      await assert.rejects(
        h
          .service()
          .review(
            { question: 'Inspect existing evidence.' },
            invocation('review'),
            controller.signal,
          ),
      )
      await h.repository.close()
      await h.repository.initialize()
      const report = (await h
        .service()
        .review({ question: 'Inspect existing evidence.' }, invocation('review'), signal())) as {
        verdict: string
      }
      assert.equal(calls, 2)
      assert.equal(report.verdict, 'needs_fix')
      const p = await h.repository.journal().loadProjection('working-test')
      assert.equal(p.reviewBudgets?.[0]?.disposition, 'remote_outcome_unknown')
      assert.equal(p.reviewBudgets?.[1]?.disposition, 'actual')
    },
    {
      async review(request) {
        if (++calls === 1) {
          controller.abort()
          throw new Error('Interrupted fixture transport')
        }
        const decision = {
          verdict: 'needs_fix' as const,
          summary: 'Missing evidence.',
          findings: request.criterionIds.map((criterionId) => ({
            criterionId,
            status: 'unverifiable' as const,
            reason: 'No observation.',
            evidenceRefs: [],
          })),
        }
        return {
          decision,
          rawResponse: JSON.stringify(decision),
          usage: { inputTokens: 2, outputTokens: 1 },
        }
      },
    },
  )
})

test('Runtime completion ignores unfinished working memory while required completion still demands review', async () => {
  await fixture('jsonl', async (h) => {
    const kernel = new RuntimeKernel({ sessionRepository: h.repository })
    const internal = kernel as unknown as {
      reviewPlanCompletionGuidance(
        session: { sessionId: string },
        run: { id: string },
      ): Promise<unknown>
    }
    await h.service().mutate('create', definition, invocation('create'))
    await h.service().mutate('progress', { itemId: 'a', status: 'blocked' }, invocation('block'))
    assert.equal(
      await internal.reviewPlanCompletionGuidance(
        { sessionId: 'working-test' },
        { id: 'working-run' },
      ),
      undefined,
    )
    await h.repository.updateTerminal('working-test', 'completed', {}, 0)
    await h.repository.appendRequestMessage(
      'working-test',
      'strict-request',
      'strict-run',
      { role: 'user', content: 'Verify before completion.' },
      'required',
    )
    assert.match(
      String(
        await internal.reviewPlanCompletionGuidance(
          { sessionId: 'working-test' },
          { id: 'strict-run' },
        ),
      ),
      /requires a ReviewPlan/,
    )
  })
})

test('fork copies the selected working checklist but never copies advisory acceptance or live task ownership', async () => {
  await fixture('jsonl', async (h) => {
    await h.service().mutate('create', definition, invocation('create'))
    const target = {
      sessionId: 'working-fork',
      state: 'idle' as const,
      cwd: process.cwd(),
      provider: 'fixture',
      model: 'fixture-model',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    await h.repository.forkSession('working-test', target)
    const fork = await h.repository.journal().loadProjection('working-fork')
    assert.equal(fork.workingPlan?.revision, 1)
    assert.equal(fork.workingPlan?.objective, definition.objective)
    assert.equal(fork.workingReviews, undefined)
    assert.equal(fork.reviewPlan, undefined)
    await h.repository.forkSession(
      'working-test',
      { ...target, sessionId: 'working-early-fork' },
      1,
    )
    assert.equal(
      (await h.repository.journal().loadProjection('working-early-fork')).workingPlan,
      undefined,
    )
  })
})

async function fixture(
  store: 'sqlite' | 'jsonl',
  run: (h: {
    repository: SessionRepositoryV3
    service: (options?: { legacyReviewer?: SemanticReviewerPortV1 }) => WorkingPlanServiceV1
    artifacts: ArtifactStore
    usage: ProviderUsage[]
  }) => Promise<void>,
  reviewer: SemanticReviewerPortV1 = {
    async review() {
      throw new Error('Unexpected model request')
    },
  },
) {
  const root = await mkdtemp(join(tmpdir(), 'praxis-working-plan-'))
  const repository = new SessionRepositoryV3({ root, store })
  const calls = new ReviewCallStoreV1(root)
  const usage: ProviderUsage[] = []
  try {
    await repository.initialize()
    await calls.initialize()
    await repository.create({
      sessionId: 'working-test',
      state: 'idle',
      cwd: process.cwd(),
      provider: 'fixture',
      model: 'fixture-model',
      createdAt: '2026-09-05T00:00:00.000Z',
      updatedAt: '2026-09-05T00:00:00.000Z',
    })
    await repository.appendRequestMessage(
      'working-test',
      'working-request',
      'working-run',
      { role: 'user', content: 'Deliver the requested result.' },
      'optional',
    )
    await run({
      repository,
      usage,
      artifacts: new ArtifactStore(join(root, 'artifacts')),
      service: (options) =>
        new WorkingPlanServiceV1({
          sessionId: 'working-test',
          journal: repository.journal(),
          artifacts: new ArtifactStore(join(root, 'artifacts')),
          reviewCalls: calls,
          reviewer,
          ...options,
          onProviderUsage: (_id, value) => usage.push(value),
        }),
    })
  } finally {
    calls.close()
    await repository.close()
    await rm(root, { recursive: true, force: true })
  }
}
