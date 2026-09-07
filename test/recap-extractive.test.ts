import assert from 'node:assert/strict'
import test from 'node:test'
import type { ProviderChunk, ProviderRequest } from '@praxis/core-sdk'
import { ConservativeTokenizer } from '../apps/runtime/src/memory/tokenizer.js'
import { MockProvider } from '../apps/runtime/src/providers/mockProvider.js'
import {
  extractiveCandidates,
  makeExtractiveSnapshot,
} from '../apps/runtime/src/recap/extractiveRecap.js'
import { generateRecap } from '../apps/runtime/src/recap/providerRecapGenerator.js'
import { recapSource, validateRecapSnapshot } from '../apps/runtime/src/recap/recap.js'
import { renderRecapContext } from '../apps/runtime/src/recap/recapContext.js'

const rule = 'last_7_days starts today minus 6 days; last_30_days starts today minus 29 days.'
const source = recapSource('p', 'e', [
  {
    role: 'assistant',
    content: 'For 2026-03-01 the seven-day interval starts 2026-02-24. Unchecked and wrong.',
  },
  {
    role: 'tool',
    name: 'read',
    toolCallId: 'r',
    content: JSON.stringify({
      ok: true,
      output: { content: `${rule}\n${rule}\n${'x'.repeat(600)}` },
    }),
  },
  {
    role: 'tool',
    name: 'write',
    toolCallId: 'w',
    content: JSON.stringify({ ok: true, output: { content: 'The interval starts 2026-02-24.' } }),
  },
  {
    role: 'tool',
    name: 'read',
    toolCallId: 'f',
    content: JSON.stringify({
      ok: false,
      output: { content: 'Failed read is not an observation.' },
    }),
  },
])

test('extractive memory copies whole observed excerpts, excludes assistant calculations and write success, and deduplicates', () => {
  assert.deepEqual(extractiveCandidates(source), [{ id: 'c0', evidenceRef: 'm1', content: rule }])
  const snapshot = makeExtractiveSnapshot(source, 'test/extractive-v2', {
    candidateIds: ['c0'],
  })
  assert.equal(snapshot.notes[0]?.content, rule)
  assert.doesNotMatch(JSON.stringify(snapshot), /2026-02-24/)
  const rendered = renderRecapContext(
    { projectId: 'p', snapshot, maxTokens: 1500 },
    new ConservativeTokenizer(),
    1500,
  )
  assert.equal(rendered.messages.length, 1)
  assert.ok(rendered.manifest.tokens <= 1500)
  assert.equal(rendered.messages[0]?.role === 'user' && rendered.messages[0].trust, 'low')
})

test('extractive selection rejects invented text, missing evidence and duplicate choices instead of silently repairing', () => {
  for (const candidateIds of [[], ['c99'], ['c0', 'c0'], [42], Array(9).fill('c0')])
    assert.throws(() => makeExtractiveSnapshot(source, 'test', { candidateIds }), /RECAP_INVALID/)
  assert.throws(
    () => makeExtractiveSnapshot(source, 'test', { candidateIds: ['c0'], content: 'made up' }),
    /RECAP_INVALID/,
  )
})

test('valid selections from the candidate pool are packed by tokens instead of failing at 8 or 32 notes', () => {
  const paragraphs = Array.from(
    { length: 40 },
    (_, i) => `Rule ${i}: keep current policy authoritative and preserve complete source excerpts.`,
  )
  const history = recapSource('p', 'many', [
    {
      role: 'tool',
      name: 'read',
      toolCallId: 'r',
      content: JSON.stringify({ ok: true, output: { content: paragraphs.join('\n') } }),
    },
  ])
  const ids = extractiveCandidates(history).map((c) => c.id)
  const snapshot = makeExtractiveSnapshot(history, 'test/extractive-v3', { candidateIds: ids })
  assert.equal(validateRecapSnapshot(snapshot).notes.length, 40)
  assert.deepEqual(
    snapshot.notes.map((n) => n.content),
    paragraphs,
  )
  const rendered = renderRecapContext(
    { projectId: 'p', snapshot, maxTokens: 1500 },
    new ConservativeTokenizer(),
    1500,
  )
  assert.ok(rendered.manifest.selectedIds.length > 0 && rendered.manifest.selectedIds.length < 40)
  assert.equal(rendered.manifest.selectedIds.length + rendered.manifest.omittedIds.length, 40)
  assert.ok(rendered.manifest.tokens <= 1500)
  assert.throws(
    () => makeExtractiveSnapshot(history, 'test', { candidateIds: [...ids, 'c40'] }),
    /RECAP_INVALID/,
  )
})

test('bounded Unicode excerpts fit MiniMax budget without truncation and cannot override current request budget', () => {
  const paragraphs = Array.from({ length: 8 }, (_, i) => `规则${i}：${'保留完整原文。'.repeat(18)}`)
  const unicode = recapSource('p', 'u', [
    {
      role: 'tool',
      name: 'read',
      toolCallId: 'r',
      content: JSON.stringify({ ok: true, output: { content: paragraphs.join('\n') } }),
    },
  ])
  const candidates = extractiveCandidates(unicode)
  assert.equal(candidates.length, 8)
  const snapshot = makeExtractiveSnapshot(unicode, 'test', {
    candidateIds: candidates.map((c) => c.id),
  })
  const context = { projectId: 'p', snapshot, maxTokens: 1500 }
  const rendered = renderRecapContext(context, new ConservativeTokenizer(), 1500)
  assert.ok(rendered.manifest.selectedIds.length > 0 && rendered.manifest.selectedIds.length < 8)
  assert.ok(rendered.manifest.tokens <= 1500)
  assert.deepEqual(
    snapshot.notes.map((n) => n.content),
    paragraphs,
  )
  assert.equal(renderRecapContext(context, new ConservativeTokenizer(), 0).messages.length, 0)
})

test('reading back a generated answer does not promote assistant arithmetic into eligible evidence', () => {
  const history = recapSource('p', 'readback', [
    {
      role: 'assistant',
      content: '',
      toolCalls: [
        { id: 'w', name: 'write', input: { path: 'answer.json', content: 'Wrong derived value.' } },
      ],
    },
    {
      role: 'tool',
      name: 'read',
      toolCallId: 'r',
      content: JSON.stringify({
        ok: true,
        output: { path: 'D:\\experiment\\answer.json', content: 'Wrong derived value.' },
      }),
    },
    {
      role: 'tool',
      name: 'read',
      toolCallId: 'r2',
      content: JSON.stringify({
        ok: true,
        output: { path: 'D:\\experiment\\rules.txt', content: rule },
      }),
    },
  ])
  assert.deepEqual(extractiveCandidates(history), [{ id: 'c0', evidenceRef: 'm2', content: rule }])
})

test('ID-only extraction sends eligible excerpts without assistant claims and validates both tool and JSON-text submissions', async () => {
  class SelectionProvider extends MockProvider {
    constructor(readonly asText: boolean) {
      super()
    }
    override async *stream(request: ProviderRequest): AsyncIterable<ProviderChunk> {
      const payload = JSON.parse(String(request.messages[0]?.content))
      assert.deepEqual(Object.keys(payload), ['candidates'])
      assert.doesNotMatch(JSON.stringify(payload), /2026-02-24/)
      assert.deepEqual(
        request.tools.map((t) => t.name),
        ['select_excerpts'],
      )
      const input = { candidateIds: ['c0'] }
      if (this.asText) yield { type: 'text_delta', text: JSON.stringify(input) }
      else
        yield { type: 'tool_calls', calls: [{ id: 'selection', name: 'select_excerpts', input }] }
      yield {
        type: 'completed',
        stopReason: this.asText ? 'stop' : 'tool_calls',
        usage: { inputTokens: 12, outputTokens: 5 },
      }
    }
  }
  for (const asText of [false, true]) {
    const snapshot = await generateRecap({
      source,
      strategy: 'extractive',
      provider: new SelectionProvider(asText),
      model: 'mock-v1',
      maxTokens: 975,
      signal: new AbortController().signal,
    })
    assert.equal(snapshot.notes[0]?.content, rule)
    assert.equal(snapshot.usage?.outputTokens, 5)
    assert.match(snapshot.generator, /extractive-v3$/)
  }
})
