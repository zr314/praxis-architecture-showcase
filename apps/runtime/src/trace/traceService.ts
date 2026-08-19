import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import {
  createTraceRecord,
  runtimeError,
  type TraceContext,
  type TraceRecord,
} from '@praxis/core-sdk'
import {
  assertSafeTraceId,
  captureDirectoryIdentity,
  JsonlTraceSink,
  openExclusiveVerifiedFile,
  validateDirectoryIdentity,
  validateOpenFileIdentity,
  type DirectoryIdentity,
  type TraceRecordStore,
} from './jsonlTraceSink.js'

export type TracePrivacyInventory = {
  included: ['eventKinds', 'timestamps', 'correlationIds', 'declaredAttributes', 'aggregateMetrics']
  excluded: ['prompts', 'credentials', 'environment', 'rawToolInput', 'rawToolOutput']
}

export type TraceExportDocument = {
  bundleVersion: 1
  schemaVersion: 1
  traceId: string
  createdAt: string
  recordCount: number
  privacy: TracePrivacyInventory
  records: TraceRecord[]
}

export type TraceExportResult = TraceExportDocument & { path: string }

export interface RuntimeTraceService {
  createContext(input: { runtimeId: string; sessionId?: string; runId?: string }): TraceContext
  record(input: Omit<TraceRecord, 'schemaVersion' | 'timestamp'>): Promise<void>
  exportTrace(traceId: string, destination: string): Promise<TraceExportResult>
  beginShutdown(): void
  flush(): Promise<void>
  shutdown(): Promise<void>
}

export type TraceServiceOptions = {
  sink?: TraceRecordStore
  now?: () => Date
  createId?: () => string
  correlation?: Readonly<Pick<TraceContext, 'parentRunId' | 'childRunId' | 'parentTraceId'>>
}

const PRIVACY: TracePrivacyInventory = {
  included: [
    'eventKinds',
    'timestamps',
    'correlationIds',
    'declaredAttributes',
    'aggregateMetrics',
  ],
  excluded: ['prompts', 'credentials', 'environment', 'rawToolInput', 'rawToolOutput'],
}

export class TraceService implements RuntimeTraceService {
  private readonly sink: TraceRecordStore
  private readonly now: () => Date
  private readonly createId: () => string
  private readonly correlation: NonNullable<TraceServiceOptions['correlation']>
  private readonly pendingRecords = new Set<Promise<void>>()
  private acceptingRecords = true
  private shutdownPromise?: Promise<void>

  constructor(options: TraceServiceOptions = {}) {
    this.sink = options.sink ?? new JsonlTraceSink()
    this.now = options.now ?? (() => new Date())
    this.createId = options.createId ?? randomUUID
    this.correlation = Object.freeze({ ...(options.correlation ?? {}) })
  }

  createContext(input: { runtimeId: string; sessionId?: string; runId?: string }): TraceContext {
    const traceId = `trace-${this.createId()}`
    assertSafeTraceId(traceId)
    return validatedContext(traceId, { ...input, ...this.correlation }, this.now)
  }

  record(input: Omit<TraceRecord, 'schemaVersion' | 'timestamp'>): Promise<void> {
    if (!this.acceptingRecords) {
      return Promise.reject(new Error('Trace service is shutting down.'))
    }
    const operation = this.sink.append(
      createTraceRecord({ ...input, timestamp: this.now().toISOString() }),
    )
    this.pendingRecords.add(operation)
    void operation.then(
      () => this.pendingRecords.delete(operation),
      () => this.pendingRecords.delete(operation),
    )
    return operation
  }

  async exportTrace(traceId: string, destination: string): Promise<TraceExportResult> {
    assertSafeTraceId(traceId)
    await this.sink.flush()
    const records = await this.sink.load(traceId)
    if (records.length === 0) {
      throw runtimeError('TRACE_NOT_FOUND', 'protocol', 'Trace not found.')
    }

    const destinationDirectory = await prepareDestination(destination)
    const outputPath = join(destinationDirectory.path, `${traceId}.json`)
    await assertNotSymlink(outputPath)

    const document: TraceExportDocument = {
      bundleVersion: 1,
      schemaVersion: 1,
      traceId,
      createdAt: this.now().toISOString(),
      recordCount: records.length,
      privacy: clonePrivacy(),
      records,
    }
    const temporaryPath = join(
      destinationDirectory.path,
      `.${basename(outputPath)}.${process.pid}.${randomUUID()}.tmp`,
    )
    const temporaryHandle = await openExclusiveVerifiedFile(temporaryPath, destinationDirectory)
    let temporaryIdentity: Awaited<ReturnType<typeof validateOpenFileIdentity>> | undefined
    let temporaryHandleOpen = true
    try {
      temporaryIdentity = await validateOpenFileIdentity(
        temporaryHandle,
        temporaryPath,
        destinationDirectory,
      )
      await temporaryHandle.writeFile(`${JSON.stringify(document, undefined, 2)}\n`, 'utf8')
      await temporaryHandle.sync()
      await validateOpenFileIdentity(temporaryHandle, temporaryPath, destinationDirectory)
      await temporaryHandle.close()
      temporaryHandleOpen = false
      await validateDirectoryIdentity(destinationDirectory)
      await assertNotSymlink(outputPath)
      // Node exposes no renameat/openat. Revalidation immediately before and
      // after publication detects path replacement but is not an OS sandbox.
      await rename(temporaryPath, outputPath)
      await validatePublishedExport(outputPath, destinationDirectory, temporaryIdentity)
    } finally {
      if (temporaryHandleOpen) await temporaryHandle.close().catch(() => undefined)
      if (temporaryIdentity) {
        await removeTemporaryIfOwned(temporaryPath, destinationDirectory, temporaryIdentity)
      }
    }
    return { ...document, path: outputPath }
  }

  beginShutdown(): void {
    this.acceptingRecords = false
  }

  async flush(): Promise<void> {
    await Promise.allSettled([...this.pendingRecords])
    await this.sink.flush()
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise
    this.beginShutdown()
    this.shutdownPromise = this.flush()
    return this.shutdownPromise
  }
}

/** Test harness service that preserves correlation semantics without retaining data. */
export class NoopTraceService implements RuntimeTraceService {
  private acceptingRecords = true
  private shutdownPromise?: Promise<void>

  constructor(
    private readonly createId: () => string = randomUUID,
    private readonly now: () => Date = () => new Date(),
  ) {}

  createContext(input: { runtimeId: string; sessionId?: string; runId?: string }): TraceContext {
    const traceId = `trace-${this.createId()}`
    assertSafeTraceId(traceId)
    return validatedContext(traceId, input, this.now)
  }

  async record(_input: Omit<TraceRecord, 'schemaVersion' | 'timestamp'>): Promise<void> {
    if (!this.acceptingRecords) throw new Error('Trace service is shutting down.')
  }

  async exportTrace(traceId: string, _destination: string): Promise<TraceExportResult> {
    assertSafeTraceId(traceId)
    throw runtimeError('TRACE_NOT_FOUND', 'protocol', 'Trace not found.')
  }

  beginShutdown(): void {
    this.acceptingRecords = false
  }

  async flush(): Promise<void> {}

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise
    this.beginShutdown()
    this.shutdownPromise = this.flush()
    return this.shutdownPromise
  }
}

function clonePrivacy(): TracePrivacyInventory {
  return {
    included: [...PRIVACY.included],
    excluded: [...PRIVACY.excluded],
  }
}

function validatedContext(
  traceId: string,
  input: {
    runtimeId: string
    sessionId?: string
    runId?: string
    parentRunId?: string
    childRunId?: string
    parentTraceId?: string
  },
  now: () => Date,
): TraceContext {
  return createTraceRecord({
    kind: 'run.started',
    timestamp: now().toISOString(),
    context: {
      runtimeId: input.runtimeId,
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      ...(input.runId === undefined ? {} : { runId: input.runId }),
      ...(input.parentRunId === undefined ? {} : { parentRunId: input.parentRunId }),
      ...(input.childRunId === undefined ? {} : { childRunId: input.childRunId }),
      ...(input.parentTraceId === undefined ? {} : { parentTraceId: input.parentTraceId }),
      traceId,
    },
  }).context
}

async function prepareDestination(destination: string): Promise<DirectoryIdentity> {
  if (!destination) throw new TypeError('Trace export destination must be a directory.')
  const absolute = resolve(destination)
  await mkdir(absolute, { recursive: true })
  return captureDirectoryIdentity(absolute)
}

async function validatePublishedExport(
  path: string,
  parent: DirectoryIdentity,
  expected: Awaited<ReturnType<typeof validateOpenFileIdentity>>,
): Promise<void> {
  const handle = await open(path, 'r')
  try {
    const published = await validateOpenFileIdentity(handle, path, parent)
    if (published.dev !== expected.dev || published.ino !== expected.ino) {
      throw new TypeError('Published trace export identity changed during rename.')
    }
  } finally {
    await handle.close()
  }
}

async function removeTemporaryIfOwned(
  path: string,
  parent: DirectoryIdentity,
  expected: Awaited<ReturnType<typeof validateOpenFileIdentity>>,
): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(path, 'r')
    const current = await validateOpenFileIdentity(handle, path, parent)
    if (current.dev !== expected.dev || current.ino !== expected.ino) return
    await handle.close()
    handle = undefined
    await validateDirectoryIdentity(parent)
    await rm(path)
  } catch (error) {
    if (!isNotFound(error)) return
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function assertNotSymlink(path: string): Promise<void> {
  try {
    if ((await lstat(path)).isSymbolicLink()) {
      throw new TypeError('Trace export refuses to replace a symbolic link.')
    }
  } catch (error) {
    if (isNotFound(error)) return
    throw error
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
