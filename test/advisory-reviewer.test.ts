import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ChatProvider, ProviderCapabilities } from '@praxis/core-sdk'
import {
  ProviderAdvisoryReviewerV1,
  validateAdvisoryReviewV1,
} from '../apps/runtime/src/working-plan/advisoryReviewer.js'
import { safeReviewFailureV1 } from '../apps/runtime/src/review-plan/reviewDiagnostics.js'

const request = {
  reviewRequestId: 'advisory-test',
  neutralPayload: { reviewContract: { version: 1, kind: 'advisory-v1' } },
  criterionIds: ['interface', 'behavior'],
  evidenceRefs: ['receipt-2'],
  signal: new AbortController().signal,
}
const response = {
  summary: 'The declared interface differs from the requirement; behavior needs a check.',
  findings: [
    {
      criterionId: 'interface',
      status: 'concern',
      reason: 'The timeout unit differs from the contract.',
      evidenceRefs: ['receipt-2'],
    },
    {
      criterionId: 'behavior',
      status: 'unknown',
      reason: 'No invocation observed.',
      evidenceRefs: [],
    },
  ],
}

for (const native of [false, true]) {
  test(`advisory ${native ? 'native JSON' : 'forced Tool'} uses its own contract without proof or acceptance verdict`, async () => {
    let count = 0
    const provider: ChatProvider = {
      id: 'fixture',
      defaultModel: 'fixture',
      authState: () => ({ status: 'authenticated' }),
      ...(native
        ? { capabilities: { output: { jsonSchema: true }, limits: {} } as ProviderCapabilities }
        : {}),
      async *stream(input) {
        count++
        assert.match(input.instructions ?? '', /advisory reviewer/)
        assert.doesNotMatch(
          input.instructions ?? '',
          /isolated Praxis ReviewPlan semantic reviewer/,
        )
        assert.deepEqual(input.contextMessages, [])
        const schema = native ? input.responseFormat : input.tools[0]?.parameters
        assert.doesNotMatch(JSON.stringify(schema), /"proof"|"verdict"|unresolvedAssumptions/)
        if (native) {
          assert.deepEqual(input.tools, [])
          yield { type: 'text_delta', text: JSON.stringify(response) }
        } else {
          assert.deepEqual(input.toolChoice, { name: 'submit_advisory_review' })
          yield {
            type: 'tool_calls',
            calls: [{ id: 'review', name: 'submit_advisory_review', input: response }],
          }
        }
        yield {
          type: 'completed',
          stopReason: native ? 'end_turn' : 'tool_calls',
          usage: { inputTokens: 18, outputTokens: 12 },
        }
      },
    }
    const result = await new ProviderAdvisoryReviewerV1(provider, 'fixture').review(request)
    assert.equal(count, 1)
    assert.equal(result.decision.verdict, 'needs_fix')
    assert.deepEqual(
      result.decision.findings.map((f) => f.status),
      ['failed', 'unverifiable'],
    )
    assert.equal(result.usage.outputTokens, 12)
  })
}

test('malformed sibling, missing and duplicate findings degrade locally without discarding useful concerns', () => {
  const output = validateAdvisoryReviewV1(
    {
      ...response,
      findings: [
        response.findings[0],
        {
          criterionId: 'behavior',
          status: 'supported',
          reason: 'A claim.',
          evidenceRefs: ['foreign-receipt'],
        },
        {
          criterionId: 'duplicate',
          status: 'supported',
          reason: 'First.',
          evidenceRefs: ['receipt-2'],
        },
        {
          criterionId: 'duplicate',
          status: 'concern',
          reason: 'Conflicting.',
          evidenceRefs: ['receipt-2'],
        },
        {
          criterionId: 'not-requested',
          status: 'supported',
          reason: 'Out of scope.',
          evidenceRefs: ['receipt-2'],
        },
      ],
    },
    ['interface', 'behavior', 'missing', 'duplicate'],
    request.evidenceRefs,
  )
  assert.equal(output.findings[0]?.status, 'failed')
  assert.deepEqual(
    output.findings.slice(1).map((f) => f.status),
    ['unverifiable', 'unverifiable', 'unverifiable'],
  )
  assert.deepEqual(output.findings[1]?.evidenceRefs, [])
  assert.match(output.findings[3]!.reason, /duplicate/)
  assert.equal(output.findings.length, 4)
  assert.notEqual(output.verdict, 'accepted')
})

test('advisory never accepts unsupported or legacy proof-bearing claims', () => {
  for (const extra of [{ evidenceRefs: [] }, { proof: { unresolvedAssumptions: ['none'] } }]) {
    const output = validateAdvisoryReviewV1(
      {
        summary: 'Accepted!',
        verdict: 'accepted',
        findings: [
          {
            criterionId: 'interface',
            status: 'supported',
            reason: 'Claim.',
            evidenceRefs: ['receipt-2'],
            ...extra,
          },
        ],
      },
      ['interface'],
      request.evidenceRefs,
    )
    assert.equal(output.findings[0]?.status, 'unverifiable')
    assert.notEqual(output.verdict, 'accepted')
  }
})

test('advisory preserves an evidence-bound supported finding without requiring proof fields', () => {
  const output = validateAdvisoryReviewV1(
    {
      summary: 'Observed.',
      findings: [
        {
          criterionId: 'interface',
          status: 'supported',
          reason: 'Declared units match the requirement.',
          evidenceRefs: ['receipt-2'],
        },
      ],
    },
    ['interface'],
    request.evidenceRefs,
  )
  assert.equal(output.findings[0]?.status, 'passed')
  assert.equal(output.verdict, 'accepted') // Storage compatibility, not Runtime authority.
})

test('unreadable advisory keeps submitted structure, validation hint and usage for local diagnostics', async () => {
  const provider: ChatProvider = {
    id: 'fixture',
    defaultModel: 'fixture',
    authState: () => ({ status: 'authenticated' }),
    async *stream() {
      yield {
        type: 'tool_calls',
        calls: [
          {
            id: 'review',
            name: 'submit_advisory_review',
            input: { summary: '', findings: 'wrong type' },
          },
        ],
      }
      yield { type: 'completed', stopReason: 'tool_calls', usage: { outputTokens: 9 } }
    },
  }
  await assert.rejects(
    new ProviderAdvisoryReviewerV1(provider, 'fixture').review(request),
    (error: unknown) => {
      const e = error as {
        reviewFailure: { submittedResponse: unknown; validationHint: string }
        reviewUsage: { outputTokens: number }
      }
      assert.deepEqual(e.reviewFailure.submittedResponse, { summary: '', findings: 'wrong type' })
      assert.match(e.reviewFailure.validationHint, /nonempty summary/)
      assert.equal(e.reviewUsage.outputTokens, 9)
      return true
    },
  )
})

test('submitted diagnostics redact secret keys and token patterns while preserving invalid types and empty values', () => {
  const result = safeReviewFailureV1({
    code: 'REVIEW_RESPONSE_INVALID',
    stage: 'validation',
    usageComplete: true,
    submittedResponse: {
      summary: '',
      findings: [{ proof: { unresolvedAssumptions: ['none'] } }],
      api_key: 'secret-value',
      reason: 'Bearer ABCDEFG and sk-1234567890abcdefgh',
      thinking: 'private trace',
    },
  })
  const serialized = JSON.stringify(result)
  assert.doesNotMatch(serialized, /secret-value|ABCDEFG|1234567890abcdefgh|private trace/)
  assert.match(serialized, /unresolvedAssumptions/)
  assert.match(serialized, /"summary":""/)
  assert.match(serialized, /none/)
  const oversized = safeReviewFailureV1({
    ...result,
    submittedResponse: { summary: 'x'.repeat(100_000) },
  })
  assert.equal((oversized.submittedResponse as { truncated: boolean }).truncated, true)
})
