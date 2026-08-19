/** Largest delay Node.js can portably pass to setTimeout without overflow. */
export const MAX_NATIVE_TIMEOUT_MS = 2_147_483_647
export const MAX_CANONICAL_INSTANT = '9999-12-31T23:59:59.999Z'
const MAX_CANONICAL_INSTANT_MS = Date.parse(MAX_CANONICAL_INSTANT)

export type LongDurationTimer = Readonly<{ cancel: () => void }>

/** Returns a canonical four-digit-year deadline without Date range overflow. */
export function canonicalDeadlineAfter(start: string | number, delayMs: number): string {
  const startedAt = typeof start === 'number' ? start : Date.parse(start)
  if (!Number.isFinite(startedAt) || !Number.isSafeInteger(delayMs) || delayMs < 0) {
    throw new RangeError('Deadline inputs must be a valid instant and non-negative safe integer.')
  }
  return new Date(Math.min(MAX_CANONICAL_INSTANT_MS, startedAt + delayMs)).toISOString()
}

/** Compares instants by timestamp rather than lexicographic ISO representation. */
export function earliestCanonicalDeadline(...values: readonly string[]): string {
  if (values.length === 0) throw new RangeError('At least one deadline is required.')
  return values.reduce((earliest, candidate) =>
    Date.parse(candidate) < Date.parse(earliest) ? candidate : earliest,
  )
}

/**
 * Schedules an arbitrarily long safe-integer delay by re-arming a native timer
 * in bounded segments. This avoids Node's TimeoutOverflowWarning behavior,
 * which otherwise reduces oversized delays to roughly one millisecond.
 */
export function scheduleLongDurationTimer(
  callback: () => void,
  delayMs: number,
): LongDurationTimer {
  if (!Number.isSafeInteger(delayMs) || delayMs < 0) {
    throw new RangeError('Long-duration timer delay must be a non-negative safe integer.')
  }
  const deadline = Date.now() + delayMs
  if (!Number.isSafeInteger(deadline)) {
    throw new RangeError('Long-duration timer deadline exceeds the safe integer range.')
  }
  let cancelled = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const arm = () => {
    if (cancelled) return
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      callback()
      return
    }
    timer = setTimeout(arm, Math.min(remaining, MAX_NATIVE_TIMEOUT_MS))
    timer.unref?.()
  }
  arm()
  return Object.freeze({
    cancel: () => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
    },
  })
}
