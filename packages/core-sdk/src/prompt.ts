import { createHash } from 'node:crypto'
import type { ProviderCapabilities, ProviderToolDefinition } from './llm.js'

export type PromptPersistence = 'plaintext' | 'redacted' | 'digest' | 'none'

export type PromptEnvelopeSource = 'user_text' | 'prompt_template' | 'skill' | 'workflow'

export type PromptEnvelopePart = Readonly<{
  kind:
    | 'user_input'
    | 'command_arguments'
    | 'template_expansion'
    | 'skill_invocation'
    | 'workflow_context'
  trust: 'user' | 'low'
  persistence: PromptPersistence
  origin: string
  digest: `sha256:${string}`
  text?: string
  ref?: string
}>

/** Runtime-only normalized intent. Persistence code must project each part by policy. */
export type PromptEnvelope = Readonly<{
  schemaVersion: 1
  id: string
  source: PromptEnvelopeSource
  digest: `sha256:${string}`
  effectiveText: string
  rawInput?: string
  rawInputPersistence: PromptPersistence
  parts: readonly PromptEnvelopePart[]
  commandInvocationId?: string
  attachmentRefs: readonly string[]
}>

export type CreatePromptEnvelopeInput = Readonly<{
  id: string
  source: PromptEnvelopeSource
  effectiveText: string
  rawInput?: string
  rawInputPersistence?: PromptPersistence
  userInputPersistence?: PromptPersistence
  userOrigin?: string
  additionalParts?: readonly PromptEnvelopePart[]
  commandInvocationId?: string
  attachmentRefs?: readonly string[]
}>

export type PromptContextView = Readonly<{
  schemaVersion: 1
  authority: 'session_journal_v3' | 'compatibility_v2'
  sessionId: string
  revision: number
  checkpoint?: Readonly<{
    checkpointId: string
    trust: 'low'
    range: Readonly<{
      unit: 'entry_sequence' | 'message_index'
      start: number
      end: number
    }>
    digest: `sha256:${string}`
    generator?: Readonly<{
      kind: 'deterministic' | 'model'
      id: string
      provider?: string
      model?: string
    }>
  }>
  recentEntryRange: Readonly<{
    unit: 'entry_sequence' | 'message_index'
    start: number
    end: number
  }>
  plan?: Readonly<{
    planId: string
    revision: number
    state: string
    objective: string
    steps: readonly Readonly<{
      stepId: string
      title: string
      state: string
      prerequisiteResultRefs: readonly string[]
    }>[]
  }>
  prerequisiteResultRefs: readonly string[]
  artifactRefs: readonly string[]
  omission: Readonly<{
    entries: number
    messages: number
    reasons: readonly ('checkpoint' | 'budget' | 'capability_scope')[]
  }>
}>

export type PromptCapabilitySnapshotManifest = Readonly<{
  snapshotId: string
  digest: `sha256:${string}`
  toolCount: number
}>

export type PromptAssemblyManifest = PromptManifest &
  Readonly<{
    schemaVersion: 1
    envelope: Readonly<{
      id: string
      source: PromptEnvelopeSource
      digest: `sha256:${string}`
      partCount: number
    }>
    context: Readonly<{
      authority: PromptContextView['authority']
      sessionId: string
      revision: number
      recentEntryRange: PromptContextView['recentEntryRange']
      checkpoint?: PromptContextView['checkpoint']
      plan?: Readonly<{
        planId: string
        revision: number
        state: string
        digest: `sha256:${string}`
      }>
      prerequisiteResultCount: number
      prerequisiteResultDigest: `sha256:${string}`
      omittedEntries: number
      omittedMessages: number
      omissionReasons: PromptContextView['omission']['reasons']
      state:
        | Readonly<{ kind: 'none' }>
        | Readonly<{
            kind: 'semantic_checkpoint'
            checkpointId: string
            digest: `sha256:${string}`
          }>
        | Readonly<{
            kind: 'provider_native'
            checkpointId: string
            provider: string
            model: string
            format: string
            sourceDigest: `sha256:${string}`
            instructionsDigest: `sha256:${string}`
          }>
    }>
    capability: PromptCapabilitySnapshotManifest &
      Readonly<{ toolSchemaTokens: number; bundleScoped: boolean }>
    target: Readonly<{ provider: string; model: string }>
    budget: Readonly<{
      tokenizerId: string
      contextWindowTokens: number
      reservedTokens: number
      availableMessageTokens: number
      selectedTokens: number
      checkpointTokens: number
      contextViewTokens: number
      pinnedContextTokens: number
    }>
  }>

export function createPromptEnvelope(input: CreatePromptEnvelopeInput): PromptEnvelope {
  const effectiveText = boundedText(input.effectiveText, 32_768)
  const rawInput = input.rawInput === undefined ? undefined : boundedText(input.rawInput, 32_768)
  const userInput: PromptEnvelopePart = {
    kind: 'user_input',
    trust: 'user',
    persistence: input.userInputPersistence ?? 'plaintext',
    origin: safeOrigin(input.userOrigin ?? 'user:interactive'),
    digest: promptDigest(effectiveText),
    text: effectiveText,
  }
  const candidate = {
    schemaVersion: 1 as const,
    id: safeIdentifier(input.id),
    source: input.source,
    effectiveText,
    ...(rawInput === undefined ? {} : { rawInput }),
    rawInputPersistence: input.rawInputPersistence ?? userInput.persistence,
    parts: [userInput, ...(input.additionalParts ?? []).map(clonePromptPart)],
    ...(input.commandInvocationId === undefined
      ? {}
      : { commandInvocationId: safeIdentifier(input.commandInvocationId) }),
    attachmentRefs: [...(input.attachmentRefs ?? [])].map(safeReference),
  }
  return validatePromptEnvelope({ ...candidate, digest: envelopeDigest(candidate) })
}

export function validatePromptEnvelope(input: unknown): PromptEnvelope {
  if (!isRecord(input) || !onlyKeys(input, ENVELOPE_KEYS) || input.schemaVersion !== 1) invalid()
  if (
    !safeIdentifierValue(input.id) ||
    !ENVELOPE_SOURCES.has(input.source as PromptEnvelopeSource) ||
    typeof input.effectiveText !== 'string' ||
    input.effectiveText.length < 1 ||
    Buffer.byteLength(input.effectiveText, 'utf8') > 32_768 ||
    (input.rawInput !== undefined &&
      (typeof input.rawInput !== 'string' || Buffer.byteLength(input.rawInput, 'utf8') > 32_768)) ||
    !PERSISTENCE.has(input.rawInputPersistence as PromptPersistence) ||
    !Array.isArray(input.parts) ||
    input.parts.length < 1 ||
    input.parts.length > 16 ||
    !Array.isArray(input.attachmentRefs) ||
    input.attachmentRefs.length > 32 ||
    !input.attachmentRefs.every(safeReferenceValue) ||
    (input.commandInvocationId !== undefined && !safeIdentifierValue(input.commandInvocationId)) ||
    typeof input.digest !== 'string' ||
    !SHA256.test(input.digest)
  ) {
    invalid()
  }
  const parts = input.parts.map(validatePromptPart)
  const userInput = parts[0]
  if (
    userInput?.kind !== 'user_input' ||
    userInput.trust !== 'user' ||
    userInput.text !== input.effectiveText
  ) {
    invalid()
  }
  const candidate = {
    schemaVersion: 1 as const,
    id: input.id as string,
    source: input.source as PromptEnvelopeSource,
    effectiveText: input.effectiveText,
    ...(input.rawInput === undefined ? {} : { rawInput: input.rawInput as string }),
    rawInputPersistence: input.rawInputPersistence as PromptPersistence,
    parts,
    ...(input.commandInvocationId === undefined
      ? {}
      : { commandInvocationId: input.commandInvocationId as string }),
    attachmentRefs: [...(input.attachmentRefs as string[])],
  }
  if (input.digest !== envelopeDigest(candidate)) invalid()
  return deepFreeze({ ...candidate, digest: input.digest as `sha256:${string}` })
}

export function promptDigest(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

export type PromptSource = 'builtin' | 'runtime' | 'project'

export type PromptCacheScope = 'request'

/** Selects a versioned, model-visible prompt program. Runtime policy remains authoritative. */
export type PromptVariant = 'baseline-v1' | 'iron-law-lean-v1'

export type PromptProgramManifest = Readonly<{
  variant: PromptVariant
  trustedInstructions: Readonly<{
    id: 'praxis.trusted-instructions'
    version: string
    owner: 'runtime'
    blockCount: 1
    digest: `sha256:${string}`
    estimatedTokens: number
    componentIds: readonly string[]
  }>
}>

export type PromptWorkspace = {
  cwd: string
  platform: NodeJS.Platform
  shell: 'powershell' | 'posix'
}

export type PromptSection = {
  id: string
  source: PromptSource
  order: number
  cacheScope: PromptCacheScope
  content: string
}

export type PromptManifestSection = {
  id: string
  source: PromptSource
  order: number
  cacheScope: PromptCacheScope
  characters: number
  estimatedTokens: number
  included: boolean
  digest: string
  projectInstructions?: PromptProjectInstructionDecision[]
}

export type ProjectInstructionName = 'AGENTS.md' | 'PRAXIS.md'

export type PromptProjectInstruction = {
  name: ProjectInstructionName
  content: string
  bytes: number
  renderedBytes: number
  digest: string
  clipped: boolean
}

export type PromptProjectInstructionDecision = {
  name: ProjectInstructionName
  status: 'loaded' | 'rejected' | 'skipped'
  reason?:
    | 'symbolic_link'
    | 'not_regular_file'
    | 'outside_workspace'
    | 'not_accessible'
    | 'total_limit'
  bytes?: number
  renderedBytes?: number
  digest?: string
  clipped?: boolean
  sourceTruncated?: boolean
}

export type PromptManifest = {
  estimatedTokens: number
  maxTokens: number
  sections: PromptManifestSection[]
  program: PromptProgramManifest
}

export type PromptBuildInput = {
  workspace: PromptWorkspace
  tools: ProviderToolDefinition[]
  variant?: PromptVariant
  provider?: { id: string; capabilities?: ProviderCapabilities }
  workflow?: {
    role: 'root' | 'child'
    mode: 'auto' | 'solo' | 'workflow'
  }
  maxSystemPromptTokens: number
  skills?: PromptSkillDisclosure[]
  projectInstructions?: PromptProjectInstruction[]
  projectInstructionDecisions?: PromptProjectInstructionDecision[]
}

export type PromptSkillDisclosure = {
  id: string
  name: string
  description: string
  modelInvocable: boolean
}

export type PromptContextMessage = {
  role: 'user'
  content: string
}

export type SystemPromptBuild = {
  instructions: string
  contextMessages: PromptContextMessage[]
  manifest: PromptManifest
}

const SHA256 = /^sha256:[a-f0-9]{64}$/
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/
const PERSISTENCE = new Set<PromptPersistence>(['plaintext', 'redacted', 'digest', 'none'])
const ENVELOPE_SOURCES = new Set<PromptEnvelopeSource>([
  'user_text',
  'prompt_template',
  'skill',
  'workflow',
])
const PART_KINDS = new Set<PromptEnvelopePart['kind']>([
  'user_input',
  'command_arguments',
  'template_expansion',
  'skill_invocation',
  'workflow_context',
])
const ENVELOPE_KEYS = [
  'schemaVersion',
  'id',
  'source',
  'digest',
  'effectiveText',
  'rawInput',
  'rawInputPersistence',
  'parts',
  'commandInvocationId',
  'attachmentRefs',
] as const
const PART_KEYS = ['kind', 'trust', 'persistence', 'origin', 'digest', 'text', 'ref'] as const

function validatePromptPart(input: unknown): PromptEnvelopePart {
  if (
    !isRecord(input) ||
    !onlyKeys(input, PART_KEYS) ||
    !PART_KINDS.has(input.kind as PromptEnvelopePart['kind']) ||
    (input.trust !== 'user' && input.trust !== 'low') ||
    !PERSISTENCE.has(input.persistence as PromptPersistence) ||
    typeof input.origin !== 'string' ||
    !safeMetadataValue(input.origin) ||
    typeof input.digest !== 'string' ||
    !SHA256.test(input.digest) ||
    (input.text !== undefined &&
      (typeof input.text !== 'string' || Buffer.byteLength(input.text, 'utf8') > 32_768)) ||
    (input.ref !== undefined && !safeReferenceValue(input.ref)) ||
    (input.text === undefined && input.ref === undefined) ||
    (input.text !== undefined && promptDigest(input.text) !== input.digest) ||
    ((input.kind === 'user_input' || input.kind === 'command_arguments') &&
      input.trust !== 'user') ||
    (input.kind !== 'user_input' && input.kind !== 'command_arguments' && input.trust !== 'low')
  ) {
    invalid()
  }
  return Object.freeze({
    kind: input.kind as PromptEnvelopePart['kind'],
    trust: input.trust,
    persistence: input.persistence as PromptPersistence,
    origin: input.origin,
    digest: input.digest as `sha256:${string}`,
    ...(input.text === undefined ? {} : { text: input.text as string }),
    ...(input.ref === undefined ? {} : { ref: input.ref as string }),
  })
}

function clonePromptPart(input: PromptEnvelopePart): PromptEnvelopePart {
  return validatePromptPart({ ...input })
}

function envelopeDigest(input: Omit<PromptEnvelope, 'digest'>): `sha256:${string}` {
  const canonical = {
    schemaVersion: 1,
    id: input.id,
    source: input.source,
    effectiveTextDigest: promptDigest(input.effectiveText),
    ...(input.rawInput === undefined ? {} : { rawInputDigest: promptDigest(input.rawInput) }),
    rawInputPersistence: input.rawInputPersistence,
    parts: input.parts.map((part) => ({
      kind: part.kind,
      trust: part.trust,
      persistence: part.persistence,
      origin: part.origin,
      digest: part.digest,
      ...(part.ref === undefined ? {} : { ref: part.ref }),
    })),
    ...(input.commandInvocationId === undefined
      ? {}
      : { commandInvocationId: input.commandInvocationId }),
    attachmentRefs: [...input.attachmentRefs],
  }
  return promptDigest(JSON.stringify(canonical))
}

function boundedText(value: string, maximumBytes: number): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    Buffer.byteLength(value, 'utf8') > maximumBytes
  ) {
    invalid()
  }
  return value
}

function safeIdentifier(value: string): string {
  if (!safeIdentifierValue(value)) invalid()
  return value
}

function safeIdentifierValue(value: unknown): value is string {
  return typeof value === 'string' && SAFE_IDENTIFIER.test(value)
}

function safeOrigin(value: string): string {
  if (!safeMetadataValue(value)) invalid()
  return value
}

function safeReference(value: string): string {
  if (!safeReferenceValue(value)) invalid()
  return value
}

function safeReferenceValue(value: unknown): value is string {
  return typeof value === 'string' && safeMetadataValue(value)
}

function safeMetadataValue(value: string): boolean {
  return (
    value.length >= 1 &&
    value.length <= 512 &&
    [...value].every((character) => {
      const codePoint = character.codePointAt(0)!
      return codePoint > 31 && codePoint !== 127
    })
  )
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const nested of Object.values(value)) deepFreeze(nested)
  }
  return value
}

function invalid(): never {
  throw new TypeError('PROMPT_ENVELOPE_INVALID')
}
