import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { closeSync, readSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { type ExecutionBudget, runtimeError } from '@praxis/core-sdk'
import {
  type ChildCapabilityBundleV1,
  type ChildWorkspaceAccess,
  validateChildCapabilityBundle,
} from './childCapabilityBundle.js'
import { CHILD_RESULT_SUBMISSION_TOOL_NAME } from './childResultSubmissionTool.js'

export const CHILD_BOOTSTRAP_CHANNEL_FD = 3
export const CHILD_BOOTSTRAP_MODE_ENV = 'PRAXIS_CHILD_BOOTSTRAP'
export const CHILD_BOOTSTRAP_KEY_ENV = 'PRAXIS_CHILD_BOOTSTRAP_KEY'

const CHILD_BOOTSTRAP_MODE = 'v3'
const MAX_BOOTSTRAP_BYTES = 64 * 1024
const MAX_LAUNCH_TTL_MS = 60_000
const CLOCK_SKEW_MS = 5_000
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const DIGEST_PATTERN = /^[a-f0-9]{64}$/
const SIGNATURE_PATTERN = /^[a-f0-9]{64}$/
const NONCE_PATTERN = /^[A-Za-z0-9_-]{43}$/
const ARTIFACT_ID_PATTERN = /^artifact-[a-f0-9]{64}$/

export const CHILD_BOOTSTRAP_METHODS = [
  'initialize',
  'events.subscribe',
  'session.create',
  'session.prompt',
  'permission.decide',
  'session.abort',
  'shutdown',
] as const

export type ChildBootstrapMethod = (typeof CHILD_BOOTSTRAP_METHODS)[number]

export type ChildBootstrapProfileV3 = Readonly<{
  schemaVersion: 3
  parentRunId: string
  childRunId: string
  workspace: Readonly<{ root: string; access: ChildWorkspaceAccess }>
  methodAllowlist: readonly ChildBootstrapMethod[]
  ephemeral: Readonly<{
    root: string
    sessionRoot: string
    traceRoot: string
    artifactRoot: string
    retention: 'delete' | 'retain_on_failure'
  }>
  provider: Readonly<{ providerId: string; model: string }>
  /** Authenticated immutable task contract replayed on every Child model turn. */
  pinnedContext?: string
  /** Authenticated Runtime-owned structured-result commit capability. */
  resultSubmission?: Readonly<{
    toolName: typeof CHILD_RESULT_SUBMISSION_TOOL_NAME
    schema: Readonly<Record<string, unknown>>
    criterionIds: readonly string[]
  }>
  artifactAccess?: Readonly<{ root: string; artifactIds: readonly string[] }>
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high'
  capabilityBundleDigest: string
  capabilityBundle: ChildCapabilityBundleV1
  budget: Readonly<ExecutionBudget>
  admission: Readonly<{ depth: number; remainingDepth: number }>
  deadlineAt: string
  trace: Readonly<{ traceId: string; parentTraceId?: string }>
  launch: Readonly<{ nonce: string; issuedAt: string; expiresAt: string }>
}>

export type ChildBootstrapProfileInputV3 = Omit<ChildBootstrapProfileV3, 'launch'>

export type ChildBootstrapLaunch = Readonly<{
  profile: ChildBootstrapProfileV3
  environment: Readonly<Record<string, string>>
  payloadForPid(pid: number): string
}>

export type ChildBootstrapFailureCode =
  | 'CHILD_BOOTSTRAP_REQUIRED'
  | 'CHILD_BOOTSTRAP_INVALID'
  | 'CHILD_BOOTSTRAP_UNAUTHORIZED'
  | 'CHILD_BOOTSTRAP_EXPIRED'
  | 'CHILD_BOOTSTRAP_REPLAYED'
  | 'CHILD_BOOTSTRAP_OVERSIZED'

const CHILD_BOOTSTRAP_FAILURE_CODES = new Set<string>([
  'CHILD_BOOTSTRAP_REQUIRED',
  'CHILD_BOOTSTRAP_INVALID',
  'CHILD_BOOTSTRAP_UNAUTHORIZED',
  'CHILD_BOOTSTRAP_EXPIRED',
  'CHILD_BOOTSTRAP_REPLAYED',
  'CHILD_BOOTSTRAP_OVERSIZED',
] satisfies ChildBootstrapFailureCode[])

export class ChildBootstrapReplayGuard {
  readonly #consumed = new Set<string>()

  consume(nonce: string): void {
    const digest = createHash('sha256').update(nonce).digest('hex')
    if (this.#consumed.has(digest)) {
      throw bootstrapFailure('CHILD_BOOTSTRAP_REPLAYED')
    }
    this.#consumed.add(digest)
  }
}

const processReplayGuard = new ChildBootstrapReplayGuard()

export function createChildBootstrapLaunch(
  input: ChildBootstrapProfileInputV3,
  options: {
    now?: () => number
    randomBytes?: (size: number) => Buffer
    launchTtlMs?: number
  } = {},
): ChildBootstrapLaunch {
  const now = options.now?.() ?? Date.now()
  const launchTtlMs = boundedLaunchTtl(options.launchTtlMs)
  const random = options.randomBytes ?? randomBytes
  const profile = validateChildBootstrapProfile({
    ...input,
    launch: {
      nonce: random(32).toString('base64url'),
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + launchTtlMs).toISOString(),
    },
  })
  const key = random(32).toString('base64url')

  return Object.freeze({
    profile,
    environment: Object.freeze({
      [CHILD_BOOTSTRAP_MODE_ENV]: CHILD_BOOTSTRAP_MODE,
      [CHILD_BOOTSTRAP_KEY_ENV]: key,
    }),
    payloadForPid(pid: number): string {
      if (!Number.isSafeInteger(pid) || pid <= 0) throw bootstrapFailure('CHILD_BOOTSTRAP_INVALID')
      const unsigned = { envelopeVersion: 1 as const, childPid: pid, profile }
      const signature = signEnvelope(unsigned, key)
      const payload = JSON.stringify({ ...unsigned, signature })
      if (Buffer.byteLength(payload, 'utf8') > MAX_BOOTSTRAP_BYTES) {
        throw bootstrapFailure('CHILD_BOOTSTRAP_OVERSIZED')
      }
      return payload
    },
  })
}

export function authenticateChildBootstrapPayload(
  payload: string | Buffer,
  input: {
    key: string | undefined
    processId: number
    now?: () => number
    replayGuard?: ChildBootstrapReplayGuard
  },
): ChildBootstrapProfileV3 {
  const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8')
  if (bytes.length > MAX_BOOTSTRAP_BYTES) throw bootstrapFailure('CHILD_BOOTSTRAP_OVERSIZED')
  const key = parseKey(input.key)
  let value: unknown
  try {
    value = JSON.parse(bytes.toString('utf8'))
  } catch {
    throw bootstrapFailure('CHILD_BOOTSTRAP_INVALID')
  }
  if (!isExactRecord(value, ['envelopeVersion', 'childPid', 'profile', 'signature'])) {
    throw bootstrapFailure('CHILD_BOOTSTRAP_INVALID')
  }
  if (
    value.envelopeVersion !== 1 ||
    !Number.isSafeInteger(value.childPid) ||
    typeof value.signature !== 'string' ||
    !SIGNATURE_PATTERN.test(value.signature)
  ) {
    throw bootstrapFailure('CHILD_BOOTSTRAP_INVALID')
  }
  if (value.childPid !== input.processId) {
    throw bootstrapFailure('CHILD_BOOTSTRAP_UNAUTHORIZED')
  }
  const unsigned = {
    envelopeVersion: 1 as const,
    childPid: value.childPid as number,
    profile: value.profile,
  }
  const expected = Buffer.from(signEnvelope(unsigned, key), 'hex')
  const actual = Buffer.from(value.signature, 'hex')
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw bootstrapFailure('CHILD_BOOTSTRAP_UNAUTHORIZED')
  }

  const profile = validateChildBootstrapProfile(value.profile)
  const now = input.now?.() ?? Date.now()
  const issuedAt = Date.parse(profile.launch.issuedAt)
  const expiresAt = Date.parse(profile.launch.expiresAt)
  const deadlineAt = Date.parse(profile.deadlineAt)
  const credentialExpiresAt = delegatedCredentialExpiry(profile.capabilityBundle)
  if (
    issuedAt > now + CLOCK_SKEW_MS ||
    expiresAt < now ||
    expiresAt - issuedAt > MAX_LAUNCH_TTL_MS ||
    deadlineAt <= now ||
    (credentialExpiresAt !== undefined && Date.parse(credentialExpiresAt) <= now)
  ) {
    throw bootstrapFailure('CHILD_BOOTSTRAP_EXPIRED')
  }
  const replayGuard = input.replayGuard ?? processReplayGuard
  replayGuard.consume(profile.launch.nonce)
  return profile
}

function delegatedCredentialExpiry(bundle: ChildCapabilityBundleV1): string | undefined {
  const credential = bundle.provider.credential
  return credential.kind === 'none' ? undefined : credential.expiresAt
}

export function readChildBootstrapProfileFromProcess(
  options: {
    environment?: NodeJS.ProcessEnv
    processId?: number
    now?: () => number
    replayGuard?: ChildBootstrapReplayGuard
    readPayload?: () => Buffer
  } = {},
): ChildBootstrapProfileV3 | undefined {
  const environment = options.environment ?? process.env
  if (environment[CHILD_BOOTSTRAP_MODE_ENV] === undefined) return undefined
  const mode = environment[CHILD_BOOTSTRAP_MODE_ENV]
  const key = environment[CHILD_BOOTSTRAP_KEY_ENV]
  delete environment[CHILD_BOOTSTRAP_MODE_ENV]
  delete environment[CHILD_BOOTSTRAP_KEY_ENV]
  if (mode !== CHILD_BOOTSTRAP_MODE) throw bootstrapFailure('CHILD_BOOTSTRAP_UNAUTHORIZED')

  let payload: Buffer
  try {
    payload = options.readPayload?.() ?? readBoundedChannel(CHILD_BOOTSTRAP_CHANNEL_FD)
  } catch (error) {
    if (isChildBootstrapFailure(error)) throw error
    throw bootstrapFailure('CHILD_BOOTSTRAP_REQUIRED')
  }
  return authenticateChildBootstrapPayload(payload, {
    key,
    processId: options.processId ?? process.pid,
    now: options.now,
    replayGuard: options.replayGuard,
  })
}

export function isChildBootstrapFailure(
  error: unknown,
): error is Error & { code: ChildBootstrapFailureCode } {
  return (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    CHILD_BOOTSTRAP_FAILURE_CODES.has(error.code)
  )
}

export function validateChildBootstrapProfile(value: unknown): ChildBootstrapProfileV3 {
  const requiredKeys = [
    'schemaVersion',
    'parentRunId',
    'childRunId',
    'workspace',
    'methodAllowlist',
    'ephemeral',
    'provider',
    'capabilityBundleDigest',
    'capabilityBundle',
    'budget',
    'admission',
    'deadlineAt',
    'trace',
    'launch',
  ] as const
  if (
    !isRecord(value) ||
    !requiredKeys.every((key) => Object.hasOwn(value, key)) ||
    !hasOnlyKeys(value, [
      ...requiredKeys,
      'artifactAccess',
      'reasoningEffort',
      'pinnedContext',
      'resultSubmission',
    ]) ||
    value.schemaVersion !== 3 ||
    !isId(value.parentRunId) ||
    !isId(value.childRunId) ||
    typeof value.capabilityBundleDigest !== 'string' ||
    !DIGEST_PATTERN.test(value.capabilityBundleDigest) ||
    !isCanonicalInstant(value.deadlineAt) ||
    (value.reasoningEffort !== undefined &&
      !['none', 'low', 'medium', 'high'].includes(String(value.reasoningEffort))) ||
    (value.pinnedContext !== undefined &&
      (typeof value.pinnedContext !== 'string' ||
        Buffer.byteLength(value.pinnedContext, 'utf8') > 48 * 1024))
  ) {
    throw bootstrapFailure('CHILD_BOOTSTRAP_INVALID')
  }
  const workspace = validateWorkspace(value.workspace)
  const methodAllowlist = validateMethodAllowlist(value.methodAllowlist)
  const ephemeral = validateEphemeralRoots(value.ephemeral)
  const provider = validateProvider(value.provider)
  const artifactAccess =
    value.artifactAccess === undefined ? undefined : validateArtifactAccess(value.artifactAccess)
  const resultSubmission =
    value.resultSubmission === undefined
      ? undefined
      : validateResultSubmission(value.resultSubmission)
  let capabilityBundle: ChildCapabilityBundleV1
  try {
    capabilityBundle = validateChildCapabilityBundle(value.capabilityBundle, {
      digest: value.capabilityBundleDigest,
      workspace,
      provider,
      methodAllowlist,
    })
  } catch {
    throw bootstrapFailure('CHILD_BOOTSTRAP_INVALID')
  }
  const credentialExpiresAt = delegatedCredentialExpiry(capabilityBundle)
  if (
    credentialExpiresAt !== undefined &&
    Date.parse(credentialExpiresAt) > Date.parse(value.deadlineAt)
  ) {
    throw bootstrapFailure('CHILD_BOOTSTRAP_INVALID')
  }
  const budget = validateBudget(value.budget)
  const admission = validateAdmission(value.admission, budget)
  if (budget.deadlineAt !== undefined && budget.deadlineAt !== value.deadlineAt) {
    throw bootstrapFailure('CHILD_BOOTSTRAP_INVALID')
  }
  const trace = validateTrace(value.trace)
  const launch = validateLaunch(value.launch)

  return deepFreeze({
    schemaVersion: 3,
    parentRunId: value.parentRunId,
    childRunId: value.childRunId,
    workspace,
    methodAllowlist,
    ephemeral,
    provider,
    ...(value.pinnedContext === undefined ? {} : { pinnedContext: value.pinnedContext as string }),
    ...(resultSubmission === undefined ? {} : { resultSubmission }),
    ...(artifactAccess === undefined ? {} : { artifactAccess }),
    ...(value.reasoningEffort === undefined
      ? {}
      : {
          reasoningEffort: value.reasoningEffort as 'none' | 'low' | 'medium' | 'high',
        }),
    capabilityBundleDigest: value.capabilityBundleDigest as string,
    capabilityBundle,
    budget,
    admission,
    deadlineAt: value.deadlineAt as string,
    trace,
    launch,
  })
}

function validateResultSubmission(
  value: unknown,
): NonNullable<ChildBootstrapProfileV3['resultSubmission']> {
  if (
    !isExactRecord(value, ['toolName', 'schema', 'criterionIds']) ||
    value.toolName !== CHILD_RESULT_SUBMISSION_TOOL_NAME ||
    !isRecord(value.schema) ||
    !Array.isArray(value.criterionIds) ||
    value.criterionIds.length === 0 ||
    value.criterionIds.length > 64 ||
    value.criterionIds.some((id) => !isId(id)) ||
    new Set(value.criterionIds).size !== value.criterionIds.length
  ) {
    throw bootstrapFailure('CHILD_BOOTSTRAP_INVALID')
  }
  let schema: Record<string, unknown>
  try {
    const serialized = JSON.stringify(value.schema)
    if (Buffer.byteLength(serialized, 'utf8') > 16 * 1024) {
      throw bootstrapFailure('CHILD_BOOTSTRAP_INVALID')
    }
    schema = JSON.parse(serialized) as Record<string, unknown>
  } catch {
    throw bootstrapFailure('CHILD_BOOTSTRAP_INVALID')
  }
  return {
    toolName: CHILD_RESULT_SUBMISSION_TOOL_NAME,
    schema,
    criterionIds: [...(value.criterionIds as string[])],
  }
}

function readBoundedChannel(fd: number): Buffer {
  const chunks: Buffer[] = []
  let total = 0
  try {
    for (;;) {
      const chunk = Buffer.allocUnsafe(4 * 1024)
      const bytesRead = readSync(fd, chunk, 0, chunk.length, null)
      if (bytesRead === 0) break
      total += bytesRead
      if (total > MAX_BOOTSTRAP_BYTES) throw bootstrapFailure('CHILD_BOOTSTRAP_OVERSIZED')
      chunks.push(chunk.subarray(0, bytesRead))
    }
  } finally {
    closeSync(fd)
  }
  if (total === 0) throw bootstrapFailure('CHILD_BOOTSTRAP_REQUIRED')
  return Buffer.concat(chunks, total)
}

function signEnvelope(value: unknown, key: string): string {
  return createHmac('sha256', Buffer.from(key, 'base64url'))
    .update(JSON.stringify(value))
    .digest('hex')
}

function parseKey(value: string | undefined): string {
  if (typeof value !== 'string') throw bootstrapFailure('CHILD_BOOTSTRAP_UNAUTHORIZED')
  const key = Buffer.from(value, 'base64url')
  if (key.length !== 32 || key.toString('base64url') !== value) {
    throw bootstrapFailure('CHILD_BOOTSTRAP_UNAUTHORIZED')
  }
  return value
}

function validateWorkspace(value: unknown): ChildBootstrapProfileV3['workspace'] {
  if (
    !isExactRecord(value, ['root', 'access']) ||
    (value.access !== 'read_only' &&
      value.access !== 'isolated_process' &&
      value.access !== 'workspace_write') ||
    !isCanonicalAbsolutePath(value.root)
  ) {
    throw bootstrapFailure('CHILD_BOOTSTRAP_INVALID')
  }
  return { root: value.root, access: value.access }
}

function validateMethodAllowlist(value: unknown): readonly ChildBootstrapMethod[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > CHILD_BOOTSTRAP_METHODS.length
  ) {
    throw bootstrapFailure('CHILD_BOOTSTRAP_INVALID')
  }
  const allowed = new Set<string>(CHILD_BOOTSTRAP_METHODS)
  const methods = value.filter((method): method is ChildBootstrapMethod => {
    return typeof method === 'string' && allowed.has(method)
  })
  if (methods.length !== value.length || new Set(methods).size !== methods.length) {
    throw bootstrapFailure('CHILD_BOOTSTRAP_INVALID')
  }
  return [...methods]
}

function validateEphemeralRoots(value: unknown): ChildBootstrapProfileV3['ephemeral'] {
  if (
    !isExactRecord(value, ['root', 'sessionRoot', 'traceRoot', 'artifactRoot', 'retention']) ||
    !isCanonicalAbsolutePath(value.root) ||
    !isCanonicalAbsolutePath(value.sessionRoot) ||
    !isCanonicalAbsolutePath(value.traceRoot) ||
    !isCanonicalAbsolutePath(value.artifactRoot) ||
    (value.retention !== 'delete' && value.retention !== 'retain_on_failure')
  ) {
    throw bootstrapFailure('CHILD_BOOTSTRAP_INVALID')
  }
  const root = value.root as string
  const children = [value.sessionRoot, value.traceRoot, value.artifactRoot] as string[]
  if (
    new Set(children).size !== children.length ||
    children.some((path) => !isInside(root, path))
  ) {
    throw bootstrapFailure('CHILD_BOOTSTRAP_INVALID')
  }
  return {
    root,
    sessionRoot: value.sessionRoot,
    traceRoot: value.traceRoot,
    artifactRoot: value.artifactRoot,
    retention: value.retention as 'delete' | 'retain_on_failure',
  }
}

function validateProvider(value: unknown): ChildBootstrapProfileV3['provider'] {
  if (
    !isExactRecord(value, ['providerId', 'model']) ||
    !isBoundedString(value.providerId, 128) ||
    !isBoundedString(value.model, 256)
  ) {
    throw bootstrapFailure('CHILD_BOOTSTRAP_INVALID')
  }
  return { providerId: value.providerId, model: value.model }
}

function validateArtifactAccess(
  value: unknown,
): NonNullable<ChildBootstrapProfileV3['artifactAccess']> {
  if (
    !isExactRecord(value, ['root', 'artifactIds']) ||
    !isCanonicalAbsolutePath(value.root) ||
    !Array.isArray(value.artifactIds) ||
    value.artifactIds.length === 0 ||
    value.artifactIds.some(
      (artifactId) => typeof artifactId !== 'string' || !ARTIFACT_ID_PATTERN.test(artifactId),
    ) ||
    new Set(value.artifactIds).size !== value.artifactIds.length
  ) {
    throw bootstrapFailure('CHILD_BOOTSTRAP_INVALID')
  }
  return {
    root: value.root as string,
    artifactIds: [...(value.artifactIds as string[])],
  }
}

function validateBudget(value: unknown): Readonly<ExecutionBudget> {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'maxTurns',
      'maxToolCalls',
      'maxTokens',
      'maxChildRuns',
      'maxParallelChildren',
      'maxDepth',
      'deadlineAt',
    ]) ||
    !isInteger(value.maxTurns, 1) ||
    !isInteger(value.maxToolCalls, 0) ||
    !isInteger(value.maxChildRuns, 0) ||
    !isInteger(value.maxParallelChildren, 0) ||
    value.maxParallelChildren > value.maxChildRuns ||
    !isInteger(value.maxDepth, 0) ||
    (value.maxTokens !== undefined && !isInteger(value.maxTokens, 1)) ||
    (value.deadlineAt !== undefined && !isCanonicalInstant(value.deadlineAt))
  ) {
    throw bootstrapFailure('CHILD_BOOTSTRAP_INVALID')
  }
  return {
    maxTurns: value.maxTurns,
    maxToolCalls: value.maxToolCalls,
    ...(value.maxTokens === undefined ? {} : { maxTokens: value.maxTokens }),
    maxChildRuns: value.maxChildRuns,
    maxParallelChildren: value.maxParallelChildren,
    maxDepth: value.maxDepth,
    ...(value.deadlineAt === undefined ? {} : { deadlineAt: value.deadlineAt }),
  } as ExecutionBudget
}

function validateAdmission(
  value: unknown,
  budget: Readonly<ExecutionBudget>,
): ChildBootstrapProfileV3['admission'] {
  if (
    !isExactRecord(value, ['depth', 'remainingDepth']) ||
    !isInteger(value.depth, 1) ||
    !isInteger(value.remainingDepth, 0) ||
    value.remainingDepth !== budget.maxDepth
  ) {
    throw bootstrapFailure('CHILD_BOOTSTRAP_INVALID')
  }
  return { depth: value.depth, remainingDepth: value.remainingDepth }
}

function validateTrace(value: unknown): ChildBootstrapProfileV3['trace'] {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['traceId', 'parentTraceId']) ||
    !isId(value.traceId) ||
    (value.parentTraceId !== undefined && !isId(value.parentTraceId))
  ) {
    throw bootstrapFailure('CHILD_BOOTSTRAP_INVALID')
  }
  return {
    traceId: value.traceId,
    ...(value.parentTraceId === undefined ? {} : { parentTraceId: value.parentTraceId }),
  }
}

function validateLaunch(value: unknown): ChildBootstrapProfileV3['launch'] {
  if (
    !isExactRecord(value, ['nonce', 'issuedAt', 'expiresAt']) ||
    typeof value.nonce !== 'string' ||
    !NONCE_PATTERN.test(value.nonce) ||
    !isCanonicalInstant(value.issuedAt) ||
    !isCanonicalInstant(value.expiresAt) ||
    Date.parse(value.expiresAt) <= Date.parse(value.issuedAt)
  ) {
    throw bootstrapFailure('CHILD_BOOTSTRAP_INVALID')
  }
  return { nonce: value.nonce, issuedAt: value.issuedAt, expiresAt: value.expiresAt }
}

function bootstrapFailure(
  code: ChildBootstrapFailureCode,
): Error & { code: ChildBootstrapFailureCode } {
  const messages: Record<ChildBootstrapFailureCode, string> = {
    CHILD_BOOTSTRAP_REQUIRED: 'Child Runtime bootstrap authority is required.',
    CHILD_BOOTSTRAP_INVALID: 'Child Runtime bootstrap profile is invalid.',
    CHILD_BOOTSTRAP_UNAUTHORIZED: 'Child Runtime bootstrap authority could not be verified.',
    CHILD_BOOTSTRAP_EXPIRED: 'Child Runtime bootstrap authority has expired.',
    CHILD_BOOTSTRAP_REPLAYED: 'Child Runtime bootstrap authority was already consumed.',
    CHILD_BOOTSTRAP_OVERSIZED: 'Child Runtime bootstrap payload exceeds its limit.',
  }
  const message = messages[code]
  return Object.assign(new Error(message), runtimeError(code, 'subagent', message)) as Error & {
    code: ChildBootstrapFailureCode
  }
}

function boundedLaunchTtl(value: number | undefined): number {
  if (value === undefined) return 10_000
  if (!Number.isInteger(value) || value < 1 || value > MAX_LAUNCH_TTL_MS) {
    throw bootstrapFailure('CHILD_BOOTSTRAP_INVALID')
  }
  return value
}

function isCanonicalAbsolutePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 1_024 &&
    !value.includes('\0') &&
    isAbsolute(value) &&
    resolve(value) === value
  )
}

function isInside(root: string, candidate: string): boolean {
  const child = relative(root, candidate)
  return child.length > 0 && !child.startsWith('..') && !isAbsolute(child)
}

function isCanonicalInstant(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value)
}

function isBoundedString(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' &&
    value.trim() === value &&
    value.length > 0 &&
    value.length <= maximum
  )
}

function isInteger(value: unknown, minimum: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys)
  return Object.keys(value).every((key) => expected.has(key))
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).length === keys.length && hasOnlyKeys(value, keys)
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const child of Object.values(value)) deepFreeze(child)
  return value
}
