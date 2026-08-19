import { constants, type BigIntStats } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, stat, type FileHandle } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative } from 'node:path'
import {
  createTraceRecord,
  type CreateTraceRecordInput,
  type TraceRecord,
  type TraceSink,
} from '@praxis/core-sdk'

export const MAX_TRACE_LINE_BYTES = 16 * 1_024

const SAFE_TRACE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const TRACE_DATE = /^(\d{4}-\d{2}-\d{2})T/

export interface TraceRecordStore extends TraceSink {
  load(traceId: string): Promise<TraceRecord[]>
}

export type DirectoryIdentity = {
  path: string
  device: bigint
  inode: bigint
}

/** Append-only, privacy-safe trace storage independent of session persistence. */
export class JsonlTraceSink implements TraceRecordStore {
  private readonly rootDirectory: string
  private readonly traceDirectory: string
  private readonly preparedPaths = new Set<string>()
  private readonly writeFailures: unknown[] = []
  private pending: Promise<void> = Promise.resolve()

  constructor(root = process.env.PRAXIS_HOME ?? join(homedir(), '.praxis')) {
    this.rootDirectory = root
    this.traceDirectory = join(root, 'traces')
  }

  async append(record: TraceRecord): Promise<void> {
    const safeRecord = sanitizeRecord(record)
    assertSafeTraceId(safeRecord.context.traceId)
    const date = traceDate(safeRecord.timestamp)
    const line = `${JSON.stringify(safeRecord)}\n`
    if (Buffer.byteLength(line, 'utf8') > MAX_TRACE_LINE_BYTES) {
      throw new RangeError('A trace record line cannot exceed 16 KiB.')
    }

    await this.enqueue(async () => {
      const dateDirectory = await this.prepareDateDirectory(date)
      const path = join(dateDirectory.path, `${safeRecord.context.traceId}.jsonl`)
      const handle = await openVerifiedTraceFile(path, dateDirectory, true)
      try {
        if (!this.preparedPaths.has(path)) await repairTruncatedTail(handle)
        await writeAtEnd(handle, line)
        this.preparedPaths.add(path)
      } finally {
        await handle.close()
      }
    })
  }

  async load(traceId: string): Promise<TraceRecord[]> {
    assertSafeTraceId(traceId)
    await this.flush()
    const dateDirectories = await this.traceDateDirectories()
    const records: TraceRecord[] = []
    for (const dateDirectory of dateDirectories) {
      const path = join(dateDirectory.path, `${traceId}.jsonl`)
      let source: string
      try {
        const handle = await openVerifiedTraceFile(path, dateDirectory, false)
        try {
          source = await handle.readFile('utf8')
        } finally {
          await handle.close()
        }
      } catch (error) {
        if (isNotFound(error)) continue
        throw error
      }
      const completeSource = source.endsWith('\n')
        ? source
        : source.slice(0, Math.max(0, source.lastIndexOf('\n') + 1))
      for (const line of completeSource.split(/\r?\n/)) {
        if (!line) continue
        if (Buffer.byteLength(`${line}\n`, 'utf8') > MAX_TRACE_LINE_BYTES) {
          throw new RangeError('A stored trace record line exceeds 16 KiB.')
        }
        const record = sanitizeRecord(JSON.parse(line) as TraceRecord)
        if (record.context.traceId !== traceId) {
          throw new SyntaxError('Stored trace record belongs to a different trace ID.')
        }
        records.push(record)
      }
    }
    return records
  }

  async flush(): Promise<void> {
    await this.pending
    const failures = this.writeFailures.splice(0)
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'Multiple trace writes failed.')
  }

  private enqueue(action: () => Promise<void>): Promise<void> {
    const operation = this.pending.then(action)
    this.pending = operation.catch((error) => {
      this.writeFailures.push(error)
    })
    return operation
  }

  private async prepareDateDirectory(date: string): Promise<DirectoryIdentity> {
    await mkdir(this.rootDirectory, { recursive: true })
    await mkdir(this.traceDirectory, { recursive: true })
    const traceDirectory = await this.canonicalTraceDirectory()

    const dateDirectory = join(traceDirectory.path, date)
    await mkdir(dateDirectory, { recursive: true })
    return captureDirectoryIdentity(dateDirectory, traceDirectory.path)
  }

  private async traceDateDirectories(): Promise<DirectoryIdentity[]> {
    let traceDirectory: DirectoryIdentity
    try {
      traceDirectory = await this.canonicalTraceDirectory()
    } catch (error) {
      if (isNotFound(error)) return []
      throw error
    }
    const entries = (await readdir(traceDirectory.path, { withFileTypes: true }))
      .filter((entry) => /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
      .sort((left, right) => left.name.localeCompare(right.name))
    const directories: DirectoryIdentity[] = []
    for (const entry of entries) {
      const path = join(traceDirectory.path, entry.name)
      if (!entry.isDirectory()) continue
      directories.push(await captureDirectoryIdentity(path, traceDirectory.path))
    }
    return directories
  }

  private async canonicalTraceDirectory(): Promise<DirectoryIdentity> {
    const canonicalRoot = await realpath(this.rootDirectory)
    return captureDirectoryIdentity(this.traceDirectory, canonicalRoot)
  }
}

export function assertSafeTraceId(traceId: string): void {
  if (typeof traceId !== 'string') {
    throw new TypeError('Trace ID must be a string.')
  }
  if (!SAFE_TRACE_ID.test(traceId)) {
    throw new TypeError(
      'Trace ID must contain only safe alphanumeric, hyphen, or underscore characters.',
    )
  }
}

function sanitizeRecord(record: TraceRecord): TraceRecord {
  if (!record || typeof record !== 'object' || record.schemaVersion !== 1) {
    throw new TypeError('Trace record must use schema version 1.')
  }
  return createTraceRecord({
    kind: record.kind,
    timestamp: record.timestamp,
    context: record.context,
    ...(record.attributes === undefined ? {} : { attributes: record.attributes }),
    ...(record.metrics === undefined ? {} : { metrics: record.metrics }),
  } as CreateTraceRecordInput)
}

function traceDate(timestamp: string): string {
  const match = TRACE_DATE.exec(timestamp)
  if (!match || !Number.isFinite(Date.parse(timestamp))) {
    throw new TypeError('Trace timestamp must be an ISO-8601 date-time string.')
  }
  return match[1]
}

async function repairTruncatedTail(handle: FileHandle): Promise<void> {
  const source = await handle.readFile('utf8')
  if (!source || source.endsWith('\n')) return
  const finalNewline = source.lastIndexOf('\n')
  const completeSource = finalNewline < 0 ? '' : source.slice(0, finalNewline + 1)
  await handle.truncate(Buffer.byteLength(completeSource, 'utf8'))
}

export async function captureDirectoryIdentity(
  path: string,
  container?: string,
): Promise<DirectoryIdentity> {
  const linkMetadata = await lstat(path, { bigint: true })
  if (linkMetadata.isSymbolicLink())
    throw new TypeError('Trace directory cannot be a symbolic link.')
  const canonicalPath = await realpath(path)
  if (container !== undefined) assertContained(container, canonicalPath)
  const [currentLinkMetadata, metadata] = await Promise.all([
    lstat(path, { bigint: true }),
    stat(canonicalPath, { bigint: true }),
  ])
  if (
    currentLinkMetadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    !sameIdentity(linkMetadata, currentLinkMetadata) ||
    !sameIdentity(currentLinkMetadata, metadata)
  ) {
    throw new TypeError('Trace directory identity changed during verification.')
  }
  return { path: canonicalPath, device: metadata.dev, inode: metadata.ino }
}

/**
 * Validates the actual opened file before any content read or write. Node has
 * no portable openat/renameat API, so this is a containment check rather than
 * an operating-system sandbox against a directory rename after validation.
 */
export async function validateOpenFileIdentity(
  handle: FileHandle,
  path: string,
  parent: DirectoryIdentity,
): Promise<BigIntStats> {
  await validateDirectoryIdentity(parent)
  const leafMetadata = await lstat(path, { bigint: true })
  if (leafMetadata.isSymbolicLink()) throw new TypeError('Trace file cannot be a symbolic link.')
  const canonicalLeaf = await realpath(path)
  assertContained(parent.path, canonicalLeaf)
  if (!samePath(dirname(canonicalLeaf), parent.path)) {
    throw new TypeError('Trace file must be a direct child of its verified directory.')
  }
  const [openedMetadata, pathMetadata] = await Promise.all([
    handle.stat({ bigint: true }),
    stat(canonicalLeaf, { bigint: true }),
  ])
  if (!openedMetadata.isFile() || !sameIdentity(openedMetadata, pathMetadata)) {
    throw new TypeError('Trace file identity changed before use.')
  }
  if (openedMetadata.nlink !== 1n || pathMetadata.nlink !== 1n) {
    throw new TypeError('Trace file cannot have multiple hard links.')
  }
  await validateDirectoryIdentity(parent)
  return openedMetadata
}

export async function validateDirectoryIdentity(identity: DirectoryIdentity): Promise<void> {
  const linkMetadata = await lstat(identity.path)
  if (linkMetadata.isSymbolicLink())
    throw new TypeError('Trace directory identity changed before use.')
  const canonicalPath = await realpath(identity.path)
  const metadata = await stat(canonicalPath, { bigint: true })
  if (
    !samePath(canonicalPath, identity.path) ||
    metadata.dev !== identity.device ||
    metadata.ino !== identity.inode
  ) {
    throw new TypeError('Trace directory identity changed before use.')
  }
}

export async function openExclusiveVerifiedFile(
  path: string,
  parent: DirectoryIdentity,
): Promise<FileHandle> {
  const handle = await open(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL, 0o600)
  try {
    await validateOpenFileIdentity(handle, path, parent)
    return handle
  } catch (error) {
    await handle.close()
    throw error
  }
}

async function openVerifiedTraceFile(
  path: string,
  parent: DirectoryIdentity,
  create: boolean,
): Promise<FileHandle> {
  let handle: FileHandle
  for (;;) {
    try {
      handle = await open(path, create ? constants.O_RDWR : constants.O_RDONLY)
      break
    } catch (error) {
      if (!create || !isNotFound(error)) throw error
      try {
        handle = await openExclusiveVerifiedFile(path, parent)
        break
      } catch (createError) {
        if (isAlreadyExists(createError)) continue
        throw createError
      }
    }
  }
  try {
    await validateOpenFileIdentity(handle, path, parent)
    return handle
  } catch (error) {
    await handle.close()
    throw error
  }
}

async function writeAtEnd(handle: FileHandle, value: string): Promise<void> {
  const buffer = Buffer.from(value, 'utf8')
  const metadata = await handle.stat()
  let written = 0
  while (written < buffer.byteLength) {
    const result = await handle.write(
      buffer,
      written,
      buffer.byteLength - written,
      metadata.size + written,
    )
    if (result.bytesWritten === 0) throw new Error('Trace write made no progress.')
    written += result.bytesWritten
  }
}

function assertContained(directory: string, candidate: string): void {
  const pathFromDirectory = relative(directory, candidate)
  if (pathFromDirectory.startsWith('..') || isAbsolute(pathFromDirectory)) {
    throw new TypeError('Trace storage path must remain inside PRAXIS_HOME.')
  }
}

function samePath(left: string, right: string): boolean {
  return relative(left, right) === '' && relative(right, left) === ''
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST'
}
