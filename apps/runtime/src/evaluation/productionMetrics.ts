import type { ProviderUsage, TraceRecord } from '@praxis/core-sdk'
import { PerformanceProfiler, type PerformanceSnapshot } from '../operations/index.js'

export type ProductionTraceSummary = {
  runs: number
  retries: number
  fallbacks: number
  compactions: number
  usage: ProviderUsage
  cache: {
    hitTokens: number
    missTokens: number
    /** Aggregate input-token hit rate in the closed interval [0, 1]. */
    hitRate: number
  }
  performance: {
    firstToken: PerformanceSnapshot
    provider: PerformanceSnapshot
    tool: PerformanceSnapshot
    persistence: PerformanceSnapshot
    total: PerformanceSnapshot
  }
}

/**
 * Projects privacy-safe production traces into bounded evaluation metrics.
 * It accepts no prompts, messages, Tool payloads, environment, or credentials.
 */
export function summarizeProductionTraces(records: readonly TraceRecord[]): ProductionTraceSummary {
  const profiler = new PerformanceProfiler()
  const usage: ProviderUsage = {}
  let runs = 0
  let retries = 0
  let fallbacks = 0
  let compactions = 0

  for (const record of records) {
    const duration = record.metrics?.durationMs
    if (record.kind === 'provider.first_token') recordDuration(profiler, 'first_token', duration)
    else if (record.kind === 'provider.completed') {
      recordDuration(profiler, 'provider_latency', duration)
      addUsage(usage, record.metrics)
    } else if (record.kind === 'tool.completed' || record.kind === 'tool.failed') {
      recordDuration(profiler, 'tool_latency', duration)
    } else if (record.kind === 'persistence.completed' || record.kind === 'persistence.failed') {
      recordDuration(profiler, 'persistence', duration)
    } else if (
      record.kind === 'run.completed' ||
      record.kind === 'run.failed' ||
      record.kind === 'run.aborted'
    ) {
      runs += 1
      recordDuration(profiler, 'run_latency', duration)
    } else if (record.kind === 'provider.retry') retries += 1
    else if (record.kind === 'provider.fallback') fallbacks += 1
    else if (record.kind === 'context.compacted') compactions += 1
  }

  const inputTokens = usage.inputTokens ?? 0
  const hitTokens = Math.min(inputTokens, usage.cacheReadTokens ?? 0)
  return {
    runs,
    retries,
    fallbacks,
    compactions,
    usage,
    cache: {
      hitTokens,
      missTokens: Math.max(0, inputTokens - hitTokens),
      hitRate: inputTokens === 0 ? 0 : hitTokens / inputTokens,
    },
    performance: {
      firstToken: profiler.snapshot('first_token'),
      provider: profiler.snapshot('provider_latency'),
      tool: profiler.snapshot('tool_latency'),
      persistence: profiler.snapshot('persistence'),
      total: profiler.snapshot('run_latency'),
    },
  }
}

function recordDuration(
  profiler: PerformanceProfiler,
  metric: Parameters<PerformanceProfiler['record']>[0],
  duration: number | undefined,
): void {
  if (duration !== undefined) profiler.record(metric, duration)
}

function addUsage(target: ProviderUsage, metrics: TraceRecord['metrics']): void {
  if (!metrics) return
  for (const field of [
    'inputTokens',
    'outputTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
    'costUsd',
  ] as const) {
    const value = metrics[field]
    if (value !== undefined) target[field] = (target[field] ?? 0) + value
  }
}
