import { createHash } from 'node:crypto'
import {
  runtimeError,
  type SubagentCancellationRequestV1,
  type SubagentExecutionRequestV1,
  type SubagentExecutor,
  type SubagentResultV1,
  validateSubagentCancellationRequestV1,
  validateSubagentExecutionRequestV1,
} from '@praxis/core-sdk'
import type { ChildPermissionDecisionLifecyclePort } from './childPermissionGate.js'
import type { ChildRuntimeHost, ChildRuntimeRun } from './childRuntimeHost.js'
import { validateContextPacketV1, validateSubagentResultV1 } from './contextPacket.js'

export type MaterializedSubagentExecutionV1 = Omit<ChildRuntimeRun, 'permissionDecisions'>

export type SubagentExecutionMaterializer = Readonly<{
  materialize(
    request: SubagentExecutionRequestV1,
  ): MaterializedSubagentExecutionV1 | Promise<MaterializedSubagentExecutionV1>
}>

type ChildRuntimeExecutionPort = Pick<ChildRuntimeHost, 'run' | 'cancel'>

export type ChildRuntimeSubagentExecutorOptions = Readonly<{
  host: ChildRuntimeExecutionPort
  materializer: SubagentExecutionMaterializer
  permissionDecisions: ChildPermissionDecisionLifecyclePort
}>

/** Production adapter from opaque Planner refs to the internal child Runtime host. */
export class ChildRuntimeSubagentExecutor implements SubagentExecutor {
  readonly #active = new Map<string, string>()

  constructor(private readonly options: ChildRuntimeSubagentExecutorOptions) {}

  async execute(input: SubagentExecutionRequestV1): Promise<SubagentResultV1> {
    const request = validateSubagentExecutionRequestV1(input)
    if (this.#active.has(request.childRunId)) throw executorConflict()
    this.#active.set(request.childRunId, request.parentRunId)
    try {
      const materialized = await this.options.materializer.materialize(request)
      assertMaterializedBinding(request, materialized)
      const result = validateSubagentResultV1(
        await this.options.host.run({
          ...materialized,
          permissionDecisions: this.options.permissionDecisions,
        }),
      )
      if (result.childRunId !== request.childRunId) throw executorBindingMismatch()
      return result
    } finally {
      try {
        await this.options.permissionDecisions.cancelChild?.(
          request.parentRunId,
          request.childRunId,
        )
      } finally {
        this.#active.delete(request.childRunId)
      }
    }
  }

  async cancel(input: SubagentCancellationRequestV1): Promise<boolean> {
    const request = validateSubagentCancellationRequestV1(input)
    if (this.#active.get(request.childRunId) !== request.parentRunId) return false
    let cancelled: ReturnType<ChildRuntimeExecutionPort['cancel']>
    try {
      cancelled = this.options.host.cancel(request.childRunId, request.reason)
    } finally {
      await this.options.permissionDecisions.cancelChild?.(request.parentRunId, request.childRunId)
    }
    return cancelled.some(([runId]) => runId === request.childRunId)
  }
}

export function createSubagentExecutionRequestV1(
  execution: MaterializedSubagentExecutionV1,
): SubagentExecutionRequestV1 {
  const packet = validateContextPacketV1(execution.packet)
  const profile = execution.bootstrapProfile
  const bundle = profile.capabilityBundle
  return validateSubagentExecutionRequestV1({
    schemaVersion: 1,
    parentRunId: packet.parentRunId,
    childRunId: packet.childRunId,
    packetRef: versionedRef('context_packet', packet.packetId, 1, digestCanonical(packet)),
    profileRef: versionedRef('bootstrap_profile', packet.childRunId, 3, digestCanonical(profile)),
    bundleRef: versionedRef('capability_bundle', bundle.bundleId, 1, `sha256:${bundle.digest}`),
    budgetRef: versionedRef(
      'execution_budget',
      packet.childRunId,
      1,
      digestCanonical(packet.budget),
    ),
  })
}

function assertMaterializedBinding(
  request: SubagentExecutionRequestV1,
  execution: MaterializedSubagentExecutionV1,
): void {
  const expected = createSubagentExecutionRequestV1(execution)
  if (
    expected.parentRunId !== request.parentRunId ||
    expected.childRunId !== request.childRunId ||
    !sameRef(expected.packetRef, request.packetRef) ||
    !sameRef(expected.profileRef, request.profileRef) ||
    !sameRef(expected.bundleRef, request.bundleRef) ||
    !sameRef(expected.budgetRef, request.budgetRef)
  ) {
    throw executorBindingMismatch()
  }
}

function versionedRef(
  kind: SubagentExecutionRequestV1['packetRef']['kind'],
  id: string,
  version: number,
  digest: `sha256:${string}`,
) {
  return { schemaVersion: 1, kind, id, version, digest }
}

function sameRef(
  left: SubagentExecutionRequestV1['packetRef'],
  right: SubagentExecutionRequestV1['packetRef'],
): boolean {
  return (
    left.schemaVersion === right.schemaVersion &&
    left.kind === right.kind &&
    left.id === right.id &&
    left.version === right.version &&
    left.digest === right.digest
  )
}

function digestCanonical(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`
  }
  throw executorBindingMismatch()
}

function executorConflict(): Error {
  return Object.assign(
    new Error('A subagent execution with the same child run ID is already active.'),
    runtimeError(
      'SUBAGENT_EXECUTOR_CONFLICT',
      'subagent',
      'A subagent execution with the same child run ID is already active.',
    ),
  )
}

function executorBindingMismatch(): Error {
  return Object.assign(
    new Error('Materialized child execution does not match the Planner-facing references.'),
    runtimeError(
      'SUBAGENT_EXECUTOR_BINDING_MISMATCH',
      'subagent',
      'Materialized child execution does not match the Planner-facing references.',
    ),
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
