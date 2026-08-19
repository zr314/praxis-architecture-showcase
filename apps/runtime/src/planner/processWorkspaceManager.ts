import { createHash } from 'node:crypto'
import { copyFile, lstat, mkdir, realpath, rm, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { runtimeError } from '@praxis/core-sdk'
import type { GitCommandPortV1 } from './workspaceIsolationManager.js'

const MAX_FILES = 20_000
const MAX_FILE_BYTES = 32 * 1024 * 1024
const MAX_TOTAL_BYTES = 256 * 1024 * 1024
const MAX_PATH_LIST_BYTES = 4 * 1024 * 1024
const SAFE_SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/
const SECRET_BASENAME = /^(?:\.env(?:\..+)?|\.npmrc|\.pypirc|credentials(?:\..+)?|id_[^.]+)$/iu
const SECRET_EXTENSION = /\.(?:key|pem|p12|pfx|jks|keystore)$/iu

export type ProcessWorkspaceSnapshotV1 = Readonly<{
  schemaVersion: 1
  managerId: string
  slug: string
  sourceRoot: string
  targetPath: string
  fileCount: number
  totalBytes: number
  digest: `sha256:${string}`
}>

export class ProcessWorkspaceManagerV1 {
  readonly #ownedRoot: string
  readonly #managerId: string
  readonly #created = new Map<string, ProcessWorkspaceSnapshotV1>()

  constructor(
    options: Readonly<{
      ownedRoot: string
      managerId: string
      git: GitCommandPortV1
    }>,
  ) {
    if (
      !isAbsolute(options.ownedRoot) ||
      !SAFE_SLUG.test(options.managerId) ||
      typeof options.git?.run !== 'function'
    ) {
      fail('PROCESS_WORKSPACE_MANAGER_INVALID')
    }
    this.#ownedRoot = resolve(options.ownedRoot)
    this.#managerId = options.managerId
    this.git = options.git
  }

  private readonly git: GitCommandPortV1

  async create(input: {
    sourceRoot: string
    slug: string
    targetPath: string
    signal?: AbortSignal
  }): Promise<ProcessWorkspaceSnapshotV1> {
    if (!SAFE_SLUG.test(input.slug) || input.signal?.aborted) {
      fail('PROCESS_WORKSPACE_CREATE_CANCELLED')
    }
    const sourceRoot = await canonicalDirectory(
      input.sourceRoot,
      'PROCESS_WORKSPACE_SOURCE_INVALID',
    )
    await mkdir(this.#ownedRoot, { recursive: true })
    const ownedRoot = await canonicalDirectory(this.#ownedRoot, 'PROCESS_WORKSPACE_ROOT_INVALID')
    if (pathsOverlap(sourceRoot, ownedRoot)) fail('PROCESS_WORKSPACE_ROOTS_OVERLAP')
    const targetPath = resolve(input.targetPath)
    if (
      targetPath !== join(ownedRoot, input.slug) ||
      relative(ownedRoot, targetPath).startsWith(`..${sep}`) ||
      this.#created.has(targetPath) ||
      (await lstat(targetPath).catch(() => undefined)) !== undefined
    ) {
      fail('PROCESS_WORKSPACE_TARGET_INVALID')
    }

    const listed = await this.git.run({
      cwd: sourceRoot,
      args: ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      signal: input.signal,
      maxOutputBytes: MAX_PATH_LIST_BYTES,
    })
    if (listed.exitCode !== 0) fail('PROCESS_WORKSPACE_REQUIRES_GIT')
    const paths = listed.stdout.split('\0').filter(Boolean)
    if (paths.length > MAX_FILES) fail('PROCESS_WORKSPACE_LIMIT_EXCEEDED')

    await mkdir(targetPath)
    let totalBytes = 0
    let fileCount = 0
    try {
      for (const path of paths) {
        if (input.signal?.aborted) fail('PROCESS_WORKSPACE_CREATE_CANCELLED')
        if (!portablePath(path) || secretPath(path)) continue
        const source = resolve(sourceRoot, path)
        const target = resolve(targetPath, path)
        if (!contained(sourceRoot, source) || !contained(targetPath, target)) {
          fail('PROCESS_WORKSPACE_PATH_INVALID')
        }
        const metadata = await lstat(source).catch(() => undefined)
        if (metadata === undefined || !metadata.isFile() || metadata.isSymbolicLink()) continue
        const canonical = await realpath(source)
        if (!contained(sourceRoot, canonical)) fail('PROCESS_WORKSPACE_PATH_INVALID')
        const file = await stat(canonical)
        if (file.size > MAX_FILE_BYTES || totalBytes + file.size > MAX_TOTAL_BYTES) {
          fail('PROCESS_WORKSPACE_LIMIT_EXCEEDED')
        }
        await mkdir(dirname(target), { recursive: true })
        await copyFile(canonical, target)
        totalBytes += file.size
        fileCount += 1
      }
    } catch (error) {
      await rm(targetPath, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }

    const unsigned = {
      schemaVersion: 1 as const,
      managerId: this.#managerId,
      slug: input.slug,
      sourceRoot,
      targetPath,
      fileCount,
      totalBytes,
    }
    const snapshot = Object.freeze({
      ...unsigned,
      digest:
        `sha256:${createHash('sha256').update(JSON.stringify(unsigned)).digest('hex')}` as const,
    })
    this.#created.set(targetPath, snapshot)
    return snapshot
  }

  async discard(snapshot: ProcessWorkspaceSnapshotV1): Promise<void> {
    const expected = this.#created.get(snapshot.targetPath)
    if (expected === undefined || expected.digest !== snapshot.digest || expected !== snapshot) {
      fail('PROCESS_WORKSPACE_OWNERSHIP_MISMATCH')
    }
    const ownedRoot = await canonicalDirectory(this.#ownedRoot, 'PROCESS_WORKSPACE_ROOT_INVALID')
    if (resolve(snapshot.targetPath) !== join(ownedRoot, snapshot.slug)) {
      fail('PROCESS_WORKSPACE_OWNERSHIP_MISMATCH')
    }
    const target = await lstat(snapshot.targetPath).catch(() => undefined)
    if (target === undefined || !target.isDirectory() || target.isSymbolicLink()) {
      fail('PROCESS_WORKSPACE_OWNERSHIP_MISMATCH')
    }
    await rm(snapshot.targetPath, { recursive: true, force: false })
    this.#created.delete(snapshot.targetPath)
  }
}

function portablePath(value: string): boolean {
  return (
    value.length > 0 &&
    !isAbsolute(value) &&
    !value.includes('\0') &&
    !value.split(/[\\/]/u).some((segment) => segment === '' || segment === '.' || segment === '..')
  )
}

function secretPath(value: string): boolean {
  const name = basename(value)
  return SECRET_BASENAME.test(name) || SECRET_EXTENSION.test(name)
}

function contained(root: string, candidate: string): boolean {
  const value = relative(root, candidate)
  return value === '' || (!value.startsWith(`..${sep}`) && value !== '..' && !isAbsolute(value))
}

function pathsOverlap(left: string, right: string): boolean {
  return contained(left, right) || contained(right, left)
}

async function canonicalDirectory(value: string, code: string): Promise<string> {
  if (!isAbsolute(value)) fail(code)
  const absolute = resolve(value)
  const metadata = await lstat(absolute).catch(() => undefined)
  if (metadata === undefined || !metadata.isDirectory() || metadata.isSymbolicLink()) fail(code)
  const canonical = await realpath(absolute)
  if (resolve(canonical) !== absolute) fail(code)
  return canonical
}

function fail(code: string): never {
  throw Object.assign(
    new Error(code),
    runtimeError(code, 'planner', 'Disposable process workspace operation failed.'),
    { code },
  )
}
