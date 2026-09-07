import type { AgentRun, ProviderUsage } from '@praxis/core-sdk'

const recorded = new WeakMap<AgentRun, Set<string>>()

/** New measured calls only; replaying a durable decision is not a new charge. */
export function recordAuxiliaryProviderUsageV1(
  run: AgentRun,
  callId: string,
  usage: ProviderUsage,
): void {
  const seen = recorded.get(run) ?? new Set<string>()
  if (seen.has(callId)) return
  seen.add(callId)
  recorded.set(run, seen)
  const current = run.usage ?? { turns: 0, toolCalls: 0, subagents: 0 }
  for (const key of [
    'inputTokens',
    'outputTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
    'costUsd',
  ] as const) {
    const value = usage[key]
    if (value !== undefined && Number.isFinite(value) && value >= 0) {
      current[key] = (current[key] ?? 0) + value
    }
  }
  run.usage = current
}
