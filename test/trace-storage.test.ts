import assert from 'node:assert/strict'
import { mkdir, mkdtemp, open, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import test from 'node:test'
import { createTraceRecord, type TraceRecord } from '@praxis/core-sdk'
import * as traceStorage from '../apps/runtime/src/trace/jsonlTraceSink.js'
import { JsonlTraceSink, MAX_TRACE_LINE_BYTES } from '../apps/runtime/src/trace/jsonlTraceSink.js'

const timestamp = '2026-07-20T08:00:00.000Z'

test('JSONL trace storage writes one ordered object per line under the dated trace path', async () => {
  await withTemporaryHome(async (home) => {
    const sink = new JsonlTraceSink()
    const records = Array.from({ length: 24 }, (_, index) => traceRecord(index))

    await Promise.all(records.map((record) => sink.append(record)))
    await sink.flush()

    const path = join(home, 'traces', '2026-07-20', 'trace-1.jsonl')
    const source = await readFile(path, 'utf8')
    const lines = source.trimEnd().split('\n')
    assert.equal(lines.length, records.length)
    assert.deepEqual(
      lines.map((line) => JSON.parse(line)),
      records,
    )
    assert.equal(
      lines.every((line) => !line.includes('\n')),
      true,
    )
  })
})

test('JSONL trace storage rejects oversized attributes before opening a trace file', async () => {
  await withTemporaryHome(async (_home) => {
    const sink = new JsonlTraceSink()
    const record = {
      schemaVersion: 1,
      kind: 'provider.completed',
      timestamp,
      context: { traceId: 'trace-1', runtimeId: 'rt-1' },
      attributes: { providerId: 'x'.repeat(MAX_TRACE_LINE_BYTES) },
    } as TraceRecord

    await assert.rejects(() => sink.append(record), /safe identifier.*128/i)
    await sink.append(traceRecord(1))
    await sink.flush()

    assert.deepEqual(await sink.load('trace-1'), [traceRecord(1)])
  })
})

test('JSONL trace storage ignores and repairs a truncated final line', async () => {
  await withTemporaryHome(async (home) => {
    const sink = new JsonlTraceSink()
    const first = traceRecord(1)
    const second = traceRecord(2)
    const path = join(home, 'traces', '2026-07-20', 'trace-1.jsonl')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${JSON.stringify(first)}\n{"schemaVersion":1,"kind":"run.`, 'utf8')

    assert.deepEqual(await sink.load('trace-1'), [first])

    await sink.append(second)
    await sink.flush()

    const lines = (await readFile(path, 'utf8')).trimEnd().split('\n')
    assert.deepEqual(
      lines.map((line) => JSON.parse(line)),
      [first, second],
    )
    assert.deepEqual(await sink.load('trace-1'), [first, second])
  })
})

test('JSONL trace storage rejects unsafe trace IDs before resolving storage paths', async () => {
  await withTemporaryHome(async (_home) => {
    const sink = new JsonlTraceSink()
    const unsafe = {
      schemaVersion: 1,
      kind: 'run.started',
      timestamp,
      context: { traceId: '../escape', runtimeId: 'rt-1' },
    } as TraceRecord

    await assert.rejects(() => sink.append(unsafe), /safe identifier/i)
    await assert.rejects(() => sink.load('../escape'), /trace ID/i)
  })
})

test('JSONL trace storage refuses a trace file symlink outside PRAXIS_HOME', async (context) => {
  await withTemporaryHome(async (home) => {
    const sink = new JsonlTraceSink()
    const outside = join(dirname(home), `${basename(home)}-outside.jsonl`)
    const path = join(home, 'traces', '2026-07-20', 'trace-1.jsonl')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(outside, 'outside-data', 'utf8')
    try {
      await symlink(outside, path, 'file')
    } catch (error) {
      if (isPermissionDenied(error)) {
        context.skip('Creating symbolic links is not permitted on this platform.')
        await rm(outside, { force: true })
        return
      }
      throw error
    }

    try {
      await assert.rejects(() => sink.append(traceRecord(1)), /symbolic link/i)
      assert.equal(await readFile(outside, 'utf8'), 'outside-data')
    } finally {
      await rm(outside, { force: true })
    }
  })
})

test('JSONL trace storage refuses a junctioned date directory outside PRAXIS_HOME', async () => {
  await withTemporaryHome(async (home) => {
    const sink = new JsonlTraceSink()
    const outside = join(dirname(home), `${basename(home)}-outside`)
    const dateDirectory = join(home, 'traces', '2026-07-20')
    await mkdir(join(home, 'traces'), { recursive: true })
    await mkdir(outside, { recursive: true })
    await symlink(outside, dateDirectory, 'junction')

    try {
      await assert.rejects(() => sink.append(traceRecord(1)), /symbolic link/i)
      await assert.rejects(() => readFile(join(outside, 'trace-1.jsonl'), 'utf8'), /ENOENT/)
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })
})

test('JSONL trace storage refuses to load through a junctioned trace directory', async () => {
  await withTemporaryHome(async (home) => {
    const sink = new JsonlTraceSink()
    const outside = join(dirname(home), `${basename(home)}-outside`)
    const outsidePath = join(outside, '2026-07-20', 'trace-1.jsonl')
    await mkdir(dirname(outsidePath), { recursive: true })
    await writeFile(outsidePath, `${JSON.stringify(traceRecord(1))}\n`, 'utf8')
    await symlink(outside, join(home, 'traces'), 'junction')

    try {
      await assert.rejects(() => sink.load('trace-1'), /symbolic link/i)
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })
})

test('opened-file identity validation detects a parent replaced before use', async () => {
  await withTemporaryHome(async (home) => {
    const identityApi = traceStorage as unknown as {
      captureDirectoryIdentity(path: string): Promise<unknown>
      validateOpenFileIdentity(
        handle: Awaited<ReturnType<typeof open>>,
        path: string,
        parent: unknown,
      ): Promise<void>
    }
    assert.equal(typeof identityApi.captureDirectoryIdentity, 'function')
    assert.equal(typeof identityApi.validateOpenFileIdentity, 'function')

    const parentPath = join(home, 'verified-parent')
    const outside = join(home, 'outside-parent')
    const leafPath = join(parentPath, 'trace-1.jsonl')
    await mkdir(parentPath)
    const parentIdentity = await identityApi.captureDirectoryIdentity(parentPath)
    await rm(parentPath, { recursive: true })
    await mkdir(outside)
    await writeFile(join(outside, 'trace-1.jsonl'), 'outside-data', 'utf8')
    await symlink(outside, parentPath, 'junction')
    const handle = await open(leafPath, 'r+')

    try {
      await assert.rejects(
        () => identityApi.validateOpenFileIdentity(handle, leafPath, parentIdentity),
        /directory identity changed/i,
      )
      assert.equal(await readFile(join(outside, 'trace-1.jsonl'), 'utf8'), 'outside-data')
    } finally {
      await handle.close()
    }
  })
})

test('JSONL trace storage reports queued write failures through flush and then recovers', async () => {
  await withTemporaryHome(async (home) => {
    const sink = new JsonlTraceSink()
    const traceDirectory = join(home, 'traces')
    await writeFile(traceDirectory, 'not-a-directory', 'utf8')

    await assert.rejects(() => sink.append(traceRecord(1)))
    await assert.rejects(() => sink.flush())

    await rm(traceDirectory)
    await sink.append(traceRecord(2))
    await sink.flush()
    assert.deepEqual(await sink.load('trace-1'), [traceRecord(2)])
  })
})

test('JSONL trace storage rejects a record filed under a different trace ID', async () => {
  await withTemporaryHome(async (home) => {
    const sink = new JsonlTraceSink()
    const path = join(home, 'traces', '2026-07-20', 'trace-1.jsonl')
    const mismatched = createTraceRecord({
      kind: 'run.started',
      timestamp,
      context: { traceId: 'trace-2', runtimeId: 'rt-1' },
    })
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${JSON.stringify(mismatched)}\n`, 'utf8')

    await assert.rejects(() => sink.load('trace-1'), /different trace ID/i)
  })
})

test('JSONL trace storage rejects an oversized complete line during load', async () => {
  await withTemporaryHome(async (home) => {
    const sink = new JsonlTraceSink()
    const path = join(home, 'traces', '2026-07-20', 'trace-1.jsonl')
    const oversized = {
      schemaVersion: 1,
      kind: 'provider.completed',
      timestamp,
      context: { traceId: 'trace-1', runtimeId: 'rt-1' },
      attributes: { providerId: 'x'.repeat(MAX_TRACE_LINE_BYTES) },
    } as TraceRecord
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${JSON.stringify(oversized)}\n`, 'utf8')

    await assert.rejects(() => sink.load('trace-1'), /exceeds 16 KiB/)
  })
})

function traceRecord(index: number): TraceRecord {
  return createTraceRecord({
    kind: 'run.completed',
    timestamp,
    context: { traceId: 'trace-1', runtimeId: 'rt-1', runId: `run-${index}` },
    metrics: { durationMs: index },
  })
}

async function withTemporaryHome(action: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'praxis-trace-storage-'))
  const previousHome = process.env.PRAXIS_HOME
  process.env.PRAXIS_HOME = home
  try {
    await action(home)
  } finally {
    if (previousHome === undefined) delete process.env.PRAXIS_HOME
    else process.env.PRAXIS_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
}

function isPermissionDenied(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error.code === 'EPERM' || error.code === 'EACCES')
  )
}
