import assert from 'node:assert/strict'
import test from 'node:test'
import {
  canonicalDeadlineAfter,
  earliestCanonicalDeadline,
  MAX_CANONICAL_INSTANT,
  MAX_NATIVE_TIMEOUT_MS,
  scheduleLongDurationTimer,
} from '../apps/runtime/src/longDurationTimer.js'

test('long-duration timer does not overflow into an immediate callback', async () => {
  let fired = false
  const timer = scheduleLongDurationTimer(() => {
    fired = true
  }, MAX_NATIVE_TIMEOUT_MS + 10_000)
  await new Promise((resolve) => setTimeout(resolve, 20))
  timer.cancel()
  assert.equal(fired, false)
})

test('long-duration timer still fires normally for a short deadline', async () => {
  await new Promise<void>((resolve) => scheduleLongDurationTimer(resolve, 5))
})

test('unlimited deadlines remain canonical and compare by timestamp', () => {
  const unlimited = canonicalDeadlineAfter('2026-08-08T00:00:00.000Z', 8_000_000_000_000_000)
  assert.equal(unlimited, MAX_CANONICAL_INSTANT)
  assert.equal(
    earliestCanonicalDeadline(unlimited, '2026-08-09T00:00:00.000Z'),
    '2026-08-09T00:00:00.000Z',
  )
})
