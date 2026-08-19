import assert from 'node:assert/strict'
import test from 'node:test'
import {
  compileAgentAssemblyV1,
  parseAgentAssemblyRequestV1,
} from '../apps/runtime/src/workflow/agentAssembly.js'

test('Runtime compiles model-requested Child composition and records attenuation', () => {
  const request = parseAgentAssemblyRequestV1({
    instructions: 'Inspect the implementation and return a structured risk report.',
    model: {
      provider: 'unowned-provider',
      model: 'missing-model',
      tier: 'powerful',
      reasoningEffort: 'high',
    },
    result: {
      format: 'json',
      schema: { type: 'object', required: ['risks'], properties: { risks: { type: 'array' } } },
      maxInlineBytes: 4_096,
    },
    successCriteria: [{ id: 'grounded', description: 'Every risk cites evidence.' }],
  })
  const effective = compileAgentAssemblyV1({
    profile: 'explorer',
    request,
    parentTarget: { providerId: 'kimi', model: 'balanced' },
    candidates: [
      {
        target: { providerId: 'kimi', model: 'fast' },
        reasoningLevels: ['none', 'low'],
        speedRank: 1,
        powerRank: 1,
      },
      {
        target: { providerId: 'kimi', model: 'balanced' },
        reasoningLevels: ['none', 'medium'],
        speedRank: 2,
        powerRank: 2,
      },
    ],
  })

  assert.deepEqual(effective.target, { providerId: 'kimi', model: 'balanced' })
  assert.equal(effective.reasoningEffort, 'none')
  assert.equal(effective.result.format, 'json')
  assert.equal(effective.successCriteria[0]?.id, 'grounded')
  assert.match(effective.instructions, /read-oriented explorer/i)
  assert.deepEqual(
    effective.denied.map(({ field, reason }) => [field, reason]),
    [
      ['provider', 'not_in_parent_scope'],
      ['model', 'not_available'],
      ['reasoningEffort', 'unsupported'],
    ],
  )
})

test('three built-in harnesses share one compiler while preserving role baselines', () => {
  const candidate = {
    target: { providerId: 'mock', model: 'mock-model' },
    reasoningLevels: ['none', 'low', 'medium', 'high'] as const,
    speedRank: 1,
    powerRank: 1,
  }
  const descriptions = (['default', 'worker', 'explorer'] as const).map(
    (profile) =>
      compileAgentAssemblyV1({
        profile,
        parentTarget: candidate.target,
        candidates: [candidate],
      }).instructions,
  )
  assert.match(descriptions[0]!, /general-purpose/i)
  assert.match(descriptions[1]!, /execution worker/i)
  assert.match(descriptions[2]!, /read-oriented explorer/i)
})
