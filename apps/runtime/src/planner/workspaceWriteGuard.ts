import { createHash } from 'node:crypto'
import { lstat, readdir, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { runtimeError, type SessionStepProjectionV3, type SubagentResultV1 } from '@praxis/core-sdk'
import { validateSubagentResultV1 } from '../subagent/contextPacket.js'
import { isPlanPathWithinGrantV1, isPortablePlanPathV1 } from './planValidator.js'
import type { SupervisorVerifierV1, VerificationDecisionV1 } from './verifier.js'

const DEFAULT_MAX_FILES = 4_096
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024
const MAX_FILES = 65_536
const MAX_BYTES = 1024 * 1024 * 1024

export type WorkspaceFileSnapshotV1 = Readonly<{
  path: string
  digest: `sha256:${string}`
  bytes: number
}>

export type WorkspaceSnapshotV1 = Readonly<{
  schemaVersion: 1
  workspaceRoot: string
  digest: `sha256:${string}`
  files: readonly WorkspaceFileSnapshotV1[]
}>

export type WorkspaceChangedFileV1 = Readonly<{
  path: string
  change: 'created' | 'modified' | 'deleted'
  beforeDigest?: `sha256:${string}`
  afterDigest?: `sha256:${string}`
}>

export type WorkspaceWriteEvidenceV1 = Readonly<{
  beforeDigest: `sha256:${string}`
  afterDigest: `sha256:${string}`
  changedFiles: readonly WorkspaceChangedFileV1[]
}>

export type WorkspaceWriteGuardResultV1 = Readonly<{
  status: 'succeeded' | 'blocked' | 'cancelled'
  code: string
  evidence: WorkspaceWriteEvidenceV1
  result?: SubagentResultV1
  verifications: readonly VerificationDecisionV1[]
}>

export type WorkspaceWriteGuardOptionsV1 = Readonly<{
  mechanicalVerifier: SupervisorVerifierV1
  ruleVerifier: SupervisorVerifierV1
  maxFiles?: number
  maxBytes?: number
}>

export type WorkspaceWriteLeaseV1 = Readonly<{
  workspaceRoot: string
  release: () => void
}>

type LockState = { tail: Promise<void>; waiting: number }
const WORKSPACE_LOCKS = new Map<string, LockState>()

export async function acquireWorkspaceWriteLeaseV1(input: {
  workspaceRoot: string
  signal?: AbortSignal
}): Promise<WorkspaceWriteLeaseV1> {
  const workspaceRoot = await validateRoot(input.workspaceRoot)
  const release = await acquireWorkspaceLock(workspaceRoot, input.signal)
  return Object.freeze({ workspaceRoot, release })
}

/** Process-global single-writer guard for the transitional shared-workspace stage. */
export class WorkspaceWriteGuardV1 {
  readonly #maxFiles: number
  readonly #maxBytes: number

  constructor(private readonly options: WorkspaceWriteGuardOptionsV1) {
    if (!options?.mechanicalVerifier || !options.ruleVerifier) guardFail('WORKSPACE_GUARD_INVALID')
    this.#maxFiles = boundedLimit(options.maxFiles ?? DEFAULT_MAX_FILES, MAX_FILES)
    this.#maxBytes = boundedLimit(options.maxBytes ?? DEFAULT_MAX_BYTES, MAX_BYTES)
  }

  async capture(input: {
    workspaceRoot: string
    step: SessionStepProjectionV3
  }): Promise<WorkspaceSnapshotV1> {
    const root = await validateRoot(input.workspaceRoot)
    validateWriteStep(input.step)
    return captureSnapshot(root, this.#maxFiles, this.#maxBytes)
  }

  async execute(input: {
    workspaceRoot: string
    step: SessionStepProjectionV3
    baseline: WorkspaceSnapshotV1
    signal?: AbortSignal
    run: () => Promise<unknown>
  }): Promise<WorkspaceWriteGuardResultV1> {
    const root = await validateRoot(input.workspaceRoot)
    validateWriteStep(input.step)
    const baseline = validateSnapshot(input.baseline, root)
    if (input.signal?.aborted) {
      return outcome('cancelled', 'WORKSPACE_WRITE_CANCELLED', emptyEvidence(baseline), [])
    }

    const lease = await acquireWorkspaceWriteLeaseV1({ workspaceRoot: root, signal: input.signal })
    try {
      if (input.signal?.aborted) {
        return outcome('cancelled', 'WORKSPACE_WRITE_CANCELLED', emptyEvidence(baseline), [])
      }
      const before = await captureSnapshot(root, this.#maxFiles, this.#maxBytes)
      if (before.digest !== baseline.digest) {
        return outcome('blocked', 'WORKSPACE_BASELINE_CHANGED', evidence(baseline, before), [])
      }

      let rawResult: unknown
      let executionFailed = false
      try {
        rawResult = await input.run()
      } catch {
        executionFailed = true
      }
      const after = await captureSnapshot(root, this.#maxFiles, this.#maxBytes)
      const mutationEvidence = evidence(before, after)
      if (executionFailed) {
        return outcome('blocked', 'WORKSPACE_EXECUTOR_FAILED', mutationEvidence, [])
      }

      let result: SubagentResultV1
      try {
        result = validateSubagentResultV1(rawResult)
      } catch {
        return outcome('blocked', 'WORKSPACE_RESULT_INVALID', mutationEvidence, [])
      }
      if (input.signal?.aborted) {
        return outcome(
          mutationEvidence.changedFiles.length === 0 ? 'cancelled' : 'blocked',
          mutationEvidence.changedFiles.length === 0
            ? 'WORKSPACE_WRITE_CANCELLED'
            : 'WORKSPACE_CANCELLED_AFTER_MUTATION',
          mutationEvidence,
          [],
          result,
        )
      }
      if (!changesWithinGrant(mutationEvidence.changedFiles, input.step)) {
        return outcome('blocked', 'WORKSPACE_SCOPE_VIOLATION', mutationEvidence, [], result)
      }
      if (!matchesReportedChanges(mutationEvidence.changedFiles, result.changedFiles)) {
        return outcome('blocked', 'WORKSPACE_CONCURRENT_MODIFICATION', mutationEvidence, [], result)
      }
      if (result.status !== 'succeeded') {
        return outcome('blocked', 'WORKSPACE_MUTATION_UNVERIFIED', mutationEvidence, [], result)
      }

      const mechanical = await verifySafely(
        this.options.mechanicalVerifier,
        { step: input.step, result, signal: input.signal },
        'mechanical',
      )
      const rule = await verifySafely(
        this.options.ruleVerifier,
        { step: input.step, result, signal: input.signal },
        'rule',
      )
      const verifications = Object.freeze([mechanical, rule])
      const verifiedSnapshot = await captureSnapshot(root, this.#maxFiles, this.#maxBytes)
      if (verifiedSnapshot.digest !== after.digest) {
        return outcome(
          'blocked',
          'WORKSPACE_CONCURRENT_MODIFICATION',
          evidence(before, verifiedSnapshot),
          verifications,
          result,
        )
      }
      if (mechanical.status !== 'passed' || rule.status !== 'passed') {
        return outcome(
          'blocked',
          'WORKSPACE_VERIFICATION_FAILED',
          mutationEvidence,
          verifications,
          result,
        )
      }
      return outcome(
        'succeeded',
        'WORKSPACE_WRITE_VERIFIED',
        mutationEvidence,
        verifications,
        result,
      )
    } finally {
      lease.release()
    }
  }
}

async function validateRoot(input: string): Promise<string> {
  if (typeof input !== 'string' || !isAbsolute(input)) guardFail('WORKSPACE_ROOT_INVALID')
  const absolute = resolve(input)
  const metadata = await lstat(absolute).catch(() => undefined)
  if (metadata === undefined || !metadata.isDirectory() || metadata.isSymbolicLink()) {
    guardFail('WORKSPACE_ROOT_INVALID')
  }
  const canonical = await realpath(absolute)
  if (resolve(canonical) !== absolute) guardFail('WORKSPACE_ROOT_ALIAS_UNSAFE')
  return canonical
}

function validateWriteStep(step: SessionStepProjectionV3): void {
  if (
    typeof step !== 'object' ||
    step === null ||
    step.access.mode !== 'workspace_write' ||
    step.access.paths.length === 0 ||
    !step.access.paths.every(isPortablePlanPathV1) ||
    !step.conflictKeys.includes('workspace')
  ) {
    guardFail('WORKSPACE_WRITE_AUTHORITY_INVALID')
  }
}

async function captureSnapshot(
  root: string,
  maxFiles: number,
  maxBytes: number,
): Promise<WorkspaceSnapshotV1> {
  const files: WorkspaceFileSnapshotV1[] = []
  let totalBytes = 0
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (directory === root && entry.name === '.git') continue
      const absolute = resolve(directory, entry.name)
      const metadata = await lstat(absolute)
      if (metadata.isSymbolicLink()) guardFail('WORKSPACE_SNAPSHOT_LINK_UNSAFE')
      if (metadata.isDirectory()) {
        await visit(absolute)
        continue
      }
      if (!metadata.isFile()) guardFail('WORKSPACE_SNAPSHOT_TYPE_UNSAFE')
      const content = await readFile(absolute)
      totalBytes += content.byteLength
      if (files.length >= maxFiles || totalBytes > maxBytes) {
        guardFail('WORKSPACE_SNAPSHOT_LIMIT_EXCEEDED')
      }
      files.push(
        Object.freeze({
          path: portableRelative(root, absolute),
          digest: digest(content),
          bytes: content.byteLength,
        }),
      )
    }
  }
  await visit(root)
  files.sort((left, right) => left.path.localeCompare(right.path))
  return freezeSnapshot(root, files)
}

function validateSnapshot(input: WorkspaceSnapshotV1, root: string): WorkspaceSnapshotV1 {
  if (
    typeof input !== 'object' ||
    input === null ||
    input.schemaVersion !== 1 ||
    input.workspaceRoot !== root ||
    typeof input.digest !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/.test(input.digest) ||
    !Array.isArray(input.files) ||
    input.files.length > MAX_FILES
  ) {
    guardFail('WORKSPACE_BASELINE_INVALID')
  }
  const files = input.files.map((file) => {
    if (
      typeof file !== 'object' ||
      file === null ||
      Object.keys(file).length !== 3 ||
      !isPortablePlanPathV1(file.path) ||
      file.path === '.' ||
      typeof file.digest !== 'string' ||
      !/^sha256:[a-f0-9]{64}$/.test(file.digest) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0
    ) {
      guardFail('WORKSPACE_BASELINE_INVALID')
    }
    return Object.freeze({ ...file })
  })
  if (
    new Set(files.map((file) => file.path)).size !== files.length ||
    freezeSnapshot(root, files).digest !== input.digest
  ) {
    guardFail('WORKSPACE_BASELINE_INVALID')
  }
  return Object.freeze({
    schemaVersion: 1,
    workspaceRoot: root,
    digest: input.digest,
    files: Object.freeze(files),
  })
}

function freezeSnapshot(
  root: string,
  files: readonly WorkspaceFileSnapshotV1[],
): WorkspaceSnapshotV1 {
  const canonical = files.map((file) => `${file.path}\0${file.bytes}\0${file.digest}`).join('\n')
  return Object.freeze({
    schemaVersion: 1,
    workspaceRoot: root,
    digest: digest(canonical),
    files: Object.freeze([...files]),
  })
}

function evidence(
  before: WorkspaceSnapshotV1,
  after: WorkspaceSnapshotV1,
): WorkspaceWriteEvidenceV1 {
  const beforeFiles = new Map(before.files.map((file) => [file.path, file]))
  const afterFiles = new Map(after.files.map((file) => [file.path, file]))
  const paths = [...new Set([...beforeFiles.keys(), ...afterFiles.keys()])].sort()
  const changedFiles: WorkspaceChangedFileV1[] = []
  for (const path of paths) {
    const previous = beforeFiles.get(path)
    const current = afterFiles.get(path)
    if (previous?.digest === current?.digest) continue
    changedFiles.push(
      Object.freeze({
        path,
        change: previous === undefined ? 'created' : current === undefined ? 'deleted' : 'modified',
        ...(previous === undefined ? {} : { beforeDigest: previous.digest }),
        ...(current === undefined ? {} : { afterDigest: current.digest }),
      }),
    )
  }
  return Object.freeze({
    beforeDigest: before.digest,
    afterDigest: after.digest,
    changedFiles: Object.freeze(changedFiles),
  })
}

function emptyEvidence(snapshot: WorkspaceSnapshotV1): WorkspaceWriteEvidenceV1 {
  return Object.freeze({
    beforeDigest: snapshot.digest,
    afterDigest: snapshot.digest,
    changedFiles: Object.freeze([]),
  })
}

function changesWithinGrant(
  changes: readonly WorkspaceChangedFileV1[],
  step: SessionStepProjectionV3,
): boolean {
  return changes.every(
    (change) =>
      isPortablePlanPathV1(change.path) &&
      step.access.paths.some((grant) => isPlanPathWithinGrantV1(change.path, grant)),
  )
}

function matchesReportedChanges(
  actual: readonly WorkspaceChangedFileV1[],
  reported: SubagentResultV1['changedFiles'],
): boolean {
  if (new Set(reported.map((change) => change.path)).size !== reported.length) return false
  const normalized = [...reported]
    .map((change) => ({ path: change.path, change: change.change, afterDigest: change.digest }))
    .sort((left, right) => left.path.localeCompare(right.path))
  return (
    actual.length === normalized.length &&
    actual.every(
      (change, index) =>
        change.path === normalized[index]?.path &&
        change.change === normalized[index]?.change &&
        change.afterDigest === normalized[index]?.afterDigest,
    )
  )
}

async function acquireWorkspaceLock(root: string, signal?: AbortSignal): Promise<() => void> {
  const state = WORKSPACE_LOCKS.get(root) ?? { tail: Promise.resolve(), waiting: 0 }
  WORKSPACE_LOCKS.set(root, state)
  const previous = state.tail
  let releaseCurrent!: () => void
  const current = new Promise<void>((resolveCurrent) => {
    releaseCurrent = resolveCurrent
  })
  state.tail = previous.then(() => current)
  state.waiting += 1
  try {
    await Promise.race([previous, abortPromise(signal)])
  } catch {
    releaseCurrent()
    state.waiting -= 1
    if (state.waiting === 0) WORKSPACE_LOCKS.delete(root)
    guardFail('WORKSPACE_WRITE_CANCELLED', 'cancelled')
  }
  let released = false
  return () => {
    if (released) return
    released = true
    releaseCurrent()
    state.waiting -= 1
    if (state.waiting === 0) WORKSPACE_LOCKS.delete(root)
  }
}

function abortPromise(signal?: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal?.aborted) reject(new Error('aborted'))
    else signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
  })
}

async function verifySafely(
  verifier: SupervisorVerifierV1,
  input: Parameters<SupervisorVerifierV1['verify']>[0],
  kind: 'mechanical' | 'rule',
): Promise<VerificationDecisionV1> {
  try {
    const result = await verifier.verify(input)
    if (
      result.verifier !== kind ||
      !['passed', 'failed', 'blocked'].includes(result.status) ||
      typeof result.code !== 'string' ||
      typeof result.retryable !== 'boolean' ||
      !Array.isArray(result.evidenceRefs)
    ) {
      throw new Error('invalid verifier output')
    }
    return result
  } catch {
    return Object.freeze({
      verifier: kind,
      status: 'blocked',
      evidenceRefs: Object.freeze([]),
      code: 'WORKSPACE_VERIFIER_FAILED',
      retryable: false,
    })
  }
}

function outcome(
  status: WorkspaceWriteGuardResultV1['status'],
  code: string,
  writeEvidence: WorkspaceWriteEvidenceV1,
  verifications: readonly VerificationDecisionV1[],
  result?: SubagentResultV1,
): WorkspaceWriteGuardResultV1 {
  return Object.freeze({
    status,
    code,
    evidence: writeEvidence,
    ...(result === undefined ? {} : { result }),
    verifications: Object.freeze([...verifications]),
  })
}

function portableRelative(root: string, path: string): string {
  const value = relative(root, path).split(sep).join('/')
  if (!isPortablePlanPathV1(value) || value === '.') guardFail('WORKSPACE_PATH_INVALID')
  return value
}

function boundedLimit(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    guardFail('WORKSPACE_GUARD_INVALID')
  }
  return value
}

function digest(value: string | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function guardFail(code: string, category: 'planner' | 'cancelled' = 'planner'): never {
  throw Object.assign(new Error(code), runtimeError(code, category, code), { code })
}
