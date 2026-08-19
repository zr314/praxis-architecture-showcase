import { runtimeError } from '@praxis/core-sdk'

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export async function* jsonServerEvents(
  response: Response,
): AsyncIterable<Record<string, unknown>> {
  if (!response.ok) throw await providerHttpError(response)
  if (!response.body) {
    throw runtimeError('PROVIDER_EMPTY_STREAM', 'provider', 'Provider returned an empty stream.')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      const frames = buffer.split(/\r?\n\r?\n/)
      buffer = frames.pop() ?? ''
      for (const frame of frames) {
        const parsed = parseFrame(frame)
        if (parsed === 'done') return
        if (parsed) yield parsed
      }
      if (done) break
    }
    const parsed = parseFrame(buffer)
    if (parsed && parsed !== 'done') yield parsed
  } finally {
    reader.releaseLock()
  }
}

async function providerHttpError(response: Response) {
  const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'))
  return runtimeError(
    response.status === 429 ? 'PROVIDER_RATE_LIMITED' : 'PROVIDER_HTTP_ERROR',
    'provider',
    'Provider HTTP request failed.',
    {
      status: response.status,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      rateLimitRemaining: parseNumber(response.headers.get('x-ratelimit-remaining-requests')),
      rateLimitResetMs: parseReset(response.headers.get('x-ratelimit-reset-requests')),
    },
    response.status === 408 ||
      response.status === 409 ||
      response.status === 429 ||
      response.status >= 500,
  )
}

function parseFrame(frame: string): Record<string, unknown> | 'done' | undefined {
  const data = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n')
  if (!data) return undefined
  if (data === '[DONE]') return 'done'
  try {
    const value = JSON.parse(data) as unknown
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined
  } catch {
    throw runtimeError(
      'PROVIDER_STREAM_INVALID',
      'provider',
      'Provider returned an invalid event stream.',
    )
  }
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : undefined
}

function parseReset(value: string | null): number | undefined {
  if (!value) return undefined
  const seconds = Number(value.replace(/s$/i, ''))
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : undefined
}

function parseNumber(value: string | null): number | undefined {
  if (!value) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}
