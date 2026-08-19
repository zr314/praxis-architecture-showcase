import assert from 'node:assert/strict'
import test from 'node:test'
import type { ProviderMessage, ToolDefinition } from '@praxis/core-sdk'
import {
  contextEditingPolicy,
  editReasoningContext,
  editToolResultContext,
  type TokenizerAdapter,
} from '../apps/runtime/src/memory/index.js'

test('reasoning editing clears stale blocks only in the Provider view and keeps the newest Tool turn', () => {
  const messages: ProviderMessage[] = [
    {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'old '.repeat(6_000) },
        { type: 'text', text: 'old answer' },
      ],
    },
    { role: 'user', content: 'continue' },
    {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'current '.repeat(2_000) },
        { type: 'tool_call', id: 'read-current', name: 'read', input: { path: 'a.txt' } },
      ],
    },
    { role: 'tool', toolCallId: 'read-current', name: 'read', content: 'result' },
  ]
  const canonical = structuredClone(messages)
  const edited = editReasoningContext({
    messages,
    tokenizer: new FourCharacterTokenizer(),
    policy: { triggerTokens: 4_000, keepRecentTurns: 1, clearAtLeastTokens: 1_000 },
  })

  assert.deepEqual(messages, canonical)
  const old = edited.messages[0]
  const current = edited.messages[2]
  assert.ok(old?.role === 'assistant' && Array.isArray(old.content))
  assert.deepEqual(old.content, [{ type: 'text', text: 'old answer' }])
  assert.ok(current?.role === 'assistant' && Array.isArray(current.content))
  assert.ok(current.content.some((block) => block.type === 'reasoning'))
  assert.ok(current.content.some((block) => block.type === 'tool_call'))
  assert.equal(edited.report.clearedReasoningTurns, 1)
  assert.equal(edited.report.clearedReasoningBlocks, 1)
  assert.ok(edited.report.reasoningTokensAfter < edited.report.reasoningTokensBefore)
})

test('provider-only context editing bounds results and clears only stale replayable reads', () => {
  const messages = toolTranscript()
  const canonical = structuredClone(messages)
  const result = editToolResultContext({
    messages,
    tools: [readTool(), writeTool()],
    tokenizer: new FourCharacterTokenizer(),
    policy: {
      maxToolResultTokens: 1_024,
      toolResultTriggerTokens: 2_500,
      keepRecentToolResults: 2,
      clearAtLeastTokens: 300,
    },
  })

  assert.deepEqual(messages, canonical, 'canonical Session history must not be edited')
  assert.notEqual(result.messages, messages)
  assert.ok(result.report.toolResultTokensAfter < result.report.toolResultTokensBefore)
  assert.equal(result.report.truncatedToolResults, 5)
  assert.ok(result.report.truncatedToolResultTokens > 0)
  assert.ok(result.report.clearedToolResults > 0)
  assert.ok(result.report.clearedToolResultTokens > 0)

  const toolMessages = result.messages.filter(
    (message): message is Extract<ProviderMessage, { role: 'tool' }> => message.role === 'tool',
  )
  const readKinds = toolMessages
    .filter((message) => message.name === 'read' && message.skillInvocation === undefined)
    .map((message) => contextEditKind(message))
  assert.ok(readKinds.slice(0, 2).includes('cleared'))
  assert.deepEqual(readKinds.slice(-2), ['truncated', 'truncated'])
  assert.equal(
    contextEditKind(toolMessages.find((message) => message.name === 'write')!),
    'truncated',
  )

  const skill = toolMessages.find((message) => message.skillInvocation !== undefined)
  assert.deepEqual(
    skill,
    canonical.find((message) => message.role === 'tool' && message.skillInvocation),
  )
  for (const edited of toolMessages) {
    const original = canonical.find(
      (message) => message.role === 'tool' && message.toolCallId === edited.toolCallId,
    )
    assert.ok(original?.role === 'tool')
    assert.equal(edited.toolCallId, original.toolCallId)
    assert.equal(edited.name, original.name)
  }
})

test('context editing batches stale-result clearing and validates policy', () => {
  const messages = toolTranscript().slice(0, 8)
  const result = editToolResultContext({
    messages,
    tools: [readTool()],
    tokenizer: new FourCharacterTokenizer(),
    policy: {
      maxToolResultTokens: 3_000,
      toolResultTriggerTokens: 5_000,
      keepRecentToolResults: 2,
      clearAtLeastTokens: 4_000,
    },
  })
  assert.equal(result.report.clearedToolResults, 0)
  assert.deepEqual(result.messages, messages)
  assert.throws(
    () => contextEditingPolicy({ maxToolResultTokens: 255 }),
    /CONTEXT_EDITING_POLICY_INVALID/,
  )
})

test('bounded Tool results preserve failure state and Artifact recovery metadata', () => {
  const content = JSON.stringify({
    ok: false,
    summary: 'command failed after producing recoverable evidence',
    output: {
      type: 'artifact_ref',
      artifact: {
        artifactId: 'artifact-evidence',
        digest: `sha256:${'b'.repeat(64)}`,
        mimeType: 'application/json',
        bytes: 40_000,
      },
      noise: 'x'.repeat(12_000),
    },
    error: { code: 'COMMAND_FAILED', category: 'execution', retryable: true },
  })
  const result = editToolResultContext({
    messages: [{ role: 'tool', toolCallId: 'shell-0', name: 'shell', content }],
    tools: [],
    tokenizer: new FourCharacterTokenizer(),
    policy: { maxToolResultTokens: 1_024 },
  })
  const message = result.messages[0]
  assert.ok(message?.role === 'tool' && typeof message.content === 'string')
  const envelope = JSON.parse(message.content)
  assert.equal(envelope.original.ok, false)
  assert.equal(envelope.original.error.code, 'COMMAND_FAILED')
  assert.equal(envelope.original.error.retryable, true)
  assert.equal(envelope.original.outputArtifact.artifactId, 'artifact-evidence')
  assert.equal(envelope.contextEdit.kind, 'truncated')
})

test('context editing skips the canonical prefix already covered by a checkpoint', () => {
  const messages = toolTranscript()
  const tokenizer = new FourCharacterTokenizer()
  const result = editToolResultContext({
    messages,
    messageStart: 8,
    tools: [readTool(), writeTool()],
    tokenizer,
    policy: { maxToolResultTokens: 1_024 },
  })
  const expectedActiveToolTokens = messages
    .slice(8)
    .reduce(
      (total, message) => total + (message.role === 'tool' ? tokenizer.countMessage(message) : 0),
      0,
    )

  assert.equal(result.report.toolResultTokensBefore, expectedActiveToolTokens)
  assert.ok(result.report.toolResultTokensAfter < result.report.toolResultTokensBefore)
  assert.deepEqual(result.messages.slice(0, 8), messages.slice(0, 8))
  assert.equal(result.report.truncatedToolResults, 1)
})

function toolTranscript(): ProviderMessage[] {
  const messages: ProviderMessage[] = []
  for (let index = 0; index < 4; index += 1) {
    messages.push(
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: `read-${index}`, name: 'read', input: { path: `${index}.txt` } }],
      },
      {
        role: 'tool',
        toolCallId: `read-${index}`,
        name: 'read',
        content: `read-${index}:${'r'.repeat(8_000)}`,
      },
    )
  }
  messages.push(
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'write-0', name: 'write', input: { path: 'out.txt' } }],
    },
    {
      role: 'tool',
      toolCallId: 'write-0',
      name: 'write',
      content: `write:${'w'.repeat(8_000)}`,
    },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'skill-0', name: 'read', input: {} }],
    },
    {
      role: 'tool',
      toolCallId: 'skill-0',
      name: 'read',
      content: `skill:${'s'.repeat(8_000)}`,
      skillInvocation: {
        type: 'skill_invocation',
        version: 1,
        capabilityId: 'fixture-skill',
        origin: 'fixture://skill',
        digest: `sha256:${'a'.repeat(64)}`,
        arguments: '',
        content: 'exact skill instructions',
      },
    },
  )
  return messages
}

function readTool(): ToolDefinition {
  return {
    name: 'read',
    description: 'read a file',
    parameters: {},
    execution: {
      sideEffect: 'read',
      target: { kind: 'input_path', field: 'path' },
      parallelSafe: true,
      conflictScope: 'target',
      maxInlineBytes: 65_536,
    },
  }
}

function writeTool(): ToolDefinition {
  return {
    name: 'write',
    description: 'write a file',
    parameters: {},
    execution: {
      sideEffect: 'write',
      target: { kind: 'input_path', field: 'path' },
      parallelSafe: false,
      conflictScope: 'target',
      maxInlineBytes: 65_536,
    },
  }
}

function contextEditKind(
  message: Extract<ProviderMessage, { role: 'tool' }>,
): 'truncated' | 'cleared' | undefined {
  if (typeof message.content !== 'string') return undefined
  try {
    return JSON.parse(message.content).contextEdit?.kind
  } catch {
    return undefined
  }
}

class FourCharacterTokenizer implements TokenizerAdapter {
  readonly id = 'four-character-fixture'

  countText(value: string): number {
    return Math.ceil(value.length / 4)
  }

  countMessage(message: ProviderMessage): number {
    return this.countText(
      typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
    )
  }
}
