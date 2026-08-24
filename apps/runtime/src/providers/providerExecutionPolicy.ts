import { runtimeError, type WorkflowSchedulingPolicyV1 } from '@praxis/core-sdk'
import { MINIMAX_PROVIDER_CONFIGURATIONS } from './minimaxConfig.js'

export const DEFAULT_WORKFLOW_WORKER_CONCURRENCY = 4
export const PROVIDER_WORKFLOW_CONCURRENCY_ENV = 'PRAXIS_WORKFLOW_PROVIDER_CONCURRENCY'

export type ProviderWorkflowConcurrencyPolicyV1 = Readonly<{
  defaultLimit: number
  providerLimits: Readonly<Record<string, number>>
}>

const BUILTIN_PROVIDER_LIMITS = Object.freeze(
  Object.fromEntries(
    MINIMAX_PROVIDER_CONFIGURATIONS.map(({ id, maxConcurrentWorkflowAgents }) => [
      id,
      maxConcurrentWorkflowAgents,
    ]),
  ),
)

/**
 * Resolve one immutable policy snapshot for the Runtime. The environment value
 * is a JSON object; `"*"` overrides the default and provider IDs override an
 * individual lane, for example {"*":4,"minimax":2}.
 */
export function providerWorkflowConcurrencyPolicyV1(
  environment: NodeJS.ProcessEnv = process.env,
): ProviderWorkflowConcurrencyPolicyV1 {
  const configured = parseOverrides(environment[PROVIDER_WORKFLOW_CONCURRENCY_ENV])
  return Object.freeze({
    defaultLimit: configured['*'] ?? DEFAULT_WORKFLOW_WORKER_CONCURRENCY,
    providerLimits: Object.freeze({ ...BUILTIN_PROVIDER_LIMITS, ...withoutDefault(configured) }),
  })
}

/** Persist the chosen Provider lane on the Workflow so recovery cannot drift. */
export function workflowSchedulingForProviderV1(
  providerId: string,
  policy: ProviderWorkflowConcurrencyPolicyV1,
): WorkflowSchedulingPolicyV1 {
  return Object.freeze({
    capacityGroups: Object.freeze([
      Object.freeze({
        key: `provider:${providerId}`,
        limit: policy.providerLimits[providerId] ?? policy.defaultLimit,
      }),
    ]),
  })
}

function parseOverrides(value: string | undefined): Record<string, number> {
  if (value === undefined || value.trim() === '') return {}
  try {
    const parsed: unknown = JSON.parse(value)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error()
    const entries = Object.entries(parsed)
    if (
      entries.some(
        ([key, limit]) =>
          (key !== '*' && !/^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u.test(key)) ||
          !Number.isSafeInteger(limit) ||
          Number(limit) < 1,
      )
    )
      throw new Error()
    return Object.fromEntries(entries) as Record<string, number>
  } catch {
    throw runtimeError(
      'WORKFLOW_PROVIDER_CONCURRENCY_INVALID',
      'configuration',
      `${PROVIDER_WORKFLOW_CONCURRENCY_ENV} must be a JSON object of positive integer limits.`,
    )
  }
}

function withoutDefault(input: Readonly<Record<string, number>>): Record<string, number> {
  return Object.fromEntries(Object.entries(input).filter(([key]) => key !== '*'))
}
