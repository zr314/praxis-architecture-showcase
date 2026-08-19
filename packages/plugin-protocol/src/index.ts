export const PLUGIN_MANIFEST_VERSION = 1 as const
export const PLUGIN_HANDSHAKE_VERSION = 1 as const
export const PLUGIN_API_VERSION = 1 as const

export const PLUGIN_CAPABILITY_KINDS = [
  'tool',
  'mcp',
  'provider',
  'skill',
  'template',
  'theme',
] as const
export type PluginCapabilityKind = (typeof PLUGIN_CAPABILITY_KINDS)[number]

export const PLUGIN_ISOLATIONS = ['process', 'mcp-stdio', 'data-only'] as const
export type PluginIsolation = (typeof PLUGIN_ISOLATIONS)[number]

export const PLUGIN_LIFECYCLE_STATES = [
  'installed',
  'workspace-enabled',
  'starting',
  'healthy',
  'degraded',
  'quarantined',
  'stopped',
] as const
export type PluginLifecycleState = (typeof PLUGIN_LIFECYCLE_STATES)[number]

export const PLUGIN_GRANT_TYPES = [
  'filesystem',
  'network',
  'environment',
  'process',
  'resource',
] as const

export type PluginGrant =
  | { type: 'filesystem'; access: 'read' | 'write'; paths: string[] }
  | { type: 'network'; hosts: string[] }
  | { type: 'environment'; names: string[] }
  | { type: 'process'; commands: string[] }
  | { type: 'resource'; cpuMs?: number; memoryMb?: number; processCount?: number }

export type PluginCapabilityDescriptor =
  | { id: string; kind: 'tool' | 'mcp' | 'provider' }
  | { id: string; kind: 'skill' | 'template' | 'theme'; path: string }

export type PluginToolCommandMappingV1 = {
  id: string
  title: string
  description: string
  capability: string
  tool?: string
  positional: string[]
  sensitiveArguments: string[]
  persistence: 'plaintext' | 'redacted' | 'digest' | 'none'
}

export const RUNTIME_EXECUTABLE_CAPABILITY_KINDS = [
  'llm-provider',
  'tool',
  'planner',
  'subagent',
  'persistence',
] as const
export type RuntimeExecutableCapabilityKind = (typeof RUNTIME_EXECUTABLE_CAPABILITY_KINDS)[number]

export const RUNTIME_CAPABILITY_KINDS = [
  ...RUNTIME_EXECUTABLE_CAPABILITY_KINDS,
  'mcp-server',
  'skill',
  'template',
  'theme',
] as const
export type RuntimeCapabilityKind = (typeof RUNTIME_CAPABILITY_KINDS)[number]

export type PluginCapabilityOrigin = {
  type: 'plugin'
  pluginId: string
  digest: `sha256:${string}`
}

export type PluginCapabilityIdentity = {
  id: string
  localId: string
  kind: RuntimeCapabilityKind
  origin: PluginCapabilityOrigin
  publicationKey: string
}

export type PluginManifestV1 = {
  manifestVersion: 1
  id: string
  name: string
  version: string
  apiVersion: 1
  entry?: string
  isolation: PluginIsolation
  capabilities: PluginCapabilityDescriptor[]
  commands?: PluginToolCommandMappingV1[]
  grants: PluginGrant[]
  credentials?: string[]
  engines?: { praxis?: string; node?: string }
  provenance?: {
    algorithm: 'ed25519'
    keyId: string
    signature: string
  }
}

export type PluginHandshakeRequestV1 = {
  protocolVersion: 1
  pluginId: string
  instanceId: string
  capabilities: string[]
  grants: PluginGrant[]
}

export type PluginHandshakeResultV1 = {
  protocolVersion: 1
  pluginId: string
  version: string
  capabilities: PluginCapabilityDescriptor[]
}

const MANIFEST_KEYS = new Set([
  'manifestVersion',
  'id',
  'name',
  'version',
  'apiVersion',
  'entry',
  'isolation',
  'capabilities',
  'commands',
  'grants',
  'credentials',
  'engines',
  'provenance',
])
const EXECUTABLE_CAPABILITY_KEYS = new Set(['id', 'kind'])
const DATA_CAPABILITY_KEYS = new Set(['id', 'kind', 'path'])
const COMMAND_MAPPING_KEYS = new Set([
  'id',
  'title',
  'description',
  'capability',
  'tool',
  'positional',
  'sensitiveArguments',
  'persistence',
])
const FILESYSTEM_GRANT_KEYS = new Set(['type', 'access', 'paths'])
const LIST_GRANT_KEYS = {
  network: new Set(['type', 'hosts']),
  environment: new Set(['type', 'names']),
  process: new Set(['type', 'commands']),
} as const
const RESOURCE_GRANT_KEYS = new Set(['type', 'cpuMs', 'memoryMb', 'processCount'])
const ENGINES_KEYS = new Set(['praxis', 'node'])
const PROVENANCE_KEYS = new Set(['algorithm', 'keyId', 'signature'])
const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,127}$/
const CAPABILITY_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/
const COMMAND_ID_PATTERN = /^[a-z][a-z0-9-]{0,47}$/
const COMMAND_NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/
const ARGUMENT_NAME_PATTERN = /^[a-z][a-zA-Z0-9_]{0,63}$/
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/

export function isPluginGrant(value: unknown): value is PluginGrant {
  if (!isRecord(value) || typeof value.type !== 'string') return false
  switch (value.type) {
    case 'filesystem':
      return (
        hasExactKeys(value, FILESYSTEM_GRANT_KEYS) &&
        (value.access === 'read' || value.access === 'write') &&
        isUniqueStringList(value.paths)
      )
    case 'network':
      return hasExactKeys(value, LIST_GRANT_KEYS.network) && isUniqueStringList(value.hosts)
    case 'environment':
      return (
        hasExactKeys(value, LIST_GRANT_KEYS.environment) &&
        isUniqueStringList(value.names, ENVIRONMENT_NAME_PATTERN)
      )
    case 'process':
      return hasExactKeys(value, LIST_GRANT_KEYS.process) && isUniqueStringList(value.commands)
    case 'resource':
      return (
        hasExactKeys(value, RESOURCE_GRANT_KEYS) &&
        Object.keys(value).length > 1 &&
        isOptionalBoundedInteger(value.cpuMs, 86_400_000) &&
        isOptionalBoundedInteger(value.memoryMb, 1_048_576) &&
        isOptionalBoundedInteger(value.processCount, 1_024)
      )
    default:
      return false
  }
}

export function isPluginGrantArray(value: unknown): value is PluginGrant[] {
  return Array.isArray(value) && value.length <= 128 && value.every(isPluginGrant)
}

export function isPluginManifestV1(value: unknown): value is PluginManifestV1 {
  if (!isRecord(value) || !hasExactKeys(value, MANIFEST_KEYS)) return false
  if (
    value.manifestVersion !== PLUGIN_MANIFEST_VERSION ||
    value.apiVersion !== PLUGIN_API_VERSION ||
    !isBoundedString(value.id, 128, PLUGIN_ID_PATTERN) ||
    !isBoundedString(value.name, 128) ||
    !isBoundedString(value.version, 128, VERSION_PATTERN) ||
    !isOneOf(value.isolation, PLUGIN_ISOLATIONS) ||
    !isPluginGrantArray(value.grants)
  ) {
    return false
  }
  if (value.entry !== undefined && !isPluginRelativePath(value.entry)) {
    return false
  }
  if (value.isolation !== 'data-only' && value.entry === undefined) return false
  if (
    !Array.isArray(value.capabilities) ||
    value.capabilities.length > 128 ||
    !value.capabilities.every(isCapabilityDescriptor)
  ) {
    return false
  }
  const capabilityIds = value.capabilities.map((capability) => capability.id)
  if (new Set(capabilityIds).size !== capabilityIds.length) return false
  if (!isCommandMappings(value.commands, value.id, value.isolation, value.capabilities)) {
    return false
  }
  const dataOnly = value.isolation === 'data-only'
  if (
    dataOnly !==
      value.capabilities.every(
        (capability) =>
          capability.kind === 'skill' ||
          capability.kind === 'template' ||
          capability.kind === 'theme',
      ) ||
    (dataOnly && (value.entry !== undefined || value.grants.length > 0))
  ) {
    return false
  }
  if (
    value.credentials !== undefined &&
    !isUniqueStringList(value.credentials, ENVIRONMENT_NAME_PATTERN, true)
  ) {
    return false
  }
  if (
    value.engines !== undefined &&
    (!isRecord(value.engines) ||
      !hasExactKeys(value.engines, ENGINES_KEYS) ||
      (value.engines.praxis !== undefined && !isBoundedString(value.engines.praxis, 128)) ||
      (value.engines.node !== undefined && !isBoundedString(value.engines.node, 128)))
  ) {
    return false
  }
  return (
    value.provenance === undefined ||
    (isRecord(value.provenance) &&
      hasExactKeys(value.provenance, PROVENANCE_KEYS) &&
      value.provenance.algorithm === 'ed25519' &&
      isBoundedString(value.provenance.keyId, 128) &&
      isBoundedString(value.provenance.signature, 8_192))
  )
}

function isCommandMappings(
  value: unknown,
  pluginId: string,
  isolation: PluginIsolation,
  capabilities: PluginCapabilityDescriptor[],
): value is PluginToolCommandMappingV1[] | undefined {
  if (value === undefined) return true
  if (
    isolation === 'data-only' ||
    !COMMAND_NAMESPACE_PATTERN.test(pluginId) ||
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 64
  ) {
    return false
  }
  const expectedKind = isolation === 'mcp-stdio' ? 'mcp' : 'tool'
  if (
    !value.every(
      (mapping) =>
        isRecord(mapping) &&
        hasExactKeys(mapping, COMMAND_MAPPING_KEYS) &&
        isBoundedString(mapping.id, 48, COMMAND_ID_PATTERN) &&
        isBoundedString(mapping.title, 128) &&
        isBoundedString(mapping.description, 1_024) &&
        isBoundedString(mapping.capability, 128, CAPABILITY_ID_PATTERN) &&
        (isolation === 'mcp-stdio'
          ? isBoundedString(mapping.tool, 128)
          : mapping.tool === undefined) &&
        isUniqueStringList(mapping.positional, ARGUMENT_NAME_PATTERN, true) &&
        isUniqueStringList(mapping.sensitiveArguments, ARGUMENT_NAME_PATTERN, true) &&
        ['plaintext', 'redacted', 'digest', 'none'].includes(String(mapping.persistence)) &&
        !(
          (mapping.sensitiveArguments as string[]).length > 0 && mapping.persistence === 'plaintext'
        ) &&
        capabilities.some(
          (capability) => capability.id === mapping.capability && capability.kind === expectedKind,
        ),
    )
  ) {
    return false
  }
  return new Set(value.map((mapping) => mapping.id)).size === value.length
}

export function normalizePluginCapability(
  pluginId: string,
  digest: string,
  descriptor: PluginCapabilityDescriptor,
): Readonly<PluginCapabilityIdentity> {
  if (!PLUGIN_ID_PATTERN.test(pluginId)) throw new TypeError('Invalid plugin capability plugin ID.')
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) {
    throw new TypeError('Invalid plugin capability digest.')
  }
  if (!isCapabilityDescriptor(descriptor)) {
    throw new TypeError('Invalid plugin capability descriptor.')
  }
  const id = `${pluginId}/${descriptor.id}`
  const origin = Object.freeze({
    type: 'plugin' as const,
    pluginId,
    digest: digest as `sha256:${string}`,
  })
  return Object.freeze({
    id,
    localId: descriptor.id,
    kind: mapPluginCapabilityKind(descriptor.kind),
    origin,
    publicationKey: `${id}@${digest}`,
  })
}

export function pluginCapabilityPublicationKey(
  pluginId: string,
  digest: string,
  descriptor: PluginCapabilityDescriptor,
): string {
  return normalizePluginCapability(pluginId, digest, descriptor).publicationKey
}

export function mapPluginCapabilityKind(kind: PluginCapabilityKind): RuntimeCapabilityKind {
  switch (kind) {
    case 'provider':
      return 'llm-provider'
    case 'mcp':
      return 'mcp-server'
    default:
      return kind
  }
}

export function isPluginRelativePath(value: unknown): value is string {
  return isBoundedString(value, 1_024) && isSafeRelativePath(value)
}

function isCapabilityDescriptor(value: unknown): value is PluginCapabilityDescriptor {
  if (
    !isRecord(value) ||
    !isBoundedString(value.id, 128, CAPABILITY_ID_PATTERN) ||
    !isOneOf(value.kind, PLUGIN_CAPABILITY_KINDS)
  ) {
    return false
  }
  if (value.kind === 'skill' || value.kind === 'template' || value.kind === 'theme') {
    return hasExactKeys(value, DATA_CAPABILITY_KEYS) && isPluginRelativePath(value.path)
  }
  return hasExactKeys(value, EXECUTABLE_CAPABILITY_KEYS)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key))
}

function isBoundedString(value: unknown, maximum: number, pattern?: RegExp): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    (pattern === undefined || pattern.test(value))
  )
}

function isUniqueStringList(
  value: unknown,
  pattern?: RegExp,
  allowEmpty = false,
): value is string[] {
  if (!Array.isArray(value) || value.length > 128 || (!allowEmpty && value.length === 0))
    return false
  if (!value.every((entry) => isBoundedString(entry, 1_024, pattern))) return false
  return new Set(value).size === value.length
}

function isOptionalBoundedInteger(value: unknown, maximum: number): boolean {
  return (
    value === undefined ||
    (Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= maximum)
  )
}

function isOneOf<T extends string>(value: unknown, candidates: readonly T[]): value is T {
  return typeof value === 'string' && candidates.includes(value as T)
}

function isSafeRelativePath(value: string): boolean {
  if (
    value.includes('\0') ||
    value.startsWith('/') ||
    value.startsWith('\\') ||
    /^[A-Za-z]:/.test(value)
  ) {
    return false
  }
  return !value.split(/[\\/]/).includes('..')
}

export * from './process.js'
