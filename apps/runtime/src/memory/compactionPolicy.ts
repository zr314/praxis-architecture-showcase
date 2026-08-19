import { runtimeError } from '@praxis/core-sdk'

export type ContextPolicy = Readonly<{
  /** Fraction of the available message budget that arms threshold compaction. */
  threshold: number
  /** Token basis used by the cost-aware soft ceiling. */
  compactionScope: 'total' | 'body_after_checkpoint'
  /**
   * Cost-aware soft ceiling for uncompacted replay history. This is not a
   * context or execution limit: older complete turns are summarized into a
   * durable checkpoint and the task continues.
   */
  maxUncompactedTokens: number
  /** Fraction below threshold required before threshold compaction can re-arm. */
  hysteresis: number
  /** Fraction of the Provider context window reserved as safety headroom. */
  reserve: number
  /** Minimum newest complete-turn suffix retained outside the checkpoint. */
  keepRecentTokens: number
}>

export type CompactionPolicy = Readonly<{
  /** Minimum estimated token reduction required to install a checkpoint. */
  minimumGain: number
  maxSummaryTokens: number
  /** Provider context overflow is deliberately limited to zero or one retry. */
  overflowRetryLimit: 0 | 1
  generatorDeadlineMs: number
  /** Optional per-checkpoint cost guard. Undefined means the run budget is authoritative. */
  generatorMaxCostUsd?: number
}>

export const DEFAULT_CONTEXT_POLICY: ContextPolicy = Object.freeze({
  threshold: 0.85,
  compactionScope: 'body_after_checkpoint',
  maxUncompactedTokens: 64 * 1_024,
  hysteresis: 0.1,
  reserve: 0.05,
  // Keep a meaningful raw continuation frontier outside the semantic
  // checkpoint. Eight tokens effectively retained only the final Tool result
  // and could erase a just-discovered rebuild/verification obligation.
  keepRecentTokens: 8 * 1_024,
})

export const DEFAULT_COMPACTION_POLICY: CompactionPolicy = Object.freeze({
  minimumGain: 1,
  maxSummaryTokens: 1_024,
  overflowRetryLimit: 1,
  generatorDeadlineMs: 120_000,
})

export function contextPolicy(input: Partial<ContextPolicy> = {}): ContextPolicy {
  const value = { ...DEFAULT_CONTEXT_POLICY, ...input }
  if (
    !fraction(value.threshold) ||
    value.threshold <= 0 ||
    (value.compactionScope !== 'total' && value.compactionScope !== 'body_after_checkpoint') ||
    !positiveInteger(value.maxUncompactedTokens) ||
    !fraction(value.hysteresis) ||
    value.hysteresis >= value.threshold ||
    !fraction(value.reserve) ||
    !positiveInteger(value.keepRecentTokens)
  ) {
    throw policyError()
  }
  return Object.freeze(value)
}

export function compactionPolicy(input: Partial<CompactionPolicy> = {}): CompactionPolicy {
  const value = { ...DEFAULT_COMPACTION_POLICY, ...input }
  if (
    !nonNegativeInteger(value.minimumGain) ||
    !positiveInteger(value.maxSummaryTokens) ||
    (value.overflowRetryLimit !== 0 && value.overflowRetryLimit !== 1) ||
    !positiveInteger(value.generatorDeadlineMs) ||
    (value.generatorMaxCostUsd !== undefined &&
      (typeof value.generatorMaxCostUsd !== 'number' ||
        !Number.isFinite(value.generatorMaxCostUsd) ||
        value.generatorMaxCostUsd < 0))
  ) {
    throw policyError()
  }
  return Object.freeze(value) as CompactionPolicy
}

export function shouldCompactAtThreshold(
  report: Readonly<{
    pressure: number
    uncompactedTokens?: number
    selectedTokens: number
    checkpointTokens: number
    uncoveredOmittedMessages: number
  }>,
  policy: ContextPolicy,
): boolean {
  return (
    report.uncoveredOmittedMessages > 0 ||
    report.pressure >= policy.threshold ||
    scopedTokens(report, policy) >= policy.maxUncompactedTokens
  )
}

export function thresholdCompactionRearmed(
  report: Readonly<{
    pressure: number
    uncompactedTokens?: number
    selectedTokens: number
    checkpointTokens: number
    uncoveredOmittedMessages: number
  }>,
  policy: ContextPolicy,
): boolean {
  return (
    report.uncoveredOmittedMessages === 0 &&
    report.pressure <= policy.threshold - policy.hysteresis &&
    scopedTokens(report, policy) <=
      Math.floor(policy.maxUncompactedTokens * (1 - policy.hysteresis))
  )
}

function scopedTokens(
  report: Readonly<{
    uncompactedTokens?: number
    selectedTokens: number
    checkpointTokens: number
  }>,
  policy: ContextPolicy,
): number {
  const uncompactedTokens =
    report.uncompactedTokens ?? Math.max(0, report.selectedTokens - report.checkpointTokens)
  return policy.compactionScope === 'total'
    ? uncompactedTokens + report.checkpointTokens
    : uncompactedTokens
}

function fraction(value: number): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

function nonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

function positiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

function policyError() {
  return runtimeError('COMPACTION_POLICY_INVALID', 'configuration', 'Compaction policy is invalid.')
}
