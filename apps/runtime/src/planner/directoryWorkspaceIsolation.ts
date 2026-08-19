import { createHash, randomUUID } from 'node:crypto'
import { copyFile, lstat, mkdir, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { SessionStepProjectionV3, SubagentResultV1 } from '@praxis/core-sdk'
import { isPlanPathWithinGrantV1, isPortablePlanPathV1 } from './planValidator.js'
import type { GitCommandPortV1 } from './workspaceIsolationManager.js'
import {
  type WorkspaceSnapshotV1,
  WorkspaceWriteGuardV1,
  type WorkspaceWriteEvidenceV1,
} from './workspaceWriteGuard.js'
import type { SupervisorVerifierV1, VerificationDecisionV1 } from './verifier.js'

const MAX_FILES = 65_536
const MAX_BYTES = 1024 * 1024 * 1024

export type DirectoryWorkspaceIsolationV1 = Readonly<{
  schemaVersion: 1
  kind: 'directory_snapshot'
  workspaceRoot: string
  targetPath: string
  baseCommit: string
  baseline: WorkspaceSnapshotV1
}>

export type DirectoryWorkspaceMergeResultV1 = Readonly<{
  status: 'succeeded' | 'blocked' | 'cancelled'
  code: string
  evidence: WorkspaceWriteEvidenceV1
  verifications: readonly VerificationDecisionV1[]
  candidateCommit?: string
  patchDigest?: `sha256:${string}`
  patchBytes?: number
  cleanup?: Readonly<{ status: 'removed'; code: 'WORKSPACE_SNAPSHOT_REMOVED' }>
  recovery?: Readonly<{
    mainWorkspace: string
    snapshotPath: string
    instructions: readonly string[]
  }>
}>

type DirectoryWorkspaceIsolationOptionsV1 = Readonly<{
  ownedRoot: string
  git: GitCommandPortV1
  mechanicalVerifier: SupervisorVerifierV1
  ruleVerifier: SupervisorVerifierV1
}>

type CandidateChangeV1 = Readonly<{
  path: string
  change: 'created' | 'modified' | 'deleted'
  digest?: `sha256:${string}`
}>

/** Isolates non-Git workspaces in a private snapshot repository before guarded copy-back. */
export class DirectoryWorkspaceIsolationManagerV1 {
  readonly #ownedRoot: string
  readonly #git: GitCommandPortV1
  readonly #guard: WorkspaceWriteGuardV1
  readonly #owned = new Set<string>()

  constructor(options: DirectoryWorkspaceIsolationOptionsV1) {
    if (!options || !isAbsolute(options.ownedRoot))
      directoryFail('WORKSPACE_SNAPSHOT_OPTIONS_INVALID')
    this.#ownedRoot = resolve(options.ownedRoot)
    this.#git = options.git
    this.#guard = new WorkspaceWriteGuardV1({
      mechanicalVerifier: options.mechanicalVerifier,
      ruleVerifier: options.ruleVerifier,
      maxFiles: MAX_FILES,
      maxBytes: MAX_BYTES,
    })
  }

  async create(input: {
    workspaceRoot: string
    slug: string
    step: SessionStepProjectionV3
    signal?: AbortSignal
  }): Promise<DirectoryWorkspaceIsolationV1> {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(input.slug)) {
      directoryFail('WORKSPACE_SNAPSHOT_SLUG_INVALID')
    }
    const workspaceRoot = await realpath(input.workspaceRoot)
    const targetPath = resolve(this.#ownedRoot, input.slug)
    if (!isDirectChild(this.#ownedRoot, targetPath) || targetPath === workspaceRoot) {
      directoryFail('WORKSPACE_SNAPSHOT_TARGET_INVALID')
    }
    if ((await lstat(targetPath).catch(() => undefined)) !== undefined) {
      directoryFail('WORKSPACE_SNAPSHOT_TARGET_EXISTS')
    }

    await mkdir(targetPath, { recursive: true })
    this.#owned.add(targetPath)
    try {
      const baseline = await this.#guard.capture({ workspaceRoot, step: input.step })
      await copyBaseline(workspaceRoot, targetPath, baseline, input.signal)
      const stable = await this.#guard.capture({ workspaceRoot, step: input.step })
      if (stable.digest !== baseline.digest) directoryFail('WORKSPACE_BASELINE_CHANGED')
      const baseCommit = await initializeSnapshotRepository(this.#git, targetPath, input.signal)
      return Object.freeze({
        schemaVersion: 1,
        kind: 'directory_snapshot',
        workspaceRoot,
        targetPath,
        baseCommit,
        baseline,
      })
    } catch (error) {
      await this.#removeOwned(targetPath)
      throw error
    }
  }

  async merge(input: {
    isolation: DirectoryWorkspaceIsolationV1
    step: SessionStepProjectionV3
    result: SubagentResultV1
    signal?: AbortSignal
  }): Promise<DirectoryWorkspaceMergeResultV1> {
    this.#validate(input.isolation)
    const candidate = await prepareCandidate(this.#git, input.isolation, input.signal)
    const empty = emptyEvidence(input.isolation.baseline)
    const recovery = recoveryFor(input.isolation)
    if (candidate.changes.some((change) => prohibitedSnapshotPath(change.path))) {
      return outcome('blocked', 'WORKSPACE_SNAPSHOT_PROTECTED_PATH', empty, [], candidate, recovery)
    }
    if (
      candidate.changes.some(
        (change) =>
          !input.step.access.paths.some((grant) => isPlanPathWithinGrantV1(change.path, grant)),
      )
    ) {
      return outcome(
        'blocked',
        'WORKSPACE_SNAPSHOT_SCOPE_VIOLATION',
        empty,
        [],
        candidate,
        recovery,
      )
    }
    if (!changesMatch(candidate.changes, input.result.changedFiles)) {
      return outcome(
        'blocked',
        'WORKSPACE_RESULT_CHANGESET_MISMATCH',
        empty,
        [],
        candidate,
        recovery,
      )
    }
    if (candidate.changes.length === 0) {
      await this.#removeOwned(input.isolation.targetPath)
      return outcome('succeeded', 'WORKSPACE_SNAPSHOT_UNCHANGED', empty, [], candidate, undefined, {
        status: 'removed',
        code: 'WORKSPACE_SNAPSHOT_REMOVED',
      })
    }

    let transaction: CopyBackTransaction | undefined
    const guarded = await this.#guard.execute({
      workspaceRoot: input.isolation.workspaceRoot,
      step: input.step,
      baseline: input.isolation.baseline,
      signal: input.signal,
      run: async () => {
        transaction = await copyBack(
          input.isolation.workspaceRoot,
          input.isolation.targetPath,
          candidate.changes,
          input.signal,
        )
        return input.result
      },
    })
    if (guarded.status !== 'succeeded') {
      await transaction?.rollback().catch(() => undefined)
      return outcome(
        guarded.status,
        guarded.code,
        guarded.evidence,
        guarded.verifications,
        candidate,
        recovery,
      )
    }
    await this.#removeOwned(input.isolation.targetPath)
    return outcome(
      'succeeded',
      'WORKSPACE_SNAPSHOT_MERGED_AND_VERIFIED',
      guarded.evidence,
      guarded.verifications,
      candidate,
      undefined,
      { status: 'removed', code: 'WORKSPACE_SNAPSHOT_REMOVED' },
    )
  }

  #validate(isolation: DirectoryWorkspaceIsolationV1): void {
    if (
      isolation.schemaVersion !== 1 ||
      isolation.kind !== 'directory_snapshot' ||
      !this.#owned.has(resolve(isolation.targetPath)) ||
      !isDirectChild(this.#ownedRoot, resolve(isolation.targetPath))
    ) {
      directoryFail('WORKSPACE_SNAPSHOT_OWNERSHIP_INVALID')
    }
  }

  async #removeOwned(targetPath: string): Promise<void> {
    const target = resolve(targetPath)
    if (!this.#owned.has(target) || !isDirectChild(this.#ownedRoot, target)) {
      directoryFail('WORKSPACE_SNAPSHOT_OWNERSHIP_INVALID')
    }
    await rm(target, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 })
    this.#owned.delete(target)
  }
}

type PreparedCandidate = Readonly<{
  commit: string
  patch: string
  changes: readonly CandidateChangeV1[]
}>

async function initializeSnapshotRepository(
  git: GitCommandPortV1,
  targetPath: string,
  signal?: AbortSignal,
): Promise<string> {
  for (const args of [
    ['init', '--quiet'],
    ['add', '-f', '--all'],
    [
      '-c',
      'user.name=Praxis Snapshot Worker',
      '-c',
      'user.email=snapshot@praxis.local',
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '--quiet',
      '--allow-empty',
      '-m',
      'praxis snapshot baseline',
    ],
  ] as const) {
    const command = await git.run({ cwd: targetPath, args, signal })
    if (command.exitCode !== 0) directoryFail('WORKSPACE_SNAPSHOT_CREATE_FAILED', command.stderr)
  }
  const head = await git.run({ cwd: targetPath, args: ['rev-parse', 'HEAD'], signal })
  const commit = head.stdout.trim()
  if (head.exitCode !== 0 || !isCommit(commit)) {
    directoryFail('WORKSPACE_SNAPSHOT_CREATE_FAILED', head.stderr)
  }
  return commit
}

async function prepareCandidate(
  git: GitCommandPortV1,
  isolation: DirectoryWorkspaceIsolationV1,
  signal?: AbortSignal,
): Promise<PreparedCandidate> {
  const add = await git.run({ cwd: isolation.targetPath, args: ['add', '-f', '--all'], signal })
  if (add.exitCode !== 0) directoryFail('WORKSPACE_SNAPSHOT_INSPECTION_FAILED', add.stderr)
  const staged = await git.run({
    cwd: isolation.targetPath,
    args: ['diff', '--cached', '--quiet'],
    signal,
  })
  if (staged.exitCode === 1) {
    const commit = await git.run({
      cwd: isolation.targetPath,
      args: [
        '-c',
        'user.name=Praxis Snapshot Worker',
        '-c',
        'user.email=snapshot@praxis.local',
        '-c',
        'core.hooksPath=/dev/null',
        'commit',
        '--quiet',
        '-m',
        'praxis snapshot candidate',
      ],
      signal,
    })
    if (commit.exitCode !== 0) {
      directoryFail('WORKSPACE_SNAPSHOT_CANDIDATE_FAILED', commit.stderr)
    }
  } else if (staged.exitCode !== 0) {
    directoryFail('WORKSPACE_SNAPSHOT_INSPECTION_FAILED', staged.stderr)
  }
  const [head, names, patch] = await Promise.all([
    git.run({ cwd: isolation.targetPath, args: ['rev-parse', 'HEAD'], signal }),
    git.run({
      cwd: isolation.targetPath,
      args: ['diff', '--name-status', '-z', '--no-renames', isolation.baseCommit, 'HEAD', '--'],
      signal,
    }),
    git.run({
      cwd: isolation.targetPath,
      args: [
        'diff',
        '--binary',
        '--full-index',
        '--no-ext-diff',
        '--no-renames',
        isolation.baseCommit,
        'HEAD',
        '--',
      ],
      signal,
      maxOutputBytes: 4 * 1024 * 1024,
    }),
  ])
  const commit = head.stdout.trim()
  if ([head, names, patch].some((command) => command.exitCode !== 0) || !isCommit(commit)) {
    directoryFail('WORKSPACE_SNAPSHOT_INSPECTION_FAILED')
  }
  const parsed = parseNameStatus(names.stdout)
  if (parsed === undefined) directoryFail('WORKSPACE_SNAPSHOT_CHANGESET_INVALID')
  const changes = await materializeCandidate(isolation.targetPath, parsed)
  return Object.freeze({ commit, patch: patch.stdout, changes: Object.freeze(changes) })
}

async function copyBaseline(
  sourceRoot: string,
  targetRoot: string,
  baseline: WorkspaceSnapshotV1,
  signal?: AbortSignal,
): Promise<void> {
  for (const file of baseline.files) {
    if (signal?.aborted) directoryFail('WORKSPACE_SNAPSHOT_CANCELLED', 'cancelled')
    if (prohibitedSnapshotPath(file.path)) continue
    const source = resolvePortable(sourceRoot, file.path)
    const target = resolvePortable(targetRoot, file.path)
    const metadata = await lstat(source)
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      directoryFail('WORKSPACE_SNAPSHOT_SOURCE_UNSAFE')
    }
    await mkdir(dirname(target), { recursive: true })
    await copyFile(source, target)
    if (digest(await readFile(target)) !== file.digest) {
      directoryFail('WORKSPACE_BASELINE_CHANGED')
    }
  }
}

type CopyBackTransaction = Readonly<{ rollback: () => Promise<void> }>

async function copyBack(
  workspaceRoot: string,
  snapshotRoot: string,
  changes: readonly CandidateChangeV1[],
  signal?: AbortSignal,
): Promise<CopyBackTransaction> {
  const backupRoot = resolve(snapshotRoot, '.git', 'praxis-copy-back', randomUUID())
  await mkdir(backupRoot, { recursive: true })
  const backups: Array<Readonly<{ path: string; existed: boolean; backup?: string }>> = []
  try {
    for (const [index, change] of changes.entries()) {
      if (signal?.aborted) directoryFail('WORKSPACE_WRITE_CANCELLED', 'cancelled')
      const target = resolvePortable(workspaceRoot, change.path)
      const current = await lstat(target).catch(() => undefined)
      if (current !== undefined && (!current.isFile() || current.isSymbolicLink())) {
        directoryFail('WORKSPACE_SNAPSHOT_TARGET_UNSAFE')
      }
      if (current === undefined) {
        backups.push({ path: target, existed: false })
      } else {
        const backup = resolve(backupRoot, String(index))
        await copyFile(target, backup)
        backups.push({ path: target, existed: true, backup })
      }
      if (change.change === 'deleted') {
        if (current !== undefined) await unlink(target)
        continue
      }
      const source = resolvePortable(snapshotRoot, change.path)
      const sourceMetadata = await lstat(source)
      if (!sourceMetadata.isFile() || sourceMetadata.isSymbolicLink()) {
        directoryFail('WORKSPACE_SNAPSHOT_SOURCE_UNSAFE')
      }
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, await readFile(source))
    }
  } catch (error) {
    await rollbackCopies(backups)
    throw error
  }
  return Object.freeze({ rollback: () => rollbackCopies(backups) })
}

async function rollbackCopies(
  backups: readonly Readonly<{ path: string; existed: boolean; backup?: string }>[],
): Promise<void> {
  for (const item of [...backups].reverse()) {
    if (!item.existed) {
      await unlink(item.path).catch(() => undefined)
    } else if (item.backup !== undefined) {
      await mkdir(dirname(item.path), { recursive: true })
      await copyFile(item.backup, item.path)
    }
  }
}

function parseNameStatus(input: string): CandidateChangeV1[] | undefined {
  const records = input.split('\0').filter(Boolean)
  const changes: CandidateChangeV1[] = []
  for (let index = 0; index < records.length; index += 2) {
    const status = records[index]
    const path = records[index + 1]
    if (
      !['A', 'M', 'D'].includes(status ?? '') ||
      path === undefined ||
      !isPortablePlanPathV1(path)
    ) {
      return undefined
    }
    changes.push({
      path,
      change: status === 'A' ? 'created' : status === 'D' ? 'deleted' : 'modified',
    })
  }
  return new Set(changes.map(({ path }) => path)).size === changes.length ? changes : undefined
}

async function materializeCandidate(
  root: string,
  changes: readonly CandidateChangeV1[],
): Promise<CandidateChangeV1[]> {
  return Promise.all(
    changes.map(async (change) => {
      if (change.change === 'deleted') return Object.freeze({ ...change })
      const path = resolvePortable(root, change.path)
      const metadata = await lstat(path)
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        directoryFail('WORKSPACE_SNAPSHOT_CHANGESET_INVALID')
      }
      return Object.freeze({ ...change, digest: digest(await readFile(path)) })
    }),
  )
}

function changesMatch(
  actual: readonly CandidateChangeV1[],
  reported: SubagentResultV1['changedFiles'],
): boolean {
  const left = [...actual].sort((a, b) => a.path.localeCompare(b.path))
  const right = [...reported].sort((a, b) => a.path.localeCompare(b.path))
  return (
    left.length === right.length &&
    new Set(right.map(({ path }) => path)).size === right.length &&
    left.every(
      (change, index) =>
        change.path === right[index]?.path &&
        change.change === right[index]?.change &&
        change.digest === right[index]?.digest,
    )
  )
}

function prohibitedSnapshotPath(path: string): boolean {
  const segments = path.toLowerCase().split('/')
  if (
    segments.some((segment) =>
      ['.git', '.praxis', 'node_modules', '.venv', 'venv', '__pycache__'].includes(segment),
    )
  ) {
    return true
  }
  const name = basename(path).toLowerCase()
  if (['.env.example', '.env.sample', '.env.template'].includes(name)) return false
  return (
    name === '.env' ||
    name.startsWith('.env.') ||
    ['credentials.json', 'id_rsa', 'id_ed25519'].includes(name) ||
    ['.pem', '.key', '.p12', '.pfx'].some((extension) => name.endsWith(extension))
  )
}

function resolvePortable(root: string, path: string): string {
  if (!isPortablePlanPathV1(path) || path === '.') directoryFail('WORKSPACE_SNAPSHOT_PATH_INVALID')
  const target = resolve(root, ...path.split('/'))
  const value = relative(root, target)
  if (value === '' || value === '..' || value.startsWith(`..${sep}`) || isAbsolute(value)) {
    directoryFail('WORKSPACE_SNAPSHOT_PATH_INVALID')
  }
  return target
}

function isDirectChild(root: string, target: string): boolean {
  const value = relative(root, target)
  return value !== '' && !value.includes(sep) && value !== '..' && !isAbsolute(value)
}

function recoveryFor(isolation: DirectoryWorkspaceIsolationV1) {
  return Object.freeze({
    mainWorkspace: isolation.workspaceRoot,
    snapshotPath: isolation.targetPath,
    instructions: Object.freeze([
      'Inspect the retained snapshot before applying any changes manually.',
      'The main workspace was not initialized as a Git repository by Praxis.',
    ]),
  })
}

function emptyEvidence(snapshot: WorkspaceSnapshotV1): WorkspaceWriteEvidenceV1 {
  return Object.freeze({
    beforeDigest: snapshot.digest,
    afterDigest: snapshot.digest,
    changedFiles: Object.freeze([]),
  })
}

function outcome(
  status: DirectoryWorkspaceMergeResultV1['status'],
  code: string,
  evidence: WorkspaceWriteEvidenceV1,
  verifications: readonly VerificationDecisionV1[],
  candidate: PreparedCandidate,
  recovery?: DirectoryWorkspaceMergeResultV1['recovery'],
  cleanup?: DirectoryWorkspaceMergeResultV1['cleanup'],
): DirectoryWorkspaceMergeResultV1 {
  return Object.freeze({
    status,
    code,
    evidence,
    verifications: Object.freeze([...verifications]),
    candidateCommit: candidate.commit,
    patchDigest: digest(candidate.patch),
    patchBytes: Buffer.byteLength(candidate.patch),
    ...(recovery === undefined ? {} : { recovery }),
    ...(cleanup === undefined ? {} : { cleanup }),
  })
}

function isCommit(value: string): boolean {
  return /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(value)
}

function digest(value: string | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function directoryFail(code: string, message = code): never {
  throw Object.assign(new Error(message), {
    code,
    category: code.includes('CANCELLED') ? 'cancelled' : 'planner',
    retryable: false,
  })
}
