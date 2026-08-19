import { createHash } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import { runtimeError, type ToolDefinition } from '@praxis/core-sdk'
import type { ChildBootstrapMethod } from './childBootstrapProfile.js'

// Keep enough headroom for the authenticated profile and envelope inside the
// 64 KiB bootstrap channel limit.
const MAX_BUNDLE_BYTES = 48 * 1024
const MAX_TOOLS = 64
const MAX_SKILLS = 32
const MAX_SKILL_CONTENT_BYTES = 16 * 1024
const MAX_METHODS = 16
const CHILD_METHODS = new Set<ChildBootstrapMethod>([
  'initialize',
  'events.subscribe',
  'session.create',
  'session.prompt',
  'permission.decide',
  'session.abort',
  'shutdown',
])
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/
const SAFE_DIGEST = /^[a-f0-9]{64}$/
const RESOURCE_DIGEST = /^sha256:[a-f0-9]{64}$/

export type ChildProviderTarget = Readonly<{ providerId: string; model: string }>

export type ChildCredentialGrant =
  | Readonly<{ kind: 'none'; mode: 'mock' | 'replay' }>
  | Readonly<{ kind: 'broker_handle'; handleId: string; expiresAt: string }>
  | Readonly<{ kind: 'ephemeral_token'; tokenRef: string; expiresAt: string }>

export type SerializedToolGrant = Readonly<{
  kind: 'builtin'
  name: string
  definition: Readonly<ToolDefinition>
  definitionDigest: `sha256:${string}`
}>

export type SkillResourceGrant = Readonly<{
  id: string
  localId: string
  name: string
  description: string
  origin: string
  digest: `sha256:${string}`
  trust: 'low'
  disableModelInvocation: boolean
  resource: Readonly<{ kind: 'inline'; content: string }>
}>

export type McpToolGrant = Readonly<{
  name: string
  definition: Readonly<ToolDefinition>
  definitionDigest: `sha256:${string}`
  brokerCapabilityId: string
}>

export type ChildMcpServerManifest = Readonly<{
  pluginId: string
  serverId: string
  version: string
  digest: `sha256:${string}`
  entryRef: string
}>

export type ChildMcpGrant =
  | Readonly<{ mode: 'disabled' }>
  | Readonly<{ mode: 'parent_broker'; toolGrants: readonly McpToolGrant[] }>
  | Readonly<{ mode: 'child_launch'; serverManifests: readonly ChildMcpServerManifest[] }>

export type ChildWorkspaceAccess = 'read_only' | 'isolated_process' | 'workspace_write'

export type ChildCapabilityBundleV1 = Readonly<{
  schemaVersion: 1
  bundleId: string
  parentSnapshotDigest: string
  workspace: Readonly<{ root: string; access: ChildWorkspaceAccess }>
  provider: Readonly<{ target: ChildProviderTarget; credential: ChildCredentialGrant }>
  tools: readonly SerializedToolGrant[]
  skills: readonly SkillResourceGrant[]
  mcp: ChildMcpGrant
  methodAllowlist: readonly ChildBootstrapMethod[]
  digest: string
}>

export type ChildToolCandidate = Readonly<{
  source: 'builtin' | 'mcp' | 'process'
  definition: ToolDefinition
  revoked?: boolean
}>

export type ChildSkillCandidate = Readonly<{
  id: string
  localId: string
  name: string
  description: string
  origin: string
  digest: `sha256:${string}`
  disableModelInvocation: boolean
  content: string
  status?: 'enabled' | 'disabled' | 'quarantined'
  revoked?: boolean
}>

export type ChildCapabilityParentSnapshot = Readonly<{
  workspace: string
  providerTargets: readonly ChildProviderTarget[]
  tools: readonly ChildToolCandidate[]
  skills: readonly ChildSkillCandidate[]
  mcp?:
    | Readonly<{ mode: 'parent_broker'; toolGrants: readonly McpToolGrant[] }>
    | Readonly<{ mode: 'child_launch'; serverManifests: readonly ChildMcpServerManifest[] }>
}>

export type ChildCapabilityDenialReason =
  | 'not_in_parent_snapshot'
  | 'not_step_allowed'
  | 'policy_denied'
  | 'isolation_unsupported'
  | 'unrealizable'
  | 'revoked'
  | 'disabled'
  | 'quarantined'
  | 'digest_mismatch'
  | 'not_read_only'
  | 'limit_exceeded'

export type ChildCapabilityDenial = Readonly<{
  category: 'tool' | 'skill' | 'mcp' | 'method'
  capabilityId: string
  reason: ChildCapabilityDenialReason
}>

export type CompileChildCapabilityBundleInput = Readonly<{
  bundleId: string
  parent: ChildCapabilityParentSnapshot
  workspace: Readonly<{ root: string; access: ChildWorkspaceAccess }>
  provider: Readonly<{ target: ChildProviderTarget; credential: ChildCredentialGrant }>
  step: Readonly<{
    toolNames: readonly string[]
    skillIds: readonly string[]
    methodAllowlist: readonly ChildBootstrapMethod[]
    mcpMode: ChildMcpGrant['mode']
  }>
  policy: Readonly<{
    toolNames: readonly string[]
    skillIds: readonly string[]
    methodAllowlist: readonly ChildBootstrapMethod[]
    providerTargets: readonly ChildProviderTarget[]
    mcpModes: readonly ChildMcpGrant['mode'][]
  }>
  isolation: Readonly<{
    builtinToolNames: readonly string[]
    allowInlineSkills: boolean
    methodAllowlist: readonly ChildBootstrapMethod[]
    providerTargets: readonly ChildProviderTarget[]
    credentialKinds: readonly ChildCredentialGrant['kind'][]
    mcpModes: readonly ChildMcpGrant['mode'][]
  }>
}>

export type ChildCapabilityCompilation = Readonly<{
  bundle: ChildCapabilityBundleV1
  denied: readonly ChildCapabilityDenial[]
}>

export function compileChildCapabilityBundle(
  input: CompileChildCapabilityBundleInput,
): ChildCapabilityCompilation {
  assertSafeId(input.bundleId, 'bundleId')
  const workspace = validateWorkspace(input.workspace)
  if (resolve(input.parent.workspace) !== workspace.root) {
    throw bundleFailure(
      'CHILD_CAPABILITY_WORKSPACE_DENIED',
      'The child workspace is not the parent capability snapshot workspace.',
    )
  }
  validateProviderAdmission(input)
  const denied: ChildCapabilityDenial[] = []
  const methods = intersection(
    input.step.methodAllowlist,
    input.policy.methodAllowlist,
    input.isolation.methodAllowlist,
  )
  for (const method of input.step.methodAllowlist) {
    if (!methods.includes(method)) {
      denied.push(
        denial(
          'method',
          method,
          input.policy.methodAllowlist.includes(method) ? 'isolation_unsupported' : 'policy_denied',
        ),
      )
    }
  }
  if (!methods.includes('initialize') || !methods.includes('shutdown')) {
    throw bundleFailure(
      'CHILD_CAPABILITY_METHODS_INVALID',
      'Child capability methods must include initialize and shutdown.',
    )
  }

  const tools = compileTools(input, denied)
  const skills = compileSkills(input, denied)
  const mcp = compileMcp(input, denied)
  const unsigned = {
    schemaVersion: 1 as const,
    bundleId: input.bundleId,
    parentSnapshotDigest: digestParentSnapshot(input.parent),
    workspace,
    provider: {
      target: freezeTarget(input.provider.target),
      credential: cloneCredentialGrant(input.provider.credential),
    },
    tools: Object.freeze(tools),
    skills: Object.freeze(skills),
    mcp,
    methodAllowlist: Object.freeze([...methods]),
  }
  const bundle = deepFreeze({ ...unsigned, digest: digestValue(unsigned) })
  if (Buffer.byteLength(canonicalJson(bundle), 'utf8') > MAX_BUNDLE_BYTES) {
    throw bundleFailure(
      'CHILD_CAPABILITY_BUNDLE_OVERSIZED',
      'The child capability bundle exceeds its bounded serialized size.',
    )
  }
  return Object.freeze({ bundle, denied: Object.freeze(denied) })
}

export function validateChildCapabilityBundle(
  value: unknown,
  expected?: Readonly<{
    digest?: string
    workspace?: Readonly<{ root: string; access: ChildWorkspaceAccess }>
    provider?: ChildProviderTarget
    methodAllowlist?: readonly ChildBootstrapMethod[]
    revokedCapabilityIds?: ReadonlySet<string>
  }>,
): ChildCapabilityBundleV1 {
  if (
    !isExactRecord(value, [
      'schemaVersion',
      'bundleId',
      'parentSnapshotDigest',
      'workspace',
      'provider',
      'tools',
      'skills',
      'mcp',
      'methodAllowlist',
      'digest',
    ]) ||
    value.schemaVersion !== 1 ||
    typeof value.bundleId !== 'string' ||
    !SAFE_ID.test(value.bundleId) ||
    typeof value.parentSnapshotDigest !== 'string' ||
    !SAFE_DIGEST.test(value.parentSnapshotDigest) ||
    typeof value.digest !== 'string' ||
    !SAFE_DIGEST.test(value.digest)
  ) {
    throw bundleInvalid()
  }
  const workspace = validateWorkspace(value.workspace)
  const provider = validateProviderGrant(value.provider)
  const tools = validateToolGrants(value.tools, workspace.access)
  const skills = validateSkillGrants(value.skills)
  const mcp = validateMcpGrant(value.mcp)
  const methodAllowlist = validateMethods(value.methodAllowlist)
  const unsigned = {
    schemaVersion: 1 as const,
    bundleId: value.bundleId,
    parentSnapshotDigest: value.parentSnapshotDigest,
    workspace,
    provider,
    tools,
    skills,
    mcp,
    methodAllowlist,
  }
  if (digestValue(unsigned) !== value.digest) throw bundleInvalid('CHILD_CAPABILITY_TAMPERED')
  if (expected?.digest !== undefined && expected.digest !== value.digest) {
    throw bundleInvalid('CHILD_CAPABILITY_DIGEST_MISMATCH')
  }
  if (
    expected?.workspace !== undefined &&
    (resolve(expected.workspace.root) !== workspace.root ||
      expected.workspace.access !== workspace.access)
  ) {
    throw bundleInvalid('CHILD_CAPABILITY_WORKSPACE_DENIED')
  }
  if (expected?.provider !== undefined && !sameTarget(expected.provider, provider.target)) {
    throw bundleInvalid('CHILD_CAPABILITY_PROVIDER_DENIED')
  }
  if (
    expected?.methodAllowlist !== undefined &&
    !sameStrings(expected.methodAllowlist, methodAllowlist)
  ) {
    throw bundleInvalid('CHILD_CAPABILITY_METHODS_INVALID')
  }
  const revoked = expected?.revokedCapabilityIds
  if (
    revoked !== undefined &&
    [
      ...tools.map((tool) => tool.name),
      ...skills.map((skill) => skill.id),
      ...mcpCapabilityIds(mcp),
    ].some((id) => revoked.has(id))
  ) {
    throw bundleInvalid('CHILD_CAPABILITY_REVOKED')
  }
  const bundle = deepFreeze({ ...unsigned, digest: value.digest })
  if (Buffer.byteLength(canonicalJson(bundle), 'utf8') > MAX_BUNDLE_BYTES) {
    throw bundleInvalid('CHILD_CAPABILITY_BUNDLE_OVERSIZED')
  }
  return bundle
}

export function digestParentSnapshot(snapshot: ChildCapabilityParentSnapshot): string {
  const normalized = {
    workspace: resolve(snapshot.workspace),
    providerTargets: snapshot.providerTargets.map(freezeTarget).sort(compareTargets),
    tools: snapshot.tools
      .map((tool) => ({
        source: tool.source,
        definition: jsonClone(tool.definition),
        revoked: tool.revoked === true,
      }))
      .sort((left, right) => left.definition.name.localeCompare(right.definition.name)),
    skills: snapshot.skills
      .map((skill) => ({ ...skill, revoked: skill.revoked === true }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    mcp: snapshot.mcp === undefined ? { mode: 'disabled' as const } : jsonClone(snapshot.mcp),
  }
  return digestValue(normalized)
}

export function digestToolDefinition(definition: ToolDefinition): `sha256:${string}` {
  return `sha256:${digestValue(jsonClone(definition))}`
}

function compileTools(
  input: CompileChildCapabilityBundleInput,
  denied: ChildCapabilityDenial[],
): SerializedToolGrant[] {
  const grants: SerializedToolGrant[] = []
  const parentTools = new Map(
    input.parent.tools.map((candidate) => [candidate.definition.name, candidate]),
  )
  for (const name of unique(input.step.toolNames).slice(0, MAX_TOOLS)) {
    const candidate = parentTools.get(name)
    if (candidate === undefined) {
      denied.push(denial('tool', name, 'not_in_parent_snapshot'))
      continue
    }
    if (candidate.revoked) {
      denied.push(denial('tool', name, 'revoked'))
      continue
    }
    if (!input.policy.toolNames.includes(name)) {
      denied.push(denial('tool', name, 'policy_denied'))
      continue
    }
    if (candidate.source !== 'builtin') {
      denied.push(denial('tool', name, 'unrealizable'))
      continue
    }
    if (!input.isolation.builtinToolNames.includes(name)) {
      denied.push(denial('tool', name, 'isolation_unsupported'))
      continue
    }
    const definition = validateToolDefinition(candidate.definition)
    if (!isDefinitionAllowed(definition, input.workspace.access)) {
      denied.push(denial('tool', name, 'not_read_only'))
      continue
    }
    grants.push(
      Object.freeze({
        kind: 'builtin',
        name,
        definition,
        definitionDigest: digestToolDefinition(definition),
      }),
    )
  }
  if (unique(input.step.toolNames).length > MAX_TOOLS) {
    denied.push(denial('tool', 'tool-limit', 'limit_exceeded'))
  }
  return grants.sort((left, right) => left.name.localeCompare(right.name))
}

function compileSkills(
  input: CompileChildCapabilityBundleInput,
  denied: ChildCapabilityDenial[],
): SkillResourceGrant[] {
  const grants: SkillResourceGrant[] = []
  const parentSkills = new Map(input.parent.skills.map((skill) => [skill.id, skill]))
  for (const id of unique(input.step.skillIds).slice(0, MAX_SKILLS)) {
    const candidate = parentSkills.get(id)
    if (candidate === undefined) {
      denied.push(denial('skill', id, 'not_in_parent_snapshot'))
      continue
    }
    if (candidate.revoked) {
      denied.push(denial('skill', id, 'revoked'))
      continue
    }
    if (candidate.status === 'disabled' || candidate.status === 'quarantined') {
      denied.push(denial('skill', id, candidate.status))
      continue
    }
    if (!input.policy.skillIds.includes(id)) {
      denied.push(denial('skill', id, 'policy_denied'))
      continue
    }
    if (!input.isolation.allowInlineSkills) {
      denied.push(denial('skill', id, 'isolation_unsupported'))
      continue
    }
    if (
      !RESOURCE_DIGEST.test(candidate.digest) ||
      `sha256:${digestText(candidate.content)}` !== candidate.digest
    ) {
      denied.push(denial('skill', id, 'digest_mismatch'))
      continue
    }
    if (Buffer.byteLength(candidate.content, 'utf8') > MAX_SKILL_CONTENT_BYTES) {
      denied.push(denial('skill', id, 'limit_exceeded'))
      continue
    }
    grants.push(
      Object.freeze({
        id: boundedId(candidate.id),
        localId: boundedId(candidate.localId),
        name: boundedText(candidate.name, 128),
        description: boundedText(candidate.description, 1_024),
        origin: boundedOrigin(candidate.origin),
        digest: candidate.digest,
        trust: 'low',
        disableModelInvocation: candidate.disableModelInvocation,
        resource: Object.freeze({ kind: 'inline', content: candidate.content }),
      }),
    )
  }
  if (unique(input.step.skillIds).length > MAX_SKILLS) {
    denied.push(denial('skill', 'skill-limit', 'limit_exceeded'))
  }
  return grants.sort((left, right) => left.id.localeCompare(right.id))
}

function compileMcp(
  input: CompileChildCapabilityBundleInput,
  denied: ChildCapabilityDenial[],
): ChildMcpGrant {
  const mode = input.step.mcpMode
  if (mode === 'disabled') return Object.freeze({ mode: 'disabled' })
  if (!input.policy.mcpModes.includes(mode)) {
    denied.push(denial('mcp', mode, 'policy_denied'))
    return Object.freeze({ mode: 'disabled' })
  }
  if (!input.isolation.mcpModes.includes(mode)) {
    denied.push(denial('mcp', mode, 'isolation_unsupported'))
    return Object.freeze({ mode: 'disabled' })
  }
  if (input.parent.mcp?.mode !== mode) {
    denied.push(denial('mcp', mode, 'not_in_parent_snapshot'))
    return Object.freeze({ mode: 'disabled' })
  }
  if (mode === 'parent_broker' && input.parent.mcp.mode === 'parent_broker') {
    return deepFreeze({
      mode,
      toolGrants: validateMcpToolGrants(input.parent.mcp.toolGrants),
    })
  }
  if (mode === 'child_launch' && input.parent.mcp.mode === 'child_launch') {
    return deepFreeze({
      mode,
      serverManifests: validateServerManifests(input.parent.mcp.serverManifests),
    })
  }
  denied.push(denial('mcp', mode, 'unrealizable'))
  return Object.freeze({ mode: 'disabled' })
}

function validateProviderAdmission(input: CompileChildCapabilityBundleInput): void {
  const target = input.provider.target
  if (!input.parent.providerTargets.some((candidate) => sameTarget(candidate, target))) {
    throw bundleFailure(
      'CHILD_CAPABILITY_PROVIDER_DENIED',
      'The child Provider target is absent from the parent snapshot.',
    )
  }
  if (!input.policy.providerTargets.some((candidate) => sameTarget(candidate, target))) {
    throw bundleFailure(
      'CHILD_CAPABILITY_PROVIDER_DENIED',
      'The child Provider target is denied by policy.',
    )
  }
  if (!input.isolation.providerTargets.some((candidate) => sameTarget(candidate, target))) {
    throw bundleFailure(
      'CHILD_CAPABILITY_PROVIDER_DENIED',
      'The child Provider target cannot be realized by the selected isolation.',
    )
  }
  if (!input.isolation.credentialKinds.includes(input.provider.credential.kind)) {
    throw bundleFailure(
      'CHILD_CAPABILITY_CREDENTIAL_INVALID',
      'The selected credential delegation cannot be realized by the child isolation.',
    )
  }
  if (
    input.provider.credential.kind === 'none' &&
    input.provider.credential.mode !== target.providerId
  ) {
    throw bundleFailure(
      'CHILD_CAPABILITY_CREDENTIAL_INVALID',
      'Credential-free child authority must match the selected Provider mode.',
    )
  }
}

function validateWorkspace(value: unknown): ChildCapabilityBundleV1['workspace'] {
  if (
    !isExactRecord(value, ['root', 'access']) ||
    typeof value.root !== 'string' ||
    !isAbsolute(value.root) ||
    resolve(value.root) !== value.root ||
    (value.access !== 'read_only' &&
      value.access !== 'isolated_process' &&
      value.access !== 'workspace_write')
  ) {
    throw bundleInvalid('CHILD_CAPABILITY_WORKSPACE_DENIED')
  }
  return Object.freeze({ root: value.root, access: value.access })
}

function validateProviderGrant(value: unknown): ChildCapabilityBundleV1['provider'] {
  if (!isExactRecord(value, ['target', 'credential'])) throw bundleInvalid()
  return Object.freeze({
    target: validateTarget(value.target),
    credential: validateCredentialGrant(value.credential),
  })
}

function validateTarget(value: unknown): ChildProviderTarget {
  if (
    !isExactRecord(value, ['providerId', 'model']) ||
    typeof value.providerId !== 'string' ||
    typeof value.model !== 'string'
  ) {
    throw bundleInvalid()
  }
  assertSafeId(value.providerId, 'providerId')
  assertSafeId(value.model, 'model')
  return Object.freeze({ providerId: value.providerId, model: value.model })
}

function validateCredentialGrant(value: unknown): ChildCredentialGrant {
  if (!isRecord(value) || typeof value.kind !== 'string') throw bundleInvalid()
  if (
    value.kind === 'none' &&
    isExactRecord(value, ['kind', 'mode']) &&
    (value.mode === 'mock' || value.mode === 'replay')
  ) {
    return Object.freeze({ kind: 'none', mode: value.mode })
  }
  if (
    value.kind === 'broker_handle' &&
    isExactRecord(value, ['kind', 'handleId', 'expiresAt']) &&
    typeof value.handleId === 'string' &&
    typeof value.expiresAt === 'string'
  ) {
    assertSafeId(value.handleId, 'handleId')
    assertInstant(value.expiresAt)
    return Object.freeze({
      kind: 'broker_handle',
      handleId: value.handleId,
      expiresAt: value.expiresAt,
    })
  }
  if (
    value.kind === 'ephemeral_token' &&
    isExactRecord(value, ['kind', 'tokenRef', 'expiresAt']) &&
    typeof value.tokenRef === 'string' &&
    typeof value.expiresAt === 'string'
  ) {
    assertSafeId(value.tokenRef, 'tokenRef')
    assertInstant(value.expiresAt)
    return Object.freeze({
      kind: 'ephemeral_token',
      tokenRef: value.tokenRef,
      expiresAt: value.expiresAt,
    })
  }
  throw bundleInvalid('CHILD_CAPABILITY_CREDENTIAL_INVALID')
}

function validateToolGrants(
  value: unknown,
  access: ChildWorkspaceAccess,
): readonly SerializedToolGrant[] {
  if (!Array.isArray(value) || value.length > MAX_TOOLS) throw bundleInvalid()
  const names = new Set<string>()
  return Object.freeze(
    value.map((item) => {
      if (
        !isExactRecord(item, ['kind', 'name', 'definition', 'definitionDigest']) ||
        item.kind !== 'builtin' ||
        typeof item.name !== 'string' ||
        typeof item.definitionDigest !== 'string' ||
        !RESOURCE_DIGEST.test(item.definitionDigest) ||
        names.has(item.name)
      ) {
        throw bundleInvalid()
      }
      const definition = validateToolDefinition(item.definition)
      if (
        definition.name !== item.name ||
        digestToolDefinition(definition) !== item.definitionDigest ||
        !isDefinitionAllowed(definition, access)
      ) {
        throw bundleInvalid('CHILD_CAPABILITY_RESOURCE_DRIFT')
      }
      names.add(item.name)
      return Object.freeze({
        kind: 'builtin' as const,
        name: item.name,
        definition,
        definitionDigest: item.definitionDigest as `sha256:${string}`,
      })
    }),
  )
}

function validateToolDefinition(value: unknown): Readonly<ToolDefinition> {
  if (!isRecord(value)) throw bundleInvalid()
  const definition = jsonClone(value) as ToolDefinition
  if (
    typeof definition.name !== 'string' ||
    !SAFE_ID.test(definition.name) ||
    typeof definition.description !== 'string' ||
    Buffer.byteLength(definition.description, 'utf8') > 4_096 ||
    !isRecord(definition.parameters) ||
    (definition.outputSchema !== undefined && !isRecord(definition.outputSchema))
  ) {
    throw bundleInvalid()
  }
  if (Buffer.byteLength(canonicalJson(definition), 'utf8') > 16 * 1024) throw bundleInvalid()
  return deepFreeze(definition)
}

function validateSkillGrants(value: unknown): readonly SkillResourceGrant[] {
  if (!Array.isArray(value) || value.length > MAX_SKILLS) throw bundleInvalid()
  const ids = new Set<string>()
  return Object.freeze(
    value.map((item) => {
      if (
        !isExactRecord(item, [
          'id',
          'localId',
          'name',
          'description',
          'origin',
          'digest',
          'trust',
          'disableModelInvocation',
          'resource',
        ]) ||
        typeof item.id !== 'string' ||
        typeof item.localId !== 'string' ||
        typeof item.name !== 'string' ||
        typeof item.description !== 'string' ||
        typeof item.origin !== 'string' ||
        typeof item.digest !== 'string' ||
        !RESOURCE_DIGEST.test(item.digest) ||
        item.trust !== 'low' ||
        typeof item.disableModelInvocation !== 'boolean' ||
        !isExactRecord(item.resource, ['kind', 'content']) ||
        item.resource.kind !== 'inline' ||
        typeof item.resource.content !== 'string' ||
        ids.has(item.id)
      ) {
        throw bundleInvalid()
      }
      boundedId(item.id)
      boundedId(item.localId)
      boundedOrigin(item.origin)
      boundedText(item.name, 128)
      boundedText(item.description, 1_024)
      if (
        Buffer.byteLength(item.resource.content, 'utf8') > MAX_SKILL_CONTENT_BYTES ||
        `sha256:${digestText(item.resource.content)}` !== item.digest
      ) {
        throw bundleInvalid('CHILD_CAPABILITY_RESOURCE_DRIFT')
      }
      ids.add(item.id)
      return deepFreeze({
        id: item.id,
        localId: item.localId,
        name: item.name,
        description: item.description,
        origin: item.origin,
        digest: item.digest as `sha256:${string}`,
        trust: 'low' as const,
        disableModelInvocation: item.disableModelInvocation,
        resource: { kind: 'inline' as const, content: item.resource.content },
      })
    }),
  )
}

function validateMcpGrant(value: unknown): ChildMcpGrant {
  if (!isRecord(value) || typeof value.mode !== 'string') throw bundleInvalid()
  if (value.mode === 'disabled' && isExactRecord(value, ['mode'])) {
    return Object.freeze({ mode: 'disabled' })
  }
  if (value.mode === 'parent_broker' && isExactRecord(value, ['mode', 'toolGrants'])) {
    return deepFreeze({
      mode: 'parent_broker',
      toolGrants: validateMcpToolGrants(value.toolGrants),
    })
  }
  if (value.mode === 'child_launch' && isExactRecord(value, ['mode', 'serverManifests'])) {
    return deepFreeze({
      mode: 'child_launch',
      serverManifests: validateServerManifests(value.serverManifests),
    })
  }
  throw bundleInvalid()
}

function validateMcpToolGrants(value: unknown): readonly McpToolGrant[] {
  if (!Array.isArray(value) || value.length > MAX_TOOLS) throw bundleInvalid()
  return Object.freeze(
    value.map((item) => {
      if (
        !isExactRecord(item, ['name', 'definition', 'definitionDigest', 'brokerCapabilityId']) ||
        typeof item.name !== 'string' ||
        typeof item.definitionDigest !== 'string' ||
        !RESOURCE_DIGEST.test(item.definitionDigest) ||
        typeof item.brokerCapabilityId !== 'string'
      ) {
        throw bundleInvalid()
      }
      assertSafeId(item.brokerCapabilityId, 'brokerCapabilityId')
      const definition = validateToolDefinition(item.definition)
      if (
        definition.name !== item.name ||
        digestToolDefinition(definition) !== item.definitionDigest ||
        !isReadOnlyDefinition(definition)
      ) {
        throw bundleInvalid('CHILD_CAPABILITY_RESOURCE_DRIFT')
      }
      return deepFreeze({
        name: item.name,
        definition,
        definitionDigest: item.definitionDigest as `sha256:${string}`,
        brokerCapabilityId: item.brokerCapabilityId,
      })
    }),
  )
}

function validateServerManifests(value: unknown): readonly ChildMcpServerManifest[] {
  if (!Array.isArray(value) || value.length > 16) throw bundleInvalid()
  return Object.freeze(
    value.map((item) => {
      if (
        !isExactRecord(item, ['pluginId', 'serverId', 'version', 'digest', 'entryRef']) ||
        typeof item.pluginId !== 'string' ||
        typeof item.serverId !== 'string' ||
        typeof item.version !== 'string' ||
        typeof item.digest !== 'string' ||
        !RESOURCE_DIGEST.test(item.digest) ||
        typeof item.entryRef !== 'string'
      ) {
        throw bundleInvalid()
      }
      for (const value of [item.pluginId, item.serverId, item.version, item.entryRef]) {
        assertSafeId(value, 'serverManifest')
      }
      return Object.freeze({ ...item }) as ChildMcpServerManifest
    }),
  )
}

function validateMethods(value: unknown): readonly ChildBootstrapMethod[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_METHODS) {
    throw bundleInvalid('CHILD_CAPABILITY_METHODS_INVALID')
  }
  const methods = value.filter(
    (method): method is ChildBootstrapMethod =>
      typeof method === 'string' && CHILD_METHODS.has(method as ChildBootstrapMethod),
  )
  if (methods.length !== value.length || unique(methods).length !== methods.length)
    throw bundleInvalid()
  return Object.freeze([...methods])
}

function isDefinitionAllowed(definition: ToolDefinition, access: ChildWorkspaceAccess): boolean {
  const sideEffect = definition.execution?.sideEffect
  if (sideEffect === 'none' || sideEffect === 'read') return true
  if (sideEffect === 'process') return access !== 'read_only'
  return access === 'workspace_write' && sideEffect === 'write'
}

function isReadOnlyDefinition(definition: ToolDefinition): boolean {
  const sideEffect = definition.execution?.sideEffect
  return sideEffect === 'none' || sideEffect === 'read'
}

function cloneCredentialGrant(grant: ChildCredentialGrant): ChildCredentialGrant {
  return validateCredentialGrant(jsonClone(grant))
}

function freezeTarget(target: ChildProviderTarget): ChildProviderTarget {
  return validateTarget(jsonClone(target))
}

function sameTarget(left: ChildProviderTarget, right: ChildProviderTarget): boolean {
  return left.providerId === right.providerId && left.model === right.model
}

function compareTargets(left: ChildProviderTarget, right: ChildProviderTarget): number {
  return left.providerId === right.providerId
    ? left.model.localeCompare(right.model)
    : left.providerId.localeCompare(right.providerId)
}

function intersection<T extends string>(
  first: readonly T[],
  ...rest: readonly (readonly T[])[]
): T[] {
  return unique(first).filter((value) => rest.every((values) => values.includes(value)))
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)]
}

function denial(
  category: ChildCapabilityDenial['category'],
  capabilityId: string,
  reason: ChildCapabilityDenialReason,
): ChildCapabilityDenial {
  return Object.freeze({ category, capabilityId: boundedId(capabilityId), reason })
}

function mcpCapabilityIds(grant: ChildMcpGrant): string[] {
  if (grant.mode === 'disabled') return []
  return grant.mode === 'parent_broker'
    ? grant.toolGrants.map((tool) => tool.name)
    : grant.serverManifests.map((server) => `${server.pluginId}/${server.serverId}`)
}

function boundedId(value: string): string {
  assertSafeId(value, 'capabilityId')
  return value
}

function boundedText(value: string, maxBytes: number): string {
  if (value.length === 0 || Buffer.byteLength(value, 'utf8') > maxBytes) throw bundleInvalid()
  return value
}

function boundedOrigin(value: string): string {
  if (
    value.trim() !== value ||
    Buffer.byteLength(value, 'utf8') > 2_048 ||
    [...value].some((character) => {
      const code = character.charCodeAt(0)
      return code <= 0x1f || code === 0x7f
    })
  ) {
    throw bundleInvalid()
  }
  return value
}

function assertSafeId(value: string, label: string): void {
  if (!SAFE_ID.test(value)) {
    throw bundleFailure('CHILD_CAPABILITY_INVALID', `Child capability ${label} is invalid.`)
  }
}

function assertInstant(value: string): void {
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw bundleInvalid('CHILD_CAPABILITY_CREDENTIAL_INVALID')
  }
}

function digestText(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function digestValue(value: unknown): string {
  return digestText(canonicalJson(value))
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value))
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalValue(value[key])]),
  )
}

function jsonClone<T>(value: T): T {
  try {
    return JSON.parse(JSON.stringify(value)) as T
  } catch {
    throw bundleInvalid()
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const child of Object.values(value)) deepFreeze(child)
  return value
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value)) return false
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function bundleInvalid(code = 'CHILD_CAPABILITY_INVALID'): Error & { code: string } {
  return bundleFailure(code, 'The child capability bundle is invalid or no longer authorized.')
}

function bundleFailure(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), runtimeError(code, 'subagent', message))
}
