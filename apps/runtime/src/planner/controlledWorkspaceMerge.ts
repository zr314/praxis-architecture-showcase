import { createHash } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { runtimeError, type SessionStepProjectionV3, type SubagentResultV1 } from '@praxis/core-sdk'
import { validateSubagentResultV1 } from '../subagent/contextPacket.js'
import { isPlanPathWithinGrantV1, isPortablePlanPathV1 } from './planValidator.js'
import type { SupervisorVerifierV1, VerificationDecisionV1 } from './verifier.js'
import {
  GitCliCommandPortV1,
  type GitCommandPortV1,
  type WorkspaceCleanupResultV1,
  type WorkspaceIsolationV1,
  type WorkspaceIsolationValidationPortV1,
} from './workspaceIsolationManager.js'
import { acquireWorkspaceWriteLeaseV1, type WorkspaceWriteLeaseV1 } from './workspaceWriteGuard.js'

const MAX_PATCH_BYTES = 64 * 1024

export type WorkspacePatchV1 = Readonly<{
  format: 'git-diff-binary-v1'
  bytes: number
  digest: `sha256:${string}`
  content: string
}>

export type WorkspaceMergeArtifactV1 = Readonly<{
  schemaVersion: 1
  baseCommit: string
  commit: string
  patch: WorkspacePatchV1
  result: SubagentResultV1
}>

export type WorkspaceMergeEvidenceV1 = Readonly<{
  baseCommit: string
  commit: string
  patchDigest: `sha256:${string}`
  patchBytes: number
  changedFiles: SubagentResultV1['changedFiles']
}>

export type WorkspaceMergeRecoveryV1 = Readonly<{
  mainWorkspace: string
  worktreePath: string
  baseCommit: string
  commit: string
  instructions: readonly string[]
}>

export type ControlledWorkspaceMergeResultV1 = Readonly<{
  status: 'succeeded' | 'blocked' | 'cancelled'
  code: string
  evidence: WorkspaceMergeEvidenceV1
  verifications: readonly VerificationDecisionV1[]
  cleanup?: WorkspaceCleanupResultV1
  recovery?: WorkspaceMergeRecoveryV1
}>

export type ControlledWorkspaceMergeOptionsV1 = Readonly<{
  isolationManager: WorkspaceIsolationValidationPortV1
  mechanicalVerifier: SupervisorVerifierV1
  ruleVerifier: SupervisorVerifierV1
  semanticVerifier?: SupervisorVerifierV1
  git?: GitCommandPortV1
}>

type ActualChangeV1 = Readonly<{
  path: string
  change: 'created' | 'modified' | 'deleted'
  digest?: `sha256:${string}`
}>

/** Validates one isolated worker commit, fast-forwards the exact base, and verifies again. */
export class ControlledWorkspaceMergeV1 {
  readonly #git: GitCommandPortV1

  constructor(private readonly options: ControlledWorkspaceMergeOptionsV1) {
    if (
      typeof options !== 'object' ||
      options === null ||
      !options.isolationManager ||
      !options.mechanicalVerifier ||
      !options.ruleVerifier
    ) {
      mergeFail('WORKSPACE_MERGE_OPTIONS_INVALID')
    }
    this.#git = options.git ?? new GitCliCommandPortV1()
  }

  async execute(input: {
    step: SessionStepProjectionV3
    isolation: WorkspaceIsolationV1
    artifact: WorkspaceMergeArtifactV1
    signal?: AbortSignal
  }): Promise<ControlledWorkspaceMergeResultV1> {
    validateWriteStep(input.step)
    const artifact = validateArtifact(input.artifact)
    const initialEvidence = mergeEvidence(artifact)
    if (input.signal?.aborted) {
      return outcome('cancelled', 'WORKSPACE_MERGE_CANCELLED', initialEvidence, [])
    }
    const isolation = await this.options.isolationManager.validate({
      isolation: input.isolation,
      signal: input.signal,
    })
    const recovery = recoveryFor(isolation, artifact)
    if (artifact.result.status !== 'succeeded') {
      return outcome('blocked', 'WORKSPACE_WORKER_RESULT_UNVERIFIED', initialEvidence, [], recovery)
    }
    if (
      artifact.baseCommit !== isolation.baseCommit ||
      artifact.commit === artifact.baseCommit ||
      isolation.repoRoot === isolation.targetPath
    ) {
      return outcome('blocked', 'WORKSPACE_MERGE_BINDING_INVALID', initialEvidence, [], recovery)
    }

    const leases = await acquireLeases([isolation.repoRoot, isolation.targetPath], input.signal)
    try {
      await this.options.isolationManager.validate({ isolation, signal: input.signal })
      const preflight = await this.#preflight(input.step, isolation, artifact, input.signal)
      if (preflight.code !== 'WORKSPACE_MERGE_PREFLIGHT_PASSED') {
        return outcome('blocked', preflight.code, preflight.evidence, [], recovery)
      }
      if (input.signal?.aborted) {
        return outcome('cancelled', 'WORKSPACE_MERGE_CANCELLED', preflight.evidence, [], recovery)
      }

      const mainState = await inspectMain(this.#git, isolation.repoRoot, input.signal)
      if (mainState === undefined) {
        return outcome(
          'blocked',
          'WORKSPACE_MAIN_INSPECTION_FAILED',
          preflight.evidence,
          [],
          recovery,
        )
      }
      if (mainState.head !== isolation.baseCommit) {
        return outcome('blocked', 'WORKSPACE_BASE_STALE', preflight.evidence, [], recovery)
      }
      if (mainState.changes > 0) {
        return outcome('blocked', 'WORKSPACE_MAIN_DIRTY', preflight.evidence, [], recovery)
      }

      const merge = await this.#git.run({
        cwd: isolation.repoRoot,
        args: [
          '-c',
          'core.hooksPath=/dev/null',
          'merge',
          '--ff-only',
          '--no-edit',
          artifact.commit,
        ],
        signal: input.signal,
      })
      const mergedState = await inspectMain(this.#git, isolation.repoRoot)
      if (
        mergedState === undefined ||
        mergedState.head !== artifact.commit ||
        mergedState.branch !== mainState.branch ||
        mergedState.changes > 0
      ) {
        return outcome(
          'blocked',
          mergedState?.head === isolation.baseCommit && merge.exitCode !== 0
            ? 'WORKSPACE_MERGE_CONFLICT'
            : 'WORKSPACE_MERGE_INDETERMINATE',
          preflight.evidence,
          [],
          recovery,
        )
      }
      if (merge.exitCode !== 0) {
        return outcome('blocked', 'WORKSPACE_MERGE_INDETERMINATE', preflight.evidence, [], recovery)
      }
      if (input.signal?.aborted) {
        return outcome(
          'blocked',
          'WORKSPACE_CANCELLED_AFTER_MERGE',
          preflight.evidence,
          [],
          recovery,
        )
      }

      const mechanical = await verifySafely(
        this.options.mechanicalVerifier,
        { step: input.step, result: artifact.result, signal: input.signal },
        'mechanical',
      )
      const rule = await verifySafely(
        this.options.ruleVerifier,
        { step: input.step, result: artifact.result, signal: input.signal },
        'rule',
      )
      const verifications: VerificationDecisionV1[] = [mechanical, rule]
      if (
        mechanical.status === 'passed' &&
        rule.status === 'passed' &&
        input.step.criteria.some((criterion) => criterion.kind === 'semantic')
      ) {
        verifications.push(
          this.options.semanticVerifier === undefined
            ? Object.freeze({
                verifier: 'model',
                status: 'blocked',
                evidenceRefs: Object.freeze([]),
                code: 'WORKSPACE_POST_MERGE_SEMANTIC_VERIFIER_REQUIRED',
                retryable: false,
              })
            : await verifySafely(
                this.options.semanticVerifier,
                { step: input.step, result: artifact.result, signal: input.signal },
                'model',
              ),
        )
      }
      const frozenVerifications = Object.freeze(verifications)
      const verifiedState = await inspectMain(this.#git, isolation.repoRoot)
      if (
        verifiedState === undefined ||
        verifiedState.head !== artifact.commit ||
        verifiedState.branch !== mainState.branch ||
        verifiedState.changes > 0
      ) {
        return outcome(
          'blocked',
          'WORKSPACE_POST_MERGE_STATE_CHANGED',
          preflight.evidence,
          frozenVerifications,
          recovery,
        )
      }
      if (frozenVerifications.some((verification) => verification.status !== 'passed')) {
        return outcome(
          'blocked',
          'WORKSPACE_POST_MERGE_VERIFICATION_FAILED',
          preflight.evidence,
          frozenVerifications,
          recovery,
        )
      }

      const cleanup = await this.options.isolationManager.finalizeMerged({
        isolation,
        mergedCommit: artifact.commit,
        signal: input.signal,
      })
      if (cleanup.status === 'retained') {
        return outcome(
          'succeeded',
          'WORKSPACE_MERGED_WORKTREE_RETAINED',
          preflight.evidence,
          frozenVerifications,
          recovery,
          cleanup,
        )
      }
      return outcome(
        'succeeded',
        'WORKSPACE_MERGED_AND_VERIFIED',
        preflight.evidence,
        frozenVerifications,
        undefined,
        cleanup,
      )
    } finally {
      for (const lease of leases.reverse()) lease.release()
    }
  }

  async #preflight(
    step: SessionStepProjectionV3,
    isolation: WorkspaceIsolationV1,
    artifact: WorkspaceMergeArtifactV1,
    signal?: AbortSignal,
  ): Promise<{ code: string; evidence: WorkspaceMergeEvidenceV1 }> {
    const [head, parents, status, patch, names] = await Promise.all([
      this.#git.run({ cwd: isolation.targetPath, args: ['rev-parse', 'HEAD'], signal }),
      this.#git.run({
        cwd: isolation.targetPath,
        args: ['rev-list', '--parents', '-n', '1', artifact.commit],
        signal,
      }),
      this.#git.run({
        cwd: isolation.targetPath,
        args: ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching'],
        signal,
      }),
      this.#git.run({
        cwd: isolation.targetPath,
        args: [
          'diff',
          '--binary',
          '--full-index',
          '--no-ext-diff',
          '--no-renames',
          artifact.baseCommit,
          artifact.commit,
          '--',
        ],
        signal,
      }),
      this.#git.run({
        cwd: isolation.targetPath,
        args: [
          'diff',
          '--name-status',
          '-z',
          '--no-renames',
          artifact.baseCommit,
          artifact.commit,
          '--',
        ],
        signal,
      }),
    ])
    if ([head, parents, status, patch, names].some((result) => result.exitCode !== 0)) {
      return { code: 'WORKSPACE_COMMIT_INSPECTION_FAILED', evidence: mergeEvidence(artifact) }
    }
    if (head.stdout.trim() !== artifact.commit || status.stdout.length > 0) {
      return { code: 'WORKSPACE_WORKTREE_DIRTY', evidence: mergeEvidence(artifact) }
    }
    const parentFields = parents.stdout.trim().split(/\s+/u)
    if (
      parentFields.length !== 2 ||
      parentFields[0] !== artifact.commit ||
      parentFields[1] !== artifact.baseCommit
    ) {
      return { code: 'WORKSPACE_COMMIT_SHAPE_INVALID', evidence: mergeEvidence(artifact) }
    }
    if (
      Buffer.byteLength(patch.stdout) !== artifact.patch.bytes ||
      patch.stdout !== artifact.patch.content ||
      digest(patch.stdout) !== artifact.patch.digest
    ) {
      return { code: 'WORKSPACE_PATCH_MISMATCH', evidence: mergeEvidence(artifact) }
    }

    const changedPaths = parseNameStatus(names.stdout)
    if (changedPaths === undefined || changedPaths.length === 0) {
      return { code: 'WORKSPACE_CHANGESET_INVALID', evidence: mergeEvidence(artifact) }
    }
    const actualChanges = await materializeChanges(isolation.targetPath, changedPaths)
    const evidence = Object.freeze({
      ...mergeEvidence(artifact),
      changedFiles: Object.freeze(
        actualChanges.map((change) =>
          Object.freeze({
            path: change.path,
            change: change.change,
            ...(change.digest === undefined ? {} : { digest: change.digest }),
          }),
        ),
      ),
    })
    if (
      !actualChanges.every((change) =>
        step.access.paths.some((grant) => isPlanPathWithinGrantV1(change.path, grant)),
      )
    ) {
      return { code: 'WORKSPACE_MERGE_SCOPE_VIOLATION', evidence }
    }
    if (!changesMatch(actualChanges, artifact.result.changedFiles)) {
      return { code: 'WORKSPACE_RESULT_CHANGESET_MISMATCH', evidence }
    }
    const finalHead = await this.#git.run({
      cwd: isolation.targetPath,
      args: ['rev-parse', 'HEAD'],
      signal,
    })
    const finalStatus = await this.#git.run({
      cwd: isolation.targetPath,
      args: ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching'],
      signal,
    })
    if (
      finalHead.exitCode !== 0 ||
      finalHead.stdout.trim() !== artifact.commit ||
      finalStatus.exitCode !== 0 ||
      finalStatus.stdout.length > 0
    ) {
      return { code: 'WORKSPACE_WORKTREE_CHANGED_DURING_PREFLIGHT', evidence }
    }
    return { code: 'WORKSPACE_MERGE_PREFLIGHT_PASSED', evidence }
  }
}

function validateArtifact(input: WorkspaceMergeArtifactV1): WorkspaceMergeArtifactV1 {
  if (
    typeof input !== 'object' ||
    input === null ||
    Object.keys(input).length !== 5 ||
    input.schemaVersion !== 1 ||
    !isCommit(input.baseCommit) ||
    !isCommit(input.commit) ||
    typeof input.patch !== 'object' ||
    input.patch === null ||
    Object.keys(input.patch).length !== 4 ||
    input.patch.format !== 'git-diff-binary-v1' ||
    !Number.isSafeInteger(input.patch.bytes) ||
    input.patch.bytes < 1 ||
    input.patch.bytes > MAX_PATCH_BYTES ||
    typeof input.patch.content !== 'string' ||
    Buffer.byteLength(input.patch.content) !== input.patch.bytes ||
    !/^sha256:[a-f0-9]{64}$/.test(input.patch.digest) ||
    digest(input.patch.content) !== input.patch.digest
  ) {
    mergeFail('WORKSPACE_MERGE_ARTIFACT_INVALID')
  }
  return Object.freeze({
    ...input,
    patch: Object.freeze({ ...input.patch }),
    result: validateSubagentResultV1(input.result),
  })
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
    mergeFail('WORKSPACE_MERGE_AUTHORITY_INVALID')
  }
}

async function acquireLeases(
  roots: readonly string[],
  signal?: AbortSignal,
): Promise<WorkspaceWriteLeaseV1[]> {
  const uniqueRoots = [...new Set(roots.map((root) => resolve(root)))].sort((left, right) =>
    left.localeCompare(right),
  )
  const leases: WorkspaceWriteLeaseV1[] = []
  try {
    for (const workspaceRoot of uniqueRoots) {
      leases.push(await acquireWorkspaceWriteLeaseV1({ workspaceRoot, signal }))
    }
    return leases
  } catch (error) {
    for (const lease of leases.reverse()) lease.release()
    throw error
  }
}

async function inspectMain(
  git: GitCommandPortV1,
  repoRoot: string,
  signal?: AbortSignal,
): Promise<{ head: string; branch: string; changes: number } | undefined> {
  const [head, branch, status] = await Promise.all([
    git.run({ cwd: repoRoot, args: ['rev-parse', 'HEAD'], signal }),
    git.run({ cwd: repoRoot, args: ['symbolic-ref', '--quiet', 'HEAD'], signal }),
    git.run({
      cwd: repoRoot,
      args: ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
      signal,
    }),
  ])
  if (
    head.exitCode !== 0 ||
    branch.exitCode !== 0 ||
    status.exitCode !== 0 ||
    !isCommit(head.stdout.trim()) ||
    !/^refs\/heads\/[A-Za-z0-9._/-]{1,240}$/u.test(branch.stdout.trim())
  ) {
    return undefined
  }
  return {
    head: head.stdout.trim(),
    branch: branch.stdout.trim(),
    changes: status.stdout.split('\0').filter(Boolean).length,
  }
}

function parseNameStatus(input: string): ActualChangeV1[] | undefined {
  const records = input.split('\0').filter((record) => record.length > 0)
  const changes: ActualChangeV1[] = []
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
  return new Set(changes.map((change) => change.path)).size === changes.length ? changes : undefined
}

async function materializeChanges(
  root: string,
  changes: readonly ActualChangeV1[],
): Promise<ActualChangeV1[]> {
  const materialized: ActualChangeV1[] = []
  for (const change of changes) {
    if (change.change === 'deleted') {
      materialized.push(Object.freeze({ ...change }))
      continue
    }
    const absolute = resolve(root, ...change.path.split('/'))
    if (!isWithin(root, absolute)) mergeFail('WORKSPACE_CHANGESET_INVALID')
    const metadata = await lstat(absolute).catch(() => undefined)
    if (metadata === undefined || !metadata.isFile() || metadata.isSymbolicLink()) {
      mergeFail('WORKSPACE_CHANGESET_INVALID')
    }
    const canonical = await realpath(absolute)
    if (!isWithin(root, canonical)) mergeFail('WORKSPACE_CHANGESET_INVALID')
    materialized.push(Object.freeze({ ...change, digest: digest(await readFile(canonical)) }))
  }
  return materialized
}

function changesMatch(
  actual: readonly ActualChangeV1[],
  reported: SubagentResultV1['changedFiles'],
): boolean {
  const orderedActual = [...actual].sort((left, right) => left.path.localeCompare(right.path))
  const orderedReported = [...reported].sort((left, right) => left.path.localeCompare(right.path))
  return (
    new Set(orderedReported.map((change) => change.path)).size === orderedReported.length &&
    orderedActual.length === orderedReported.length &&
    orderedActual.every(
      (change, index) =>
        change.path === orderedReported[index]?.path &&
        change.change === orderedReported[index]?.change &&
        change.digest === orderedReported[index]?.digest,
    )
  )
}

async function verifySafely(
  verifier: SupervisorVerifierV1,
  input: Parameters<SupervisorVerifierV1['verify']>[0],
  kind: 'mechanical' | 'rule' | 'model',
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
      code: 'WORKSPACE_POST_MERGE_VERIFIER_FAILED',
      retryable: false,
    })
  }
}

function mergeEvidence(artifact: WorkspaceMergeArtifactV1): WorkspaceMergeEvidenceV1 {
  return Object.freeze({
    baseCommit: artifact.baseCommit,
    commit: artifact.commit,
    patchDigest: artifact.patch.digest,
    patchBytes: artifact.patch.bytes,
    changedFiles: Object.freeze([...artifact.result.changedFiles]),
  })
}

function recoveryFor(
  isolation: WorkspaceIsolationV1,
  artifact: WorkspaceMergeArtifactV1,
): WorkspaceMergeRecoveryV1 {
  return Object.freeze({
    mainWorkspace: isolation.repoRoot,
    worktreePath: isolation.targetPath,
    baseCommit: artifact.baseCommit,
    commit: artifact.commit,
    instructions: Object.freeze([
      'Inspect the main workspace and retained worktree before making further changes.',
      'If rollback is required, create a reviewed revert commit; Praxis will not reset the main workspace.',
    ]),
  })
}

function outcome(
  status: ControlledWorkspaceMergeResultV1['status'],
  code: string,
  evidence: WorkspaceMergeEvidenceV1,
  verifications: readonly VerificationDecisionV1[],
  recovery?: WorkspaceMergeRecoveryV1,
  cleanup?: WorkspaceCleanupResultV1,
): ControlledWorkspaceMergeResultV1 {
  return Object.freeze({
    status,
    code,
    evidence,
    verifications: Object.freeze([...verifications]),
    ...(cleanup === undefined ? {} : { cleanup }),
    ...(recovery === undefined ? {} : { recovery }),
  })
}

function isCommit(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value)
}

function isWithin(root: string, target: string): boolean {
  const value = relative(root, target)
  return value !== '' && !value.startsWith(`..${sep}`) && value !== '..' && !isAbsolute(value)
}

function digest(value: string | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function mergeFail(code: string): never {
  throw Object.assign(new Error(code), runtimeError(code, 'planner', code), { code })
}
