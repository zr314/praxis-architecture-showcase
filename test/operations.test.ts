import assert from 'node:assert/strict'
import test from 'node:test'
import { OperationalMetrics, PerformanceProfiler } from '../apps/runtime/src/operations/index.js'

test('performance profiles are bounded, reproducible, and gate measured percentiles', () => {
  let clock = 0
  const profiler = new PerformanceProfiler(3, () => clock)
  for (const duration of [10, 20, 30, 40]) {
    const finish = profiler.start('tool_latency')
    clock += duration
    finish()
  }
  assert.deepEqual(profiler.snapshot('tool_latency'), {
    metric: 'tool_latency',
    samples: 3,
    p50: 30,
    p95: 40,
    max: 40,
  })
  assert.equal(
    profiler.verify([
      { metric: 'tool_latency', percentile: 'p95', maximum: 40, minimumSamples: 3 },
    ])[0]?.status,
    'pass',
  )
  assert.throws(
    () => profiler.assertBudgets([{ metric: 'tool_latency', percentile: 'p95', maximum: 39 }]),
    hasCode('PERFORMANCE_BUDGET_EXCEEDED'),
  )
})

test('operational metrics aggregate fixed bounded usage metadata only', () => {
  const metrics = new OperationalMetrics(2)
  metrics.record({
    provider: 'mock',
    health: 'healthy',
    retries: 1,
    artifacts: 2,
    usage: { inputTokens: 3, cacheReadTokens: 1, costUsd: 0.01 },
  })
  assert.deepEqual(metrics.snapshot(), {
    runs: 1,
    retries: 1,
    artifacts: 2,
    usage: { inputTokens: 3, cacheReadTokens: 1, costUsd: 0.01 },
    providers: { mock: 1 },
    health: { healthy: 1 },
  })
})

function hasCode(code: string) {
  return (error: unknown) =>
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code
}
