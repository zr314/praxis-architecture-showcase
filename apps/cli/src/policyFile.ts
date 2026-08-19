import { readFile } from 'node:fs/promises'
import type { PermissionDecision, SessionEvent } from '@praxis/protocol'

export type NonInteractivePolicy = {
  version: 1
  default: 'deny' | 'allow_once'
  rules: Array<{
    tool: string
    decision: 'deny' | 'allow_once' | 'allow_always'
    targetPrefix?: string
  }>
}

export async function loadPolicyFile(path: string): Promise<NonInteractivePolicy> {
  const value = JSON.parse(await readFile(path, 'utf8')) as unknown
  if (!isPolicy(value)) throw new Error('Policy file must satisfy the Praxis policy v1 format.')
  return {
    version: 1,
    default: value.default,
    rules: value.rules.map((rule) => ({ ...rule })),
  }
}

export function policyDecision(
  policy: NonInteractivePolicy,
  event: Extract<SessionEvent, { type: 'permission_request' }>,
): PermissionDecision {
  const rule = policy.rules.find(
    (candidate) =>
      candidate.tool === event.tool &&
      (candidate.targetPrefix === undefined || event.target?.startsWith(candidate.targetPrefix)),
  )
  const decision = rule?.decision ?? policy.default
  if (decision === 'allow_once') return { type: 'allow_once' }
  if (decision === 'allow_always') return { type: 'allow_always' }
  return { type: 'deny', reason: 'Denied by the non-interactive policy file.' }
}

function isPolicy(value: unknown): value is NonInteractivePolicy {
  if (!value || typeof value !== 'object') return false
  const policy = value as NonInteractivePolicy
  return (
    policy.version === 1 &&
    (policy.default === 'deny' || policy.default === 'allow_once') &&
    Array.isArray(policy.rules) &&
    policy.rules.every(
      (rule) =>
        rule &&
        typeof rule === 'object' &&
        typeof rule.tool === 'string' &&
        ['deny', 'allow_once', 'allow_always'].includes(rule.decision) &&
        (rule.targetPrefix === undefined || typeof rule.targetPrefix === 'string'),
    )
  )
}
