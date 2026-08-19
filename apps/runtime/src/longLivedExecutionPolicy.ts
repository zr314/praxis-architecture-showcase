/**
 * Numeric representation used at legacy/internal boundaries that still require
 * a finite integer. v4 treats these values as `unlimited`; they are not product
 * budgets and must never be surfaced as a recommended task size.
 *
 * Wall-clock time uses the largest round value that can still be added to a
 * contemporary timestamp and converted by JavaScript's Date implementation.
 * Timers for that duration must be armed through the long-duration timer helper
 * rather than passed directly to setTimeout (whose portable limit is ~24.8d).
 */
export const UNLIMITED_EXECUTION_COUNT = Number.MAX_SAFE_INTEGER
export const UNLIMITED_WALL_CLOCK_MS = 8_000_000_000_000_000

/** Immutable values used by the persisted built-in v3 profile digests. */
export const BUILTIN_AGENT_PROFILE_V3_LIMITS = Object.freeze({
  maxWallClockMs: 30 * 24 * 60 * 60 * 1_000,
  maxTurns: 100_000,
  maxToolCalls: 1_000_000,
  maxDepth: 64,
})

/**
 * Product defaults for the long-lived v4 Agent platform.
 *
 * Cumulative work and duration are unlimited unless a caller supplies an
 * explicit budget. Parallelism in the logical budget is also unlimited; local
 * worker capacity is enforced separately so it cannot become a task boundary.
 */
export const LONG_LIVED_EXECUTION_POLICY_V1 = Object.freeze({
  maxWallClockMs: UNLIMITED_WALL_CLOCK_MS,
  maxTurns: UNLIMITED_EXECUTION_COUNT,
  maxToolCalls: UNLIMITED_EXECUTION_COUNT,
  maxWorkflowToolCalls: UNLIMITED_EXECUTION_COUNT,
  maxWorkflowTokens: UNLIMITED_EXECUTION_COUNT,
  maxChildRuns: UNLIMITED_EXECUTION_COUNT,
  maxParallelChildren: UNLIMITED_EXECUTION_COUNT,
  maxDepth: UNLIMITED_EXECUTION_COUNT,
  maxLoopIterations: UNLIMITED_EXECUTION_COUNT,
  maxGraphMutations: UNLIMITED_EXECUTION_COUNT,
  childNoProgressMs: undefined,
  localWorkerParallelChildren: 256,
})

export const ACTIVE_BUILTIN_AGENT_PROFILE_VERSION = 4
