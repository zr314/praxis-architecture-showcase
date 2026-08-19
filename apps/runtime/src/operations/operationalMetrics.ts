import type { ProviderUsage } from '@praxis/core-sdk'

export type OperationalRecord = {
  provider: string
  health: string
  retries: number
  artifacts: number
  usage: ProviderUsage
}

/**
 * Fixed-vocabulary evaluation/test aggregate; prompts and raw Tool data are not accepted.
 * This is not a live operations surface until an explicit opt-in diagnostics contract exists.
 */
export class OperationalMetrics {
  readonly #records: OperationalRecord[] = []

  constructor(private readonly maximumRecords = 2_048) {}

  record(value: OperationalRecord): void {
    this.#records.push({
      provider: boundedLabel(value.provider),
      health: boundedLabel(value.health),
      retries: boundedCount(value.retries),
      artifacts: boundedCount(value.artifacts),
      usage: boundedUsage(value.usage),
    })
    if (this.#records.length > this.maximumRecords) {
      this.#records.splice(0, this.#records.length - this.maximumRecords)
    }
  }

  snapshot(): {
    runs: number
    retries: number
    artifacts: number
    usage: ProviderUsage
    providers: Record<string, number>
    health: Record<string, number>
  } {
    const result = {
      runs: this.#records.length,
      retries: 0,
      artifacts: 0,
      usage: {} as ProviderUsage,
      providers: {} as Record<string, number>,
      health: {} as Record<string, number>,
    }
    for (const record of this.#records) {
      result.retries += record.retries
      result.artifacts += record.artifacts
      result.providers[record.provider] = (result.providers[record.provider] ?? 0) + 1
      result.health[record.health] = (result.health[record.health] ?? 0) + 1
      for (const field of [
        'inputTokens',
        'outputTokens',
        'cacheReadTokens',
        'cacheWriteTokens',
        'costUsd',
      ] as const) {
        if (record.usage[field] !== undefined) {
          result.usage[field] = (result.usage[field] ?? 0) + record.usage[field]
        }
      }
    }
    return structuredClone(result)
  }
}

function boundedUsage(usage: ProviderUsage): ProviderUsage {
  const output: ProviderUsage = {}
  for (const field of [
    'inputTokens',
    'outputTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
    'costUsd',
  ] as const) {
    const value = usage[field]
    if (value !== undefined && Number.isFinite(value) && value >= 0) {
      output[field] = Math.min(value, Number.MAX_SAFE_INTEGER)
    }
  }
  return output
}

function boundedCount(value: number): number {
  return Number.isFinite(value) ? Math.min(1_000_000, Math.max(0, Math.floor(value))) : 0
}

function boundedLabel(value: string): string {
  return value.slice(0, 128).replace(/[^A-Za-z0-9._-]/gu, '_')
}
