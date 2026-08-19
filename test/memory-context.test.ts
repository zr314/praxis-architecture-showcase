import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { contentText } from '@praxis/core-sdk'
import { selectContextWindow } from '../apps/runtime/src/memory/contextWindow.js'
import { JsonlRepository } from '../apps/runtime/src/session-db/jsonlRepository.js'

test('context window preserves a checkpoint and newest committed messages within budget', () => {
  const selection = selectContextWindow({
    messages: [
      { role: 'user', content: 'first request that is intentionally old' },
      { role: 'assistant', content: 'old answer that no longer fits' },
      { role: 'user', content: 'latest constraint' },
      { role: 'assistant', content: 'latest observed result' },
    ],
    checkpoint: {
      id: 'cp-1',
      messageStart: 0,
      messageEnd: 2,
      content: 'The user asked for a focused change.',
      digest: 'sha256:test',
      estimatedTokens: 18,
      createdAt: '2026-07-17T00:00:00.000Z',
    },
    maxTokens: 256,
  })

  assert.equal(selection.contextMessages[0]?.role, 'user')
  assert.match(
    selection.contextMessages[0] ? contentText(selection.contextMessages[0].content) : '',
    /^<praxis-context kind="session_checkpoint">/,
  )
  assert.deepEqual(selection.messages, [
    { role: 'user', content: 'latest constraint' },
    { role: 'assistant', content: 'latest observed result' },
  ])
  assert.equal(selection.includedMessageStart, 2)
  assert.equal(selection.truncated, true)
  assert.ok(selection.estimatedTokens <= 256)
})

test('JSONL repository preserves checkpoint and compact plan across a restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-memory-'))
  try {
    const repository = new JsonlRepository(root)
    await repository.initialize()
    await repository.saveMemory({
      sessionId: 's-memory',
      checkpoint: {
        id: 'cp-memory',
        messageStart: 0,
        messageEnd: 3,
        content: 'Remember the accepted constraint.',
        digest: 'sha256:memory',
        estimatedTokens: 16,
        createdAt: '2026-07-17T00:00:00.000Z',
        provenance: {
          schemaVersion: 1,
          generator: { kind: 'deterministic', id: 'praxis-deterministic-v1' },
        },
      },
      plan: {
        objective: 'Finish the harness',
        revision: 2,
        updatedAt: '2026-07-17T00:00:00.000Z',
        steps: [{ id: 'h2', title: 'Persist memory', state: 'completed' }],
      },
    })

    assert.deepEqual(await new JsonlRepository(root).loadMemory('s-memory'), {
      sessionId: 's-memory',
      checkpoint: {
        id: 'cp-memory',
        messageStart: 0,
        messageEnd: 3,
        content: 'Remember the accepted constraint.',
        digest: 'sha256:memory',
        estimatedTokens: 16,
        createdAt: '2026-07-17T00:00:00.000Z',
        provenance: {
          schemaVersion: 1,
          generator: { kind: 'deterministic', id: 'praxis-deterministic-v1' },
        },
      },
      plan: {
        objective: 'Finish the harness',
        revision: 2,
        updatedAt: '2026-07-17T00:00:00.000Z',
        steps: [{ id: 'h2', title: 'Persist memory', state: 'completed' }],
      },
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('context window deterministically keeps the newest message when no checkpoint fits', () => {
  const selection = selectContextWindow({
    messages: [
      { role: 'user', content: 'discard me' },
      { role: 'assistant', content: 'keep me' },
    ],
    maxTokens: 8,
  })

  assert.deepEqual(selection.messages, [{ role: 'assistant', content: 'keep me' }])
  assert.deepEqual(selection.contextMessages, [])
  assert.equal(selection.includedMessageStart, 1)
  assert.equal(selection.truncated, true)
})

test('context window never sends an orphan Tool result after a token cut', () => {
  const selection = selectContextWindow({
    messages: [
      {
        role: 'assistant',
        content: 'large '.repeat(100),
        toolCalls: [{ id: 'read-1', name: 'read', input: { path: 'README.md' } }],
      },
      { role: 'tool', toolCallId: 'read-1', name: 'read', content: 'small result' },
      { role: 'user', content: 'continue' },
    ],
    maxTokens: 20,
  })

  assert.deepEqual(selection.messages, [{ role: 'user', content: 'continue' }])
  assert.equal(selection.includedMessageStart, 2)
  assert.equal(selection.report.uncoveredOmittedMessages, 2)
})
