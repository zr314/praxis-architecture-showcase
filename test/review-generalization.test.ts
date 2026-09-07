import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AgentRun, ChatProvider, ProviderRequest, ProviderUsage } from '@praxis/core-sdk'
import { ProviderSemanticReviewerV1 } from '../apps/runtime/src/review-plan/semanticReviewer.js'
import {
  MAX_EVIDENCE_READS,
  reviewOutputBudgetV1,
} from '../apps/runtime/src/review-plan/semanticReviewer.js'
import { ReviewCoordinatorV1 } from '../apps/runtime/src/review-plan/reviewCoordinator.js'
import { PlanControlServiceV1 } from '../apps/runtime/src/review-plan/planControlService.js'
import { ArtifactStore } from '../apps/runtime/src/artifacts/artifactStore.js'
import { SessionRepositoryV3 } from '../apps/runtime/src/session-db/sessionRepositoryV3.js'
import { recordAuxiliaryProviderUsageV1 } from '../apps/runtime/src/loop/auxiliaryUsage.js'
import {
  CompactionService,
  DeterministicSummaryGenerator,
} from '../apps/runtime/src/memory/compactionService.js'
import { RegisteredReviewChecksV1 } from '../apps/runtime/src/review-plan/registeredChecks.js'
import { planDefinitionPropertiesV1 } from '../apps/runtime/src/review-plan/tools/shared.js'
import { ProviderCompactionSummaryGenerator } from '../apps/runtime/src/memory/providerCompactionSummaryGenerator.js'

const decision = {
  verdict: 'needs_fix',
  summary: 'The supplied observation does not establish the requested result.',
  findings: [
    {
      criterionId: 'behavior',
      status: 'unverifiable',
      reason:
        'Evidence is incomplete; supply the missing observation before changing the implementation.',
      evidenceRefs: ['artifact-visible'],
    },
  ],
}

function provider(stream: ChatProvider['stream']): ChatProvider {
  return {
    id: 'fixture',
    defaultModel: 'fixture-model',
    authState: () => ({ status: 'authenticated' }),
    stream,
  }
}

const request = {
  reviewRequestId: 'review-general',
  neutralPayload: { purpose: 'inspect frozen evidence' },
  criterionIds: ['behavior'],
  evidenceRefs: ['artifact-visible'],
  signal: new AbortController().signal,
}

test('Reviewer budgets grow with criteria and respect the selected model output limit', () => {
  assert.equal(reviewOutputBudgetV1(1), 4096)
  assert.equal(reviewOutputBudgetV1(7), 7424)
  assert.equal(reviewOutputBudgetV1(129), 32768)
  assert.equal(reviewOutputBudgetV1(7, 5000), 5000)
})

test('Reviewer distinguishes truncation from schema failure while retaining known usage', async () => {
  const reviewer = new ProviderSemanticReviewerV1(
    provider(async function* (input) {
      assert.equal(input.maxOutputTokens, 7424)
      yield { type: 'text_delta', text: '{"findings":[' }
      yield {
        type: 'completed',
        stopReason: 'max_output_tokens',
        usage: { inputTokens: 17, outputTokens: 7424 },
      }
    }),
    'fixture-model',
  )
  await assert.rejects(
    reviewer.review({ ...request, criterionIds: Array.from({ length: 7 }, (_, i) => `c${i}`) }),
    (error: unknown) => {
      const failure = error as {
        code: string
        reviewUsage: ProviderUsage
        reviewFailure: { stopReason: string; usageComplete: boolean }
      }
      assert.equal(failure.code, 'REVIEW_RESPONSE_TRUNCATED')
      assert.equal(failure.reviewFailure.stopReason, 'max_output_tokens')
      assert.equal(failure.reviewFailure.usageComplete, true)
      assert.equal(failure.reviewUsage.outputTokens, 7424)
      return true
    },
  )
})

test('isolated Reviewer reads frozen evidence then submits structured feedback and aggregates calls', async () => {
  const requests: ProviderRequest[] = []
  const readerCalls: unknown[] = []
  const reviewer = new ProviderSemanticReviewerV1(
    provider(async function* (input) {
      requests.push({ ...input, messages: structuredClone(input.messages) })
      if (requests.length === 1) {
        yield {
          type: 'tool_calls',
          calls: [
            {
              id: 'read-1',
              name: 'read_review_evidence',
              input: { ref: 'artifact-visible', offset: 10, length: 20 },
            },
          ],
        }
      } else {
        assert.match(String(input.messages.at(-1)?.content), /frozen observation/u)
        yield {
          type: 'tool_calls',
          calls: [{ id: 'submit', name: 'submit_review_plan_decision', input: decision }],
        }
      }
      yield { type: 'completed', usage: { inputTokens: 7, outputTokens: 3, cacheReadTokens: 2 } }
    }),
    'fixture-model',
  )
  const result = await reviewer.review({
    ...request,
    readEvidence: (...args) => {
      readerCalls.push(args)
      return { content: 'frozen observation' }
    },
  })
  assert.deepEqual(readerCalls, [['artifact-visible', 10, 20]])
  assert.deepEqual(result.usage, { inputTokens: 14, outputTokens: 6, cacheReadTokens: 4 })
  assert.deepEqual(result.decision, decision)
  assert.equal(requests.length, 2)
  assert.equal(result.evidenceReads?.[0]?.ref, 'artifact-visible')
  assert.ok(requests[0]?.tools.some(({ name }) => name === 'read_review_evidence'))
})

test('Reviewer cannot read foreign evidence or mix an uninspected read with acceptance', async () => {
  for (const calls of [
    [
      {
        id: 'foreign',
        name: 'read_review_evidence',
        input: { ref: 'artifact-foreign', offset: 0, length: 10 },
      },
    ],
    [
      {
        id: 'read',
        name: 'read_review_evidence',
        input: { ref: 'artifact-visible', offset: 0, length: 10 },
      },
      { id: 'submit', name: 'submit_review_plan_decision', input: decision },
    ],
  ]) {
    let reads = 0
    const reviewer = new ProviderSemanticReviewerV1(
      provider(async function* () {
        yield { type: 'tool_calls', calls }
        yield { type: 'completed', usage: { inputTokens: 11 } }
      }),
      'fixture-model',
    )
    await assert.rejects(
      reviewer.review({
        ...request,
        readEvidence: () => {
          reads += 1
          return {}
        },
      }),
      (error: unknown) => {
        assert.equal((error as { code: string }).code, 'REVIEW_EVIDENCE_READ_INVALID')
        assert.deepEqual((error as { reviewUsage: ProviderUsage }).reviewUsage, { inputTokens: 11 })
        return true
      },
    )
    assert.equal(reads, 0)
  }
})

test('evidence read allowance ends in a forced decision instead of an unbounded agent loop', async () => {
  let calls = 0
  const reviewer = new ProviderSemanticReviewerV1(
    provider(async function* (input) {
      calls += 1
      if (calls <= MAX_EVIDENCE_READS) {
        yield {
          type: 'tool_calls',
          calls: [
            {
              id: `read-${calls}`,
              name: 'read_review_evidence',
              input: { ref: 'artifact-visible', offset: calls, length: 1 },
            },
          ],
        }
      } else {
        assert.deepEqual(input.toolChoice, { name: 'submit_review_plan_decision' })
        assert.deepEqual(
          input.tools.map(({ name }) => name),
          ['submit_review_plan_decision'],
        )
        yield {
          type: 'tool_calls',
          calls: [{ id: 'submit', name: 'submit_review_plan_decision', input: decision }],
        }
      }
      yield { type: 'completed', usage: { inputTokens: 1 } }
    }),
    'fixture-model',
  )
  const result = await reviewer.review({ ...request, readEvidence: () => ({ content: 'x' }) })
  assert.equal(calls, MAX_EVIDENCE_READS + 1)
  assert.equal(result.evidenceReads?.length, MAX_EVIDENCE_READS)
  assert.equal(result.usage.inputTokens, calls)
})

test('a failed later Reviewer request preserves known partial usage without claiming complete billing', async () => {
  let calls = 0
  const reviewer = new ProviderSemanticReviewerV1(
    provider(async function* () {
      calls += 1
      if (calls === 2) throw new Error('transport interrupted')
      yield {
        type: 'tool_calls',
        calls: [
          {
            id: 'read',
            name: 'read_review_evidence',
            input: { ref: 'artifact-visible', offset: 0, length: 10 },
          },
        ],
      }
      yield { type: 'completed', usage: { inputTokens: 13 } }
    }),
    'fixture-model',
  )
  await assert.rejects(
    reviewer.review({ ...request, readEvidence: () => ({ content: 'sample' }) }),
    (error: unknown) => {
      assert.deepEqual((error as { reviewUsage: ProviderUsage }).reviewUsage, { inputTokens: 13 })
      assert.equal((error as { reviewUsageComplete: boolean }).reviewUsageComplete, false)
      return true
    },
  )
})

test('auxiliary call identities prevent duplicate charging without incrementing Root turns', () => {
  const run = { usage: { turns: 2, toolCalls: 3, subagents: 0, inputTokens: 5 } } as AgentRun
  recordAuxiliaryProviderUsageV1(run, 'review:1', { inputTokens: 7, outputTokens: 2 })
  recordAuxiliaryProviderUsageV1(run, 'review:1', { inputTokens: 7, outputTokens: 2 })
  recordAuxiliaryProviderUsageV1(run, 'review:2', { inputTokens: 11 })
  assert.deepEqual(run.usage, {
    turns: 2,
    toolCalls: 3,
    subagents: 0,
    inputTokens: 23,
    outputTokens: 2,
  })
})

test('registered checks are Host-pinned, evidence-bound and exposed only when available', async () => {
  const digest = `sha256:${'a'.repeat(64)}` as const
  let calls = 0
  const registry = new RegisteredReviewChecksV1([
    {
      id: 'structured-data',
      version: '1',
      digest,
      description: 'Validate structured output with the Host contract.',
      expectedExitCodes: [0],
      async evaluate(input) {
        calls += 1
        assert.equal(input.evidence[0]?.ref, 'artifact-visible')
        return {
          exitCode: 0,
          reason: 'Frozen structured data satisfies the Host validator.',
          evidenceRefs: ['artifact-visible'],
        }
      },
    },
  ])
  const check = {
    checker: 'registered_check' as const,
    checkerId: 'structured-data',
    checkerVersion: '1',
    checkerDigest: digest,
    expectedExitCodes: [0],
  }
  const evidence = [{ ref: 'artifact-visible', value: { result: 'observed' } }]
  assert.equal((await registry.evaluate(check, evidence, request.signal)).status, 'passed')
  assert.equal(
    (await registry.evaluate({ ...check, expectedExitCodes: [1] }, evidence, request.signal))
      .status,
    'unverifiable',
  )
  assert.equal(
    (await registry.evaluate({ ...check, checkerVersion: '2' }, evidence, request.signal)).status,
    'unverifiable',
  )
  assert.equal(calls, 1)
  assert.doesNotMatch(JSON.stringify(planDefinitionPropertiesV1()), /registered_check/u)
  assert.match(
    JSON.stringify(planDefinitionPropertiesV1(registry.definitions())),
    /structured-data/u,
  )
})

test('deterministic continuation keeps only the latest assistant intention, not all historical next steps', async () => {
  const generator = new DeterministicSummaryGenerator()
  const first = await generator.generate({
    messages: [{ role: 'assistant', content: 'Next inspect the draft.' }],
  })
  assert.ok(first.activePlan.some((entry) => entry.includes('draft')))
  const next = await generator.generate({
    previous: first,
    messages: [
      { role: 'assistant', content: 'Next inspect the draft again.' },
      { role: 'assistant', content: 'The draft was inspected. Next verify the installed package.' },
    ],
  })
  assert.equal(
    next.activePlan.some((entry) => entry.includes('again')),
    false,
  )
  assert.equal(next.activePlan.includes('intent: Next inspect the draft.'), false)
  assert.ok(next.activePlan.some((entry) => entry.includes('installed package')))
})

test('semantic continuation can supersede old intentions without erasing the task contract', async () => {
  const checkpoint = await new CompactionService({
    generator: {
      identity: { kind: 'model', id: 'fixture', provider: 'fixture', model: 'fixture' },
      async generate() {
        return {
          objective: 'invented objective',
          decisions: [],
          constraints: [],
          readFiles: [],
          modifiedFiles: [],
          unresolved: [],
          activePlan: ['Verify the final deliverable.'],
        }
      },
    },
    retainRecentMessages: 1,
    compactionPolicy: { minimumGain: 0 },
  }).compact({
    sessionId: 'semantic-frontier',
    messages: [
      { role: 'user', content: 'Deliver the validated package.' },
      { role: 'assistant', content: 'Next inspect the old draft.' },
      { role: 'user', content: 'Continue.' },
    ],
  })
  assert.equal(checkpoint?.summary?.objective, 'Deliver the validated package.')
  assert.deepEqual(checkpoint?.summary?.activePlan, ['Verify the final deliverable.'])
  assert.equal(
    checkpoint?.summary?.unresolved.some((entry) => entry.includes('old draft')),
    false,
  )
})

test('failed structured compaction retains measured usage when a deterministic fallback succeeds', async () => {
  for (const response of ['not structured JSON', '{"unknown":true}']) {
    const generator = new ProviderCompactionSummaryGenerator(
      provider(async function* () {
        yield { type: 'text_delta', text: response }
        yield { type: 'completed', usage: { inputTokens: 13, outputTokens: 3, cacheReadTokens: 2 } }
      }),
      { model: 'fixture-model', messages: [], tools: [], signal: request.signal },
    )
    const result = await new CompactionService({
      generator,
      retainRecentMessages: 1,
      compactionPolicy: { minimumGain: 0 },
    }).compactDetailed({
      sessionId: 'measured-fallback',
      messages: [
        { role: 'user', content: 'Deliver the validated package.' },
        { role: 'assistant', content: 'Next verify the package.' },
        { role: 'user', content: 'Continue.' },
      ],
    })
    assert.equal(result.status, 'compacted')
    if (result.status !== 'compacted') continue
    assert.deepEqual(result.usage, { inputTokens: 13, outputTokens: 3, cacheReadTokens: 2 })
    assert.match(result.checkpoint.provenance?.failureCode ?? '', /^COMPACTION_/u)
  }
})

test('low-gain compaction still returns measured usage for the rejected checkpoint', async () => {
  const result = await new CompactionService({
    generator: {
      identity: { kind: 'model', id: 'fixture', provider: 'fixture', model: 'fixture' },
      async generate() {
        return {
          summary: {
            decisions: [],
            constraints: [],
            readFiles: [],
            modifiedFiles: [],
            unresolved: [],
            activePlan: ['Verify output.'],
          },
          usage: { inputTokens: 19, outputTokens: 2 },
        }
      },
    },
    retainRecentMessages: 1,
    compactionPolicy: { minimumGain: 1_000_000 },
  }).compactDetailed({
    sessionId: 'low-gain-billing',
    messages: [
      { role: 'user', content: 'Validate the output.' },
      { role: 'assistant', content: 'Next verify output.' },
      { role: 'user', content: 'Continue.' },
    ],
  })
  assert.equal(result.status, 'low_gain')
  if (result.status === 'low_gain')
    assert.deepEqual(result.usage, { inputTokens: 19, outputTokens: 2 })
})

test('coordinator exposes frozen file tails and task contract during Item review', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-review-general-'))
  const repository = new SessionRepositoryV3({ root: join(root, 'sessions'), store: 'jsonl' })
  try {
    await repository.initialize()
    await writeFile(join(root, 'output.txt'), `${'x'.repeat(90_000)}ORIGINAL_TAIL`, 'utf8')
    await repository.create({
      sessionId: 'session-review',
      state: 'idle',
      cwd: root,
      provider: 'fixture',
      model: 'fixture',
      createdAt: '2026-09-05T00:00:00.000Z',
      updatedAt: '2026-09-05T00:00:00.000Z',
    })
    await repository.appendRequestMessage(
      'session-review',
      'request',
      'run-review',
      { role: 'user', content: 'Produce a complete, verified deliverable.' },
      'optional',
    )
    const control = new PlanControlServiceV1(repository.journal())
    const invocation = (suffix: string) => ({
      invocationId: `pti_${suffix}` as const,
      sessionId: 'session-review',
      runId: 'run-review',
      providerTurnId: suffix,
      providerToolCallId: suffix,
    })
    await control.create({
      sessionId: 'session-review',
      invocation: invocation('create'),
      input: {
        objective: 'Produce the deliverable.',
        acceptanceCriteria: [
          {
            id: 'exists',
            description: 'Output exists.',
            kind: 'mechanical',
            required: true,
            check: { checker: 'file_rule', path: 'output.txt', rule: { kind: 'exists' } },
          },
          {
            id: 'format',
            description: 'Host format check.',
            kind: 'mechanical',
            required: true,
            check: {
              checker: 'registered_check',
              checkerId: 'host-format',
              checkerVersion: '1',
              checkerDigest: `sha256:${'a'.repeat(64)}`,
              expectedExitCodes: [0],
            },
          },
          {
            id: 'behavior',
            description: 'Output satisfies the original task.',
            kind: 'semantic',
            required: true,
          },
        ],
        items: [
          {
            id: 'work',
            title: 'Produce output',
            criterionIds: ['exists', 'behavior', 'format'],
            reviewCheckpoint: true,
          },
        ],
      },
    })
    await control.progress({
      sessionId: 'session-review',
      expectedPlanRevision: 1,
      invocation: invocation('start'),
      action: { kind: 'start', itemId: 'work' },
    })
    const coordinator = new ReviewCoordinatorV1({
      journal: repository.journal(),
      control,
      artifacts: new ArtifactStore(join(root, 'artifacts')),
      registeredChecks: new RegisteredReviewChecksV1([
        {
          id: 'host-format',
          version: '1',
          digest: `sha256:${'a'.repeat(64)}`,
          description: 'Frozen output check.',
          expectedExitCodes: [0],
          async evaluate(input) {
            const file = input.evidence.find(
              ({ value }) => (value as { kind?: string }).kind === 'review_prepared_file',
            )!
            assert.match(JSON.stringify(file.value), /ORIGINAL_TAIL/u)
            return {
              exitCode: 0,
              reason: 'The frozen output matches the Host format.',
              evidenceRefs: [file.ref],
            }
          },
        },
      ]),
      reviewer: {
        async review(input) {
          const payload = input.neutralPayload as {
            originalTaskContract: { text: string }
            evidenceManifest: {
              entries: { ref: string; source: string; truncated: boolean; contentBytes: number }[]
            }
            deterministicResults: { criterionId: string; status: string }[]
          }
          assert.equal(
            payload.originalTaskContract.text,
            'Produce a complete, verified deliverable.',
          )
          assert.equal(
            payload.deterministicResults.find(({ criterionId }) => criterionId === 'behavior')
              ?.status,
            'deferred',
          )
          assert.equal(
            payload.deterministicResults.find(({ criterionId }) => criterionId === 'format')
              ?.status,
            'passed',
          )
          const file = payload.evidenceManifest.entries.find(
            ({ source }) => source === 'prepared_file',
          )!
          assert.equal(file.truncated, true)
          assert.equal(Reflect.get(file, 'context').path, 'output.txt')
          assert.ok(input.readEvidence)
          await writeFile(join(root, 'output.txt'), 'MUTATED_LIVE_FILE')
          const tail = input.readEvidence(file.ref, 89_000, 16_384)
          assert.match(String(tail.content), /ORIGINAL_TAIL/u)
          assert.doesNotMatch(String(tail.content), /MUTATED_LIVE_FILE/u)
          assert.throws(() => input.readEvidence!('artifact-foreign', 0, 100))
          return {
            decision: {
              verdict: 'needs_fix',
              summary: 'Need behavioral evidence, not a file rewrite.',
              findings: input.criterionIds.map((criterionId) => ({
                criterionId,
                status: 'unverifiable',
                reason: 'Supply outcome evidence.',
                evidenceRefs: [file.ref],
              })),
            },
            rawResponse: '{}',
            usage: {},
          }
        },
      },
    })
    const result = await coordinator.review(
      {
        sessionId: 'session-review',
        expectedPlanRevision: 1,
        invocation: invocation('review'),
        scope: { kind: 'item', itemId: 'work' },
        summary: 'Done.',
        evidenceRefs: [],
      },
      new AbortController().signal,
    )
    assert.equal(result.status, 'needs_fix')
    assert.equal(result.findings?.length, 3)
  } finally {
    await repository.close()
    await rm(root, { recursive: true, force: true })
  }
})
