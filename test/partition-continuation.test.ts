import assert from 'node:assert/strict'
import test from 'node:test'
import {
  addKnownPartitionUsage,
  mergePartitionContinuation,
} from '../apps/runtime/src/evaluation/recap/partitionContinuation.js'

test('resuming a solved but interrupted task preserves its original first pass and charges later work', () => {
  const previous = {
    key: '0-structured',
    status: 'prompt_failed',
    directory: 'old',
    toolCalls: 104,
    toolEnds: 104,
    elapsedMs: 100,
    firstPassingTool: 52,
    completeCheckpointEvidence: true,
    usage: { inputTokens: 100, outputTokens: 50 },
    primaryUsage: {
      before: { inputTokens: 60, outputTokens: 20 },
      after: { inputTokens: 40, outputTokens: 30 },
    },
  }
  const next = {
    key: '0-structured',
    status: 'completed',
    directory: 'new',
    toolCalls: 3,
    toolEnds: 3,
    elapsedMs: 10,
    firstPassingTool: 0,
    completeCheckpointEvidence: true,
    usage: { inputTokens: 20, outputTokens: 10 },
    mainLoopUsage: { inputTokens: 15, outputTokens: 5 },
  }
  const merged = mergePartitionContinuation(previous, next)
  assert.equal(merged.firstPassingTool, 52)
  assert.equal(merged.toolsAfterFirstPass, 55)
  assert.equal(merged.toolCalls, 107)
  assert.equal(merged.elapsedMs, 110)
  assert.deepEqual(merged.primaryUsage?.before, previous.primaryUsage.before)
  assert.deepEqual(merged.primaryUsage?.after, { inputTokens: 55, outputTokens: 35 })
  assert.deepEqual(merged.usage, { inputTokens: 120, outputTokens: 60 })
})
test('zero-turn restart keeps missing old accounting unknown and does not shift milestone', () => {
  const old = { key: '1-none', status: 'prompt_failed', directory: 'old', toolCalls: 0 }
  const next = {
    key: '1-none',
    status: 'completed',
    directory: 'new',
    toolCalls: 20,
    firstPassingTool: 10,
  }
  const r = mergePartitionContinuation(old, next)
  assert.equal(r.firstPassingTool, 10)
  assert.equal(r.priorAttemptUsage, null)
  assert.deepEqual(addKnownPartitionUsage({ inputTokens: 1 }, { outputTokens: 1 }), {})
})
