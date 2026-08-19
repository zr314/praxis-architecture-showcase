import { randomUUID } from 'node:crypto'
import {
  assertCommandCatalogBindingV1,
  type CommandCatalogSnapshotV1,
  type CommandInvokeOutputV1,
  type CommandInvokeRequestV1,
  type CommandInvokeResultV1,
  type CommandRegistryV1,
  createCommandAuditRecordV1,
  createCommandInvokeResultV1,
  validateCommandInvocationAgainstDescriptorV1,
  validateCommandInvokeRequestV1,
} from '@praxis/core-sdk'
import type { CommandAuditStoreV1 } from './commandAuditStore.js'

export type RuntimeCommandBindingV1 = Readonly<{
  workspaceId: string
  workspaceTrusted: boolean
  capabilityIds: readonly string[]
}>

export type RuntimeCommandExecutorV1 = (input: {
  request: CommandInvokeRequestV1
  descriptor: CommandCatalogSnapshotV1['entries'][number]['descriptor']
}) => Promise<CommandInvokeOutputV1>

export type RuntimeCommandAvailabilityContextV1 = Readonly<{
  session: 'none' | 'present'
  run: 'idle' | 'active'
}>

/** Owns stale-source rejection, durable audit ordering, and in-process idempotency. */
export class RuntimeCommandServiceV1 {
  readonly #completed = new Map<
    string,
    Readonly<{ invocationDigest: string; result: CommandInvokeResultV1 }>
  >()
  readonly #inFlight = new Map<
    string,
    Readonly<{ invocationDigest: string; result: Promise<CommandInvokeResultV1> }>
  >()

  constructor(
    private readonly registry: CommandRegistryV1,
    private readonly auditStore: CommandAuditStoreV1,
  ) {}

  initialize(): Promise<void> {
    return this.auditStore.initialize()
  }

  list(
    binding: RuntimeCommandBindingV1,
    registry: CommandRegistryV1 = this.registry,
  ): CommandCatalogSnapshotV1 {
    return registry.snapshot(binding)
  }

  invoke(
    input: unknown,
    binding: RuntimeCommandBindingV1,
    availability: RuntimeCommandAvailabilityContextV1,
    execute: RuntimeCommandExecutorV1,
    registry: CommandRegistryV1 = this.registry,
  ): Promise<CommandInvokeResultV1> {
    const request = validateCommandInvokeRequestV1(input)
    const snapshot = assertCommandCatalogBindingV1(this.list(binding, registry), request)
    const entry = snapshot.entries.find(
      ({ descriptor }) => descriptor.id === request.invocation.descriptorId,
    )
    if (entry === undefined) return Promise.reject(commandFailure('COMMAND_DESCRIPTOR_STALE'))
    const invocation = validateCommandInvocationAgainstDescriptorV1(
      request.invocation,
      entry.descriptor,
    )
    if (entry.descriptor.availability.session === 'required' && availability.session === 'none') {
      return Promise.reject(commandFailure('COMMAND_SESSION_REQUIRED'))
    }
    if (entry.descriptor.availability.run === 'idle' && availability.run === 'active') {
      return Promise.reject(commandFailure('COMMAND_UNAVAILABLE_ACTIVE_RUN'))
    }
    if (entry.descriptor.availability.run === 'active' && availability.run !== 'active') {
      return Promise.reject(commandFailure('COMMAND_ACTIVE_RUN_REQUIRED'))
    }
    const invocationDigest = createCommandAuditRecordV1({
      auditId: `audit:${randomUUID()}`,
      recordedAt: new Date().toISOString(),
      descriptor: entry.descriptor,
      invocation,
      ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
    }).invocationDigest
    const completed = this.#completed.get(invocation.clientRequestId)
    if (completed !== undefined) {
      if (completed.invocationDigest !== invocationDigest) {
        return Promise.reject(commandFailure('COMMAND_CLIENT_REQUEST_COLLISION'))
      }
      return Promise.resolve(completed.result)
    }
    const pending = this.#inFlight.get(invocation.clientRequestId)
    if (pending !== undefined) {
      return pending.invocationDigest === invocationDigest
        ? pending.result
        : Promise.reject(commandFailure('COMMAND_CLIENT_REQUEST_COLLISION'))
    }
    const result = this.#invoke(request, entry.descriptor, execute)
    this.#inFlight.set(invocation.clientRequestId, Object.freeze({ invocationDigest, result }))
    void result.finally(() => this.#inFlight.delete(invocation.clientRequestId)).catch(() => {})
    return result
  }

  async #invoke(
    request: CommandInvokeRequestV1,
    descriptor: CommandCatalogSnapshotV1['entries'][number]['descriptor'],
    execute: RuntimeCommandExecutorV1,
  ): Promise<CommandInvokeResultV1> {
    const invocation = request.invocation
    const audit = createCommandAuditRecordV1({
      auditId: `audit:${randomUUID()}`,
      recordedAt: new Date().toISOString(),
      descriptor,
      invocation,
      ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
    })
    const appended = await this.auditStore.append(audit)
    if (appended.duplicate) {
      const completed = this.#completed.get(invocation.clientRequestId)
      if (completed !== undefined) return completed.result
      throw commandFailure('COMMAND_OUTCOME_UNKNOWN')
    }
    const output = await execute({ request, descriptor })
    const result = createCommandInvokeResultV1({ descriptor, invocation, output })
    this.#completed.set(
      invocation.clientRequestId,
      Object.freeze({ invocationDigest: audit.invocationDigest, result }),
    )
    return result
  }
}

function commandFailure(code: string): Error {
  return Object.assign(new Error(code), { code })
}
