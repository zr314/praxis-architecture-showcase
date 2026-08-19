import assert from 'node:assert/strict'
import test from 'node:test'
import type { ExecutionBudget } from '@praxis/core-sdk'
import { ChildResultSubmissionToolV1 } from '../apps/runtime/src/subagent/childResultSubmissionTool.js'
import {
  assertContextPacketAuthority,
  type ContextPacketV1,
  createSubagentResultV1,
  renderContextPacketPrompt,
  type SubagentResultV1,
  validateContextPacketV1,
  validateSubagentResultV1,
} from '../apps/runtime/src/subagent/contextPacket.js'
import { mockChildCapabilityBundle } from './support/child-capability.js'

const digest = (character: string): `sha256:${string}` => `sha256:${character.repeat(64)}`

test('Child result submission is a fail-closed commit point for exact criterion IDs', async () => {
  const tool = new ChildResultSubmissionToolV1(
    {
      type: 'object',
      required: ['summary', 'criteria'],
      properties: {
        summary: { type: 'string' },
        criteria: { type: 'array' },
      },
    },
    ['criterion-1'],
  )
  const request = (input: Record<string, unknown>) =>
    tool.execute({
      name: tool.definition.name,
      input,
      cwd: process.cwd(),
      signal: new AbortController().signal,
    })

  assert.equal(
    (
      await request({
        summary: 'invalid',
        criteria: [{ id: 'invented', status: 'passed', summary: 'not admitted' }],
      })
    ).error?.code,
    'CHILD_RESULT_CRITERIA_INVALID',
  )
  assert.deepEqual(
    await request({
      summary: 'valid',
      criteria: [{ id: 'criterion-1', status: 'passed', summary: 'verified' }],
    }),
    {
      ok: true,
      summary: 'The complete Child result was validated and committed.',
      output: {
        summary: 'valid',
        criteria: [{ id: 'criterion-1', status: 'passed', summary: 'verified' }],
      },
    },
  )
})

test('ContextPacketV1 is self-contained, bounded, immutable, and prompt-renderable', () => {
  const input = contextPacket()
  const packet = validateContextPacketV1(input)

  assert.deepEqual(packet, input)
  assert.notEqual(packet, input)
  assert.equal(Object.isFrozen(packet), true)
  assert.equal(Object.isFrozen(packet.step), true)
  assert.equal(Object.isFrozen(packet.relevantRefs), true)
  assert.equal(Object.isFrozen(packet.outputSchema.schema), true)

  const prompt = renderContextPacketPrompt(packet)
  assert.match(prompt, /PRAXIS_CONTEXT_PACKET_V1/u)
  assert.match(prompt, /Inspect the workspace/u)
  assert.match(prompt, /artifact_ref/u)
  assert.match(prompt, /parent transport threshold/u)
  assert.match(prompt, /Do not compress, retry, or repeat/u)
  assert.doesNotMatch(prompt, /return an artifact reference and digest/iu)
  assert.doesNotMatch(prompt, /conversation|transcript/iu)
})

test('ContextPacketV1 rejects unknown fields, versions, oversize, and invalid grants', () => {
  const privateObjective = 'private-objective-must-not-enter-errors'
  for (const [candidate, code] of [
    [{ ...contextPacket(), unknown: true }, 'SUBAGENT_CONTEXT_PACKET_INVALID'],
    [{ ...contextPacket(), schemaVersion: 2 }, 'SUBAGENT_CONTEXT_PACKET_VERSION_UNSUPPORTED'],
    [
      { ...contextPacket(), objective: privateObjective.repeat(6_000) },
      'SUBAGENT_CONTEXT_PACKET_OVERSIZED',
    ],
    [
      {
        ...contextPacket(),
        grant: { ...contextPacket().grant, tools: ['read', 'read'] },
      },
      'SUBAGENT_CONTEXT_PACKET_INVALID',
    ],
    [
      {
        ...contextPacket(),
        outputSchema: { ...contextPacket().outputSchema, overflow: 'truncate' },
      },
      'SUBAGENT_CONTEXT_PACKET_INVALID',
    ],
  ] as const) {
    assert.throws(
      () => validateContextPacketV1(candidate),
      (error: unknown) => hasFailure(error, code, privateObjective),
      code,
    )
  }
})

test('ContextPacketV1 authority binding rejects valid but unauthorized grant drift', () => {
  const methods = [
    'initialize',
    'events.subscribe',
    'session.create',
    'session.prompt',
    'shutdown',
  ] as const
  const bundle = mockChildCapabilityBundle({ methods })
  const input = contextPacket()
  const packet = validateContextPacketV1({
    ...input,
    grant: {
      bundleId: bundle.bundleId,
      bundleDigest: bundle.digest,
      provider: bundle.provider.target,
      tools: bundle.tools.map((tool) => tool.name),
      skills: bundle.skills.map((skill) => skill.id),
      methods: [...bundle.methodAllowlist],
      mcpMode: bundle.mcp.mode,
    },
  })
  const authority = {
    workspace: packet.workspace,
    provider: bundle.provider.target,
    capabilityBundle: bundle,
  } as const

  assert.deepEqual(assertContextPacketAuthority(packet, authority), packet)
  assert.throws(
    () =>
      assertContextPacketAuthority({ ...packet, grant: { ...packet.grant, tools: [] } }, authority),
    (error: unknown) =>
      hasFailure(error, 'SUBAGENT_CONTEXT_PACKET_AUTHORITY_MISMATCH', packet.objective),
  )
})

test('SubagentResultV1 accepts bounded evidence refs instead of inline large output', () => {
  const result = createSubagentResultV1({
    childRunId: 'child-1',
    status: 'succeeded',
    summary: 'Analysis is stored as a bounded artifact.',
    evidenceRefs: [
      {
        kind: 'artifact',
        ref: 'artifact:child-1/analysis.json',
        digest: digest('b'),
        mediaType: 'application/json',
      },
    ],
    changedFiles: [],
    checks: [{ id: 'check-1', status: 'passed', summary: 'Schema validated.' }],
    usage: {
      turns: 1,
      toolCalls: 1,
      inputTokens: 12,
      outputTokens: 8,
      subagents: 0,
    },
    retryable: false,
  })

  assert.equal(result.schemaVersion, 1)
  assert.equal(Object.isFrozen(result), true)
  assert.equal(Object.isFrozen(result.evidenceRefs[0]), true)
  assert.equal(result.evidenceRefs[0]?.digest, digest('b'))
  assert.equal('events' in result, false)
  assert.deepEqual(validateSubagentResultV1(result), result)
})

test('SubagentResultV1 enforces terminal/error invariants and strict bounded schemas', () => {
  const success = subagentResult()
  const privateSummary = 'private-result-must-not-enter-errors'
  for (const [candidate, code] of [
    [{ ...success, extra: true }, 'SUBAGENT_RESULT_INVALID'],
    [{ ...success, schemaVersion: 2 }, 'SUBAGENT_RESULT_VERSION_UNSUPPORTED'],
    [{ ...success, childRunId: 'invalid child id' }, 'SUBAGENT_RESULT_INVALID'],
    [{ ...success, summary: '' }, 'SUBAGENT_RESULT_INVALID'],
    [{ ...success, summary: privateSummary.repeat(3_000) }, 'SUBAGENT_RESULT_OVERSIZED'],
    [
      {
        ...success,
        status: 'failed',
        retryable: true,
      },
      'SUBAGENT_RESULT_INVALID',
    ],
    [
      {
        ...success,
        error: {
          code: 'UNEXPECTED',
          category: 'execution',
          message: 'success cannot carry error',
          retryable: false,
        },
      },
      'SUBAGENT_RESULT_INVALID',
    ],
    [
      {
        ...success,
        evidenceRefs: [
          {
            kind: 'artifact',
            ref: 'artifact:missing-digest',
            digest: 'not-a-digest',
          },
        ],
      },
      'SUBAGENT_RESULT_INVALID',
    ],
  ] as const) {
    assert.throws(
      () => validateSubagentResultV1(candidate),
      (error: unknown) => hasFailure(error, code, privateSummary),
      code,
    )
  }

  const failed = validateSubagentResultV1({
    ...success,
    status: 'failed',
    summary: 'Child execution failed.',
    retryable: true,
    error: {
      code: 'CHILD_PROMPT_FAILED',
      category: 'execution',
      message: 'The child prompt did not complete.',
      retryable: true,
    },
  })
  assert.equal(failed.status, 'failed')
  assert.equal(failed.error?.retryable, failed.retryable)
})

function contextPacket(): ContextPacketV1 {
  const deadlineAt = new Date(Date.now() + 60_000).toISOString()
  return {
    schemaVersion: 1,
    packetId: 'packet-1',
    parentRunId: 'parent-1',
    childRunId: 'child-1',
    objective: 'Inspect the workspace and report evidence.',
    step: {
      stepId: 'step-1',
      title: 'Inspect the workspace',
      instructions: 'Read package.json and summarize the package name.',
    },
    constraints: ['Use only granted read-only capabilities.'],
    relevantRefs: [
      {
        kind: 'file',
        ref: 'package.json',
        digest: digest('a'),
        summary: 'Workspace package manifest.',
      },
    ],
    successCriteria: [
      {
        id: 'criterion-1',
        description: 'Report the package name with file evidence.',
      },
    ],
    workspace: { root: process.cwd(), access: 'read_only' },
    grant: {
      bundleId: 'bundle-1',
      bundleDigest: 'c'.repeat(64),
      provider: { providerId: 'mock', model: 'mock-v1' },
      tools: ['read'],
      skills: [],
      methods: ['initialize', 'events.subscribe', 'session.create', 'session.prompt', 'shutdown'],
      mcpMode: 'disabled',
    },
    budget: budget(deadlineAt),
    prohibitions: ['Do not modify files.', 'Do not spawn descendants.'],
    outputSchema: {
      format: 'json',
      schema: {
        type: 'object',
        required: ['summary'],
        properties: { summary: { type: 'string' } },
        additionalProperties: false,
      },
      maxInlineBytes: 4_096,
      overflow: 'artifact_ref',
    },
  }
}

function subagentResult(): SubagentResultV1 {
  return {
    schemaVersion: 1,
    childRunId: 'child-1',
    status: 'succeeded',
    summary: 'Package name identified.',
    evidenceRefs: [
      {
        kind: 'file',
        ref: 'package.json',
        digest: digest('a'),
      },
    ],
    changedFiles: [],
    checks: [{ id: 'criterion-1', status: 'passed', summary: 'Evidence matched.' }],
    usage: { turns: 1, toolCalls: 1, subagents: 0 },
    retryable: false,
  }
}

function budget(deadlineAt: string): ExecutionBudget {
  return {
    maxTurns: 2,
    maxToolCalls: 1,
    maxTokens: 1_000,
    maxChildRuns: 0,
    maxParallelChildren: 0,
    maxDepth: 0,
    deadlineAt,
  }
}

function hasFailure(error: unknown, code: string, privateText: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code &&
    'category' in error &&
    (error as { category?: unknown }).category === 'subagent' &&
    'retryable' in error &&
    (error as { retryable?: unknown }).retryable === false &&
    !String((error as { message?: unknown }).message).includes(privateText)
  )
}
