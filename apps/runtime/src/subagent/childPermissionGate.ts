import { isAbsolute, relative, resolve } from 'node:path'
import { runtimeError } from '@praxis/core-sdk'
import type { PermissionDecision, SessionEvent } from '@praxis/protocol'
import type { ChildCapabilityBundleV1 } from './childCapabilityBundle.js'
import type { ContextPacketV1 } from './contextPacket.js'

const MAX_PERMISSION_REQUEST_BYTES = 16 * 1024
const MAX_JSON_DEPTH = 16
const MAX_JSON_NODES = 1_024
const MAX_ARRAY_ITEMS = 64
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/

type PermissionRequestEvent = Extract<SessionEvent, { type: 'permission_request' }>

export type ChildPermissionRequestV1 = Readonly<{
  schemaVersion: 1
  parentRunId: string
  childRunId: string
  workspace: string
  runId: string
  requestId: string
  toolCallId: string
  tool: string
  rule: string
  input: unknown
  risk?: 'low' | 'medium' | 'high'
  target?: string
  grant: Readonly<{ bundleId: string; bundleDigest: string }>
}>

export type ChildPermissionDecisionPort = Readonly<{
  decide(request: ChildPermissionRequestV1): PermissionDecision | Promise<PermissionDecision>
}>

export type ChildPermissionDecisionLifecyclePort = ChildPermissionDecisionPort &
  Readonly<{
    cancelChild?(parentRunId: string, childRunId: string): void | Promise<void>
  }>

/**
 * Converts child protocol permission events into bounded parent-owned decisions.
 * The gate never lets a decision port expand the signed capability bundle.
 */
export class ChildPermissionGate {
  readonly #seen = new Set<string>()

  constructor(
    private readonly authority: Readonly<{
      parentRunId: string
      childRunId: string
      workspace: string
      capabilityBundle: ChildCapabilityBundleV1
    }>,
    private readonly decisionPort?: ChildPermissionDecisionPort,
  ) {}

  async decide(event: PermissionRequestEvent): Promise<PermissionDecision> {
    if (this.#seen.has(event.requestId)) return denied('duplicate_request')
    this.#seen.add(event.requestId)

    const request = this.#request(event)
    if (request === undefined || !this.#withinGrant(request)) {
      return denied('outside_signed_grant')
    }
    if (this.decisionPort === undefined) return denied('parent_decision_unavailable')

    try {
      return validDecision(await this.decisionPort.decide(request))
    } catch {
      return denied('parent_decision_failed')
    }
  }

  #request(event: PermissionRequestEvent): ChildPermissionRequestV1 | undefined {
    if (
      !safeId(this.authority.parentRunId) ||
      !safeId(this.authority.childRunId) ||
      !safeId(event.runId) ||
      !safeId(event.requestId) ||
      !safeId(event.toolCallId) ||
      !safeId(event.tool) ||
      !safeRule(event.rule)
    ) {
      return undefined
    }
    let input: unknown
    try {
      input = cloneBoundedJson(event.input)
    } catch {
      return undefined
    }
    const request = deepFreeze({
      schemaVersion: 1 as const,
      parentRunId: this.authority.parentRunId,
      childRunId: this.authority.childRunId,
      workspace: resolve(this.authority.workspace),
      runId: event.runId,
      requestId: event.requestId,
      toolCallId: event.toolCallId,
      tool: event.tool,
      rule: event.rule,
      input,
      ...(event.risk === undefined ? {} : { risk: event.risk }),
      ...(event.target === undefined ? {} : { target: event.target }),
      grant: {
        bundleId: this.authority.capabilityBundle.bundleId,
        bundleDigest: this.authority.capabilityBundle.digest,
      },
    })
    return Buffer.byteLength(JSON.stringify(request), 'utf8') <= MAX_PERMISSION_REQUEST_BYTES
      ? request
      : undefined
  }

  #withinGrant(request: ChildPermissionRequestV1): boolean {
    const grant =
      this.authority.capabilityBundle.tools.find((candidate) => candidate.name === request.tool) ??
      (this.authority.capabilityBundle.mcp.mode === 'parent_broker'
        ? this.authority.capabilityBundle.mcp.toolGrants.find(
            (candidate) => candidate.name === request.tool,
          )
        : undefined)
    const execution = grant?.definition.execution
    const allowedEffects = allowedSideEffects(this.authority.capabilityBundle.workspace.access)
    if (
      grant === undefined ||
      execution === undefined ||
      !allowedEffects.has(execution.sideEffect)
    ) {
      return false
    }
    if (execution.target.kind === 'none') return request.target === undefined
    if (request.target === undefined || !isAbsolute(request.target)) return false
    return containedPath(this.authority.workspace, request.target)
  }
}

/** Freeze the current execution MVP before any child process is admitted. */
export function assertChildExecutionMvp(
  packet: ContextPacketV1,
  bundle: ChildCapabilityBundleV1,
): void {
  if (
    packet.budget.maxChildRuns !== 0 ||
    packet.budget.maxParallelChildren !== 0 ||
    packet.budget.maxDepth !== 0
  ) {
    throw mvpFailure(
      'CHILD_MVP_DESCENDANTS_DENIED',
      'The child execution MVP does not permit descendant authority.',
    )
  }
  if (bundle.mcp.mode === 'child_launch') {
    throw mvpFailure('CHILD_MVP_MCP_DISABLED', 'Child-side MCP server launch remains disabled.')
  }
  const allowedEffects = allowedSideEffects(bundle.workspace.access)
  if (
    bundle.tools.some(
      (grant) => !allowedEffects.has(grant.definition.execution?.sideEffect ?? 'none'),
    )
  ) {
    throw mvpFailure(
      'CHILD_MVP_TOOL_DENIED',
      'The child execution grant contains a Tool side effect outside its workspace authority.',
    )
  }
  if (
    bundle.mcp.mode === 'parent_broker' &&
    bundle.mcp.toolGrants.some(
      (grant) => !allowedEffects.has(grant.definition.execution?.sideEffect ?? 'none'),
    )
  ) {
    throw mvpFailure(
      'CHILD_MVP_TOOL_DENIED',
      'The child execution grant contains a brokered MCP side effect outside its authority.',
    )
  }
}

function allowedSideEffects(access: ChildCapabilityBundleV1['workspace']['access']): Set<string> {
  if (access === 'workspace_write') return new Set(['none', 'read', 'write', 'process'])
  if (access === 'isolated_process') return new Set(['none', 'read', 'process'])
  return new Set(['none', 'read'])
}

function validDecision(value: unknown): PermissionDecision {
  if (!isRecord(value)) return denied('parent_decision_invalid')
  if (
    (value.type === 'allow_once' || value.type === 'allow_always') &&
    Object.keys(value).length === 1
  ) {
    return { type: value.type }
  }
  if (
    value.type === 'deny' &&
    Object.keys(value).every((key) => key === 'type' || key === 'reason') &&
    (value.reason === undefined ||
      (typeof value.reason === 'string' && Buffer.byteLength(value.reason, 'utf8') <= 512))
  ) {
    return value.reason === undefined ? { type: 'deny' } : { type: 'deny', reason: value.reason }
  }
  return denied('parent_decision_invalid')
}

function denied(reason: string): PermissionDecision {
  return { type: 'deny', reason: `Child permission denied (${reason}).` }
}

function containedPath(workspace: string, target: string): boolean {
  const root = resolve(workspace)
  const relation = relative(root, resolve(target))
  return (
    relation !== '..' &&
    !relation.startsWith('../') &&
    !relation.startsWith('..\\') &&
    !isAbsolute(relation)
  )
}

function cloneBoundedJson(value: unknown): unknown {
  const state = { nodes: 0 }
  const cloned = cloneJson(value, 0, state)
  if (Buffer.byteLength(JSON.stringify(cloned), 'utf8') > MAX_PERMISSION_REQUEST_BYTES) {
    throw new TypeError('Permission input exceeds its bounded size.')
  }
  return cloned
}

function cloneJson(value: unknown, depth: number, state: { nodes: number }): unknown {
  state.nodes += 1
  if (depth > MAX_JSON_DEPTH || state.nodes > MAX_JSON_NODES) throw new TypeError('Invalid JSON.')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_ITEMS) throw new TypeError('Invalid JSON.')
    return value.map((entry) => cloneJson(entry, depth + 1, state))
  }
  if (!isRecord(value)) throw new TypeError('Invalid JSON.')
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      if (!key || Buffer.byteLength(key, 'utf8') > 256) throw new TypeError('Invalid JSON.')
      return [key, cloneJson(entry, depth + 1, state)]
    }),
  )
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const entry of Object.values(value)) deepFreeze(entry)
  return Object.freeze(value)
}

function safeId(value: string): boolean {
  return SAFE_ID.test(value)
}

function safeRule(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= 1_024
}

function mvpFailure(code: string, message: string): Error {
  return Object.assign(new Error(message), runtimeError(code, 'subagent', message))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
