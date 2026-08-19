import { createHash } from 'node:crypto'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import type { ProviderMessage, SessionRecord } from '@praxis/core-sdk'
import { JsonlRepository } from '../apps/runtime/src/session-db/jsonlRepository.js'

const SAMPLE_APPENDS = 25
const LONG_SESSION_MESSAGES = 5_000

type BenchmarkResult = {
  existingMessages: number
  restartRecoveryMs: number
  searchMs: number
  firstAppendMs: number
  appendMedianMs: number
  appendP95Ms: number
  historyBytes: number
}

const root = await mkdtemp(join(tmpdir(), 'praxis-session-benchmark-'))
try {
  const shallow = await benchmarkSession(join(root, 'shallow'), 'shallow', 0)
  const long = await benchmarkSession(join(root, 'long'), 'long', LONG_SESSION_MESSAGES)
  const firstAppendRatio = ratio(long.firstAppendMs, shallow.firstAppendMs)
  const appendMedianRatio = ratio(long.appendMedianMs, shallow.appendMedianMs)

  process.stdout.write(
    `${JSON.stringify(
      {
        benchmark: 'session-storage',
        sampleAppends: SAMPLE_APPENDS,
        shallow,
        long,
        firstAppendRatio,
        appendMedianRatio,
        interpretation:
          'Restart recovery and storage scale with transcript length; warmed append latency should remain approximately constant.',
      },
      undefined,
      2,
    )}\n`,
  )
} finally {
  await rm(root, { recursive: true, force: true })
}

async function benchmarkSession(
  sessionRoot: string,
  sessionId: string,
  existingMessages: number,
): Promise<BenchmarkResult> {
  const initial = new JsonlRepository(sessionRoot)
  await initial.initialize()
  await initial.create(record(sessionId))
  if (existingMessages > 0) {
    await writeFile(
      join(sessionRoot, 'history', `${sessionId}.jsonl`),
      seedHistory(existingMessages),
      'utf8',
    )
  }

  const repository = new JsonlRepository(sessionRoot)
  const restartStarted = performance.now()
  await repository.initialize()
  const restartRecoveryMs = performance.now() - restartStarted

  const searchStarted = performance.now()
  await repository.search(sessionId)
  const searchMs = performance.now() - searchStarted

  const appendSamples: number[] = []
  for (let index = 0; index < SAMPLE_APPENDS; index += 1) {
    const started = performance.now()
    await repository.appendMessage(sessionId, {
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `sample-${index}`,
    })
    appendSamples.push(performance.now() - started)
  }
  const firstAppendMs = appendSamples[0] ?? 0
  appendSamples.sort((left, right) => left - right)

  return {
    existingMessages,
    restartRecoveryMs: round(restartRecoveryMs),
    searchMs: round(searchMs),
    firstAppendMs: round(firstAppendMs),
    appendMedianMs: round(percentile(appendSamples, 0.5)),
    appendP95Ms: round(percentile(appendSamples, 0.95)),
    historyBytes: (await stat(join(sessionRoot, 'history', `${sessionId}.jsonl`))).size,
  }
}

function seedHistory(count: number): string {
  const lines: string[] = []
  for (let index = 0; index < count; index += 1) {
    const message: ProviderMessage = {
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `seed-${index}`,
    }
    const payload = {
      version: 2 as const,
      sequence: index + 1,
      committedAt: '2026-01-01T00:00:00.000Z',
      message,
    }
    lines.push(JSON.stringify({ ...payload, checksum: checksum(payload) }))
  }
  return `${lines.join('\n')}\n`
}

function record(sessionId: string): SessionRecord {
  return {
    sessionId,
    state: 'idle',
    cwd: process.cwd(),
    provider: 'mock',
    model: 'mock-v1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

function checksum(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`
}

function percentile(values: number[], quantile: number): number {
  return values[Math.min(values.length - 1, Math.floor(values.length * quantile))] ?? 0
}

function ratio(numerator: number, denominator: number): number {
  return round(denominator === 0 ? 0 : numerator / denominator)
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}
