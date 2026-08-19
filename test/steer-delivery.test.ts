import assert from 'node:assert/strict'
import test from 'node:test'
import type { RuntimeBridge } from '@praxis/protocol'
import { deliverSteer } from '../apps/cli/src/ui/steerDelivery.js'

const input = {
  sessionId: 'session',
  runId: 'run',
  text: 'keep the result concise',
}

test('deliverSteer reports accepted active-run input', async () => {
  const texts: string[] = []
  const bridge = {
    steer: async (steerInput: typeof input) => {
      texts.push(steerInput.text)
      return { accepted: true as const, applyAt: 'next_safe_boundary' as const }
    },
  } as Pick<RuntimeBridge, 'steer'>

  assert.equal(await deliverSteer(bridge, input), 'steered')
  assert.deepEqual(texts, ['keep the result concise'])
})

test('deliverSteer classifies the run-completion race', async () => {
  const bridge = {
    steer: async () => {
      throw { rpc: { code: 'RUN_NOT_ACTIVE', message: 'ended' } }
    },
  } as Pick<RuntimeBridge, 'steer'>

  assert.equal(await deliverSteer(bridge, input), 'run-ended')
})

test('deliverSteer rethrows unrelated failures', async () => {
  const failure = { code: 'PROVIDER_ERROR', message: 'unavailable' }
  const bridge = {
    steer: async () => {
      throw failure
    },
  } as Pick<RuntimeBridge, 'steer'>

  await assert.rejects(deliverSteer(bridge, input), (error) => error === failure)
})
