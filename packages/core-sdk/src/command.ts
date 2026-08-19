import { createHash } from 'node:crypto'
import type { PromptPersistence } from './prompt.js'

const SHA256 = /^sha256:[a-f0-9]{64}$/u
const SAFE_ID = /^[a-z][a-z0-9.-]*:[a-z0-9][a-z0-9._/-]{0,127}$/u
const SAFE_COMMAND = /^[a-z][a-z0-9-]{0,47}$/u
const SAFE_NAMESPACE = /^[a-z0-9][a-z0-9._-]{0,63}$/u
const SAFE_CAPABILITY = /^[a-z][a-z0-9._:-]{0,95}$/u
const SAFE_ARGUMENT = /^[a-z][a-zA-Z0-9_]{0,63}$/u
const SAFE_WORKSPACE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const MAX_DESCRIPTOR_BYTES = 32 * 1024

export const RESERVED_COMMAND_NAMES_V1 = Object.freeze([
  'new',
  'resume',
  'session',
  'provider',
  'login',
  'logout',
  'model',
  'compact',
  'context',
  'plan',
  'artifacts',
  'copy',
  'export',
  'doctor',
] as const)

export type CommandKindV1 =
  | 'client_local'
  | 'runtime_query'
  | 'runtime_mutation'
  | 'prompt_template'
  | 'skill_invocation'
  | 'workflow'

export type CommandSourceKindV1 = 'builtin' | 'prompt' | 'skill' | 'plugin' | 'mcp'
export type CommandRegistryOwnerV1 = 'client' | 'runtime'
export type CommandRegistryLayerV1 = 'builtin' | 'workspace' | 'extension'
export type CommandEffectV1 = 'none' | 'read' | 'mutation' | 'prompt' | 'job'
export type CommandOutputKindV1 =
  | 'none'
  | 'ui_action'
  | 'runtime_result'
  | 'prompt_envelope'
  | 'bounded_job'

export type CommandArgumentPropertyV1 = Readonly<{
  type: 'string' | 'integer' | 'boolean'
  description?: string
  minLength?: number
  maxLength?: number
  minimum?: number
  maximum?: number
  enum?: readonly string[]
}>

export type CommandArgumentSchemaV1 = Readonly<{
  type: 'object'
  additionalProperties: false
  properties: Readonly<Record<string, CommandArgumentPropertyV1>>
  required: readonly string[]
  positional: readonly string[]
}>

export type CommandSourceV1 = Readonly<{
  kind: CommandSourceKindV1
  origin: string
  namespace?: string
  digest: `sha256:${string}`
}>

export type CommandAvailabilityV1 = Readonly<{
  session: 'none' | 'optional' | 'required'
  run: 'any' | 'idle' | 'active'
  requiresWorkspaceTrust: boolean
}>

export type CommandOutputV1 = Readonly<{
  kind: CommandOutputKindV1
  maxBytes: number
}>

export type CommandDescriptorV1 = Readonly<{
  schemaVersion: 1
  id: string
  command: string
  aliases: readonly string[]
  title: string
  description: string
  usage: string
  kind: CommandKindV1
  schema: CommandArgumentSchemaV1
  source: CommandSourceV1
  effect: CommandEffectV1
  capabilities: readonly string[]
  availability: CommandAvailabilityV1
  output: CommandOutputV1
  sensitiveArguments: readonly string[]
  persistence: PromptPersistence
  descriptorDigest: `sha256:${string}`
}>

export type CreateCommandDescriptorInputV1 = Omit<
  CommandDescriptorV1,
  'schemaVersion' | 'descriptorDigest'
>

export type CommandCatalogEntryV1 = Readonly<{
  layer: CommandRegistryLayerV1
  descriptor: CommandDescriptorV1
  availableAliases: readonly string[]
}>

export type CommandCatalogSnapshotV1 = Readonly<{
  schemaVersion: 1
  owner: CommandRegistryOwnerV1
  workspaceId: string
  workspaceTrusted: boolean
  capabilityIds: readonly string[]
  capabilityDigest: `sha256:${string}`
  entries: readonly CommandCatalogEntryV1[]
  snapshotDigest: `sha256:${string}`
}>

export type CommandSnapshotInputV1 = Readonly<{
  workspaceId: string
  workspaceTrusted: boolean
  capabilityIds: readonly string[]
}>

export function commandSourceDigestV1(value: string): `sha256:${string}` {
  if (typeof value !== 'string' || value.length < 1 || Buffer.byteLength(value) > 4_096) {
    commandFail('COMMAND_SOURCE_DIGEST_INPUT_INVALID')
  }
  return digest(value)
}

export function createCommandDescriptorV1(
  input: CreateCommandDescriptorInputV1,
): CommandDescriptorV1 {
  const candidate = canonicalDescriptor({
    ...input,
    schemaVersion: 1,
    descriptorDigest: 'sha256:'.padEnd(71, '0') as `sha256:${string}`,
  })
  const descriptorDigest = descriptorDigestFor(candidate)
  return validateCommandDescriptorV1({ ...candidate, descriptorDigest })
}

export function validateCommandDescriptorV1(input: unknown): CommandDescriptorV1 {
  if (!isRecord(input) || !exactKeys(input, DESCRIPTOR_KEYS) || input.schemaVersion !== 1) {
    commandFail('COMMAND_DESCRIPTOR_INVALID')
  }
  const descriptor = canonicalDescriptor(input as CommandDescriptorV1)
  if (
    typeof input.descriptorDigest !== 'string' ||
    !SHA256.test(input.descriptorDigest) ||
    input.descriptorDigest !== descriptorDigestFor(descriptor) ||
    Buffer.byteLength(JSON.stringify(descriptor)) > MAX_DESCRIPTOR_BYTES
  ) {
    commandFail('COMMAND_DESCRIPTOR_INVALID')
  }
  return deepFreeze({ ...descriptor, descriptorDigest: input.descriptorDigest })
}

export class CommandRegistryV1 {
  readonly #owner: CommandRegistryOwnerV1
  readonly #reserved: ReadonlySet<string>
  readonly #byId = new Map<string, CommandDescriptorV1>()
  readonly #byCommand = new Map<string, CommandDescriptorV1>()

  constructor(input: {
    owner: CommandRegistryOwnerV1
    reservedCommands?: readonly string[]
  }) {
    if (!isRecord(input) || !['client', 'runtime'].includes(input.owner)) {
      commandFail('COMMAND_REGISTRY_INVALID')
    }
    this.#owner = input.owner as CommandRegistryOwnerV1
    const reserved = input.reservedCommands ?? RESERVED_COMMAND_NAMES_V1
    if (!Array.isArray(reserved) || !reserved.every(isSafeCommand) || hasDuplicates(reserved)) {
      commandFail('COMMAND_REGISTRY_INVALID')
    }
    this.#reserved = new Set(reserved)
  }

  register(input: CommandDescriptorV1): CommandDescriptorV1 {
    const descriptor = validateCommandDescriptorV1(input)
    if (
      (this.#owner === 'client' && descriptor.kind !== 'client_local') ||
      (this.#owner === 'runtime' && descriptor.kind === 'client_local')
    ) {
      commandFail('COMMAND_REGISTRY_OWNER_VIOLATION')
    }
    if (this.#byId.has(descriptor.id) || this.#byCommand.has(descriptor.command)) {
      commandFail('COMMAND_REGISTRY_COLLISION')
    }
    if (
      descriptor.source.kind !== 'builtin' &&
      descriptor.aliases.some((alias) => this.#reserved.has(alias))
    ) {
      commandFail('COMMAND_RESERVED_NAME_COLLISION')
    }
    this.#byId.set(descriptor.id, descriptor)
    this.#byCommand.set(descriptor.command, descriptor)
    return descriptor
  }

  snapshot(input: CommandSnapshotInputV1): CommandCatalogSnapshotV1 {
    const binding = canonicalCapabilityBinding(input)
    const capabilitySet = new Set(binding.capabilityIds)
    const descriptors = [...this.#byId.values()]
      .filter(
        (descriptor) =>
          descriptor.capabilities.every((capability) => capabilitySet.has(capability)) &&
          (!descriptor.availability.requiresWorkspaceTrust || binding.workspaceTrusted),
      )
      .sort(compareDescriptors)
    const aliasOwners = new Map<string, CommandDescriptorV1[]>()
    for (const descriptor of descriptors) {
      for (const alias of descriptor.aliases) {
        const owners = aliasOwners.get(alias) ?? []
        owners.push(descriptor)
        aliasOwners.set(alias, owners)
      }
    }
    const entries = descriptors.map((descriptor) =>
      Object.freeze({
        layer: layerFor(descriptor.source.kind),
        descriptor,
        availableAliases: Object.freeze(
          descriptor.aliases.filter(
            (alias) => !this.#reserved.has(alias) && aliasOwners.get(alias)?.length === 1,
          ),
        ),
      }),
    )
    const candidate = {
      schemaVersion: 1 as const,
      owner: this.#owner,
      ...binding,
      capabilityDigest: capabilityDigestFor(binding),
      entries: Object.freeze(entries),
    }
    return deepFreeze({ ...candidate, snapshotDigest: catalogDigestFor(candidate) })
  }

  get size(): number {
    return this.#byId.size
  }
}

export function validateCommandCatalogSnapshotV1(input: unknown): CommandCatalogSnapshotV1 {
  if (!isRecord(input) || !exactKeys(input, SNAPSHOT_KEYS) || input.schemaVersion !== 1) {
    commandFail('COMMAND_CATALOG_SNAPSHOT_INVALID')
  }
  if (
    !['client', 'runtime'].includes(String(input.owner)) ||
    typeof input.workspaceId !== 'string' ||
    !SAFE_WORKSPACE.test(input.workspaceId) ||
    typeof input.workspaceTrusted !== 'boolean' ||
    !Array.isArray(input.capabilityIds) ||
    !input.capabilityIds.every(isSafeCapability) ||
    hasDuplicates(input.capabilityIds) ||
    typeof input.capabilityDigest !== 'string' ||
    !SHA256.test(input.capabilityDigest) ||
    !Array.isArray(input.entries) ||
    input.entries.length > 512 ||
    typeof input.snapshotDigest !== 'string' ||
    !SHA256.test(input.snapshotDigest)
  ) {
    commandFail('COMMAND_CATALOG_SNAPSHOT_INVALID')
  }
  const binding = canonicalCapabilityBinding({
    workspaceId: input.workspaceId,
    workspaceTrusted: input.workspaceTrusted,
    capabilityIds: input.capabilityIds,
  })
  if (input.capabilityDigest !== capabilityDigestFor(binding)) {
    commandFail('COMMAND_CATALOG_SNAPSHOT_INVALID')
  }
  const seenIds = new Set<string>()
  const seenCommands = new Set<string>()
  const owner = input.owner as CommandRegistryOwnerV1
  const entries = input.entries.map((value) => {
    if (
      !isRecord(value) ||
      !exactKeys(value, ENTRY_KEYS) ||
      !['builtin', 'workspace', 'extension'].includes(String(value.layer)) ||
      !Array.isArray(value.availableAliases) ||
      !value.availableAliases.every(isSafeCommand) ||
      hasDuplicates(value.availableAliases)
    ) {
      commandFail('COMMAND_CATALOG_SNAPSHOT_INVALID')
    }
    const descriptor = validateCommandDescriptorV1(value.descriptor)
    if (
      value.layer !== layerFor(descriptor.source.kind) ||
      seenIds.has(descriptor.id) ||
      seenCommands.has(descriptor.command) ||
      (owner === 'client' && descriptor.kind !== 'client_local') ||
      (owner === 'runtime' && descriptor.kind === 'client_local') ||
      !value.availableAliases.every((alias) => descriptor.aliases.includes(alias)) ||
      value.availableAliases.some((alias) => RESERVED_COMMAND_SET.has(alias)) ||
      !descriptor.capabilities.every((capability) => binding.capabilityIds.includes(capability)) ||
      (descriptor.availability.requiresWorkspaceTrust && !binding.workspaceTrusted)
    ) {
      commandFail('COMMAND_CATALOG_SNAPSHOT_INVALID')
    }
    seenIds.add(descriptor.id)
    seenCommands.add(descriptor.command)
    return Object.freeze({
      layer: value.layer as CommandRegistryLayerV1,
      descriptor,
      availableAliases: Object.freeze([...value.availableAliases] as string[]),
    })
  })
  const ordered = [...entries].sort((left, right) =>
    compareDescriptors(left.descriptor, right.descriptor),
  )
  const availableAliases = entries.flatMap((entry) => entry.availableAliases)
  if (
    entries.some((entry, index) => entry.descriptor.id !== ordered[index]?.descriptor.id) ||
    hasDuplicates(availableAliases) ||
    entries.some((entry) =>
      entry.availableAliases.some(
        (alias) =>
          entries.filter((candidate) => candidate.descriptor.aliases.includes(alias)).length !== 1,
      ),
    )
  ) {
    commandFail('COMMAND_CATALOG_SNAPSHOT_INVALID')
  }
  const candidate = {
    schemaVersion: 1 as const,
    owner,
    ...binding,
    capabilityDigest: input.capabilityDigest as `sha256:${string}`,
    entries: Object.freeze(entries),
  }
  if (input.snapshotDigest !== catalogDigestFor(candidate)) {
    commandFail('COMMAND_CATALOG_SNAPSHOT_INVALID')
  }
  return deepFreeze({ ...candidate, snapshotDigest: input.snapshotDigest as `sha256:${string}` })
}

function canonicalDescriptor(input: CommandDescriptorV1): CommandDescriptorV1 {
  if (
    !isRecord(input) ||
    input.schemaVersion !== 1 ||
    typeof input.id !== 'string' ||
    !SAFE_ID.test(input.id) ||
    typeof input.command !== 'string' ||
    !isSafeQualifiedCommand(input.command) ||
    !Array.isArray(input.aliases) ||
    !input.aliases.every(isSafeCommand) ||
    hasDuplicates(input.aliases) ||
    !boundedText(input.title, 128) ||
    !boundedText(input.description, 1_024) ||
    !boundedText(input.usage, 256) ||
    !COMMAND_KINDS.has(input.kind) ||
    !EFFECTS.has(input.effect) ||
    !PERSISTENCE.has(input.persistence) ||
    !Array.isArray(input.capabilities) ||
    !input.capabilities.every(isSafeCapability) ||
    hasDuplicates(input.capabilities) ||
    !Array.isArray(input.sensitiveArguments) ||
    hasDuplicates(input.sensitiveArguments)
  ) {
    commandFail('COMMAND_DESCRIPTOR_INVALID')
  }
  const schema = canonicalSchema(input.schema)
  const source = canonicalSource(input.source)
  const availability = canonicalAvailability(input.availability)
  const output = canonicalOutput(input.output)
  const sensitiveArguments = [...input.sensitiveArguments].sort()
  if (
    !sensitiveArguments.every(
      (pointer) => schema.properties[argumentFromPointer(pointer)] !== undefined,
    ) ||
    (sensitiveArguments.length > 0 && input.persistence === 'plaintext') ||
    !kindMatchesSource(input.kind, source.kind) ||
    !kindMatchesEffectAndOutput(input.kind, input.effect, output.kind) ||
    !commandMatchesSource(input.command, source)
  ) {
    commandFail('COMMAND_DESCRIPTOR_INVALID')
  }
  return {
    schemaVersion: 1,
    id: input.id,
    command: input.command,
    aliases: Object.freeze([...input.aliases].sort()),
    title: input.title,
    description: input.description,
    usage: input.usage,
    kind: input.kind,
    schema,
    source,
    effect: input.effect,
    capabilities: Object.freeze([...input.capabilities].sort()),
    availability,
    output,
    sensitiveArguments: Object.freeze(sensitiveArguments),
    persistence: input.persistence,
    descriptorDigest: input.descriptorDigest,
  }
}

function canonicalSchema(input: CommandArgumentSchemaV1): CommandArgumentSchemaV1 {
  if (
    !isRecord(input) ||
    !exactKeys(input, SCHEMA_KEYS) ||
    input.type !== 'object' ||
    input.additionalProperties !== false ||
    !isRecord(input.properties) ||
    Object.keys(input.properties).length > 16 ||
    !Array.isArray(input.required) ||
    !input.required.every(isSafeArgument) ||
    hasDuplicates(input.required) ||
    !Array.isArray(input.positional) ||
    !input.positional.every(isSafeArgument) ||
    hasDuplicates(input.positional)
  ) {
    commandFail('COMMAND_DESCRIPTOR_INVALID')
  }
  const properties = Object.fromEntries(
    Object.entries(input.properties)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, property]) => {
        if (!isSafeArgument(name)) commandFail('COMMAND_DESCRIPTOR_INVALID')
        return [name, canonicalProperty(property)]
      }),
  )
  if (
    !input.required.every((name) => properties[name] !== undefined) ||
    !input.positional.every((name) => properties[name] !== undefined) ||
    requiredAfterOptional(input.positional, input.required)
  ) {
    commandFail('COMMAND_DESCRIPTOR_INVALID')
  }
  return Object.freeze({
    type: 'object',
    additionalProperties: false,
    properties: Object.freeze(properties),
    required: Object.freeze([...input.required].sort()),
    positional: Object.freeze([...input.positional]),
  })
}

function canonicalProperty(input: unknown): CommandArgumentPropertyV1 {
  if (
    !isRecord(input) ||
    !exactKeysWithOptional(input, PROPERTY_REQUIRED_KEYS, PROPERTY_OPTIONAL_KEYS) ||
    !PROPERTY_TYPES.has(String(input.type))
  ) {
    commandFail('COMMAND_DESCRIPTOR_INVALID')
  }
  if (input.description !== undefined && !boundedText(input.description, 256)) {
    commandFail('COMMAND_DESCRIPTOR_INVALID')
  }
  const type = input.type as CommandArgumentPropertyV1['type']
  if (
    (input.minLength !== undefined && !boundedInteger(input.minLength, 0, 32_768)) ||
    (input.maxLength !== undefined && !boundedInteger(input.maxLength, 1, 32_768)) ||
    (input.minimum !== undefined &&
      (typeof input.minimum !== 'number' || !Number.isSafeInteger(input.minimum))) ||
    (input.maximum !== undefined &&
      (typeof input.maximum !== 'number' || !Number.isSafeInteger(input.maximum))) ||
    (input.enum !== undefined &&
      (!Array.isArray(input.enum) ||
        input.enum.length < 1 ||
        input.enum.length > 64 ||
        !input.enum.every((value) => boundedText(value, 256)) ||
        hasDuplicates(input.enum))) ||
    (type !== 'string' &&
      (input.minLength !== undefined ||
        input.maxLength !== undefined ||
        input.enum !== undefined)) ||
    (type !== 'integer' && (input.minimum !== undefined || input.maximum !== undefined)) ||
    (input.minLength !== undefined &&
      input.maxLength !== undefined &&
      input.minLength > input.maxLength) ||
    (typeof input.minimum === 'number' &&
      typeof input.maximum === 'number' &&
      input.minimum > input.maximum)
  ) {
    commandFail('COMMAND_DESCRIPTOR_INVALID')
  }
  return Object.freeze({
    type,
    ...(input.description === undefined ? {} : { description: input.description as string }),
    ...(input.minLength === undefined ? {} : { minLength: input.minLength as number }),
    ...(input.maxLength === undefined ? {} : { maxLength: input.maxLength as number }),
    ...(input.minimum === undefined ? {} : { minimum: input.minimum as number }),
    ...(input.maximum === undefined ? {} : { maximum: input.maximum as number }),
    ...(input.enum === undefined
      ? {}
      : { enum: Object.freeze([...(input.enum as string[])].sort()) }),
  })
}

function canonicalSource(input: CommandSourceV1): CommandSourceV1 {
  if (
    !isRecord(input) ||
    !exactKeysWithOptional(input, SOURCE_REQUIRED_KEYS, SOURCE_OPTIONAL_KEYS) ||
    !SOURCE_KINDS.has(input.kind) ||
    !boundedOrigin(input.origin) ||
    typeof input.digest !== 'string' ||
    !SHA256.test(input.digest) ||
    (input.kind === 'builtin' && input.namespace !== undefined) ||
    (input.kind !== 'builtin' && !isSafeNamespace(input.namespace))
  ) {
    commandFail('COMMAND_DESCRIPTOR_INVALID')
  }
  return Object.freeze({
    kind: input.kind,
    origin: input.origin,
    ...(input.namespace === undefined ? {} : { namespace: input.namespace }),
    digest: input.digest,
  })
}

function canonicalAvailability(input: CommandAvailabilityV1): CommandAvailabilityV1 {
  if (
    !isRecord(input) ||
    !exactKeys(input, AVAILABILITY_KEYS) ||
    !['none', 'optional', 'required'].includes(input.session) ||
    !['any', 'idle', 'active'].includes(input.run) ||
    typeof input.requiresWorkspaceTrust !== 'boolean' ||
    (input.session === 'none' && input.run !== 'any')
  ) {
    commandFail('COMMAND_DESCRIPTOR_INVALID')
  }
  return Object.freeze({ ...input })
}

function canonicalOutput(input: CommandOutputV1): CommandOutputV1 {
  if (
    !isRecord(input) ||
    !exactKeys(input, OUTPUT_KEYS) ||
    !OUTPUT_KINDS.has(input.kind) ||
    !boundedInteger(input.maxBytes, 0, 1024 * 1024) ||
    (input.kind === 'none' ? input.maxBytes !== 0 : input.maxBytes < 1)
  ) {
    commandFail('COMMAND_DESCRIPTOR_INVALID')
  }
  return Object.freeze({ kind: input.kind, maxBytes: input.maxBytes })
}

function canonicalCapabilityBinding(
  input: CommandSnapshotInputV1,
): Omit<
  CommandCatalogSnapshotV1,
  'schemaVersion' | 'owner' | 'capabilityDigest' | 'entries' | 'snapshotDigest'
> {
  if (
    !isRecord(input) ||
    typeof input.workspaceId !== 'string' ||
    !SAFE_WORKSPACE.test(input.workspaceId) ||
    typeof input.workspaceTrusted !== 'boolean' ||
    !Array.isArray(input.capabilityIds) ||
    !input.capabilityIds.every(isSafeCapability) ||
    hasDuplicates(input.capabilityIds)
  ) {
    commandFail('COMMAND_CAPABILITY_BINDING_INVALID')
  }
  return Object.freeze({
    workspaceId: input.workspaceId,
    workspaceTrusted: input.workspaceTrusted,
    capabilityIds: Object.freeze([...input.capabilityIds].sort()),
  })
}

function descriptorDigestFor(input: CommandDescriptorV1): `sha256:${string}` {
  const { descriptorDigest: _descriptorDigest, ...candidate } = input
  return digest(JSON.stringify(candidate))
}

function capabilityDigestFor(
  input: Pick<CommandCatalogSnapshotV1, 'workspaceId' | 'workspaceTrusted' | 'capabilityIds'>,
): `sha256:${string}` {
  return digest(
    JSON.stringify({
      workspaceId: input.workspaceId,
      workspaceTrusted: input.workspaceTrusted,
      capabilityIds: input.capabilityIds,
    }),
  )
}

function catalogDigestFor(
  input: Omit<CommandCatalogSnapshotV1, 'snapshotDigest'>,
): `sha256:${string}` {
  return digest(JSON.stringify(input))
}

function kindMatchesSource(kind: CommandKindV1, source: CommandSourceKindV1): boolean {
  if (kind === 'client_local') return source === 'builtin'
  if (source === 'prompt') return kind === 'prompt_template'
  if (source === 'skill') return kind === 'skill_invocation'
  if (source === 'plugin' || source === 'mcp') return kind === 'workflow'
  return true
}

function kindMatchesEffectAndOutput(
  kind: CommandKindV1,
  effect: CommandEffectV1,
  output: CommandOutputKindV1,
): boolean {
  switch (kind) {
    case 'client_local':
      return effect === 'none' && ['none', 'ui_action'].includes(output)
    case 'runtime_query':
      return effect === 'read' && ['runtime_result', 'ui_action'].includes(output)
    case 'runtime_mutation':
      return effect === 'mutation' && ['none', 'runtime_result', 'ui_action'].includes(output)
    case 'prompt_template':
    case 'skill_invocation':
      return effect === 'prompt' && output === 'prompt_envelope'
    case 'workflow':
      return effect === 'job' && output === 'bounded_job'
  }
}

function commandMatchesSource(command: string, source: CommandSourceV1): boolean {
  if (source.kind === 'builtin') return isSafeCommand(command)
  if (source.kind === 'prompt' || source.kind === 'skill') {
    return command === `${source.kind}:${source.namespace}`
  }
  return (
    command.startsWith(`${source.kind}:${source.namespace}/`) &&
    isSafeCommand(command.slice(`${source.kind}:${source.namespace}/`.length))
  )
}

function layerFor(source: CommandSourceKindV1): CommandRegistryLayerV1 {
  if (source === 'builtin') return 'builtin'
  return source === 'prompt' || source === 'skill' ? 'workspace' : 'extension'
}

function compareDescriptors(left: CommandDescriptorV1, right: CommandDescriptorV1): number {
  const layer = LAYER_ORDER[layerFor(left.source.kind)] - LAYER_ORDER[layerFor(right.source.kind)]
  return layer === 0 ? left.command.localeCompare(right.command) : layer
}

function requiredAfterOptional(
  positional: readonly string[],
  required: readonly string[],
): boolean {
  let optionalSeen = false
  for (const name of positional) {
    if (!required.includes(name)) optionalSeen = true
    else if (optionalSeen) return true
  }
  return false
}

function argumentFromPointer(value: unknown): string {
  if (typeof value !== 'string' || !/^\/[a-z][a-zA-Z0-9_]{0,63}$/u.test(value)) {
    commandFail('COMMAND_DESCRIPTOR_INVALID')
  }
  return value.slice(1)
}

function isSafeQualifiedCommand(input: string): boolean {
  return (
    isSafeCommand(input) ||
    /^(?:prompt|skill):[a-z0-9][a-z0-9._-]{0,63}$/u.test(input) ||
    /^(?:plugin|mcp):[a-z0-9][a-z0-9._-]{0,63}\/[a-z][a-z0-9-]{0,47}$/u.test(input)
  )
}

function isSafeCommand(value: unknown): value is string {
  return typeof value === 'string' && SAFE_COMMAND.test(value)
}

function isSafeNamespace(value: unknown): value is string {
  return typeof value === 'string' && SAFE_NAMESPACE.test(value)
}

function isSafeCapability(value: unknown): value is string {
  return typeof value === 'string' && SAFE_CAPABILITY.test(value)
}

function isSafeArgument(value: unknown): value is string {
  return typeof value === 'string' && SAFE_ARGUMENT.test(value)
}

function boundedText(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value) <= maxBytes &&
    [...value].every((character) => {
      const code = character.charCodeAt(0)
      return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127)
    })
  )
}

function boundedOrigin(value: unknown): value is string {
  return boundedText(value, 512) && !/[\r\n]/u.test(value)
}

function boundedInteger(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum
}

function hasDuplicates(values: readonly unknown[]): boolean {
  return new Set(values).size !== values.length
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
  const keys = Object.keys(input)
  return (
    [...required].every((key) => Object.hasOwn(input, key)) &&
    keys.every((key) => required.has(key) || optional.has(key))
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

function commandFail(code: string): never {
  throw Object.assign(new Error(code), { code })
}

const COMMAND_KINDS = new Set<CommandKindV1>([
  'client_local',
  'runtime_query',
  'runtime_mutation',
  'prompt_template',
  'skill_invocation',
  'workflow',
])
const RESERVED_COMMAND_SET: ReadonlySet<string> = new Set(RESERVED_COMMAND_NAMES_V1)
const SOURCE_KINDS = new Set<CommandSourceKindV1>(['builtin', 'prompt', 'skill', 'plugin', 'mcp'])
const EFFECTS = new Set<CommandEffectV1>(['none', 'read', 'mutation', 'prompt', 'job'])
const OUTPUT_KINDS = new Set<CommandOutputKindV1>([
  'none',
  'ui_action',
  'runtime_result',
  'prompt_envelope',
  'bounded_job',
])
const PROPERTY_TYPES = new Set(['string', 'integer', 'boolean'])
const PERSISTENCE = new Set<PromptPersistence>(['plaintext', 'redacted', 'digest', 'none'])
const LAYER_ORDER: Readonly<Record<CommandRegistryLayerV1, number>> = Object.freeze({
  builtin: 0,
  workspace: 1,
  extension: 2,
})
const DESCRIPTOR_KEYS = new Set([
  'schemaVersion',
  'id',
  'command',
  'aliases',
  'title',
  'description',
  'usage',
  'kind',
  'schema',
  'source',
  'effect',
  'capabilities',
  'availability',
  'output',
  'sensitiveArguments',
  'persistence',
  'descriptorDigest',
])
const SCHEMA_KEYS = new Set([
  'type',
  'additionalProperties',
  'properties',
  'required',
  'positional',
])
const PROPERTY_REQUIRED_KEYS = new Set(['type'])
const PROPERTY_OPTIONAL_KEYS = new Set([
  'description',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'enum',
])
const SOURCE_REQUIRED_KEYS = new Set(['kind', 'origin', 'digest'])
const SOURCE_OPTIONAL_KEYS = new Set(['namespace'])
const AVAILABILITY_KEYS = new Set(['session', 'run', 'requiresWorkspaceTrust'])
const OUTPUT_KEYS = new Set(['kind', 'maxBytes'])
const ENTRY_KEYS = new Set(['layer', 'descriptor', 'availableAliases'])
const SNAPSHOT_KEYS = new Set([
  'schemaVersion',
  'owner',
  'workspaceId',
  'workspaceTrusted',
  'capabilityIds',
  'capabilityDigest',
  'entries',
  'snapshotDigest',
])
