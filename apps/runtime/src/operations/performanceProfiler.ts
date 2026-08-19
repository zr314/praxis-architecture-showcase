import { runtimeError } from '@praxis/core-sdk'

export const PERFORMANCE_METRICS = [
  'provider_latency',
  'first_token',
  'run_latency',
  'tool_latency',
  'context_construction',
  'persistence',
  'tui_render',
  'startup',
  'memory_bytes',
] as const

export type PerformanceMetric = (typeof PERFORMANCE_METRICS)[number]

export type PerformanceBudget = {
  metric: PerformanceMetric
  percentile: 'p50' | 'p95' | 'max'
  maximum: number
  minimumSamples?: number
}

export type PerformanceSnapshot = {
  metric: PerformanceMetric
  samples: number
  p50: number
  p95: number
  max: number
}

/**
 * Bounded, content-free evaluation/test profiling.
 * This is not a live operations surface until an explicit opt-in diagnostics contract exists.
 */
export class PerformanceProfiler {
  readonly #samples = new Map<PerformanceMetric, number[]>()

  constructor(
    private readonly maxSamplesPerMetric = 2_048,
    private readonly now: () => number = () => performance.now(),
  ) {}

  start(metric: PerformanceMetric): () => number {
    const startedAt = this.now()
    let finished = false
    return () => {
      if (finished) throw new Error('Performance span was already finished.')
      finished = true
      const duration = Math.max(0, this.now() - startedAt)
      this.record(metric, duration)
      return duration
    }
  }

  async measure<T>(metric: PerformanceMetric, action: () => Promise<T>): Promise<T> {
    const finish = this.start(metric)
    try {
      return await action()
    } finally {
      finish()
    }
  }

  record(metric: PerformanceMetric, value: number): void {
    if (!PERFORMANCE_METRICS.includes(metric) || !Number.isFinite(value) || value < 0) {
      throw new TypeError('Invalid performance sample.')
    }
    const samples = this.#samples.get(metric) ?? []
    samples.push(value)
    if (samples.length > this.maxSamplesPerMetric) {
      samples.splice(0, samples.length - this.maxSamplesPerMetric)
    }
    this.#samples.set(metric, samples)
  }

  snapshot(metric: PerformanceMetric): PerformanceSnapshot {
    const values = [...(this.#samples.get(metric) ?? [])].sort((left, right) => left - right)
    return {
      metric,
      samples: values.length,
      p50: percentile(values, 0.5),
      p95: percentile(values, 0.95),
      max: values.at(-1) ?? 0,
    }
  }

  verify(budgets: readonly PerformanceBudget[]): Array<{
    budget: PerformanceBudget
    actual: number
    status: 'pass' | 'insufficient_samples' | 'fail'
  }> {
    return budgets.map((budget) => {
      const snapshot = this.snapshot(budget.metric)
      const actual = snapshot[budget.percentile]
      const enough = snapshot.samples >= (budget.minimumSamples ?? 1)
      return {
        budget: { ...budget },
        actual,
        status: !enough ? 'insufficient_samples' : actual <= budget.maximum ? 'pass' : 'fail',
      }
    })
  }

  assertBudgets(budgets: readonly PerformanceBudget[]): void {
    const failed = this.verify(budgets).filter((result) => result.status === 'fail')
    if (failed.length > 0) {
      throw runtimeError(
        'PERFORMANCE_BUDGET_EXCEEDED',
        'configuration',
        'One or more measured performance budgets were exceeded.',
        {
          failures: failed.map((failure) => ({
            metric: failure.budget.metric,
            percentile: failure.budget.percentile,
            maximum: failure.budget.maximum,
            actual: failure.actual,
          })),
        },
      )
    }
  }
}

function percentile(values: readonly number[], proportion: number): number {
  if (values.length === 0) return 0
  return values[Math.min(values.length - 1, Math.ceil(values.length * proportion) - 1)] ?? 0
}
