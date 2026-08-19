import type { Serializable } from 'node:child_process'
import type {
  ChatProvider,
  ProviderAuthState,
  ProviderCapabilities,
  ProviderChunk,
  ProviderMessage,
  ProviderNativeCompactionResult,
  ProviderRequest,
  ProviderToolDefinition,
  ProviderUsage,
} from '@praxis/core-sdk'
import { isProviderNativeContext } from '@praxis/core-sdk'
import type { ProcessIpcController } from '../process/ndjsonProcessConnection.js'
import type { ChildProviderTarget } from './childCapabilityBundle.js'
import {
  createCredentialDelegationFailure,
  isCredentialDelegationFailure,
  type ChildCredentialBrokerPort,
  type CredentialDelegationFailureCode,
} from './credentialDelegation.js'

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/
const MAX_MESSAGES = 512
const MAX_TOOLS = 128

type BrokerInvokeMessage = Readonly<{
  schemaVersion: 1
  type: 'credential_broker.invoke'
  requestId: string
  request: SerializedProviderRequest
}>

type BrokerCompactMessage = Readonly<{
  schemaVersion: 1
  type: 'credential_broker.compact'
  requestId: string
  request: SerializedProviderRequest
}>

type BrokerCancelMessage = Readonly<{
  schemaVersion: 1
  type: 'credential_broker.cancel'
  requestId: string
}>

type BrokerChildMessage = BrokerInvokeMessage | BrokerCompactMessage | BrokerCancelMessage

type BrokerParentMessage =
  | Readonly<{
      schemaVersion: 1
      type: 'credential_broker.chunk'
      requestId: string
      sequence: number
      chunk: ProviderChunk
    }>
  | Readonly<{
      schemaVersion: 1
      type: 'credential_broker.done'
      requestId: string
      sequence: number
    }>
  | Readonly<{
      schemaVersion: 1
      type: 'credential_broker.failed'
      requestId: string
      sequence: number
      errorCode: CredentialDelegationFailureCode
    }>
  | Readonly<{
      schemaVersion: 1
      type: 'credential_broker.compacted'
      requestId: string
      sequence: number
      result: ProviderNativeCompactionResult
    }>

type SerializedProviderRequest = Omit<ProviderRequest, 'signal' | 'promptManifest'>

type ParentBrokerRecord = {
  controller: AbortController
  sequence: number
}

type ChildBrokerRecord = {
  queue: AsyncQueue<ProviderChunk>
  nextSequence: number
}

type ChildCompactRecord = {
  resolve(result: ProviderNativeCompactionResult): void
  reject(error: Error): void
}

type ChildIpcProcess = Pick<NodeJS.Process, 'connected' | 'send' | 'on' | 'off'>

/** Parent endpoint for the private child credential channel. It never carries credential material. */
export class ChildCredentialBrokerIpcServer implements ProcessIpcController {
  readonly #active = new Map<string, ParentBrokerRecord>()
  #send?: (message: Serializable) => Promise<void>
  #closed = false

  constructor(
    private readonly options: Readonly<{
      broker?: Pick<ChildCredentialBrokerPort, 'invoke'> &
        Partial<Pick<ChildCredentialBrokerPort, 'compact'>>
      parentRunId: string
      childRunId: string
      target: ChildProviderTarget
      handleId: string
    }>,
  ) {}

  attach(send: (message: Serializable) => Promise<void>): void {
    if (this.#send !== undefined || this.#closed) throw channelFailure('CHILD_CREDENTIAL_INVALID')
    this.#send = send
  }

  receive(message: unknown): void {
    if (this.#closed) return
    if (!messageType(message)?.startsWith('credential_broker.')) return
    let parsed: BrokerChildMessage
    try {
      parsed = validateChildMessage(message)
    } catch {
      this.close()
      return
    }
    if (parsed.type === 'credential_broker.cancel') {
      this.#active.get(parsed.requestId)?.controller.abort()
      return
    }
    if (parsed.type === 'credential_broker.compact') void this.#compact(parsed)
    else void this.#invoke(parsed)
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    for (const record of this.#active.values()) record.controller.abort()
    this.#active.clear()
  }

  async #invoke(message: BrokerInvokeMessage): Promise<void> {
    if (this.#active.has(message.requestId)) {
      await this.#failed(message.requestId, 0, 'CHILD_CREDENTIAL_BUSY')
      return
    }
    const record: ParentBrokerRecord = { controller: new AbortController(), sequence: 0 }
    this.#active.set(message.requestId, record)
    try {
      const broker = this.options.broker
      if (!broker) throw channelFailure('CHILD_CREDENTIAL_HANDLE_UNKNOWN')
      const request: ProviderRequest = {
        ...message.request,
        model: this.options.target.model,
        signal: record.controller.signal,
      }
      for await (const candidate of broker.invoke({
        handleId: this.options.handleId,
        parentRunId: this.options.parentRunId,
        childRunId: this.options.childRunId,
        target: this.options.target,
        requestId: message.requestId,
        request,
      })) {
        const chunk = validateProviderChunk(candidate)
        await this.#write({
          schemaVersion: 1,
          type: 'credential_broker.chunk',
          requestId: message.requestId,
          sequence: record.sequence++,
          chunk,
        })
      }
      await this.#write({
        schemaVersion: 1,
        type: 'credential_broker.done',
        requestId: message.requestId,
        sequence: record.sequence,
      })
    } catch (error) {
      const code = isCredentialDelegationFailure(error)
        ? error.code
        : 'CHILD_CREDENTIAL_PROVIDER_FAILED'
      await this.#failed(message.requestId, record.sequence, code)
    } finally {
      this.#active.delete(message.requestId)
    }
  }

  async #compact(message: BrokerCompactMessage): Promise<void> {
    if (this.#active.has(message.requestId)) {
      await this.#failed(message.requestId, 0, 'CHILD_CREDENTIAL_BUSY')
      return
    }
    const record: ParentBrokerRecord = { controller: new AbortController(), sequence: 0 }
    this.#active.set(message.requestId, record)
    try {
      const broker = this.options.broker
      if (!broker?.compact) throw channelFailure('CHILD_CREDENTIAL_PROVIDER_FAILED')
      const result = await broker.compact({
        handleId: this.options.handleId,
        parentRunId: this.options.parentRunId,
        childRunId: this.options.childRunId,
        target: this.options.target,
        requestId: message.requestId,
        request: {
          ...message.request,
          model: this.options.target.model,
          signal: record.controller.signal,
        },
      })
      await this.#write({
        schemaVersion: 1,
        type: 'credential_broker.compacted',
        requestId: message.requestId,
        sequence: 0,
        result: validateProviderNativeCompactionResult(result),
      })
    } catch (error) {
      const code = isCredentialDelegationFailure(error)
        ? error.code
        : 'CHILD_CREDENTIAL_PROVIDER_FAILED'
      await this.#failed(message.requestId, 0, code)
    } finally {
      this.#active.delete(message.requestId)
    }
  }

  async #failed(
    requestId: string,
    sequence: number,
    errorCode: CredentialDelegationFailureCode,
  ): Promise<void> {
    try {
      await this.#write({
        schemaVersion: 1,
        type: 'credential_broker.failed',
        requestId,
        sequence,
        errorCode,
      })
    } catch {
      this.close()
    }
  }

  async #write(message: BrokerParentMessage): Promise<void> {
    if (this.#closed || !this.#send) throw channelFailure('CHILD_CREDENTIAL_CANCELLED')
    await this.#send(message)
  }
}

/** Child-side Provider facade backed by the parent broker IPC channel. */
export class ChildBrokeredProvider implements ChatProvider {
  readonly contractVersion = 2 as const
  readonly id: string
  readonly defaultModel: string
  readonly capabilities: ProviderCapabilities
  readonly compact?: (request: ProviderRequest) => Promise<ProviderNativeCompactionResult>
  readonly #client: ChildCredentialBrokerIpcClient
  readonly #expiresAt: string

  constructor(options: {
    target: ChildProviderTarget
    expiresAt: string
    capabilities: ProviderCapabilities
    process?: ChildIpcProcess
  }) {
    this.id = options.target.providerId
    this.defaultModel = options.target.model
    this.capabilities = options.capabilities
    this.#expiresAt = options.expiresAt
    this.#client = new ChildCredentialBrokerIpcClient(options.target, options.process ?? process)
    if (options.target.providerId === 'openai') {
      this.compact = (request) => this.#client.compact(request)
    }
  }

  authState(): ProviderAuthState {
    if (Date.parse(this.#expiresAt) <= Date.now()) return { status: 'expired' }
    return this.#client.available() ? { status: 'authenticated' } : { status: 'unavailable' }
  }

  stream(request: ProviderRequest): AsyncIterable<ProviderChunk> {
    return this.#client.invoke(request)
  }

  close(): void {
    this.#client.close()
  }
}

class ChildCredentialBrokerIpcClient {
  readonly #active = new Map<string, ChildBrokerRecord>()
  readonly #compactions = new Map<string, ChildCompactRecord>()
  readonly #onMessage = (message: unknown) => this.#receive(message)
  #nextRequestId = 1
  #closed = false

  constructor(
    private readonly target: ChildProviderTarget,
    private readonly childProcess: ChildIpcProcess,
  ) {
    childProcess.on('message', this.#onMessage)
  }

  available(): boolean {
    return (
      !this.#closed && this.childProcess.connected === true && this.childProcess.send !== undefined
    )
  }

  async *invoke(request: ProviderRequest): AsyncIterable<ProviderChunk> {
    if (!this.available()) throw channelFailure('CHILD_CREDENTIAL_HANDLE_UNKNOWN')
    if (request.model !== this.target.model) {
      throw channelFailure('CHILD_CREDENTIAL_SCOPE_MISMATCH')
    }
    const requestId = `cbreq-${this.#nextRequestId++}`
    const queue = new AsyncQueue<ProviderChunk>()
    this.#active.set(requestId, { queue, nextSequence: 0 })
    const abort = () => {
      void this.#send({ schemaVersion: 1, type: 'credential_broker.cancel', requestId }).catch(
        () => undefined,
      )
      queue.fail(channelFailure('CHILD_CREDENTIAL_CANCELLED'))
    }
    request.signal.addEventListener('abort', abort, { once: true })
    try {
      await this.#send({
        schemaVersion: 1,
        type: 'credential_broker.invoke',
        requestId,
        request: serializeProviderRequest(request),
      })
      for (;;) {
        const next = await queue.next()
        if (next.done) return
        yield next.value
      }
    } finally {
      request.signal.removeEventListener('abort', abort)
      this.#active.delete(requestId)
    }
  }

  async compact(request: ProviderRequest): Promise<ProviderNativeCompactionResult> {
    if (!this.available()) throw channelFailure('CHILD_CREDENTIAL_HANDLE_UNKNOWN')
    if (request.model !== this.target.model) {
      throw channelFailure('CHILD_CREDENTIAL_SCOPE_MISMATCH')
    }
    const requestId = `cbreq-${this.#nextRequestId++}`
    let rejectCompaction!: (error: Error) => void
    const pending = new Promise<ProviderNativeCompactionResult>((resolve, reject) => {
      rejectCompaction = reject
      this.#compactions.set(requestId, { resolve, reject })
    })
    const abort = () => {
      void this.#send({ schemaVersion: 1, type: 'credential_broker.cancel', requestId }).catch(
        () => undefined,
      )
      rejectCompaction(channelFailure('CHILD_CREDENTIAL_CANCELLED'))
    }
    request.signal.addEventListener('abort', abort, { once: true })
    try {
      await this.#send({
        schemaVersion: 1,
        type: 'credential_broker.compact',
        requestId,
        request: serializeProviderRequest(request),
      })
      return await pending
    } finally {
      request.signal.removeEventListener('abort', abort)
      this.#compactions.delete(requestId)
    }
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.childProcess.off('message', this.#onMessage)
    const failure = channelFailure('CHILD_CREDENTIAL_CANCELLED')
    for (const record of this.#active.values()) record.queue.fail(failure)
    for (const record of this.#compactions.values()) record.reject(failure)
    this.#active.clear()
    this.#compactions.clear()
  }

  #receive(message: unknown): void {
    if (this.#closed) return
    if (!messageType(message)?.startsWith('credential_broker.')) return
    let parsed: BrokerParentMessage
    try {
      parsed = validateParentMessage(message)
    } catch {
      this.#failAll('CHILD_CREDENTIAL_INVALID')
      return
    }
    const compaction = this.#compactions.get(parsed.requestId)
    if (parsed.type === 'credential_broker.compacted') {
      if (parsed.sequence !== 0 || !compaction) {
        compaction?.reject(channelFailure('CHILD_CREDENTIAL_INVALID'))
        return
      }
      compaction.resolve(parsed.result)
      return
    }
    if (parsed.type === 'credential_broker.failed' && compaction) {
      if (parsed.sequence !== 0) compaction.reject(channelFailure('CHILD_CREDENTIAL_INVALID'))
      else compaction.reject(channelFailure(parsed.errorCode))
      return
    }
    const record = this.#active.get(parsed.requestId)
    if (!record) return
    if (parsed.sequence !== record.nextSequence) {
      record.queue.fail(channelFailure('CHILD_CREDENTIAL_INVALID'))
      return
    }
    if (parsed.type === 'credential_broker.chunk') {
      record.nextSequence += 1
      record.queue.push(parsed.chunk)
    } else if (parsed.type === 'credential_broker.done') {
      record.queue.close()
    } else {
      record.queue.fail(channelFailure(parsed.errorCode))
    }
  }

  #send(message: BrokerChildMessage): Promise<void> {
    if (!this.available() || !this.childProcess.send) {
      return Promise.reject(channelFailure('CHILD_CREDENTIAL_HANDLE_UNKNOWN'))
    }
    try {
      this.childProcess.send(message)
      return Promise.resolve()
    } catch {
      return Promise.reject(channelFailure('CHILD_CREDENTIAL_CANCELLED'))
    }
  }

  #failAll(code: CredentialDelegationFailureCode): void {
    const failure = channelFailure(code)
    for (const record of this.#active.values()) record.queue.fail(failure)
    for (const record of this.#compactions.values()) record.reject(failure)
  }
}

function serializeProviderRequest(request: ProviderRequest): SerializedProviderRequest {
  const value = jsonClone({
    model: request.model,
    messages: request.messages,
    ...(request.contextMessages === undefined ? {} : { contextMessages: request.contextMessages }),
    tools: request.tools,
    ...(request.instructions === undefined ? {} : { instructions: request.instructions }),
    ...(request.maxOutputTokens === undefined ? {} : { maxOutputTokens: request.maxOutputTokens }),
    ...(request.reasoning === undefined ? {} : { reasoning: request.reasoning }),
    ...(request.responseFormat === undefined ? {} : { responseFormat: request.responseFormat }),
    ...(request.nativeContext === undefined ? {} : { nativeContext: request.nativeContext }),
  })
  return validateSerializedProviderRequest(value)
}

function validateChildMessage(value: unknown): BrokerChildMessage {
  if (!isRecord(value)) throw channelInvalid()
  if (
    value.type === 'credential_broker.cancel' &&
    exactKeys(value, ['schemaVersion', 'type', 'requestId']) &&
    value.schemaVersion === 1 &&
    safeId(value.requestId)
  ) {
    return value as BrokerCancelMessage
  }
  if (
    (value.type === 'credential_broker.invoke' || value.type === 'credential_broker.compact') &&
    exactKeys(value, ['schemaVersion', 'type', 'requestId', 'request']) &&
    value.schemaVersion === 1 &&
    safeId(value.requestId)
  ) {
    return {
      schemaVersion: 1,
      type: value.type,
      requestId: value.requestId,
      request: validateSerializedProviderRequest(value.request),
    }
  }
  throw channelInvalid()
}

function validateParentMessage(value: unknown): BrokerParentMessage {
  if (!isRecord(value)) throw channelInvalid()
  if (!safeId(value.requestId) || value.schemaVersion !== 1 || !nonNegativeInt(value.sequence)) {
    throw channelInvalid()
  }
  if (
    value.type === 'credential_broker.chunk' &&
    exactKeys(value, ['schemaVersion', 'type', 'requestId', 'sequence', 'chunk'])
  ) {
    return { ...value, chunk: validateProviderChunk(value.chunk) } as BrokerParentMessage
  }
  if (
    value.type === 'credential_broker.done' &&
    exactKeys(value, ['schemaVersion', 'type', 'requestId', 'sequence'])
  ) {
    return value as BrokerParentMessage
  }
  if (
    value.type === 'credential_broker.compacted' &&
    exactKeys(value, ['schemaVersion', 'type', 'requestId', 'sequence', 'result'])
  ) {
    return {
      ...value,
      result: validateProviderNativeCompactionResult(value.result),
    } as BrokerParentMessage
  }
  if (
    value.type === 'credential_broker.failed' &&
    exactKeys(value, ['schemaVersion', 'type', 'requestId', 'sequence', 'errorCode']) &&
    isCredentialCode(value.errorCode)
  ) {
    return value as BrokerParentMessage
  }
  throw channelInvalid()
}

function validateSerializedProviderRequest(value: unknown): SerializedProviderRequest {
  if (!isRecord(value) || !exactOptionalKeys(value, REQUEST_KEYS)) throw channelInvalid()
  if (
    !safeId(value.model) ||
    !providerMessages(value.messages) ||
    !providerMessages(value.contextMessages, true) ||
    !providerTools(value.tools) ||
    !optionalString(value.instructions, 64 * 1024) ||
    (value.maxOutputTokens !== undefined && !positiveInt(value.maxOutputTokens)) ||
    !reasoningConfig(value.reasoning) ||
    !responseFormat(value.responseFormat) ||
    (value.nativeContext !== undefined && !isProviderNativeContext(value.nativeContext))
  ) {
    throw channelInvalid()
  }
  return jsonClone(value) as SerializedProviderRequest
}

const REQUEST_KEYS = [
  'model',
  'messages',
  'contextMessages',
  'tools',
  'instructions',
  'maxOutputTokens',
  'reasoning',
  'responseFormat',
  'nativeContext',
] as const

function reasoningConfig(value: unknown): boolean {
  return (
    value === undefined ||
    (isRecord(value) &&
      exactOptionalKeys(value, ['mode', 'effort']) &&
      Object.hasOwn(value, 'mode') &&
      (value.mode === 'default' || value.mode === 'compact') &&
      (value.effort === undefined ||
        ['none', 'low', 'medium', 'high'].includes(String(value.effort))))
  )
}

function providerMessages(
  value: unknown,
  optional = false,
): value is ProviderMessage[] | undefined {
  if (value === undefined) return optional
  if (!Array.isArray(value) || value.length > MAX_MESSAGES) return false
  return value.every((message) => {
    if (
      !isRecord(message) ||
      typeof message.role !== 'string' ||
      !providerContent(message.content)
    ) {
      return false
    }
    if (message.role === 'tool') {
      return safeId(message.toolCallId) && safeId(message.name)
    }
    return message.role === 'user' || message.role === 'assistant'
  })
}

function providerContent(value: unknown): boolean {
  if (typeof value === 'string') return true
  return (
    Array.isArray(value) &&
    value.every(
      (block) => isRecord(block) && typeof block.type === 'string' && jsonBytes(block) <= 64 * 1024,
    )
  )
}

function providerTools(value: unknown): value is ProviderToolDefinition[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_TOOLS &&
    value.every(
      (tool) =>
        isRecord(tool) &&
        safeId(tool.name) &&
        optionalString(tool.description, 8 * 1024, false) &&
        isRecord(tool.parameters),
    )
  )
}

function responseFormat(value: unknown): boolean {
  return (
    value === undefined ||
    (isRecord(value) &&
      exactOptionalKeys(value, ['type', 'name', 'schema', 'strict']) &&
      value.type === 'json_schema' &&
      safeId(value.name) &&
      isRecord(value.schema) &&
      (value.strict === undefined || typeof value.strict === 'boolean'))
  )
}

function validateProviderChunk(value: unknown): ProviderChunk {
  if (!isRecord(value) || typeof value.type !== 'string') {
    throw channelInvalid()
  }
  const valid = (() => {
    switch (value.type) {
      case 'message_start':
        return exactKeys(value, ['type'])
      case 'text_start':
      case 'text_end':
      case 'reasoning_start':
      case 'reasoning_end':
        return exactKeys(value, ['type', 'contentIndex']) && nonNegativeInt(value.contentIndex)
      case 'text_delta':
        return (
          exactOptionalKeys(value, ['type', 'text', 'contentIndex']) &&
          typeof value.text === 'string' &&
          optionalNonNegativeInt(value.contentIndex)
        )
      case 'reasoning_delta':
        return (
          exactKeys(value, ['type', 'contentIndex', 'text']) &&
          nonNegativeInt(value.contentIndex) &&
          typeof value.text === 'string'
        )
      case 'tool_call_start':
        return (
          exactKeys(value, ['type', 'index', 'id', 'name']) &&
          nonNegativeInt(value.index) &&
          safeId(value.id) &&
          safeId(value.name)
        )
      case 'tool_call_delta':
        return (
          exactKeys(value, ['type', 'index', 'argumentsDelta']) &&
          nonNegativeInt(value.index) &&
          typeof value.argumentsDelta === 'string'
        )
      case 'tool_call_end':
        return exactOptionalKeys(value, ['type', 'index', 'input']) && nonNegativeInt(value.index)
      case 'tool_calls':
        return (
          exactKeys(value, ['type', 'calls']) &&
          Array.isArray(value.calls) &&
          value.calls.length <= MAX_TOOLS &&
          value.calls.every(
            (call) =>
              isRecord(call) &&
              exactKeys(call, ['id', 'name', 'input']) &&
              safeId(call.id) &&
              safeId(call.name),
          )
        )
      case 'completed':
        return (
          exactOptionalKeys(value, ['type', 'stopReason', 'usage']) &&
          optionalString(value.stopReason, 128) &&
          providerUsage(value.usage)
        )
      default:
        return false
    }
  })()
  if (!valid) throw channelInvalid()
  return jsonClone(value) as ProviderChunk
}

function providerUsage(value: unknown): value is ProviderUsage | undefined {
  if (value === undefined) return true
  if (!isRecord(value)) return false
  return (
    exactOptionalKeys(value, [
      'inputTokens',
      'outputTokens',
      'cacheReadTokens',
      'cacheWriteTokens',
      'costUsd',
    ]) && Object.values(value).every((item) => item === undefined || nonNegativeNumber(item))
  )
}

function validateProviderNativeCompactionResult(value: unknown): ProviderNativeCompactionResult {
  if (
    !isRecord(value) ||
    !exactOptionalKeys(value, ['format', 'items', 'usage']) ||
    !safeId(value.format) ||
    !Array.isArray(value.items) ||
    value.items.length === 0 ||
    value.items.length > 2_048 ||
    !value.items.every((item) => isRecord(item)) ||
    !providerUsage(value.usage)
  ) {
    throw channelInvalid()
  }
  return jsonClone(value) as ProviderNativeCompactionResult
}

function isCredentialCode(value: unknown): value is CredentialDelegationFailureCode {
  if (typeof value !== 'string') return false
  try {
    return isCredentialDelegationFailure(
      createCredentialDelegationFailure(value as CredentialDelegationFailureCode),
    )
  } catch {
    return false
  }
}

function channelFailure(code: CredentialDelegationFailureCode): Error {
  return Object.assign(
    new Error('Child credential delegation failed.'),
    createCredentialDelegationFailure(code),
  )
}

function channelInvalid(): Error {
  return channelFailure('CHILD_CREDENTIAL_INVALID')
}

function jsonClone<T>(value: T): T {
  let serialized: string
  try {
    serialized = JSON.stringify(value)
  } catch {
    throw channelInvalid()
  }
  return JSON.parse(serialized) as T
}

function jsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8')
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function messageType(value: unknown): string | undefined {
  return isRecord(value) && typeof value.type === 'string' ? value.type : undefined
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

function exactOptionalKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key))
}

function safeId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_ID.test(value)
}

function optionalString(value: unknown, maxBytes: number, optional = true): boolean {
  return (
    (optional && value === undefined) ||
    (typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= maxBytes)
  )
}

function nonNegativeInt(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

function optionalNonNegativeInt(value: unknown): boolean {
  return value === undefined || nonNegativeInt(value)
}

function positiveInt(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0
}

function nonNegativeNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

class AsyncQueue<T> {
  readonly #values: T[] = []
  readonly #waiters: Array<{
    resolve(result: IteratorResult<T>): void
    reject(error: Error): void
  }> = []
  #closed = false
  #failure?: Error

  push(value: T): void {
    if (this.#closed) return
    const waiter = this.#waiters.shift()
    if (waiter) waiter.resolve({ value, done: false })
    else this.#values.push(value)
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    for (const waiter of this.#waiters.splice(0)) {
      waiter.resolve({ value: undefined, done: true })
    }
  }

  fail(error: Error): void {
    if (this.#closed) return
    this.#failure = error
    this.#closed = true
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error)
  }

  async next(): Promise<IteratorResult<T>> {
    if (this.#values.length > 0) return { value: this.#values.shift()!, done: false }
    if (this.#failure) throw this.#failure
    if (this.#closed) return { value: undefined, done: true }
    return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }))
  }
}
