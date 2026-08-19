import { runtimeError, type BudgetUsage, type SessionProjectionV3 } from '@praxis/core-sdk'

/** Returns usage owned by one active parent Run, never the Session aggregate. */
export function currentRunBudgetUsageV1(
  projection: SessionProjectionV3,
  parentRunId: string,
): Readonly<BudgetUsage> {
  const run = projection.snapshot.runs.find((candidate) => candidate.runId === parentRunId)
  if (run === undefined || run.state !== 'running') {
    throw runtimeError('DAG_PARENT_RUN_NOT_ACTIVE', 'planner', 'Parent Run is not active.')
  }
  return Object.freeze({
    ...run.usage,
    turns: run.usage.turns ?? 0,
    toolCalls: run.usage.toolCalls ?? 0,
    subagents: run.usage.subagents ?? 0,
  })
}
