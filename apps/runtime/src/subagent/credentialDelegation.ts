import { createHash, randomBytes } from 'node:crypto'
import {
  isRuntimeError,
  type ProviderChunk,
  type ProviderNativeCompactionResult,
  type ProviderRequest,
  type ProviderUsage,
  type RuntimeError,
  runtimeError,
} from '@praxis/core-sdk'
import { LONG_LIVED_EXECUTION_POLICY_V1 } from '../longLivedExecutionPolicy.js'
import type { ChildCredentialGrant, ChildProviderTarget } from './childCapabilityBundle.js'

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/
const MAX_HANDLES = 1_024
const MAX_REQUESTS_PER_HANDLE = LONG_LIVED_EXECUTION_POLICY_V1.maxTurns
const MAX_DELEGATION_TTL_MS = LONG_LIVED_EXECUTION_POLICY_V1.maxWallClockMs
const DEFAULT_PROVIDER_ATTEMPTS = 3
const DEFAULT_RETRY_BASE_DELAY_MS = 250
const MAX_RETRY_DELAY_MS = 2_000

export type ChildCredentialDelegationScope = Readonly<{
  parentRunId: string
  childRunId: string
  target: ChildProviderTarget
  deadlineAt: string
  maxTokens?: number
  preference?: 'broker_handle' | 'ephemeral_token'
}>

export type CredentialBrokerInvocation = Readonly<{
  handleId: string
  parentRunId: string
  childRunId: string
  target: ChildProviderTarget
  requestId: string
  request: ProviderRequest
}>

export type CredentialBrokerTraceEvent = Readonly<{
  type:
    | 'credential_broker_issued'
    | 'credential_broker_started'
    | 'credential_broker_completed'
    | 'credential_broker_failed'
    | 'credential_broker_revoked'
  handleDigest: `sha256:${string}`
  parentRunId: string
  childRunId: string
  providerId: string
  model: string
  operation?: 'stream' | 'compact'
  errorCode?: CredentialDelegationFailureCode
  usage?: Readonly<{ inputTokens: number; outputTokens: number; totalTokens: number }>
}>

export interface CredentialBrokerProviderPort {
  stream(target: ChildProviderTarget, request: ProviderRequest): AsyncIterable<ProviderChunk>
  compact?(
    target: ChildProviderTarget,
    request: ProviderRequest,
  ): Promise<ProviderNativeCompactionResult>
}

export interface ChildCredentialBrokerPort {
  issue(
    scope: ChildCredentialDelegationScope,
  ): Extract<ChildCredentialGrant, { kind: 'broker_handle' }>
  invoke(input: CredentialBrokerInvocation): AsyncIterable<ProviderChunk>
  compact(input: CredentialBrokerInvocation): Promise<ProviderNativeCompactionResult>
  revokeHandle(handleId: string): void
  revokeChild(parentRunId: string, childRunId: string): void
  revokeParent(parentRunId: string): void
}

export interface ChildEphemeralTokenIssuer {
  supports(target: ChildProviderTarget): boolean
  issue(
    scope: ChildCredentialDelegationScope,
  ): Promise<Readonly<{ tokenRef: string; expiresAt: string }>>
  revoke?(tokenRef: string): void | Promise<void>
}

export type CredentialDelegationFailureCode =
  | 'CHILD_CREDENTIAL_INVALID'
  | 'CHILD_CREDENTIAL_HANDLE_LIMIT'
  | 'CHILD_CREDENTIAL_HANDLE_UNKNOWN'
  | 'CHILD_CREDENTIAL_SCOPE_MISMATCH'
  | 'CHILD_CREDENTIAL_EXPIRED'
  | 'CHILD_CREDENTIAL_REVOKED'
  | 'CHILD_CREDENTIAL_REPLAYED'
  | 'CHILD_CREDENTIAL_BUSY'
  | 'CHILD_CREDENTIAL_BUDGET_EXCEEDED'
  | 'CHILD_CREDENTIAL_USAGE_UNKNOWN'
  | 'CHILD_CREDENTIAL_CANCELLED'
  | 'CHILD_CREDENTIAL_RATE_LIMITED'
  | 'CHILD_CREDENTIAL_PROVIDER_UNAVAILABLE'
  | 'CHILD_CREDENTIAL_PROVIDER_ACCOUNT_UNAVAILABLE'
  | 'CHILD_CREDENTIAL_PROVIDER_FAILED'
  | 'CHILD_CREDENTIAL_REQUEST_OVERSIZED'
  | 'CHILD_CREDENTIAL_TOKEN_UNSUPPORTED'

const CREDENTIAL_FAILURE_CODES = new Set<CredentialDelegationFailureCode>([
  'CHILD_CREDENTIAL_INVALID',
  'CHILD_CREDENTIAL_HANDLE_LIMIT',
  'CHILD_CREDENTIAL_HANDLE_UNKNOWN',
  'CHILD_CREDENTIAL_SCOPE_MISMATCH',
  'CHILD_CREDENTIAL_EXPIRED',
  'CHILD_CREDENTIAL_REVOKED',
  'CHILD_CREDENTIAL_REPLAYED',
  'CHILD_CREDENTIAL_BUSY',
  'CHILD_CREDENTIAL_BUDGET_EXCEEDED',
  'CHILD_CREDENTIAL_USAGE_UNKNOWN',
  'CHILD_CREDENTIAL_CANCELLED',
  'CHILD_CREDENTIAL_RATE_LIMITED',
  'CHILD_CREDENTIAL_PROVIDER_UNAVAILABLE',
  'CHILD_CREDENTIAL_PROVIDER_ACCOUNT_UNAVAILABLE',
  'CHILD_CREDENTIAL_PROVIDER_FAILED',
  'CHILD_CREDENTIAL_REQUEST_OVERSIZED',
  'CHILD_CREDENTIAL_TOKEN_UNSUPPORTED',
])

type TokenLease = Readonly<{
  tokenRef: string
  parentRunId: string
  childRunId: string
}>

/** Selects one explicit credential strategy without exposing durable credential material. */
export class ChildCredentialDelegationService {
  readonly #broker: ChildCredentialBrokerPort
  readonly #ephemeralTokens?: ChildEphemeralTokenIssuer
  readonly #now: () => number
  readonly #tokenLeases = new Map<string, TokenLease>()

  constructor(options: {
    broker: ChildCredentialBrokerPort
    ephemeralTokens?: ChildEphemeralTokenIssuer
    now?: () => number
  }) {
    this.#broker = options.broker
    this.#ephemeralTokens = options.ephemeralTokens
    this.#now = options.now ?? Date.now
  }

  async delegate(scope: ChildCredentialDelegationScope): Promise<ChildCredentialGrant> {
    const validated = validateScope(scope, this.#now())
    if (validated.target.providerId === 'mock' || validated.target.providerId === 'replay') {
      return Object.freeze({ kind: 'none', mode: validated.target.providerId })
    }
    if ((validated.preference ?? 'broker_handle') === 'broker_handle') {
      return this.#broker.issue(validated)
    }
    const issuer = this.#ephemeralTokens
    if (!issuer?.supports(validated.target)) {
      throw credentialFailure('CHILD_CREDENTIAL_TOKEN_UNSUPPORTED')
    }
    const issued = await issuer.issue(validated)
    if (
      this.#tokenLeases.size >= MAX_HANDLES ||
      !SAFE_ID.test(issued.tokenRef) ||
      !isCanonicalInstant(issued.expiresAt) ||
      Date.parse(issued.expiresAt) <= this.#now() ||
      Date.parse(issued.expiresAt) > Date.parse(validated.deadlineAt) ||
      this.#tokenLeases.has(issued.tokenRef)
    ) {
      throw credentialFailure('CHILD_CREDENTIAL_INVALID')
    }
    this.#tokenLeases.set(
      issued.tokenRef,
      Object.freeze({
        tokenRef: issued.tokenRef,
        parentRunId: validated.parentRunId,
        childRunId: validated.childRunId,
      }),
    )
    return Object.freeze({
      kind: 'ephemeral_token',
      tokenRef: issued.tokenRef,
      expiresAt: issued.expiresAt,
    })
  }

  async revokeChild(parentRunId: string, childRunId: string): Promise<void> {
    this.#broker.revokeChild(parentRunId, childRunId)
    await this.#revokeTokens(
      (lease) => lease.parentRunId === parentRunId && lease.childRunId === childRunId,
    )
  }

  async revokeParent(parentRunId: string): Promise<void> {
    this.#broker.revokeParent(parentRunId)
    await this.#revokeTokens((lease) => lease.parentRunId === parentRunId)
  }

  async #revokeTokens(select: (lease: TokenLease) => boolean): Promise<void> {
    const leases = [...this.#tokenLeases.values()].filter(select)
    for (const lease of leases) this.#tokenLeases.delete(lease.tokenRef)
    if (this.#ephemeralTokens?.revoke) {
      await Promise.allSettled(
        leases.map((lease) => this.#ephemeralTokens!.revoke!(lease.tokenRef)),
      )
    }
  }
}

type HandleRecord = {
  handleId: string
  scope: ChildCredentialDelegationScope
  handleDigest: `sha256:${string}`
  state: 'active' | 'revoked' | 'expired'
  seenRequestIds: Set<string>
  usedTokens: number
  invocationActive: boolean
  controller: AbortController
}

/** Parent-side bounded broker fixture and reference SPI implementation. */
export class InMemoryChildCredentialBroker implements ChildCredentialBrokerPort {
  readonly #provider: CredentialBrokerProviderPort
  readonly #now: () => number
  readonly #randomBytes: (size: number) => Buffer
  readonly #trace?: (event: CredentialBrokerTraceEvent) => void | Promise<void>
  readonly #maxProviderAttempts: number
  readonly #retryBaseDelayMs: number
  readonly #handles = new Map<string, HandleRecord>()

  constructor(options: {
    provider: CredentialBrokerProviderPort
    now?: () => number
    randomBytes?: (size: number) => Buffer
    trace?: (event: CredentialBrokerTraceEvent) => void | Promise<void>
    maxProviderAttempts?: number
    retryBaseDelayMs?: number
  }) {
    this.#provider = options.provider
    this.#now = options.now ?? Date.now
    this.#randomBytes = options.randomBytes ?? randomBytes
    this.#trace = options.trace
    this.#maxProviderAttempts = options.maxProviderAttempts ?? DEFAULT_PROVIDER_ATTEMPTS
    this.#retryBaseDelayMs = options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS
    if (
      !Number.isSafeInteger(this.#maxProviderAttempts) ||
      this.#maxProviderAttempts < 1 ||
      this.#maxProviderAttempts > 5 ||
      !Number.isSafeInteger(this.#retryBaseDelayMs) ||
      this.#retryBaseDelayMs < 0 ||
      this.#retryBaseDelayMs > MAX_RETRY_DELAY_MS
    ) {
      throw credentialFailure('CHILD_CREDENTIAL_INVALID')
    }
  }

  issue(
    scope: ChildCredentialDelegationScope,
  ): Extract<ChildCredentialGrant, { kind: 'broker_handle' }> {
    const validated = validateScope(scope, this.#now())
    this.#markExpired()
    if (this.#handles.size >= MAX_HANDLES) {
      throw credentialFailure('CHILD_CREDENTIAL_HANDLE_LIMIT')
    }
    let handleId: string | undefined
    let attempts = 0
    do {
      handleId = `cbh-${this.#randomBytes(24).toString('hex')}`
      attempts += 1
      if (attempts >= 8 && this.#handles.has(handleId)) {
        throw credentialFailure('CHILD_CREDENTIAL_INVALID')
      }
    } while (this.#handles.has(handleId))
    const record: HandleRecord = {
      handleId,
      scope: validated,
      handleDigest: digestHandle(handleId),
      state: 'active',
      seenRequestIds: new Set(),
      usedTokens: 0,
      invocationActive: false,
      controller: new AbortController(),
    }
    this.#handles.set(handleId, record)
    void this.#emit(record, { type: 'credential_broker_issued' })
    return Object.freeze({ kind: 'broker_handle', handleId, expiresAt: validated.deadlineAt })
  }

  async *invoke(input: CredentialBrokerInvocation): AsyncIterable<ProviderChunk> {
    const record = this.#authorize(input)
    const remaining =
      record.scope.maxTokens === undefined ? undefined : record.scope.maxTokens - record.usedTokens
    if (remaining !== undefined && remaining <= 0) {
      throw credentialFailure('CHILD_CREDENTIAL_BUDGET_EXCEEDED')
    }
    record.seenRequestIds.add(input.requestId)
    record.invocationActive = true
    const linked = linkedInvocationSignal(
      input.request.signal,
      record.controller.signal,
      Date.parse(record.scope.deadlineAt),
      this.#now,
    )
    const request: ProviderRequest = {
      ...input.request,
      model: record.scope.target.model,
      signal: linked.signal,
      ...(remaining === undefined
        ? {}
        : {
            maxOutputTokens: Math.min(remaining, input.request.maxOutputTokens ?? remaining),
          }),
    }
    await this.#emit(record, { type: 'credential_broker_started', operation: 'stream' })
    try {
      for (let attempt = 1; attempt <= this.#maxProviderAttempts; attempt += 1) {
        let usage: ReturnType<typeof normalizedUsage> | undefined
        let emitted = false
        const iterator = this.#provider.stream(record.scope.target, request)[Symbol.asyncIterator]()
        try {
          for (;;) {
            const next = await nextProviderChunk(iterator, linked.signal)
            if (next.done) break
            const chunk = next.value
            if (chunk.type === 'completed') {
              usage = normalizedUsage(chunk.usage)
              if (usage === undefined) {
                this.#revokeRecord(record)
                throw credentialFailure('CHILD_CREDENTIAL_USAGE_UNKNOWN')
              }
              if (
                record.scope.maxTokens !== undefined &&
                record.usedTokens + usage.totalTokens > record.scope.maxTokens
              ) {
                record.usedTokens = record.scope.maxTokens
                this.#revokeRecord(record)
                throw credentialFailure('CHILD_CREDENTIAL_BUDGET_EXCEEDED')
              }
              record.usedTokens += usage.totalTokens
            }
            emitted = true
            yield chunk
          }
          if (usage === undefined) {
            this.#revokeRecord(record)
            throw credentialFailure('CHILD_CREDENTIAL_USAGE_UNKNOWN')
          }
          await this.#emit(record, {
            type: 'credential_broker_completed',
            operation: 'stream',
            usage,
          })
          return
        } catch (error) {
          const failure = this.#normalizeInvocationFailure(record, linked.reason(), error)
          const delayMs = this.#retryDelay(record, failure, attempt, emitted)
          if (delayMs === undefined) {
            await this.#emit(record, {
              type: 'credential_broker_failed',
              operation: 'stream',
              errorCode: failure.code,
            })
            throw failure
          }
          if (iterator.return) await iterator.return().catch(() => undefined)
          try {
            await abortableDelay(delayMs, linked.signal)
          } catch (waitError) {
            const interrupted = this.#normalizeInvocationFailure(record, linked.reason(), waitError)
            await this.#emit(record, {
              type: 'credential_broker_failed',
              operation: 'stream',
              errorCode: interrupted.code,
            })
            throw interrupted
          }
        } finally {
          if (linked.signal.aborted && iterator.return) {
            void iterator.return().catch(() => undefined)
          }
        }
      }
    } finally {
      record.invocationActive = false
      linked.dispose()
    }
  }

  async compact(input: CredentialBrokerInvocation): Promise<ProviderNativeCompactionResult> {
    const record = this.#authorize(input)
    const compact = this.#provider.compact
    if (compact === undefined) throw credentialFailure('CHILD_CREDENTIAL_PROVIDER_FAILED')
    const remaining =
      record.scope.maxTokens === undefined ? undefined : record.scope.maxTokens - record.usedTokens
    if (remaining !== undefined && remaining <= 0) {
      throw credentialFailure('CHILD_CREDENTIAL_BUDGET_EXCEEDED')
    }
    record.seenRequestIds.add(input.requestId)
    record.invocationActive = true
    const linked = linkedInvocationSignal(
      input.request.signal,
      record.controller.signal,
      Date.parse(record.scope.deadlineAt),
      this.#now,
    )
    const request: ProviderRequest = {
      ...input.request,
      model: record.scope.target.model,
      signal: linked.signal,
    }
    await this.#emit(record, { type: 'credential_broker_started', operation: 'compact' })
    try {
      for (let attempt = 1; attempt <= this.#maxProviderAttempts; attempt += 1) {
        try {
          const result = await abortableProviderPromise(
            compact.call(this.#provider, record.scope.target, request),
            linked.signal,
          )
          const usage = normalizedUsage(result.usage)
          if (usage === undefined) {
            this.#revokeRecord(record)
            throw credentialFailure('CHILD_CREDENTIAL_USAGE_UNKNOWN')
          }
          if (
            record.scope.maxTokens !== undefined &&
            record.usedTokens + usage.totalTokens > record.scope.maxTokens
          ) {
            record.usedTokens = record.scope.maxTokens
            this.#revokeRecord(record)
            throw credentialFailure('CHILD_CREDENTIAL_BUDGET_EXCEEDED')
          }
          record.usedTokens += usage.totalTokens
          await this.#emit(record, {
            type: 'credential_broker_completed',
            operation: 'compact',
            usage,
          })
          return Object.freeze({
            format: result.format,
            items: Object.freeze(result.items.map((item) => Object.freeze(structuredClone(item)))),
            usage: Object.freeze({ ...result.usage }),
          })
        } catch (error) {
          const failure = this.#normalizeInvocationFailure(record, linked.reason(), error)
          const delayMs = this.#retryDelay(record, failure, attempt, false)
          if (delayMs === undefined) {
            await this.#emit(record, {
              type: 'credential_broker_failed',
              operation: 'compact',
              errorCode: failure.code,
            })
            throw failure
          }
          try {
            await abortableDelay(delayMs, linked.signal)
          } catch (waitError) {
            const interrupted = this.#normalizeInvocationFailure(record, linked.reason(), waitError)
            await this.#emit(record, {
              type: 'credential_broker_failed',
              operation: 'compact',
              errorCode: interrupted.code,
            })
            throw interrupted
          }
        }
      }
      throw credentialFailure('CHILD_CREDENTIAL_PROVIDER_FAILED')
    } finally {
      record.invocationActive = false
      linked.dispose()
    }
  }

  revokeHandle(handleId: string): void {
    const record = this.#handles.get(handleId)
    if (record) this.#revokeRecord(record)
  }

  revokeChild(parentRunId: string, childRunId: string): void {
    for (const record of this.#handles.values()) {
      if (record.scope.parentRunId === parentRunId && record.scope.childRunId === childRunId) {
        this.#revokeRecord(record)
      }
    }
  }

  revokeParent(parentRunId: string): void {
    for (const record of this.#handles.values()) {
      if (record.scope.parentRunId === parentRunId) this.#revokeRecord(record)
    }
  }

  #authorize(input: CredentialBrokerInvocation): HandleRecord {
    const record = this.#handles.get(input.handleId)
    if (!record) throw credentialFailure('CHILD_CREDENTIAL_HANDLE_UNKNOWN')
    if (record.state === 'revoked') throw credentialFailure('CHILD_CREDENTIAL_REVOKED')
    if (Date.parse(record.scope.deadlineAt) <= this.#now()) {
      throw credentialFailure('CHILD_CREDENTIAL_EXPIRED')
    }
    if (
      record.scope.parentRunId !== input.parentRunId ||
      record.scope.childRunId !== input.childRunId ||
      !sameTarget(record.scope.target, input.target) ||
      input.request.model !== record.scope.target.model
    ) {
      throw credentialFailure('CHILD_CREDENTIAL_SCOPE_MISMATCH')
    }
    if (!SAFE_ID.test(input.requestId)) throw credentialFailure('CHILD_CREDENTIAL_INVALID')
    if (record.seenRequestIds.has(input.requestId)) {
      throw credentialFailure('CHILD_CREDENTIAL_REPLAYED')
    }
    if (record.invocationActive) throw credentialFailure('CHILD_CREDENTIAL_BUSY')
    if (record.seenRequestIds.size >= MAX_REQUESTS_PER_HANDLE) {
      this.#revokeRecord(record)
      throw credentialFailure('CHILD_CREDENTIAL_BUDGET_EXCEEDED')
    }
    return record
  }

  #normalizeInvocationFailure(
    record: HandleRecord,
    abortReason: 'caller' | 'handle' | 'deadline' | undefined,
    error: unknown,
  ): RuntimeError & { code: CredentialDelegationFailureCode } {
    if (isCredentialDelegationFailure(error)) return error
    if (record.state === 'revoked') return credentialFailure('CHILD_CREDENTIAL_REVOKED')
    if (record.state === 'expired') return credentialFailure('CHILD_CREDENTIAL_EXPIRED')
    if (abortReason === 'deadline') return credentialFailure('CHILD_CREDENTIAL_EXPIRED')
    if (Date.parse(record.scope.deadlineAt) <= this.#now()) {
      return credentialFailure('CHILD_CREDENTIAL_EXPIRED')
    }
    if (abortReason === 'caller') return credentialFailure('CHILD_CREDENTIAL_CANCELLED')
    const status = providerStatus(error)
    const retryAfterMs = providerRetryAfterMs(error)
    if (status === 429 || (isRuntimeError(error) && error.code === 'PROVIDER_RATE_LIMITED')) {
      return credentialFailure('CHILD_CREDENTIAL_RATE_LIMITED', { status: 429, retryAfterMs })
    }
    if (
      status === 402 ||
      (isRuntimeError(error) && error.code === 'PROVIDER_ACCOUNT_UNAVAILABLE')
    ) {
      return credentialFailure('CHILD_CREDENTIAL_PROVIDER_ACCOUNT_UNAVAILABLE', {
        ...(status === undefined ? {} : { status }),
      })
    }
    if (
      status === 408 ||
      status === 409 ||
      (status !== undefined && status >= 500) ||
      (isRuntimeError(error) && error.retryable)
    ) {
      return credentialFailure('CHILD_CREDENTIAL_PROVIDER_UNAVAILABLE', {
        ...(status === undefined ? {} : { status }),
        retryAfterMs,
      })
    }
    return credentialFailure('CHILD_CREDENTIAL_PROVIDER_FAILED')
  }

  #retryDelay(
    record: HandleRecord,
    failure: RuntimeError & { code: CredentialDelegationFailureCode },
    attempt: number,
    emitted: boolean,
  ): number | undefined {
    if (!failure.retryable || emitted || attempt >= this.#maxProviderAttempts) return undefined
    const retryAfterMs = providerRetryAfterMs(failure)
    const delayMs = Math.min(
      MAX_RETRY_DELAY_MS,
      retryAfterMs ?? this.#retryBaseDelayMs * 2 ** (attempt - 1),
    )
    return this.#now() + delayMs < Date.parse(record.scope.deadlineAt) ? delayMs : undefined
  }

  #revokeRecord(record: HandleRecord): void {
    if (record.state === 'revoked') return
    record.state = 'revoked'
    record.controller.abort()
    void this.#emit(record, { type: 'credential_broker_revoked' })
  }

  #markExpired(): void {
    const now = this.#now()
    for (const record of this.#handles.values()) {
      if (
        Date.parse(record.scope.deadlineAt) <= now &&
        record.state === 'active' &&
        !record.invocationActive
      ) {
        record.state = 'expired'
        record.controller.abort()
      }
    }
  }

  async #emit(
    record: HandleRecord,
    event: Pick<CredentialBrokerTraceEvent, 'type' | 'operation' | 'errorCode' | 'usage'>,
  ): Promise<void> {
    if (!this.#trace) return
    try {
      await this.#trace(
        Object.freeze({
          type: event.type,
          handleDigest: record.handleDigest,
          parentRunId: record.scope.parentRunId,
          childRunId: record.scope.childRunId,
          providerId: record.scope.target.providerId,
          model: record.scope.target.model,
          ...(event.operation === undefined ? {} : { operation: event.operation }),
          ...(event.errorCode === undefined ? {} : { errorCode: event.errorCode }),
          ...(event.usage === undefined ? {} : { usage: Object.freeze({ ...event.usage }) }),
        }),
      )
    } catch {
      // Credential trace is diagnostic-only and cannot alter delegation state.
    }
  }
}

function validateScope(
  value: ChildCredentialDelegationScope,
  now: number,
): ChildCredentialDelegationScope {
  if (
    !SAFE_ID.test(value.parentRunId) ||
    !SAFE_ID.test(value.childRunId) ||
    !SAFE_ID.test(value.target.providerId) ||
    !SAFE_ID.test(value.target.model) ||
    !isCanonicalInstant(value.deadlineAt) ||
    Date.parse(value.deadlineAt) <= now ||
    Date.parse(value.deadlineAt) - now > MAX_DELEGATION_TTL_MS ||
    (value.maxTokens !== undefined &&
      (!Number.isSafeInteger(value.maxTokens) || value.maxTokens < 1)) ||
    (value.preference !== undefined &&
      value.preference !== 'broker_handle' &&
      value.preference !== 'ephemeral_token')
  ) {
    throw credentialFailure('CHILD_CREDENTIAL_INVALID')
  }
  return Object.freeze({
    parentRunId: value.parentRunId,
    childRunId: value.childRunId,
    target: Object.freeze({ ...value.target }),
    deadlineAt: value.deadlineAt,
    ...(value.maxTokens === undefined ? {} : { maxTokens: value.maxTokens }),
    ...(value.preference === undefined ? {} : { preference: value.preference }),
  })
}

function linkedInvocationSignal(
  caller: AbortSignal,
  handle: AbortSignal,
  deadline: number,
  now: () => number,
): Readonly<{
  signal: AbortSignal
  reason(): 'caller' | 'handle' | 'deadline' | undefined
  dispose(): void
}> {
  const controller = new AbortController()
  let reason: 'caller' | 'handle' | 'deadline' | undefined
  const abort = (source: NonNullable<typeof reason>) => {
    reason ??= source
    controller.abort()
  }
  const abortCaller = () => abort('caller')
  const abortHandle = () => abort('handle')
  caller.addEventListener('abort', abortCaller, { once: true })
  handle.addEventListener('abort', abortHandle, { once: true })
  if (caller.aborted) abortCaller()
  else if (handle.aborted) abortHandle()
  const timeout = setTimeout(() => abort('deadline'), Math.max(1, deadline - now()))
  return Object.freeze({
    signal: controller.signal,
    reason: () => reason,
    dispose() {
      clearTimeout(timeout)
      caller.removeEventListener('abort', abortCaller)
      handle.removeEventListener('abort', abortHandle)
    },
  })
}

function nextProviderChunk(
  iterator: AsyncIterator<ProviderChunk>,
  signal: AbortSignal,
): Promise<IteratorResult<ProviderChunk>> {
  if (signal.aborted) return Promise.reject(new Error('Delegated Provider invocation aborted.'))
  return new Promise((resolve, reject) => {
    let settled = false
    const abort = () => {
      if (settled) return
      settled = true
      reject(new Error('Delegated Provider invocation aborted.'))
    }
    signal.addEventListener('abort', abort, { once: true })
    void iterator.next().then(
      (result) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', abort)
        resolve(result)
      },
      (error: unknown) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', abort)
        reject(error)
      },
    )
  })
}

function abortableProviderPromise<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('Delegated Provider invocation aborted.'))
  return new Promise((resolve, reject) => {
    let settled = false
    const abort = () => {
      if (settled) return
      settled = true
      reject(new Error('Delegated Provider invocation aborted.'))
    }
    signal.addEventListener('abort', abort, { once: true })
    void promise.then(
      (value) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', abort)
        resolve(value)
      },
      (error: unknown) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', abort)
        reject(error)
      },
    )
  })
}

function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error('Credential retry was cancelled.'))
  if (delayMs === 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, delayMs)
    const abort = () => {
      clearTimeout(timer)
      reject(new Error('Credential retry was cancelled.'))
    }
    signal.addEventListener('abort', abort, { once: true })
  })
}

function providerStatus(error: unknown): number | undefined {
  const direct = recordNumber(error, 'status')
  if (direct !== undefined) return direct
  return recordNumber(recordValue(error, 'data'), 'status')
}

function providerRetryAfterMs(error: unknown): number | undefined {
  const dataValue = recordNumber(recordValue(error, 'data'), 'retryAfterMs')
  if (dataValue !== undefined) return dataValue
  const headers = recordValue(error, 'headers')
  if (headers && typeof Reflect.get(headers, 'get') === 'function') {
    const value = Reflect.apply(
      Reflect.get(headers, 'get') as (...args: unknown[]) => unknown,
      headers,
      ['retry-after'],
    )
    return retryAfterMilliseconds(value)
  }
  return retryAfterMilliseconds(recordValue(headers, 'retry-after'))
}

function retryAfterMilliseconds(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000)
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : undefined
}

function recordValue(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined
}

function recordNumber(value: unknown, key: string): number | undefined {
  const candidate = recordValue(value, key)
  return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : undefined
}

function normalizedUsage(
  usage: ProviderUsage | undefined,
): Readonly<{ inputTokens: number; outputTokens: number; totalTokens: number }> | undefined {
  if (
    usage === undefined ||
    (usage.inputTokens === undefined && usage.outputTokens === undefined)
  ) {
    return undefined
  }
  const inputTokens = boundedUsage(usage.inputTokens)
  const outputTokens = boundedUsage(usage.outputTokens)
  if (inputTokens === undefined || outputTokens === undefined) return undefined
  return Object.freeze({
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  })
}

function boundedUsage(value: number | undefined): number | undefined {
  if (value === undefined) return 0
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function digestHandle(handleId: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(handleId).digest('hex')}`
}

function sameTarget(left: ChildProviderTarget, right: ChildProviderTarget): boolean {
  return left.providerId === right.providerId && left.model === right.model
}

function isCanonicalInstant(value: string): boolean {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
}

export function isCredentialDelegationFailure(
  value: unknown,
): value is RuntimeError & { code: CredentialDelegationFailureCode } {
  return (
    isRuntimeError(value) &&
    typeof value.code === 'string' &&
    CREDENTIAL_FAILURE_CODES.has(value.code as CredentialDelegationFailureCode)
  )
}

export function createCredentialDelegationFailure(
  code: CredentialDelegationFailureCode,
): RuntimeError & { code: CredentialDelegationFailureCode } {
  return credentialFailure(code)
}

function credentialFailure(
  code: CredentialDelegationFailureCode,
  data?: Readonly<Record<string, unknown>>,
): RuntimeError & { code: CredentialDelegationFailureCode } {
  const messages: Record<CredentialDelegationFailureCode, string> = {
    CHILD_CREDENTIAL_INVALID: 'Child credential delegation input is invalid.',
    CHILD_CREDENTIAL_HANDLE_LIMIT: 'The child credential broker handle limit was reached.',
    CHILD_CREDENTIAL_HANDLE_UNKNOWN: 'The child credential broker handle is unavailable.',
    CHILD_CREDENTIAL_SCOPE_MISMATCH: 'The child credential broker scope does not match.',
    CHILD_CREDENTIAL_EXPIRED: 'The child credential delegation has expired.',
    CHILD_CREDENTIAL_REVOKED: 'The child credential delegation was revoked.',
    CHILD_CREDENTIAL_REPLAYED: 'The child credential request was already consumed.',
    CHILD_CREDENTIAL_BUSY: 'The child credential handle already has an active request.',
    CHILD_CREDENTIAL_BUDGET_EXCEEDED: 'The child credential token budget was exhausted.',
    CHILD_CREDENTIAL_USAGE_UNKNOWN: 'The child credential invocation returned unknown usage.',
    CHILD_CREDENTIAL_CANCELLED: 'The child credential invocation was cancelled.',
    CHILD_CREDENTIAL_RATE_LIMITED: 'The delegated Provider rate limit was reached.',
    CHILD_CREDENTIAL_PROVIDER_UNAVAILABLE: 'The delegated Provider is temporarily unavailable.',
    CHILD_CREDENTIAL_PROVIDER_ACCOUNT_UNAVAILABLE:
      'The delegated Provider account has insufficient quota or billing availability.',
    CHILD_CREDENTIAL_PROVIDER_FAILED: 'The delegated Provider invocation failed.',
    CHILD_CREDENTIAL_REQUEST_OVERSIZED: 'The child Provider request exceeded its IPC limit.',
    CHILD_CREDENTIAL_TOKEN_UNSUPPORTED: 'The Provider does not support ephemeral child tokens.',
  }
  const retryable =
    code === 'CHILD_CREDENTIAL_RATE_LIMITED' || code === 'CHILD_CREDENTIAL_PROVIDER_UNAVAILABLE'
  return runtimeError(code, 'subagent', messages[code], data, retryable) as RuntimeError & {
    code: CredentialDelegationFailureCode
  }
}
