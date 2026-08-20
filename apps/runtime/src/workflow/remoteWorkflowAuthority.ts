import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type {
  AgentProfileV1,
  ArtifactReference,
  VersionedWorkflowRefV1,
  WorkflowAuthorityPortV1,
  WorkflowEffectAdmissionV1,
  WorkflowEffectReceiptV1,
  WorkflowEventV1,
  WorkflowHumanTaskV1,
  WorkflowMessageInputV1,
  WorkflowMessageTypeV1,
  WorkflowMessageV1,
  WorkflowProjectionV1,
  WorkflowRecoveryDecisionV1,
  WorkflowSignalV1,
  WorkflowSpecV1,
  WorkflowTaskClaimV1,
  WorkflowTaskKindV1,
  WorkflowTaskLeaseV1,
  WorkflowTaskStateV1,
  WorkflowTaskV1,
  WorkflowTimerV1,
  WorkflowTransactionV1,
} from '@praxis/core-sdk'
import { ArtifactStore } from '../artifacts/artifactStore.js'

const MAX_REQUEST_BYTES = 4 * 1024 * 1024

type RemoteCall = Readonly<{ method: string; args: readonly unknown[] }>

/** Authenticated RPC boundary for workers that must not access the authority DB directly. */
export class WorkflowAuthorityHttpServerV1 {
  #server?: Server

  constructor(
    private readonly authority: WorkflowAuthorityPortV1,
    private readonly options: Readonly<{
      host: string
      port: number
      token: string
      artifacts?: Pick<ArtifactStore, 'put' | 'read' | 'list'>
    }>,
  ) {}

  async start(): Promise<void> {
    if (this.#server !== undefined) return
    const server = createServer((request, response) => {
      void this.handle(request, response)
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.options.port, this.options.host, () => {
        server.off('error', reject)
        resolve()
      })
    })
    this.#server = server
  }

  async close(): Promise<void> {
    const server = this.#server
    this.#server = undefined
    if (server === undefined) return
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    )
  }

  url(): string {
    const address = this.#server?.address()
    if (address === null || address === undefined || typeof address === 'string') {
      throw remoteError('WORKFLOW_AUTHORITY_SERVER_NOT_LISTENING', false)
    }
    const host = address.address === '::' ? '127.0.0.1' : address.address
    return `http://${host}:${address.port}`
  }

  private async handle(
    request: import('node:http').IncomingMessage,
    response: import('node:http').ServerResponse,
  ): Promise<void> {
    response.setHeader('content-type', 'application/json; charset=utf-8')
    if (
      request.method !== 'POST' ||
      request.url !== '/v1/workflow-authority' ||
      !authorized(request.headers.authorization, this.options.token)
    ) {
      response.statusCode = request.headers.authorization === undefined ? 401 : 404
      response.end(JSON.stringify({ error: { code: 'WORKFLOW_AUTHORITY_UNAUTHORIZED' } }))
      return
    }
    try {
      const call = validateCall(JSON.parse(await readBody(request)) as unknown)
      const artifactMethod = call.method.startsWith('artifact.')
      const owner = artifactMethod ? this.options.artifacts : this.authority
      const localMethod = artifactMethod ? call.method.slice('artifact.'.length) : call.method
      const target = owner === undefined ? undefined : Reflect.get(owner, localMethod)
      if (typeof target !== 'function' || !REMOTE_METHODS.has(call.method))
        throw remoteError('WORKFLOW_AUTHORITY_METHOD_DENIED', false)
      const result = await Reflect.apply(target, owner, call.args)
      response.statusCode = 200
      response.end(JSON.stringify({ result }))
    } catch (error) {
      response.statusCode = 400
      response.end(
        JSON.stringify({
          error: {
            code: errorCode(error),
            message: error instanceof Error ? error.message : 'Workflow authority call failed.',
            retryable: error instanceof Error && Reflect.get(error, 'retryable') === true,
          },
        }),
      )
    }
  }
}

/** WorkflowAuthorityPort implementation used by remote/isolated Worker processes. */
export class RemoteWorkflowAuthorityClientV1 implements WorkflowAuthorityPortV1 {
  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}

  initialize() {
    return this.call<void>('initialize')
  }
  create(
    spec: WorkflowSpecV1,
    transactionId: string,
    bootstrap?: Parameters<WorkflowAuthorityPortV1['create']>[2],
  ) {
    return this.call<WorkflowProjectionV1>('create', spec, transactionId, bootstrap)
  }
  transact(input: WorkflowTransactionV1) {
    return this.call<WorkflowProjectionV1>('transact', input)
  }
  get(workflowId: string) {
    return this.call<WorkflowProjectionV1>('get', workflowId)
  }
  events(workflowId: string, afterSequence?: number) {
    return this.call<readonly WorkflowEventV1[]>('events', workflowId, afterSequence)
  }
  list(options?: Parameters<WorkflowAuthorityPortV1['list']>[0]) {
    return this.call<readonly WorkflowProjectionV1[]>('list', options)
  }
  listTasks(
    options?: Readonly<{
      workflowId?: string
      states?: readonly WorkflowTaskStateV1[]
      kinds?: readonly WorkflowTaskKindV1[]
      limit?: number
    }>,
  ) {
    return this.call<readonly WorkflowTaskV1[]>('listTasks', options)
  }
  bindTaskCapabilityBundle(
    taskId: string,
    leaseToken: string,
    ref: VersionedWorkflowRefV1,
    at?: string,
  ) {
    return this.call<WorkflowTaskV1>('bindTaskCapabilityBundle', taskId, leaseToken, ref, at)
  }
  claim(workerId: string, options?: Parameters<WorkflowAuthorityPortV1['claim']>[1]) {
    return this.call<WorkflowTaskClaimV1 | undefined>('claim', workerId, options)
  }
  heartbeat(taskId: string, leaseToken: string, progress: boolean, now?: string) {
    return this.call<WorkflowTaskLeaseV1>('heartbeat', taskId, leaseToken, progress, now)
  }
  recoverExpired(now?: string) {
    return this.call<readonly WorkflowRecoveryDecisionV1[]>('recoverExpired', now)
  }
  signal(input: WorkflowSignalV1) {
    return this.call<boolean>('signal', input)
  }
  postMessage(input: WorkflowMessageInputV1) {
    return this.call<WorkflowMessageV1>('postMessage', input)
  }
  listMessages(
    options: Readonly<{
      workflowId: string
      recipientNodeId?: string
      afterSequence?: number
      types?: readonly WorkflowMessageTypeV1[]
      includeAcknowledged?: boolean
      limit?: number
    }>,
  ) {
    return this.call<readonly WorkflowMessageV1[]>('listMessages', options)
  }
  acknowledgeMessages(
    workflowId: string,
    recipientNodeId: string,
    throughSequence: number,
    at?: string,
  ) {
    return this.call<number>(
      'acknowledgeMessages',
      workflowId,
      recipientNodeId,
      throughSequence,
      at,
    )
  }
  acknowledgeMessage(workflowId: string, messageId: string, recipientNodeId: string, at?: string) {
    return this.call<boolean>('acknowledgeMessage', workflowId, messageId, recipientNodeId, at)
  }
  fireDueTimers(now?: string) {
    return this.call<readonly WorkflowTimerV1[]>('fireDueTimers', now)
  }
  expireDueHumanTasks(now?: string) {
    return this.call<readonly WorkflowHumanTaskV1[]>('expireDueHumanTasks', now)
  }
  getEffectReceipt(workflowId: string, idempotencyKey: string) {
    return this.call<WorkflowEffectReceiptV1 | undefined>(
      'getEffectReceipt',
      workflowId,
      idempotencyKey,
    )
  }
  listEffectReceipts(workflowId: string) {
    return this.call<readonly WorkflowEffectReceiptV1[]>('listEffectReceipts', workflowId)
  }
  reserveEffect(
    workflowId: string,
    idempotencyKey: string,
    inputDigest: `sha256:${string}`,
    attemptId: string,
    leaseExpiresAt: string,
    at?: string,
  ) {
    return this.call<WorkflowEffectAdmissionV1>(
      'reserveEffect',
      workflowId,
      idempotencyKey,
      inputDigest,
      attemptId,
      leaseExpiresAt,
      at,
    )
  }
  markEffectCompensated(
    workflowId: string,
    sourceReceiptArtifactId: string,
    compensationReceiptArtifactId: string,
    at?: string,
  ) {
    return this.call<WorkflowEffectReceiptV1>(
      'markEffectCompensated',
      workflowId,
      sourceReceiptArtifactId,
      compensationReceiptArtifactId,
      at,
    )
  }
  listHumanTasks(workflowId: string, states?: readonly WorkflowHumanTaskV1['state'][]) {
    return this.call<readonly WorkflowHumanTaskV1[]>('listHumanTasks', workflowId, states)
  }
  resolveHumanTask(
    humanTaskId: string,
    state: Exclude<WorkflowHumanTaskV1['state'], 'waiting'>,
    resolution?: Readonly<Record<string, unknown>>,
    at?: string,
  ) {
    return this.call<WorkflowHumanTaskV1>('resolveHumanTask', humanTaskId, state, resolution, at)
  }
  retryNode(workflowId: string, nodeId: string, at?: string) {
    return this.call<WorkflowProjectionV1>('retryNode', workflowId, nodeId, at)
  }
  resolveUnknown(
    workflowId: string,
    nodeId: string,
    resolution: 'succeeded' | 'failed' | 'manual_intervention',
    code?: string,
    at?: string,
  ) {
    return this.call<WorkflowProjectionV1>(
      'resolveUnknown',
      workflowId,
      nodeId,
      resolution,
      code,
      at,
    )
  }
  registerProfile(profile: AgentProfileV1) {
    return this.call<void>('registerProfile', profile)
  }
  getProfile(profileId: string, version?: number) {
    return this.call<AgentProfileV1>('getProfile', profileId, version)
  }
  listProfiles() {
    return this.call<readonly AgentProfileV1[]>('listProfiles')
  }
  close(): void {}

  private async call<T>(method: string, ...args: readonly unknown[]): Promise<T> {
    const response = await fetch(new URL('/v1/workflow-authority', this.url), {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ method, args: compactArgs(args) }),
    })
    const payload = (await response.json()) as {
      result?: T
      error?: { code?: string; message?: string; retryable?: boolean }
    }
    if (!response.ok || payload.error !== undefined) {
      const code = payload.error?.code ?? 'WORKFLOW_AUTHORITY_REMOTE_FAILED'
      throw Object.assign(
        new Error(payload.error?.message ?? `Remote Workflow authority failed (${code}).`),
        {
          code,
          retryable: payload.error?.retryable ?? response.status >= 500,
        },
      )
    }
    return payload.result as T
  }
}

/** Content-addressed ArtifactStore proxy used with a remote authority. */
export class RemoteArtifactStoreV1 extends ArtifactStore {
  constructor(
    private readonly remoteUrl: string,
    private readonly remoteToken: string,
  ) {
    super()
  }

  override put(value: unknown, mimeType?: string): Promise<ArtifactReference> {
    return remoteArtifactCall(this.remoteUrl, this.remoteToken, 'artifact.put', value, mimeType)
  }
  override read(artifactId: string): Promise<unknown> {
    return remoteArtifactCall(this.remoteUrl, this.remoteToken, 'artifact.read', artifactId)
  }
  override list(): Promise<Array<ArtifactReference & { createdAt?: string }>> {
    return remoteArtifactCall(this.remoteUrl, this.remoteToken, 'artifact.list')
  }
}

const REMOTE_METHODS = new Set([
  'initialize',
  'create',
  'transact',
  'get',
  'events',
  'list',
  'listTasks',
  'bindTaskCapabilityBundle',
  'claim',
  'heartbeat',
  'recoverExpired',
  'signal',
  'postMessage',
  'listMessages',
  'acknowledgeMessages',
  'acknowledgeMessage',
  'fireDueTimers',
  'expireDueHumanTasks',
  'getEffectReceipt',
  'listEffectReceipts',
  'reserveEffect',
  'markEffectCompensated',
  'listHumanTasks',
  'resolveHumanTask',
  'retryNode',
  'resolveUnknown',
  'registerProfile',
  'getProfile',
  'listProfiles',
  'artifact.put',
  'artifact.read',
  'artifact.list',
])

async function remoteArtifactCall<T>(
  url: string,
  token: string,
  method: string,
  ...args: readonly unknown[]
): Promise<T> {
  const response = await fetch(new URL('/v1/workflow-authority', url), {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ method, args: compactArgs(args) }),
  })
  const payload = (await response.json()) as {
    result?: T
    error?: { code?: string; message?: string; retryable?: boolean }
  }
  if (!response.ok || payload.error !== undefined) {
    const code = payload.error?.code ?? 'WORKFLOW_ARTIFACT_REMOTE_FAILED'
    throw Object.assign(
      new Error(payload.error?.message ?? `Remote ArtifactStore failed (${code}).`),
      {
        code,
        retryable: payload.error?.retryable ?? response.status >= 500,
      },
    )
  }
  return payload.result as T
}

function validateCall(value: unknown): RemoteCall {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    typeof Reflect.get(value, 'method') !== 'string' ||
    !Array.isArray(Reflect.get(value, 'args'))
  )
    throw remoteError('WORKFLOW_AUTHORITY_REQUEST_INVALID', false)
  return {
    method: Reflect.get(value, 'method') as string,
    args: Reflect.get(value, 'args') as unknown[],
  }
}

function compactArgs(args: readonly unknown[]): readonly unknown[] {
  let length = args.length
  while (length > 0 && args[length - 1] === undefined) length -= 1
  return args.slice(0, length)
}

async function readBody(request: import('node:http').IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > MAX_REQUEST_BYTES) throw remoteError('WORKFLOW_AUTHORITY_REQUEST_TOO_LARGE', false)
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function remoteError(code: string, retryable: boolean): Error {
  return Object.assign(new Error(`Remote Workflow authority failed (${code}).`), {
    code,
    retryable,
  })
}
function authorized(header: string | undefined, token: string): boolean {
  if (header === undefined || !header.startsWith('Bearer ')) return false
  const actual = createHash('sha256').update(header.slice('Bearer '.length)).digest()
  const expected = createHash('sha256').update(token).digest()
  return timingSafeEqual(actual, expected)
}
function errorCode(error: unknown): string {
  return error instanceof Error && typeof Reflect.get(error, 'code') === 'string'
    ? Reflect.get(error, 'code')
    : 'WORKFLOW_AUTHORITY_REMOTE_FAILED'
}
