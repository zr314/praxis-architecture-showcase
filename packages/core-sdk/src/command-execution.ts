import { createHash } from 'node:crypto'
import type {
  CommandArgumentPropertyV1,
  CommandCatalogSnapshotV1,
  CommandDescriptorV1,
} from './command.js'
import { validateCommandCatalogSnapshotV1, validateCommandDescriptorV1 } from './command.js'
import type { CommandArgumentValueV1, CommandInvocationV1 } from './input-router.js'
import { validateCommandInvocationV1 } from './input-router.js'
import type { PromptEnvelope } from './prompt.js'
import { validatePromptEnvelope } from './prompt.js'

const SHA256 = /^sha256:[a-f0-9]{64}$/u
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/u
const SAFE_ACTION = /^[a-z][a-z0-9._-]{0,95}$/u
const MAX_RESULT_BYTES = 1024 * 1024
const MAX_JSON_DEPTH = 16
const MAX_JSON_ITEMS = 4_096

export type CommandJsonPrimitiveV1 = string | number | boolean | null
export type CommandJsonValueV1 =
  | CommandJsonPrimitiveV1
  | readonly CommandJsonValueV1[]
  | Readonly<{ [key: string]: CommandJsonValueV1 }>

export type CommandInvokeRequestV1 = Readonly<{
  schemaVersion: 1
  workspace: string
  catalogSnapshotDigest: `sha256:${string}`
  capabilityDigest: `sha256:${string}`
  invocation: CommandInvocationV1
  sessionId?: string
}>

export type CommandInvokeOutputV1 =
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'runtime_result'; value: CommandJsonValueV1 }>
  | Readonly<{
      kind: 'ui_action'
      action: string
      payload?: Readonly<Record<string, CommandJsonValueV1>>
    }>
  | Readonly<{
      kind: 'bounded_job'
      jobId: string
      state: 'accepted' | 'completed'
    }>
  | Readonly<{
      kind: 'prompt_envelope'
      envelope: PromptEnvelope
    }>

export type CommandInvokeResultV1 = Readonly<{
  schemaVersion: 1
  invocationId: string
  clientRequestId: string
  descriptorId: string
  descriptorDigest: `sha256:${string}`
  effect: 'read' | 'mutation' | 'prompt' | 'job'
  audited: true
  output: CommandInvokeOutputV1
}>

export type CommandAuditRecordV1 = Readonly<{
  schemaVersion: 1
  event: 'command.invoked'
  auditId: string
  recordedAt: string
  clientRequestId: string
  invocationId: string
  sessionId?: string
  commandId: string
  descriptorId: string
  descriptorDigest: `sha256:${string}`
  sourceDigest: `sha256:${string}`
  persistence: 'plaintext' | 'redacted' | 'digest' | 'none'
  argumentNames: readonly string[]
  arguments?: Readonly<Record<string, CommandArgumentValueV1 | '[REDACTED]'>>
  argumentDigest?: `sha256:${string}`
  invocationDigest: `sha256:${string}`
}>

export function validateCommandInvokeRequestV1(input: unknown): CommandInvokeRequestV1 {
  if (
    !isRecord(input) ||
    !exactKeysWithOptional(
      input,
      new Set([
        'schemaVersion',
        'workspace',
        'catalogSnapshotDigest',
        'capabilityDigest',
        'invocation',
      ]),
      new Set(['sessionId']),
    ) ||
    input.schemaVersion !== 1 ||
    !boundedText(input.workspace, 4_096) ||
    typeof input.catalogSnapshotDigest !== 'string' ||
    !SHA256.test(input.catalogSnapshotDigest) ||
    typeof input.capabilityDigest !== 'string' ||
    !SHA256.test(input.capabilityDigest) ||
    (input.sessionId !== undefined && !safeId(input.sessionId))
  ) {
    commandExecutionFail('COMMAND_INVOKE_REQUEST_INVALID')
  }
  return deepFreeze({
    schemaVersion: 1,
    workspace: input.workspace,
    catalogSnapshotDigest: input.catalogSnapshotDigest as `sha256:${string}`,
    capabilityDigest: input.capabilityDigest as `sha256:${string}`,
    invocation: validateCommandInvocationV1(input.invocation),
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId as string }),
  })
}

export function validateCommandInvocationAgainstDescriptorV1(
  invocationInput: unknown,
  descriptorInput: unknown,
): CommandInvocationV1 {
  const invocation = validateCommandInvocationV1(invocationInput)
  const descriptor = validateCommandDescriptorV1(descriptorInput)
  if (
    invocation.descriptorId !== descriptor.id ||
    invocation.descriptorDigest !== descriptor.descriptorDigest ||
    invocation.command !== descriptor.command
  ) {
    commandExecutionFail('COMMAND_DESCRIPTOR_STALE')
  }
  const names = Object.keys(invocation.arguments)
  if (
    names.some((name) => descriptor.schema.properties[name] === undefined) ||
    descriptor.schema.required.some((name) => invocation.arguments[name] === undefined) ||
    names.some(
      (name) => !matchesProperty(invocation.arguments[name], descriptor.schema.properties[name]!),
    ) ||
    (invocation.body !== undefined && invocation.arguments.body !== invocation.body)
  ) {
    commandExecutionFail('COMMAND_ARGUMENTS_INVALID')
  }
  return invocation
}

export function validateCommandInvokeResultV1(input: unknown): CommandInvokeResultV1 {
  if (
    !isRecord(input) ||
    !exactKeys(
      input,
      new Set([
        'schemaVersion',
        'invocationId',
        'clientRequestId',
        'descriptorId',
        'descriptorDigest',
        'effect',
        'audited',
        'output',
      ]),
    ) ||
    input.schemaVersion !== 1 ||
    !safeId(input.invocationId) ||
    !safeId(input.clientRequestId) ||
    !safeId(input.descriptorId) ||
    typeof input.descriptorDigest !== 'string' ||
    !SHA256.test(input.descriptorDigest) ||
    !['read', 'mutation', 'prompt', 'job'].includes(String(input.effect)) ||
    input.audited !== true
  ) {
    commandExecutionFail('COMMAND_INVOKE_RESULT_INVALID')
  }
  const output = validateOutput(input.output)
  const result = {
    schemaVersion: 1 as const,
    invocationId: input.invocationId,
    clientRequestId: input.clientRequestId,
    descriptorId: input.descriptorId,
    descriptorDigest: input.descriptorDigest as `sha256:${string}`,
    effect: input.effect as CommandInvokeResultV1['effect'],
    audited: true as const,
    output,
  }
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_RESULT_BYTES) {
    commandExecutionFail('COMMAND_INVOKE_RESULT_INVALID')
  }
  return deepFreeze(result)
}

export function createCommandInvokeResultV1(input: {
  descriptor: CommandDescriptorV1
  invocation: CommandInvocationV1
  output: CommandInvokeOutputV1
}): CommandInvokeResultV1 {
  const descriptor = validateCommandDescriptorV1(input.descriptor)
  const invocation = validateCommandInvocationAgainstDescriptorV1(input.invocation, descriptor)
  const effect =
    descriptor.effect === 'read'
      ? 'read'
      : descriptor.effect === 'mutation'
        ? 'mutation'
        : descriptor.effect === 'prompt'
          ? 'prompt'
          : descriptor.effect === 'job'
            ? 'job'
            : undefined
  if (effect === undefined) commandExecutionFail('COMMAND_EFFECT_NOT_INVOKABLE')
  if (input.output.kind !== descriptor.output.kind) {
    commandExecutionFail('COMMAND_OUTPUT_KIND_INVALID')
  }
  return validateCommandInvokeResultV1({
    schemaVersion: 1,
    invocationId: invocation.invocationId,
    clientRequestId: invocation.clientRequestId,
    descriptorId: descriptor.id,
    descriptorDigest: descriptor.descriptorDigest,
    effect,
    audited: true,
    output: input.output,
  })
}

export function createCommandAuditRecordV1(input: {
  auditId: string
  recordedAt: string
  descriptor: CommandDescriptorV1
  invocation: CommandInvocationV1
  sessionId?: string
}): CommandAuditRecordV1 {
  const descriptor = validateCommandDescriptorV1(input.descriptor)
  const invocation = validateCommandInvocationAgainstDescriptorV1(input.invocation, descriptor)
  const argumentNames = Object.keys(invocation.arguments).sort()
  const canonicalArguments = Object.fromEntries(
    argumentNames.map((name) => [name, invocation.arguments[name]!]),
  ) as Record<string, CommandArgumentValueV1>
  const sensitive = new Set(descriptor.sensitiveArguments.map((pointer) => pointer.slice(1)))
  const projection = auditProjection(descriptor.persistence, canonicalArguments, sensitive)
  return validateCommandAuditRecordV1({
    schemaVersion: 1,
    event: 'command.invoked',
    auditId: input.auditId,
    recordedAt: input.recordedAt,
    clientRequestId: invocation.clientRequestId,
    invocationId: invocation.invocationId,
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    commandId: invocation.command,
    descriptorId: descriptor.id,
    descriptorDigest: descriptor.descriptorDigest,
    sourceDigest: descriptor.source.digest,
    persistence: descriptor.persistence,
    argumentNames,
    ...projection,
    invocationDigest: commandInvocationDigestV1(invocation),
  })
}

export function validateCommandAuditRecordV1(input: unknown): CommandAuditRecordV1 {
  if (
    !isRecord(input) ||
    !exactKeysWithOptional(
      input,
      new Set([
        'schemaVersion',
        'event',
        'auditId',
        'recordedAt',
        'clientRequestId',
        'invocationId',
        'commandId',
        'descriptorId',
        'descriptorDigest',
        'sourceDigest',
        'persistence',
        'argumentNames',
        'invocationDigest',
      ]),
      new Set(['sessionId', 'arguments', 'argumentDigest']),
    ) ||
    input.schemaVersion !== 1 ||
    input.event !== 'command.invoked' ||
    !safeId(input.auditId) ||
    !validTimestamp(input.recordedAt) ||
    !safeId(input.clientRequestId) ||
    !safeId(input.invocationId) ||
    (input.sessionId !== undefined && !safeId(input.sessionId)) ||
    !boundedText(input.commandId, 256) ||
    !safeId(input.descriptorId) ||
    typeof input.descriptorDigest !== 'string' ||
    !SHA256.test(input.descriptorDigest) ||
    typeof input.sourceDigest !== 'string' ||
    !SHA256.test(input.sourceDigest) ||
    !['plaintext', 'redacted', 'digest', 'none'].includes(String(input.persistence)) ||
    !Array.isArray(input.argumentNames) ||
    input.argumentNames.length > 16 ||
    !(input.argumentNames as unknown[]).every(argumentName) ||
    new Set(input.argumentNames as unknown[]).size !== input.argumentNames.length ||
    [...(input.argumentNames as unknown[])]
      .sort()
      .some((name, index) => name !== (input.argumentNames as unknown[])[index]) ||
    typeof input.invocationDigest !== 'string' ||
    !SHA256.test(input.invocationDigest)
  ) {
    commandExecutionFail('COMMAND_AUDIT_RECORD_INVALID')
  }
  const persistence = input.persistence as CommandAuditRecordV1['persistence']
  const arguments_ = input.arguments
  if (
    (persistence === 'plaintext' &&
      !validAuditArguments(arguments_, input.argumentNames as unknown[], false)) ||
    (persistence === 'redacted' &&
      !validAuditArguments(arguments_, input.argumentNames as unknown[], true)) ||
    ((persistence === 'digest' || persistence === 'none') && arguments_ !== undefined) ||
    (persistence === 'digest' &&
      (typeof input.argumentDigest !== 'string' || !SHA256.test(input.argumentDigest))) ||
    (persistence !== 'digest' && input.argumentDigest !== undefined)
  ) {
    commandExecutionFail('COMMAND_AUDIT_RECORD_INVALID')
  }
  return deepFreeze({
    schemaVersion: 1,
    event: 'command.invoked',
    auditId: input.auditId,
    recordedAt: input.recordedAt,
    clientRequestId: input.clientRequestId,
    invocationId: input.invocationId,
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId as string }),
    commandId: input.commandId,
    descriptorId: input.descriptorId,
    descriptorDigest: input.descriptorDigest as `sha256:${string}`,
    sourceDigest: input.sourceDigest as `sha256:${string}`,
    persistence,
    argumentNames: Object.freeze([...(input.argumentNames as string[])]),
    ...(arguments_ === undefined
      ? {}
      : {
          arguments: Object.freeze({
            ...(arguments_ as Record<string, CommandArgumentValueV1 | '[REDACTED]'>),
          }),
        }),
    ...(input.argumentDigest === undefined
      ? {}
      : { argumentDigest: input.argumentDigest as `sha256:${string}` }),
    invocationDigest: input.invocationDigest as `sha256:${string}`,
  })
}

export function commandInvocationDigestV1(input: CommandInvocationV1): `sha256:${string}` {
  const invocation = validateCommandInvocationV1(input)
  return digest(
    JSON.stringify({
      schemaVersion: invocation.schemaVersion,
      invocationId: invocation.invocationId,
      clientRequestId: invocation.clientRequestId,
      descriptorId: invocation.descriptorId,
      descriptorDigest: invocation.descriptorDigest,
      command: invocation.command,
      arguments: Object.fromEntries(
        Object.entries(invocation.arguments).sort(([a], [b]) => a.localeCompare(b)),
      ),
      ...(invocation.body === undefined ? {} : { body: invocation.body }),
    }),
  )
}

export function assertCommandCatalogBindingV1(
  snapshotInput: unknown,
  request: Pick<CommandInvokeRequestV1, 'catalogSnapshotDigest' | 'capabilityDigest'>,
): CommandCatalogSnapshotV1 {
  const snapshot = validateCommandCatalogSnapshotV1(snapshotInput)
  if (
    snapshot.snapshotDigest !== request.catalogSnapshotDigest ||
    snapshot.capabilityDigest !== request.capabilityDigest
  ) {
    commandExecutionFail('COMMAND_CATALOG_STALE')
  }
  return snapshot
}

function auditProjection(
  persistence: CommandAuditRecordV1['persistence'],
  arguments_: Readonly<Record<string, CommandArgumentValueV1>>,
  sensitive: ReadonlySet<string>,
): Pick<CommandAuditRecordV1, 'arguments' | 'argumentDigest'> {
  if (persistence === 'none') return {}
  if (persistence === 'digest') return { argumentDigest: digest(JSON.stringify(arguments_)) }
  if (persistence === 'redacted') {
    return {
      arguments: Object.freeze(
        Object.fromEntries(Object.keys(arguments_).map((name) => [name, '[REDACTED]'])) as Record<
          string,
          '[REDACTED]'
        >,
      ),
    }
  }
  if (sensitive.size > 0) commandExecutionFail('COMMAND_AUDIT_POLICY_INVALID')
  return { arguments: Object.freeze({ ...arguments_ }) }
}

function validateOutput(input: unknown): CommandInvokeOutputV1 {
  if (!isRecord(input) || typeof input.kind !== 'string') {
    commandExecutionFail('COMMAND_INVOKE_RESULT_INVALID')
  }
  switch (input.kind) {
    case 'none':
      if (!exactKeys(input, new Set(['kind'])))
        commandExecutionFail('COMMAND_INVOKE_RESULT_INVALID')
      return Object.freeze({ kind: 'none' })
    case 'runtime_result':
      if (!exactKeys(input, new Set(['kind', 'value']))) {
        commandExecutionFail('COMMAND_INVOKE_RESULT_INVALID')
      }
      validateJson(input.value)
      return deepFreeze({
        kind: 'runtime_result',
        value: structuredClone(input.value) as CommandJsonValueV1,
      })
    case 'ui_action': {
      if (
        !exactKeysWithOptional(input, new Set(['kind', 'action']), new Set(['payload'])) ||
        typeof input.action !== 'string' ||
        !SAFE_ACTION.test(input.action) ||
        (input.payload !== undefined && !isRecord(input.payload))
      ) {
        commandExecutionFail('COMMAND_INVOKE_RESULT_INVALID')
      }
      if (input.payload !== undefined) validateJson(input.payload)
      return deepFreeze({
        kind: 'ui_action',
        action: input.action,
        ...(input.payload === undefined
          ? {}
          : { payload: structuredClone(input.payload) as Record<string, CommandJsonValueV1> }),
      })
    }
    case 'bounded_job':
      if (
        !exactKeys(input, new Set(['kind', 'jobId', 'state'])) ||
        !safeId(input.jobId) ||
        !['accepted', 'completed'].includes(String(input.state))
      ) {
        commandExecutionFail('COMMAND_INVOKE_RESULT_INVALID')
      }
      return Object.freeze({
        kind: 'bounded_job',
        jobId: input.jobId,
        state: input.state as 'accepted' | 'completed',
      })
    case 'prompt_envelope':
      if (!exactKeys(input, new Set(['kind', 'envelope']))) {
        commandExecutionFail('COMMAND_INVOKE_RESULT_INVALID')
      }
      return deepFreeze({
        kind: 'prompt_envelope',
        envelope: validatePromptEnvelope(input.envelope),
      })
    default:
      commandExecutionFail('COMMAND_INVOKE_RESULT_INVALID')
  }
}

function matchesProperty(
  value: CommandArgumentValueV1 | undefined,
  property: CommandArgumentPropertyV1,
): boolean {
  if (value === undefined || typeof value !== property.type.replace('integer', 'number'))
    return false
  if (typeof value === 'string') {
    const bytes = Buffer.byteLength(value)
    return (
      (property.minLength === undefined || bytes >= property.minLength) &&
      (property.maxLength === undefined || bytes <= property.maxLength) &&
      (property.enum === undefined || property.enum.includes(value))
    )
  }
  if (typeof value === 'number') {
    return (
      Number.isSafeInteger(value) &&
      (property.minimum === undefined || value >= property.minimum) &&
      (property.maximum === undefined || value <= property.maximum)
    )
  }
  return true
}

function validateJson(input: unknown): asserts input is CommandJsonValueV1 {
  let items = 0
  const visit = (value: unknown, depth: number): void => {
    items += 1
    if (items > MAX_JSON_ITEMS || depth > MAX_JSON_DEPTH) {
      commandExecutionFail('COMMAND_INVOKE_RESULT_INVALID')
    }
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return
    if (typeof value === 'number' && Number.isFinite(value)) return
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1)
      return
    }
    if (isRecord(value)) {
      for (const [key, nested] of Object.entries(value)) {
        if (!boundedText(key, 256)) commandExecutionFail('COMMAND_INVOKE_RESULT_INVALID')
        visit(nested, depth + 1)
      }
      return
    }
    commandExecutionFail('COMMAND_INVOKE_RESULT_INVALID')
  }
  visit(input, 0)
  if (Buffer.byteLength(JSON.stringify(input)) > MAX_RESULT_BYTES) {
    commandExecutionFail('COMMAND_INVOKE_RESULT_INVALID')
  }
}

function validAuditArguments(input: unknown, names: unknown[], redacted: boolean): boolean {
  return (
    isRecord(input) &&
    Object.keys(input).length === names.length &&
    names.every((name) => typeof name === 'string' && Object.hasOwn(input, name)) &&
    Object.values(input).every((value) =>
      redacted ? value === '[REDACTED]' : isCommandArgumentValue(value),
    )
  )
}

function isCommandArgumentValue(value: unknown): value is CommandArgumentValueV1 {
  return (
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isSafeInteger(value)) ||
    (typeof value === 'string' && Buffer.byteLength(value) <= 28 * 1024)
  )
}

function argumentName(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][a-zA-Z0-9_]{0,63}$/u.test(value)
}

function safeId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_ID.test(value)
}

function boundedText(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= maxBytes
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function exactKeys(input: Record<string, unknown>, expected: ReadonlySet<string>): boolean {
  const keys = Object.keys(input)
  return keys.length === expected.size && keys.every((key) => expected.has(key))
}

function exactKeysWithOptional(
  input: Record<string, unknown>,
  required: ReadonlySet<string>,
  optional: ReadonlySet<string>,
): boolean {
  return (
    [...required].every((key) => Object.hasOwn(input, key)) &&
    Object.keys(input).every((key) => required.has(key) || optional.has(key))
  )
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input)
}

function digest(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const nested of Object.values(value)) deepFreeze(nested)
  }
  return value
}

function commandExecutionFail(code: string): never {
  throw Object.assign(new Error(code), { code })
}
