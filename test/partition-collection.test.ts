import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  observePartitionEvent,
  optionalPartitionLines,
  type CollectedEpisode,
} from '../apps/runtime/src/evaluation/recap/partitionRunner.js'

test('model completion survives later collection errors without concealing them', () => {
  const r: CollectedEpisode = {
    status: 'infrastructure_error',
    toolCalls: 0,
    toolEnds: 0,
    evidenceErrors: [],
    elapsedMs: 0,
  }
  observePartitionEvent(r, {
    type: 'prompt_completed',
    runId: 'r1',
    stopReason: 'end_turn',
    usage: { turns: 1, toolCalls: 0, inputTokens: 10, outputTokens: 5, subagents: 0 },
  })
  r.evidenceErrors.push({ phase: 'connection_close', errorName: 'Error' })
  assert.equal(r.status, 'completed')
  assert.equal(r.evidenceErrors.length, 1)
  assert.equal((r.usage as { turns: number }).turns, 1)
})

test('Plan calls are included in total cost but not repository checkpoint ordinals', () => {
  const r: CollectedEpisode = {
    status: 'running',
    toolCalls: 0,
    toolEnds: 0,
    evidenceErrors: [],
    elapsedMs: 0,
  }
  for (const [id, name] of [
    ['p', 'plan.create'],
    ['s', 'repo_shell'],
  ]) {
    observePartitionEvent(r, {
      type: 'tool_planning',
      runId: 'r',
      toolCallId: id!,
      name: name!,
      input: {},
    })
    observePartitionEvent(r, { type: 'tool_end', runId: 'r', toolCallId: id!, ok: true })
  }
  assert.equal(r.toolCalls, 1)
  assert.equal(r.toolEnds, 1)
  assert.equal(r.totalToolCalls, 2)
  assert.equal(r.totalToolEnds, 2)
})

test('zero-turn provider rejection retains its cause and missing activity logs are empty', async () => {
  const r: CollectedEpisode = {
    status: 'infrastructure_error',
    toolCalls: 0,
    toolEnds: 0,
    evidenceErrors: [],
    elapsedMs: 0,
  }
  observePartitionEvent(r, {
    type: 'prompt_failed',
    runId: 'r1',
    code: 'PROVIDER_RATE_LIMITED',
    error: 'Rate limit',
  })
  assert.equal(r.status, 'prompt_failed')
  assert.equal(r.failureCode, 'PROVIDER_RATE_LIMITED')
  const at = await mkdtemp(join(tmpdir(), 'partition-empty-'))
  assert.deepEqual(await optionalPartitionLines(join(at, 'timeline.jsonl')), [])
  await writeFile(join(at, 'malformed.jsonl'), '{broken')
  await assert.rejects(optionalPartitionLines(join(at, 'malformed.jsonl')), SyntaxError)
})
