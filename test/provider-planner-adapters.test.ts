import assert from 'node:assert/strict'
import test from 'node:test'
import type { ChatProvider, ProviderChunk, ProviderRequest } from '@praxis/core-sdk'
import {
  PLAN_PROPOSAL_JSON_SCHEMA_V1,
  type PlanGeneratorModelInputV1,
} from '../apps/runtime/src/planner/planGenerator.js'
import { ProviderPlanGeneratorModelPortV1 } from '../apps/runtime/src/planner/providerPlanGenerator.js'
import { ProviderSemanticVerifierModelPortV1 } from '../apps/runtime/src/planner/providerSemanticVerifier.js'
import {
  SEMANTIC_VERIFICATION_JSON_SCHEMA_V1,
  type SemanticVerifierModelInputV1,
} from '../apps/runtime/src/planner/verifier.js'

test('Provider plan adapter submits a strict dynamic DAG through the synthetic tool port', async () => {
  const proposal = {
    objective: 'Modify and verify the project',
    steps: [
      {
        key: 'implement',
        title: 'Implement the change',
        access: { mode: 'workspace_write', paths: ['.'] },
        capabilities: ['write', 'shell'],
        conflictKeys: ['workspace'],
        criteria: [{ kind: 'schema', description: 'Structured result is valid.' }],
      },
    ],
  }
  let requestTools: readonly string[] = []
  let reasoningMode: string | undefined
  let toolChoice: unknown
  const provider = syntheticToolProvider(
    'submit_supervisor_plan',
    proposal,
    (tools) => {
      requestTools = tools
    },
    (mode) => {
      reasoningMode = mode
    },
    (choice) => {
      toolChoice = choice
    },
  )
  const output = await new ProviderPlanGeneratorModelPortV1(provider, 'fixture-model').generate({
    objective: proposal.objective,
    context: { tools: ['write', 'shell'] },
    responseFormat: {
      type: 'json_schema',
      name: 'praxis_plan_proposal_v1',
      strict: true,
      schema: PLAN_PROPOSAL_JSON_SCHEMA_V1,
    },
    maxOutputTokens: 2_048,
    signal: new AbortController().signal,
  } satisfies PlanGeneratorModelInputV1)

  assert.deepEqual(output.output, proposal)
  assert.deepEqual(requestTools, ['submit_supervisor_plan'])
  assert.equal(reasoningMode, 'compact')
  assert.deepEqual(toolChoice, { name: 'submit_supervisor_plan' })
  assert.deepEqual(output.usage, { inputTokens: 30, outputTokens: 20, costUsd: 0.01 })
})

test('Provider plan adapter reports a truncated proposal instead of schema invalid', async () => {
  const provider: ChatProvider = {
    id: 'fixture',
    defaultModel: 'fixture-model',
    authState: () => ({ status: 'authenticated' }),
    async *stream() {
      yield { type: 'reasoning_delta', contentIndex: 0, text: 'Still planning' }
      yield { type: 'completed', stopReason: 'length', usage: { outputTokens: 2_048 } }
    },
  }

  await assert.rejects(
    new ProviderPlanGeneratorModelPortV1(provider, 'fixture-model').generate({
      objective: 'Return a bounded plan',
      responseFormat: {
        type: 'json_schema',
        name: 'praxis_plan_proposal_v1',
        strict: true,
        schema: PLAN_PROPOSAL_JSON_SCHEMA_V1,
      },
      maxOutputTokens: 2_048,
      signal: new AbortController().signal,
    }),
    (error: unknown) =>
      typeof error === 'object' &&
      error !== null &&
      Reflect.get(error, 'code') === 'PLAN_GENERATOR_OUTPUT_TRUNCATED',
  )
})

test('Provider plan adapter marks failures after partial output as unsafe to retry', async () => {
  const provider: ChatProvider = {
    id: 'fixture',
    defaultModel: 'fixture-model',
    authState: () => ({ status: 'authenticated' }),
    async *stream() {
      yield { type: 'text_delta', text: '{' }
      throw Object.assign(new Error('fixture rate limit'), { status: 429 })
    },
  }

  await assert.rejects(
    new ProviderPlanGeneratorModelPortV1(provider, 'fixture-model').generate({
      objective: 'Do not retry partial output',
      responseFormat: {
        type: 'json_schema',
        name: 'praxis_plan_proposal_v1',
        strict: true,
        schema: PLAN_PROPOSAL_JSON_SCHEMA_V1,
      },
      maxOutputTokens: 2_048,
      signal: new AbortController().signal,
    }),
    (error: unknown) =>
      typeof error === 'object' &&
      error !== null &&
      Reflect.get(error, 'planProviderOutputStarted') === true &&
      Reflect.get(Reflect.get(error, 'cause') as object, 'status') === 429,
  )
})

test('Provider semantic adapter returns only evidence-bound criterion decisions', async () => {
  const decision = {
    criteria: [
      {
        criterionId: 'semantic-1',
        status: 'passed',
        evidenceRefs: ['artifact://evidence'],
      },
    ],
  }
  let toolChoice: unknown
  const provider = syntheticToolProvider(
    'submit_semantic_verification',
    decision,
    undefined,
    undefined,
    (choice) => {
      toolChoice = choice
    },
  )
  const output = await new ProviderSemanticVerifierModelPortV1(provider, 'fixture-model').verify({
    identity: {
      role: 'semantic_verifier',
      verifierRunId: 'semantic-run',
      modelId: 'fixture/fixture-model',
    },
    context: { mode: 'fresh' },
    criteria: [
      {
        criterionId: 'semantic-1',
        kind: 'semantic',
        description: 'The implementation satisfies the request.',
      },
    ],
    result: {
      status: 'succeeded',
      summary: 'Implemented and checked.',
      evidenceRefs: [
        {
          kind: 'artifact',
          ref: 'artifact://evidence',
          digest: `sha256:${'a'.repeat(64)}`,
        },
      ],
      changedFiles: [],
      checks: [],
    },
    responseFormat: {
      type: 'json_schema',
      name: 'praxis_semantic_verification_v1',
      strict: true,
      schema: SEMANTIC_VERIFICATION_JSON_SCHEMA_V1,
    },
    maxOutputTokens: 1_024,
    signal: new AbortController().signal,
  } satisfies SemanticVerifierModelInputV1)

  assert.deepEqual(output.output, decision)
  assert.deepEqual(toolChoice, { name: 'submit_semantic_verification' })
})

test('Provider semantic adapter accepts one fenced JSON decision with surrounding prose', async () => {
  const decision = {
    criteria: [
      {
        criterionId: 'semantic-1',
        status: 'passed',
        evidenceRefs: ['artifact://evidence'],
      },
    ],
  }
  const provider: ChatProvider = {
    id: 'prose-fixture',
    defaultModel: 'fixture-model',
    authState: () => ({ status: 'authenticated' }),
    async *stream() {
      yield {
        type: 'text_delta' as const,
        text: `Verification follows:\n\`\`\`json\n${JSON.stringify(decision)}\n\`\`\``,
      }
      yield { type: 'completed' as const }
    },
  }
  const output = await new ProviderSemanticVerifierModelPortV1(provider, 'fixture-model').verify(
    semanticInput(),
  )
  assert.deepEqual(output.output, decision)
})

test('default auxiliary model requests compile lean contracts into one Trusted Instructions block', async () => {
  const requests: ProviderRequest[] = []
  const planProvider = syntheticToolProvider(
    'submit_supervisor_plan',
    { objective: 'Inspect', steps: [] },
    undefined,
    undefined,
    undefined,
    (request) => requests.push(request),
  )
  await new ProviderPlanGeneratorModelPortV1(planProvider, 'fixture-model').generate({
    objective: 'Inspect',
    responseFormat: {
      type: 'json_schema',
      name: 'praxis_plan_proposal_v1',
      strict: true,
      schema: PLAN_PROPOSAL_JSON_SCHEMA_V1,
    },
    maxOutputTokens: 2_048,
    signal: new AbortController().signal,
  })

  const verifierProvider = syntheticToolProvider(
    'submit_semantic_verification',
    { criteria: [] },
    undefined,
    undefined,
    undefined,
    (request) => requests.push(request),
  )
  await new ProviderSemanticVerifierModelPortV1(verifierProvider, 'fixture-model').verify({
    ...semanticInput(),
    criteria: [],
  })

  assert.equal(requests.length, 2)
  for (const request of requests) {
    const instructions = request.instructions
    if (instructions === undefined) assert.fail('expected Trusted Instructions')
    assert.equal((instructions.match(/^# Praxis Trusted Instructions$/gmu) ?? []).length, 1)
    assert.match(instructions, /Runtime-enforced permissions/u)
  }
  assert.doesNotMatch(
    requests.flatMap(({ messages }) => messages.map(({ content }) => String(content))).join('\n'),
    /proposal is untrusted|low-trust|high-trust|low confidence/iu,
  )
})

function syntheticToolProvider(
  toolName: string,
  value: unknown,
  capture?: (tools: readonly string[]) => void,
  captureReasoning?: (mode: string | undefined) => void,
  captureToolChoice?: (choice: unknown) => void,
  captureRequest?: (request: ProviderRequest) => void,
): ChatProvider {
  return {
    id: 'fixture',
    defaultModel: 'fixture-model',
    authState: () => ({ status: 'authenticated' }),
    async *stream(request) {
      captureRequest?.(request)
      capture?.(request.tools.map((tool) => tool.name))
      captureReasoning?.(request.reasoning?.mode)
      captureToolChoice?.(request.toolChoice)
      const serialized = JSON.stringify(value)
      const chunks: ProviderChunk[] = [
        { type: 'tool_call_start', index: 0, id: 'call-1', name: toolName },
        { type: 'tool_call_delta', index: 0, argumentsDelta: serialized },
        { type: 'tool_call_end', index: 0 },
        {
          type: 'completed',
          usage: { inputTokens: 30, outputTokens: 20, costUsd: 0.01 },
        },
      ]
      for (const chunk of chunks) yield chunk
    },
  }
}

function semanticInput(): SemanticVerifierModelInputV1 {
  return {
    identity: {
      role: 'semantic_verifier',
      verifierRunId: 'semantic-run',
      modelId: 'fixture/fixture-model',
    },
    context: { mode: 'fresh' },
    criteria: [
      {
        criterionId: 'semantic-1',
        kind: 'semantic',
        description: 'The implementation satisfies the request.',
      },
    ],
    result: {
      status: 'succeeded',
      summary: 'Implemented and checked.',
      evidenceRefs: [
        {
          kind: 'artifact',
          ref: 'artifact://evidence',
          digest: `sha256:${'a'.repeat(64)}`,
        },
      ],
      changedFiles: [],
      checks: [],
    },
    responseFormat: {
      type: 'json_schema',
      name: 'praxis_semantic_verification_v1',
      strict: true,
      schema: SEMANTIC_VERIFICATION_JSON_SCHEMA_V1,
    },
    maxOutputTokens: 1_024,
    signal: new AbortController().signal,
  }
}
