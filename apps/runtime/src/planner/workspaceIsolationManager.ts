import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { runtimeError } from '@praxis/core-sdk'

const MARKER_DIRECTORY = '.praxis-worktrees'
const MAX_GIT_OUTPUT_BYTES = 64 * 1024
const MAX_CONFIGURED_GIT_OUTPUT_BYTES = 4 * 1024 * 1024
const DEFAULT_GIT_TIMEOUT_MS = 30_000

export type WorkspaceCopyPolicyV1 = Readonly<{
  ignored: 'exclude'
  secrets: 'exclude'
}>

export type WorkspaceIsolationV1 = Readonly<{
  schemaVersion: 1
  managerId: string
  slug: string
  repoRoot: string
  targetPath: string
  baseCommit: string
  copyPolicy: WorkspaceCopyPolicyV1
  markerDigest: `sha256:${string}`
}>

export type WorkspaceCleanupEvidenceV1 = Readonly<{
  trackedChanges: number
  untrackedFiles: number
  ignoredFiles: number
  newCommits: boolean
  headCommit?: string
}>

export type WorkspaceCleanupResultV1 = Readonly<{
  status: 'removed' | 'retained'
  code: string
  recoveryPath?: string
  evidence: WorkspaceCleanupEvidenceV1
}>

export type GitCommandResultV1 = Readonly<{
  exitCode: number
  stdout: string
  stderr: string
}>

export interface GitCommandPortV1 {
  run(input: {
    cwd: string
    args: readonly string[]
    signal?: AbortSignal
    maxOutputBytes?: number
  }): Promise<GitCommandResultV1>
}

export interface WorkspaceIsolationValidationPortV1 {
  validate(input: {
    isolation: WorkspaceIsolationV1
    signal?: AbortSignal
  }): Promise<WorkspaceIsolationV1>
  finalizeMerged(input: {
    isolation: WorkspaceIsolationV1
    mergedCommit: string
    signal?: AbortSignal
  }): Promise<WorkspaceCleanupResultV1>
}

export type WorkspaceIsolationManagerOptionsV1 = Readonly<{
  ownedRoot: string
  managerId: string
  git?: GitCommandPortV1
}>

type OwnershipMarkerV1 = Readonly<{
  schemaVersion: 1
  managerId: string
  slug: string
  repoRoot: string
  ownedRoot: string
  targetPath: string
  baseCommit: string
  copyPolicy: WorkspaceCopyPolicyV1
}>

/** Creates and removes only detached Git worktrees owned by this manager instance. */
export class WorkspaceIsolationManagerV1 {
  readonly #ownedRootInput: string
  readonly #managerId: string
  readonly #git: GitCommandPortV1
  readonly #created = new Map<string, `sha256:${string}`>()

  constructor(options: WorkspaceIsolationManagerOptionsV1) {
    if (
      typeof options !== 'object' ||
      options === null ||
      typeof options.ownedRoot !== 'string' ||
      !isAbsolute(options.ownedRoot) ||
      !isSafeIdentifier(options.managerId)
    ) {
      isolationFail('WORKTREE_MANAGER_INVALID')
    }
    this.#ownedRootInput = resolve(options.ownedRoot)
    this.#managerId = options.managerId
    this.#git = options.git ?? new GitCliCommandPortV1()
  }

  async create(input: {
    repoRoot: string
    slug: string
    targetPath: string
    baseCommit: string
    copyPolicy: WorkspaceCopyPolicyV1
    signal?: AbortSignal
  }): Promise<WorkspaceIsolationV1> {
    const ownedRoot = await this.#prepareOwnedRoot()
    const repoRoot = await validateDirectoryRoot(input.repoRoot, 'WORKTREE_REPO_ROOT_INVALID')
    if (pathsOverlap(ownedRoot, repoRoot)) isolationFail('WORKTREE_ROOTS_OVERLAP')
    if (!isSafeSlug(input.slug)) isolationFail('WORKTREE_SLUG_INVALID')
    const targetPath = validateTargetPath(input.targetPath, ownedRoot, input.slug)
    validateCopyPolicy(input.copyPolicy)
    validateCommit(input.baseCommit)
    if (input.signal?.aborted) isolationFail('WORKTREE_CREATE_CANCELLED', targetPath)

    await assertGitRepoRoot(this.#git, repoRoot, input.signal)
    const baseCommit = await resolveCommit(this.#git, repoRoot, input.baseCommit, input.signal)
    if (baseCommit !== input.baseCommit) isolationFail('WORKTREE_BASE_COMMIT_INVALID')
    if ((await lstat(targetPath).catch(() => undefined)) !== undefined) {
      isolationFail('WORKTREE_TARGET_EXISTS')
    }

    const markerPath = markerPathFor(ownedRoot, input.slug)
    if ((await lstat(markerPath).catch(() => undefined)) !== undefined) {
      isolationFail('WORKTREE_MARKER_EXISTS')
    }
    const add = await this.#git.run({
      cwd: repoRoot,
      args: [
        '-c',
        'core.hooksPath=/dev/null',
        'worktree',
        'add',
        '--detach',
        targetPath,
        baseCommit,
      ],
      signal: input.signal,
    })
    if (add.exitCode !== 0) isolationFail('WORKTREE_CREATE_FAILED', targetPath)

    const marker: OwnershipMarkerV1 = Object.freeze({
      schemaVersion: 1,
      managerId: this.#managerId,
      slug: input.slug,
      repoRoot,
      ownedRoot,
      targetPath,
      baseCommit,
      copyPolicy: Object.freeze({ ...input.copyPolicy }),
    })
    const markerText = canonicalMarker(marker)
    const markerDigest = digest(markerText)
    try {
      await writeFile(markerPath, markerText, { encoding: 'utf8', flag: 'wx' })
      this.#created.set(targetPath, markerDigest)
      await validateManagedWorktree(this.#git, targetPath, input.signal)
    } catch (error) {
      isolationFail('WORKTREE_CREATE_INCOMPLETE', targetPath, error)
    }
    return freezeIsolation(marker, markerDigest)
  }

  async cleanup(input: {
    isolation: WorkspaceIsolationV1
    signal?: AbortSignal
  }): Promise<WorkspaceCleanupResultV1> {
    const validated = await this.#validateOwnedIsolation(input)
    const { isolation, ownedRoot, repoRoot } = validated
    const inspection = await inspectWorktree(this.#git, isolation, input.signal)
    if (inspection === undefined) {
      return retained('WORKTREE_INSPECTION_FAILED', isolation.targetPath, emptyCleanupEvidence())
    }
    if (
      inspection.trackedChanges > 0 ||
      inspection.untrackedFiles > 0 ||
      inspection.ignoredFiles > 0 ||
      inspection.newCommits
    ) {
      return retained('WORKTREE_RECOVERY_REQUIRED', isolation.targetPath, inspection)
    }
    return this.#removeValidated(
      { isolation, ownedRoot, repoRoot, evidence: inspection },
      input.signal,
    )
  }

  async validate(input: {
    isolation: WorkspaceIsolationV1
    signal?: AbortSignal
  }): Promise<WorkspaceIsolationV1> {
    return (await this.#validateOwnedIsolation(input)).isolation
  }

  async finalizeMerged(input: {
    isolation: WorkspaceIsolationV1
    mergedCommit: string
    signal?: AbortSignal
  }): Promise<WorkspaceCleanupResultV1> {
    validateCommit(input.mergedCommit)
    const validated = await this.#validateOwnedIsolation(input)
    const { isolation, ownedRoot, repoRoot } = validated
    const inspection = await inspectWorktree(this.#git, isolation, input.signal)
    if (
      inspection === undefined ||
      inspection.headCommit !== input.mergedCommit ||
      inspection.trackedChanges > 0 ||
      inspection.untrackedFiles > 0 ||
      inspection.ignoredFiles > 0
    ) {
      return retained(
        'WORKTREE_POST_MERGE_RECOVERY_REQUIRED',
        isolation.targetPath,
        inspection ?? emptyCleanupEvidence(),
      )
    }
    const mainHead = await this.#git.run({
      cwd: repoRoot,
      args: ['rev-parse', 'HEAD'],
      signal: input.signal,
    })
    if (normalizedCommit(mainHead.stdout) !== input.mergedCommit) {
      return retained('WORKTREE_POST_MERGE_RECOVERY_REQUIRED', isolation.targetPath, inspection)
    }
    return this.#removeValidated(
      { isolation, ownedRoot, repoRoot, evidence: inspection },
      input.signal,
    )
  }

  async #validateOwnedIsolation(input: {
    isolation: WorkspaceIsolationV1
    signal?: AbortSignal
  }): Promise<{
    isolation: WorkspaceIsolationV1
    ownedRoot: string
    repoRoot: string
  }> {
    const ownedRoot = await this.#prepareOwnedRoot()
    const isolation = validateIsolation(input.isolation, ownedRoot, this.#managerId)
    const expectedDigest = this.#created.get(isolation.targetPath)
    if (expectedDigest === undefined || expectedDigest !== isolation.markerDigest) {
      isolationFail('WORKTREE_NOT_MANAGER_CREATED', isolation.targetPath)
    }
    if (input.signal?.aborted) isolationFail('WORKTREE_OPERATION_CANCELLED', isolation.targetPath)
    await validateManagedTarget(isolation.targetPath, ownedRoot, isolation.slug)

    const markerPath = markerPathFor(ownedRoot, isolation.slug)
    const markerText = await readBoundedMarker(markerPath)
    if (digest(markerText) !== isolation.markerDigest) {
      isolationFail('WORKTREE_OWNERSHIP_MISMATCH', isolation.targetPath)
    }
    const marker = parseMarker(markerText)
    if (!markerMatchesIsolation(marker, isolation, ownedRoot)) {
      isolationFail('WORKTREE_OWNERSHIP_MISMATCH', isolation.targetPath)
    }
    const repoRoot = await validateDirectoryRoot(isolation.repoRoot, 'WORKTREE_REPO_ROOT_INVALID')
    await assertGitRepoRoot(this.#git, repoRoot, input.signal)
    await validateManagedWorktree(this.#git, isolation.targetPath, input.signal)
    return { isolation, ownedRoot, repoRoot }
  }

  async #removeValidated(
    input: {
      isolation: WorkspaceIsolationV1
      ownedRoot: string
      repoRoot: string
      evidence: WorkspaceCleanupEvidenceV1
    },
    signal?: AbortSignal,
  ): Promise<WorkspaceCleanupResultV1> {
    const { isolation, ownedRoot, repoRoot, evidence } = input
    const markerPath = markerPathFor(ownedRoot, isolation.slug)
    const remove = await this.#git.run({
      cwd: repoRoot,
      args: ['-c', 'core.hooksPath=/dev/null', 'worktree', 'remove', isolation.targetPath],
      signal,
    })
    if (remove.exitCode !== 0) {
      return retained('WORKTREE_CLEANUP_FAILED', isolation.targetPath, evidence)
    }
    const targetAfter = await lstat(isolation.targetPath).catch(() => undefined)
    if (targetAfter !== undefined) {
      return retained('WORKTREE_CLEANUP_FAILED', isolation.targetPath, evidence)
    }
    const markerRemoved = await unlink(markerPath)
      .then(() => true)
      .catch(() => false)
    this.#created.delete(isolation.targetPath)
    return Object.freeze({
      status: 'removed',
      code: markerRemoved ? 'WORKTREE_REMOVED' : 'WORKTREE_REMOVED_MARKER_RETAINED',
      evidence,
    })
  }

  async #prepareOwnedRoot(): Promise<string> {
    await mkdir(this.#ownedRootInput, { recursive: true })
    const ownedRoot = await validateDirectoryRoot(
      this.#ownedRootInput,
      'WORKTREE_OWNED_ROOT_INVALID',
    )
    const markerDirectory = join(ownedRoot, MARKER_DIRECTORY)
    await mkdir(markerDirectory, { recursive: true })
    await validateDirectoryRoot(markerDirectory, 'WORKTREE_MARKER_ROOT_INVALID')
    return ownedRoot
  }
}

/** Shell-free bounded adapter for the local Git executable. */
export class GitCliCommandPortV1 implements GitCommandPortV1 {
  constructor(private readonly timeoutMs = DEFAULT_GIT_TIMEOUT_MS) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
      isolationFail('GIT_COMMAND_PORT_INVALID')
    }
  }

  async run(input: {
    cwd: string
    args: readonly string[]
    signal?: AbortSignal
    maxOutputBytes?: number
  }): Promise<GitCommandResultV1> {
    if (
      typeof input.cwd !== 'string' ||
      !isAbsolute(input.cwd) ||
      !Array.isArray(input.args) ||
      !input.args.every((argument) => typeof argument === 'string' && argument.length <= 4_096) ||
      (input.maxOutputBytes !== undefined &&
        (!Number.isSafeInteger(input.maxOutputBytes) ||
          input.maxOutputBytes < 1 ||
          input.maxOutputBytes > MAX_CONFIGURED_GIT_OUTPUT_BYTES))
    ) {
      isolationFail('GIT_COMMAND_INVALID')
    }
    if (input.signal?.aborted) {
      return Object.freeze({ exitCode: 130, stdout: '', stderr: '' })
    }
    const maximumOutputBytes = input.maxOutputBytes ?? MAX_GIT_OUTPUT_BYTES
    return new Promise((resolveResult) => {
      const child = spawn('git', [...input.args], {
        cwd: input.cwd,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      let stdoutBytes = 0
      let stderrBytes = 0
      let exceeded = false
      let settled = false
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      const append = (current: string, currentBytes: number, chunk: string): string => {
        if (currentBytes + Buffer.byteLength(chunk) > maximumOutputBytes) {
          exceeded = true
          child.kill()
          return current
        }
        return current + chunk
      }
      child.stdout.on('data', (chunk: string) => {
        stdout = append(stdout, stdoutBytes, chunk)
        stdoutBytes = Buffer.byteLength(stdout)
      })
      child.stderr.on('data', (chunk: string) => {
        stderr = append(stderr, stderrBytes, chunk)
        stderrBytes = Buffer.byteLength(stderr)
      })
      const finish = (exitCode: number): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        input.signal?.removeEventListener('abort', abort)
        resolveResult(
          Object.freeze({
            exitCode: exceeded ? 74 : exitCode,
            stdout,
            stderr,
          }),
        )
      }
      const abort = (): void => {
        child.kill()
        finish(130)
      }
      const timer = setTimeout(() => {
        child.kill()
        finish(124)
      }, this.timeoutMs)
      input.signal?.addEventListener('abort', abort, { once: true })
      child.once('error', () => finish(127))
      child.once('close', (code) => finish(code ?? 1))
    })
  }
}

async function validateDirectoryRoot(input: string, code: string): Promise<string> {
  if (typeof input !== 'string' || !isAbsolute(input)) isolationFail(code)
  const absolute = resolve(input)
  const metadata = await lstat(absolute).catch(() => undefined)
  if (metadata === undefined || !metadata.isDirectory() || metadata.isSymbolicLink()) {
    isolationFail(code)
  }
  const canonical = await realpath(absolute)
  if (resolve(canonical) !== absolute) isolationFail(code)
  return canonical
}

async function assertGitRepoRoot(
  git: GitCommandPortV1,
  repoRoot: string,
  signal?: AbortSignal,
): Promise<void> {
  const result = await git.run({ cwd: repoRoot, args: ['rev-parse', '--show-toplevel'], signal })
  if (result.exitCode !== 0) isolationFail('WORKTREE_REPO_ROOT_INVALID')
  const reported = result.stdout.trim()
  if (!isAbsolute(reported)) isolationFail('WORKTREE_REPO_ROOT_INVALID')
  const canonical = await realpath(resolve(reported)).catch(() => undefined)
  if (canonical === undefined || resolve(canonical) !== repoRoot) {
    isolationFail('WORKTREE_REPO_ROOT_INVALID')
  }
}

async function resolveCommit(
  git: GitCommandPortV1,
  repoRoot: string,
  commit: string,
  signal?: AbortSignal,
): Promise<string> {
  const result = await git.run({
    cwd: repoRoot,
    args: ['rev-parse', '--verify', `${commit}^{commit}`],
    signal,
  })
  if (result.exitCode !== 0) isolationFail('WORKTREE_BASE_COMMIT_INVALID')
  const resolvedCommit = normalizedCommit(result.stdout)
  if (resolvedCommit === undefined) isolationFail('WORKTREE_BASE_COMMIT_INVALID')
  return resolvedCommit
}

async function validateManagedWorktree(
  git: GitCommandPortV1,
  targetPath: string,
  signal?: AbortSignal,
): Promise<void> {
  const result = await git.run({
    cwd: targetPath,
    args: ['rev-parse', '--show-toplevel'],
    signal,
  })
  if (result.exitCode !== 0 || !isAbsolute(result.stdout.trim())) {
    isolationFail('WORKTREE_TARGET_INVALID', targetPath)
  }
  const reported = await realpath(resolve(result.stdout.trim())).catch(() => undefined)
  if (reported === undefined || resolve(reported) !== targetPath) {
    isolationFail('WORKTREE_TARGET_INVALID', targetPath)
  }
}

async function validateManagedTarget(
  targetPath: string,
  ownedRoot: string,
  slug: string,
): Promise<void> {
  if (validateTargetPath(targetPath, ownedRoot, slug) !== targetPath) {
    isolationFail('WORKTREE_TARGET_INVALID', targetPath)
  }
  const canonical = await validateDirectoryRoot(targetPath, 'WORKTREE_TARGET_INVALID')
  if (canonical !== targetPath) isolationFail('WORKTREE_TARGET_INVALID', targetPath)
}

function validateTargetPath(input: string, ownedRoot: string, slug: string): string {
  if (typeof input !== 'string' || !isAbsolute(input)) isolationFail('WORKTREE_TARGET_INVALID')
  const targetPath = resolve(input)
  if (targetPath !== join(ownedRoot, slug) || relative(ownedRoot, targetPath).startsWith('..')) {
    isolationFail('WORKTREE_TARGET_INVALID')
  }
  return targetPath
}

function validateCopyPolicy(input: WorkspaceCopyPolicyV1): void {
  if (
    typeof input !== 'object' ||
    input === null ||
    Object.keys(input).length !== 2 ||
    input.ignored !== 'exclude' ||
    input.secrets !== 'exclude'
  ) {
    isolationFail('WORKTREE_COPY_POLICY_INVALID')
  }
}

function validateCommit(input: string): void {
  if (typeof input !== 'string' || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(input)) {
    isolationFail('WORKTREE_BASE_COMMIT_INVALID')
  }
}

function validateIsolation(
  input: WorkspaceIsolationV1,
  ownedRoot: string,
  managerId: string,
): WorkspaceIsolationV1 {
  if (
    typeof input !== 'object' ||
    input === null ||
    Object.keys(input).length !== 8 ||
    input.schemaVersion !== 1 ||
    input.managerId !== managerId ||
    !isSafeSlug(input.slug) ||
    !isAbsolute(input.repoRoot) ||
    !isAbsolute(input.targetPath) ||
    resolve(input.targetPath) !== join(ownedRoot, input.slug) ||
    !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(input.baseCommit) ||
    !/^sha256:[a-f0-9]{64}$/.test(input.markerDigest)
  ) {
    isolationFail('WORKTREE_ISOLATION_INVALID')
  }
  validateCopyPolicy(input.copyPolicy)
  return input
}

function parseMarker(input: string): OwnershipMarkerV1 {
  let value: unknown
  try {
    value = JSON.parse(input)
  } catch {
    isolationFail('WORKTREE_OWNERSHIP_MISMATCH')
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    Object.keys(value).length !== 8 ||
    Reflect.get(value, 'schemaVersion') !== 1 ||
    !isSafeIdentifier(Reflect.get(value, 'managerId')) ||
    !isSafeSlug(Reflect.get(value, 'slug')) ||
    typeof Reflect.get(value, 'repoRoot') !== 'string' ||
    typeof Reflect.get(value, 'ownedRoot') !== 'string' ||
    typeof Reflect.get(value, 'targetPath') !== 'string' ||
    typeof Reflect.get(value, 'baseCommit') !== 'string'
  ) {
    isolationFail('WORKTREE_OWNERSHIP_MISMATCH')
  }
  validateCopyPolicy(Reflect.get(value, 'copyPolicy') as WorkspaceCopyPolicyV1)
  return value as OwnershipMarkerV1
}

function markerMatchesIsolation(
  marker: OwnershipMarkerV1,
  isolation: WorkspaceIsolationV1,
  ownedRoot: string,
): boolean {
  return (
    marker.managerId === isolation.managerId &&
    marker.slug === isolation.slug &&
    marker.repoRoot === isolation.repoRoot &&
    marker.ownedRoot === ownedRoot &&
    marker.targetPath === isolation.targetPath &&
    marker.baseCommit === isolation.baseCommit &&
    marker.copyPolicy.ignored === isolation.copyPolicy.ignored &&
    marker.copyPolicy.secrets === isolation.copyPolicy.secrets
  )
}

function freezeIsolation(
  marker: OwnershipMarkerV1,
  markerDigest: `sha256:${string}`,
): WorkspaceIsolationV1 {
  return Object.freeze({
    schemaVersion: 1,
    managerId: marker.managerId,
    slug: marker.slug,
    repoRoot: marker.repoRoot,
    targetPath: marker.targetPath,
    baseCommit: marker.baseCommit,
    copyPolicy: Object.freeze({ ...marker.copyPolicy }),
    markerDigest,
  })
}

function canonicalMarker(marker: OwnershipMarkerV1): string {
  return `${JSON.stringify(marker)}\n`
}

function markerPathFor(ownedRoot: string, slug: string): string {
  return join(ownedRoot, MARKER_DIRECTORY, `${slug}.json`)
}

async function readBoundedMarker(path: string): Promise<string> {
  const metadata = await lstat(path).catch(() => undefined)
  if (
    metadata === undefined ||
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size > 8_192
  ) {
    isolationFail('WORKTREE_OWNERSHIP_MISMATCH')
  }
  return readFile(path, 'utf8')
}

function parsePorcelain(
  input: string,
): Omit<WorkspaceCleanupEvidenceV1, 'newCommits' | 'headCommit'> {
  let trackedChanges = 0
  let untrackedFiles = 0
  let ignoredFiles = 0
  for (const record of input.split('\0').filter((value) => value.length > 0)) {
    const status = record.slice(0, 2)
    if (status === '??') untrackedFiles += 1
    else if (status === '!!') ignoredFiles += 1
    else trackedChanges += 1
  }
  return Object.freeze({ trackedChanges, untrackedFiles, ignoredFiles })
}

async function inspectWorktree(
  git: GitCommandPortV1,
  isolation: WorkspaceIsolationV1,
  signal?: AbortSignal,
): Promise<WorkspaceCleanupEvidenceV1 | undefined> {
  const [status, head] = await Promise.all([
    git.run({
      cwd: isolation.targetPath,
      args: ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching'],
      signal,
    }),
    git.run({ cwd: isolation.targetPath, args: ['rev-parse', 'HEAD'], signal }),
  ])
  if (status.exitCode !== 0 || head.exitCode !== 0) return undefined
  const headCommit = normalizedCommit(head.stdout)
  if (headCommit === undefined) return undefined
  return Object.freeze({
    ...parsePorcelain(status.stdout),
    newCommits: headCommit !== isolation.baseCommit,
    headCommit,
  })
}

function retained(
  code: string,
  recoveryPath: string,
  evidence: WorkspaceCleanupEvidenceV1,
): WorkspaceCleanupResultV1 {
  return Object.freeze({ status: 'retained', code, recoveryPath, evidence })
}

function emptyCleanupEvidence(): WorkspaceCleanupEvidenceV1 {
  return Object.freeze({
    trackedChanges: 0,
    untrackedFiles: 0,
    ignoredFiles: 0,
    newCommits: false,
  })
}

function normalizedCommit(input: string): string | undefined {
  const value = input.trim()
  return /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value) ? value : undefined
}

function isSafeSlug(input: unknown): input is string {
  return (
    typeof input === 'string' &&
    /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/.test(input) &&
    !input.includes('--')
  )
}

function isSafeIdentifier(input: unknown): input is string {
  return typeof input === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(input)
}

function pathsOverlap(left: string, right: string): boolean {
  const leftToRight = relative(left, right)
  const rightToLeft = relative(right, left)
  return isWithin(leftToRight) || isWithin(rightToLeft)
}

function isWithin(value: string): boolean {
  return value === '' || (!value.startsWith(`..${sep}`) && value !== '..' && !isAbsolute(value))
}

function digest(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function isolationFail(code: string, recoveryPath?: string, cause?: unknown): never {
  throw Object.assign(
    new Error(code, cause === undefined ? undefined : { cause }),
    runtimeError(code, 'planner', code),
    {
      code,
      ...(recoveryPath === undefined ? {} : { recoveryPath }),
    },
  )
}
