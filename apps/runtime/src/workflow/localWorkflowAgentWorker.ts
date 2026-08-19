import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type {
  AgentAssemblyRequestV1,
  AgentHarnessProfileV1,
  BudgetUsage,
  ChatProvider,
  ExecutionBudget,
  RuntimeTool,
  WorkflowArtifactRefV1,
  WorkflowProjectionV1,
  WorkflowTaskClaimV1,
} from '@praxis/core-sdk'
import { CancellationTree } from '@praxis/core-sdk'
import type { ArtifactStore } from '../artifacts/artifactStore.js'
import { earliestCanonicalDeadline } from '../longDurationTimer.js'
import { LONG_LIVED_EXECUTION_POLICY_V1 } from '../longLivedExecutionPolicy.js'
import {
  ControlledWorkspaceMergeV1,
  type WorkspaceMergeArtifactV1,
} from '../planner/controlledWorkspaceMerge.js'
import {
  DirectoryWorkspaceIsolationManagerV1,
  type DirectoryWorkspaceIsolationV1,
} from '../planner/directoryWorkspaceIsolation.js'
import { RuleVerifierV1, type SupervisorVerifierV1 } from '../planner/verifier.js'
import {
  GitCliCommandPortV1,
  WorkspaceIsolationManagerV1,
  type WorkspaceIsolationV1,
} from '../planner/workspaceIsolationManager.js'
import { InMemorySubagentAdmissionLedger } from '../subagent/admission.js'
import {
  CHILD_BOOTSTRAP_METHODS,
  type ChildBootstrapProfileV3,
} from '../subagent/childBootstrapProfile.js'
import {
  type ChildProviderTarget,
  type ChildSkillCandidate,
  type ChildToolCandidate,
  compileChildCapabilityBundle,
  digestToolDefinition,
  type McpToolGrant,
} from '../subagent/childCapabilityBundle.js'
import type { ChildPermissionDecisionLifecyclePort } from '../subagent/childPermissionGate.js'
import { ChildRuntimeHost, type ChildRuntimeLaunch } from '../subagent/childRuntimeHost.js'
import { SUBAGENT_SUMMARY_MAX_BYTES } from '../subagent/contextPacket.js'
import {
  ChildCredentialDelegationService,
  InMemoryChildCredentialBroker,
} from '../subagent/credentialDelegation.js'
import { bindChildMcpBrokerCapability, ChildMcpToolBroker } from '../subagent/mcpBrokerIpc.js'
import { type AgentModelCandidateV1, compileAgentAssemblyV1 } from './agentAssembly.js'
import type { WorkflowAgentWorkerPortV1, WorkflowAgentWorkerResultV1 } from './agentDelegateTool.js'

type LocalWorkflowAgentWorkerOptionsV1 = Readonly<{
  parentRunId: string
  parentBudget: Readonly<ExecutionBudget>
  parentUsage: Readonly<BudgetUsage>
  provider: ChatProvider
  providerTarget: ChildProviderTarget
  modelCandidates?: readonly AgentModelCandidateV1[]
  toolCandidates: readonly ChildToolCandidate[]
  skills: readonly ChildSkillCandidate[]
  mcpTools: readonly RuntimeTool[]
  workspace: string
  parentTraceId: string
  launch: ChildRuntimeLaunch
  artifactStore: ArtifactStore
  permissionDecisions: ChildPermissionDecisionLifecyclePort
  home?: string
  progress?: (input: Readonly<{ nodeId: string; event: unknown }>) => void
  recordExecutionSnapshot?: (
    claim: WorkflowTaskClaimV1,
    ref: Readonly<{ id: string; version: 1; digest: `sha256:${string}` }>,
  ) => Promise<void>
  resolveInputRefs?: (claim: WorkflowTaskClaimV1) => Promise<readonly WorkflowArtifactRefV1[]>
}>

type PreparedWorkspaceIsolationV1 =
  | Readonly<{
      kind: 'git_worktree'
      targetPath: string
      value: WorkspaceIsolationV1
    }>
  | Readonly<{
      kind: 'directory_snapshot'
      targetPath: string
      value: DirectoryWorkspaceIsolationV1
    }>

/** Real Local Worker backed by the authenticated child Runtime process. */
export class LocalWorkflowAgentWorkerV1 implements WorkflowAgentWorkerPortV1 {
  readonly #host: ChildRuntimeHost
  readonly #delegation: ChildCredentialDelegationService
  readonly #mcpCapabilities = new Map<string, ReturnType<typeof bindChildMcpBrokerCapability>>()
  readonly #home: string
  readonly #git = new GitCliCommandPortV1(120_000)
  readonly #isolationManager: WorkspaceIsolationManagerV1
  readonly #directoryIsolationManager: DirectoryWorkspaceIsolationManagerV1

  constructor(private readonly options: LocalWorkflowAgentWorkerOptionsV1) {
    this.#home = options.home ?? process.env.PRAXIS_HOME ?? join(homedir(), '.praxis')
    this.#isolationManager = new WorkspaceIsolationManagerV1({
      ownedRoot: join(this.#home, 'workflow-worktrees'),
      managerId: `workflow-${createHash('sha256').update(options.parentRunId).digest('hex').slice(0, 24)}`,
      git: this.#git,
    })
    this.#directoryIsolationManager = new DirectoryWorkspaceIsolationManagerV1({
      ownedRoot: join(this.#home, 'workflow-snapshots'),
      git: this.#git,
      mechanicalVerifier: passThroughVerifier('mechanical'),
      ruleVerifier: new RuleVerifierV1(),
    })
    const ledger = new InMemorySubagentAdmissionLedger()
    ledger.registerRootScope({
      runId: options.parentRunId,
      budget: options.parentBudget,
      usage: parentUsage(options.parentUsage),
    })
    const credentialBroker = new InMemoryChildCredentialBroker({
      provider: {
        stream: (target, request) => options.provider.stream({ ...request, model: target.model }),
        ...(options.provider.compact === undefined
          ? {}
          : {
              compact: (target, request) =>
                options.provider.compact!({ ...request, model: target.model }),
            }),
      },
    })
    this.#delegation = new ChildCredentialDelegationService({ broker: credentialBroker })
    const mcpBroker = new ChildMcpToolBroker((id) => this.#mcpCapabilities.get(id))
    this.#host = new ChildRuntimeHost({
      ledger,
      cancellation: new CancellationTree(),
      environment: process.env,
      permissionDecisions: options.permissionDecisions,
      credentialDelegation: this.#delegation,
      credentialBroker,
      mcpBroker,
      resultOverflow: {
        store: async ({ childRunId, text }) => {
          const artifact = await options.artifactStore.put(
            { childRunId, text },
            'application/vnd.praxis.subagent-output+json',
          )
          return {
            kind: 'artifact',
            ref: `artifact://${artifact.artifactId}`,
            digest: artifact.digest as `sha256:${string}`,
            mediaType: artifact.mimeType,
            summary: 'Full child output stored by the parent Runtime.',
          }
        },
      },
      evidenceOverflow: {
        store: async ({ childRunId, evidenceRefs }) => {
          const artifact = await options.artifactStore.put(
            {
              schemaVersion: 1,
              kind: 'subagent_evidence_manifest',
              childRunId,
              evidenceRefs,
            },
            'application/vnd.praxis.subagent-evidence-manifest+json',
          )
          return {
            kind: 'artifact',
            ref: `artifact://${artifact.artifactId}`,
            digest: artifact.digest as `sha256:${string}`,
            mediaType: artifact.mimeType,
            summary: `Full manifest for ${evidenceRefs.length} Child evidence references.`,
          }
        },
      },
      progress: {
        publish: ({ event, childRunId }) => options.progress?.({ nodeId: childRunId, event }),
      },
      handshakeTimeoutMs: 15_000,
      shutdownGraceMs: 1_000,
      noProgressTimeoutMs: LONG_LIVED_EXECUTION_POLICY_V1.childNoProgressMs,
    })
  }

  async execute(
    claim: WorkflowTaskClaimV1,
    _signal: AbortSignal,
  ): Promise<WorkflowAgentWorkerResultV1> {
    const task = claim.task
    const childRunId = task.attemptId
    const grant = capabilityGrant(task.payload.grant)
    const assembly = compileAgentAssemblyV1({
      profile: harnessProfile(task.payload.harnessProfile ?? task.payload.profileId),
      request: assemblyRequest(task.payload.assemblyRequest),
      parentTarget: this.options.providerTarget,
      candidates: this.options.modelCandidates ?? [
        defaultModelCandidate(this.options.providerTarget),
      ],
    })
    const inputRefs = uniqueArtifactRefs([
      ...workflowInputRefs(task.payload.inputRefs),
      ...((await this.options.resolveInputRefs?.(claim)) ?? []),
    ])
    const relevantRefs = await contextReferences(inputRefs, this.options.artifactStore)
    const artifactAccess = await inheritedArtifactAccessV1(inputRefs, this.options.artifactStore)
    const access = grant.workspace === 'write' ? 'workspace_write' : 'read_only'
    const isolation =
      access === 'workspace_write' ? await this.prepareIsolation(claim, _signal) : undefined
    const executionWorkspace = isolation?.targetPath ?? this.options.workspace
    const budget = taskBudget(task, this.options.parentBudget)
    const deadlineAt = budget.deadlineAt!
    const credential = await this.#delegation.delegate({
      parentRunId: this.options.parentRunId,
      childRunId,
      target: assembly.target,
      deadlineAt,
      ...(budget.maxTokens === undefined ? {} : { maxTokens: budget.maxTokens }),
    })
    const selectedTools = selectBuiltinTools(this.options.toolCandidates, grant.tools, access)
    const selectedSkills = selectSkills(this.options.skills, grant.skills)
    const selectedMcp = grant.network
      ? selectMcp(
          this.options.mcpTools,
          [...new Set([...grant.mcpServers, ...grant.tools])],
          access,
        )
      : []
    const mcpGrants = selectedMcp.map((tool) => mcpGrant(tool, childRunId))
    const mcpMode = mcpGrants.length === 0 ? ('disabled' as const) : ('parent_broker' as const)
    const bundle = compileChildCapabilityBundle({
      bundleId: `bundle-${childRunId}`,
      parent: {
        workspace: executionWorkspace,
        providerTargets: (
          this.options.modelCandidates ?? [defaultModelCandidate(this.options.providerTarget)]
        ).map(({ target }) => target),
        tools: selectedTools,
        skills: selectedSkills,
        ...(mcpMode === 'disabled'
          ? {}
          : { mcp: { mode: 'parent_broker' as const, toolGrants: mcpGrants } }),
      },
      workspace: { root: executionWorkspace, access },
      provider: { target: assembly.target, credential },
      step: {
        toolNames: selectedTools.map(({ definition }) => definition.name),
        skillIds: selectedSkills.map(({ id }) => id),
        methodAllowlist: CHILD_BOOTSTRAP_METHODS,
        mcpMode,
      },
      policy: {
        toolNames: this.options.toolCandidates.map(({ definition }) => definition.name),
        skillIds: this.options.skills.map(({ id }) => id),
        methodAllowlist: CHILD_BOOTSTRAP_METHODS,
        providerTargets: (
          this.options.modelCandidates ?? [defaultModelCandidate(this.options.providerTarget)]
        ).map(({ target }) => target),
        mcpModes: ['disabled', 'parent_broker'],
      },
      isolation: {
        builtinToolNames: this.options.toolCandidates
          .filter(({ source }) => source === 'builtin')
          .map(({ definition }) => definition.name),
        allowInlineSkills: true,
        methodAllowlist: CHILD_BOOTSTRAP_METHODS,
        providerTargets: (
          this.options.modelCandidates ?? [defaultModelCandidate(this.options.providerTarget)]
        ).map(({ target }) => target),
        credentialKinds: ['none', 'broker_handle'],
        mcpModes: ['disabled', 'parent_broker'],
      },
    }).bundle
    for (const [index, tool] of selectedMcp.entries()) {
      const mcp = mcpGrants[index]!
      this.#mcpCapabilities.set(
        mcp.brokerCapabilityId,
        bindChildMcpBrokerCapability(mcp, tool, {
          parentRunId: this.options.parentRunId,
          childRunId,
          workspace: executionWorkspace,
          bundleId: bundle.bundleId,
          bundleDigest: bundle.digest,
        }),
      )
    }
    const executionSnapshot = await this.options.artifactStore.put(
      {
        schemaVersion: 1,
        kind: 'workflow_execution_snapshot',
        workflowId: task.workflowId,
        taskId: task.taskId,
        attemptId: task.attemptId,
        parentRunId: this.options.parentRunId,
        requestedAssembly: task.payload.assemblyRequest,
        effectiveAssembly: assembly,
        provider: assembly.target,
        workspace: executionWorkspace,
        requestedCapabilities: task.payload.capabilityRequest,
        grant,
        capabilityAttenuation: capabilityAttenuation(
          task.payload.capabilityRequest,
          grant,
          bundle.tools.map(({ name }) => name),
          bundle.skills.map(({ id }) => id),
          selectedMcp.map(({ definition }) => definition.name),
        ),
        budget,
        capabilityBundleDigest: bundle.digest,
        inputRefs,
        tools: bundle.tools.map(({ name, definitionDigest }) => ({ name, definitionDigest })),
        skills: bundle.skills.map(({ id, digest }) => ({ id, digest })),
        mcp:
          bundle.mcp.mode === 'parent_broker'
            ? bundle.mcp.toolGrants.map(({ name, definitionDigest }) => ({
                name,
                definitionDigest,
              }))
            : [],
        createdAt: new Date().toISOString(),
      },
      'application/vnd.praxis.workflow-execution-snapshot+json',
    )
    await this.options.recordExecutionSnapshot?.(claim, {
      id: executionSnapshot.artifactId,
      version: 1,
      digest: executionSnapshot.digest as `sha256:${string}`,
    })
    const childParentRoot = join(this.#home, 'children', this.options.parentRunId)
    await mkdir(childParentRoot, { recursive: true })
    const childRoot = join(childParentRoot, childRunId)
    const objective = String(task.payload.objective)
    const result = await this.#host.run({
      packet: {
        schemaVersion: 1,
        packetId: `packet-${childRunId}`,
        parentRunId: this.options.parentRunId,
        childRunId,
        objective,
        step: {
          stepId: task.nodeId,
          title: workflowStepTitle(objective),
          instructions: `${assembly.instructions}\n\nComplete the delegated objective using only the effective capabilities. Return ${assembly.result.format} content inside the required result envelope.`,
        },
        constraints: [
          'Stay inside the declared workspace and capability grant.',
          'Do not invoke Praxis recursively.',
          'Return an evidence-grounded concise result.',
        ],
        relevantRefs,
        successCriteria: assembly.successCriteria,
        workspace: bundle.workspace,
        grant: {
          bundleId: bundle.bundleId,
          bundleDigest: bundle.digest,
          provider: bundle.provider.target,
          tools: bundle.tools.map(({ name }) => name),
          skills: bundle.skills.map(({ id }) => id),
          methods: [...bundle.methodAllowlist],
          mcpMode: bundle.mcp.mode,
        },
        budget,
        prohibitions: [
          'Do not spawn descendants.',
          'Do not access paths outside the workspace.',
          'Do not push or publish unless explicitly granted.',
        ],
        outputSchema: {
          format: 'json',
          schema: childResultEnvelopeSchema(assembly.result.format, assembly.result.schema),
          maxInlineBytes: Math.min(SUBAGENT_SUMMARY_MAX_BYTES, assembly.result.maxInlineBytes),
          overflow: 'artifact_ref',
        },
      },
      parentUsage: parentUsage(this.options.parentUsage),
      launch: this.options.launch,
      bootstrapProfile: {
        schemaVersion: 3,
        workspace: bundle.workspace,
        methodAllowlist: CHILD_BOOTSTRAP_METHODS,
        ephemeral: {
          root: childRoot,
          sessionRoot: join(childRoot, 'sessions'),
          traceRoot: join(childRoot, 'traces'),
          artifactRoot: join(childRoot, 'artifacts'),
          retention: 'retain_on_failure',
        },
        provider: bundle.provider.target,
        ...(artifactAccess === undefined ? {} : { artifactAccess }),
        reasoningEffort: assembly.reasoningEffort,
        capabilityBundleDigest: bundle.digest,
        capabilityBundle: bundle,
        deadlineAt,
        trace: {
          traceId: `trace-${childRunId}`,
          parentTraceId: this.options.parentTraceId,
        },
      },
    })
    const storedResult = await this.options.artifactStore.put(
      result,
      'application/vnd.praxis.workflow-agent-result+json',
    )
    const criterionFailed = result.checks.some(({ status }) => status !== 'passed')
    const workerResult: WorkflowAgentWorkerResultV1 = {
      ok: result.status === 'succeeded' && !criterionFailed,
      summary: result.summary,
      output: {
        ...(JSON.parse(JSON.stringify(result)) as Record<string, unknown>),
        assembly,
      },
      artifacts: [
        {
          artifactId: storedResult.artifactId,
          digest: storedResult.digest as `sha256:${string}`,
          mediaType: storedResult.mimeType,
        },
      ],
      errorCode: criterionFailed ? 'CHILD_SUCCESS_CRITERION_FAILED' : result.error?.code,
      retryable: result.retryable,
      usage: result.usage,
    }
    if (isolation === undefined) return workerResult
    const mergeableResult = mergeableWorkspaceResult(result)
    if (mergeableResult === undefined) {
      return {
        ...workerResult,
        output: {
          ...workerResult.output,
          workspaceRecoveryPath: isolation.targetPath,
        },
      }
    }
    return isolation.kind === 'git_worktree'
      ? this.mergeIsolatedResult(claim, isolation.value, mergeableResult, _signal)
      : this.mergeDirectoryResult(claim, isolation.value, mergeableResult, _signal)
  }

  async cancel(claim: WorkflowTaskClaimV1): Promise<void> {
    this.#host.cancel(claim.task.attemptId, 'parent_cancelled')
  }

  private async prepareIsolation(
    claim: WorkflowTaskClaimV1,
    signal: AbortSignal,
  ): Promise<PreparedWorkspaceIsolationV1> {
    const [head, topLevel] = await Promise.all([
      this.#git.run({
        cwd: this.options.workspace,
        args: ['rev-parse', 'HEAD'],
        signal,
      }),
      this.#git.run({
        cwd: this.options.workspace,
        args: ['rev-parse', '--show-toplevel'],
        signal,
      }),
    ])
    const slug = claim.task.attemptId.toLowerCase().slice(0, 48)
    if (
      head.exitCode === 0 &&
      topLevel.exitCode === 0 &&
      resolve(topLevel.stdout.trim()).toLowerCase() ===
        resolve(this.options.workspace).toLowerCase() &&
      /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(head.stdout.trim())
    ) {
      return {
        kind: 'git_worktree',
        targetPath: join(this.#home, 'workflow-worktrees', slug),
        value: await this.#isolationManager.create({
          repoRoot: this.options.workspace,
          slug,
          targetPath: join(this.#home, 'workflow-worktrees', slug),
          baseCommit: head.stdout.trim(),
          copyPolicy: { ignored: 'exclude', secrets: 'exclude' },
          signal,
        }),
      }
    }
    const step = workspaceWriteStep(claim, this.options.parentBudget)
    const snapshot = await this.#directoryIsolationManager.create({
      workspaceRoot: this.options.workspace,
      slug,
      step,
      signal,
    })
    return { kind: 'directory_snapshot', targetPath: snapshot.targetPath, value: snapshot }
  }

  private async mergeDirectoryResult(
    claim: WorkflowTaskClaimV1,
    isolation: DirectoryWorkspaceIsolationV1,
    result: import('@praxis/core-sdk').SubagentResultV1,
    signal: AbortSignal,
  ): Promise<WorkflowAgentWorkerResultV1> {
    const merged = await this.#directoryIsolationManager.merge({
      isolation,
      step: workspaceWriteStep(claim, this.options.parentBudget),
      result,
      signal,
    })
    const artifact = await this.options.artifactStore.put(
      { schemaVersion: 1, isolation: 'directory_snapshot', result, workspaceMerge: merged },
      'application/vnd.praxis.workflow-directory-merge+json',
    )
    return {
      ok: merged.status === 'succeeded',
      summary:
        merged.status === 'succeeded'
          ? `${result.summary} Snapshot changes were verified and applied.`
          : `Snapshot changes were retained for recovery (${merged.code}).`,
      output: { result, workspaceMerge: merged },
      artifacts: [
        {
          artifactId: artifact.artifactId,
          digest: artifact.digest as `sha256:${string}`,
          mediaType: artifact.mimeType,
        },
      ],
      errorCode: merged.status === 'succeeded' ? undefined : merged.code,
      retryable: false,
    }
  }

  private async mergeIsolatedResult(
    claim: WorkflowTaskClaimV1,
    isolation: WorkspaceIsolationV1,
    result: import('@praxis/core-sdk').SubagentResultV1,
    signal: AbortSignal,
  ): Promise<WorkflowAgentWorkerResultV1> {
    const status = await this.#git.run({
      cwd: isolation.targetPath,
      args: ['status', '--porcelain=v1', '--untracked-files=all'],
      signal,
    })
    if (status.exitCode !== 0)
      throw workflowWorkerError('WORKSPACE_COMMIT_INSPECTION_FAILED', status.stderr)
    if (status.stdout.length === 0) {
      const cleanup = await this.#isolationManager.cleanup({ isolation, signal })
      return {
        ok: true,
        summary: result.summary,
        output: { result, workspaceMerge: { code: cleanup.code, changed: false } },
      }
    }
    for (const args of [
      ['add', '--all'],
      [
        '-c',
        'user.name=Praxis Workflow Worker',
        '-c',
        'user.email=workflow@praxis.local',
        '-c',
        'core.hooksPath=/dev/null',
        'commit',
        '-m',
        `praxis workflow ${claim.task.nodeId}`,
      ],
    ] as const) {
      const command = await this.#git.run({ cwd: isolation.targetPath, args, signal })
      if (command.exitCode !== 0)
        throw workflowWorkerError('WORKSPACE_CANDIDATE_COMMIT_FAILED', command.stderr)
    }
    const head = await this.#git.run({
      cwd: isolation.targetPath,
      args: ['rev-parse', 'HEAD'],
      signal,
    })
    const commit = head.stdout.trim()
    const patch = await this.#git.run({
      cwd: isolation.targetPath,
      args: [
        'diff',
        '--binary',
        '--full-index',
        '--no-ext-diff',
        '--no-renames',
        isolation.baseCommit,
        commit,
        '--',
      ],
      signal,
      maxOutputBytes: 4 * 1024 * 1024,
    })
    if (head.exitCode !== 0 || patch.exitCode !== 0)
      throw workflowWorkerError('WORKSPACE_CANDIDATE_COMMIT_FAILED', patch.stderr)
    const artifact: WorkspaceMergeArtifactV1 = {
      schemaVersion: 1,
      baseCommit: isolation.baseCommit,
      commit,
      patch: {
        format: 'git-diff-binary-v1',
        bytes: Buffer.byteLength(patch.stdout),
        digest: sha256(patch.stdout),
        content: patch.stdout,
      },
      result,
    }
    const merger = new ControlledWorkspaceMergeV1({
      isolationManager: this.#isolationManager,
      mechanicalVerifier: passThroughVerifier('mechanical'),
      ruleVerifier: new RuleVerifierV1(),
      git: this.#git,
    })
    const merged = await merger.execute({
      step: workspaceWriteStep(claim, this.options.parentBudget),
      isolation,
      artifact,
      signal,
    })
    const stored = await this.options.artifactStore.put(
      artifact,
      'application/vnd.praxis.workflow-workspace-merge+json',
    )
    return {
      ok: merged.status === 'succeeded',
      summary:
        merged.status === 'succeeded'
          ? `${result.summary} Candidate commit ${commit.slice(0, 12)} was verified and merged.`
          : `Candidate changes were retained for recovery (${merged.code}).`,
      output: { result, workspaceMerge: merged },
      artifacts: [
        {
          artifactId: stored.artifactId,
          digest: stored.digest as `sha256:${string}`,
          mediaType: stored.mimeType,
        },
      ],
      errorCode: merged.status === 'succeeded' ? undefined : merged.code,
      retryable: false,
    }
  }
}

function harnessProfile(value: unknown): AgentHarnessProfileV1 {
  if (value === 'worker' || value === 'explorer' || value === 'default') return value
  if (value === 'coder') return 'worker'
  if (value === 'researcher' || value === 'reviewer' || value === 'verifier') return 'explorer'
  return 'default'
}

function assemblyRequest(value: unknown): AgentAssemblyRequestV1 | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as AgentAssemblyRequestV1)
    : undefined
}

function defaultModelCandidate(target: ChildProviderTarget): AgentModelCandidateV1 {
  return {
    target,
    reasoningLevels: ['none', 'low', 'medium', 'high'],
    speedRank: 0,
    powerRank: 0,
  }
}

function childResultEnvelopeSchema(
  format: 'text' | 'markdown' | 'json',
  resultSchema: Readonly<Record<string, unknown>>,
): import('../subagent/contextPacket.js').ContextPacketV1['outputSchema']['schema'] {
  const result =
    format === 'json'
      ? resultSchema
      : { type: 'string', description: format === 'markdown' ? 'Markdown result.' : 'Text result.' }
  return JSON.parse(
    JSON.stringify({
      type: 'object',
      additionalProperties: false,
      required: ['summary', 'result', 'criteria'],
      properties: {
        summary: { type: 'string' },
        result,
        criteria: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'status', 'summary'],
            properties: {
              id: { type: 'string' },
              status: { enum: ['passed', 'failed', 'skipped'] },
              summary: { type: 'string' },
              evidenceRef: { type: 'string' },
            },
          },
        },
      },
    }),
  ) as import('../subagent/contextPacket.js').ContextPacketV1['outputSchema']['schema']
}

function workflowInputRefs(value: unknown): readonly WorkflowArtifactRefV1[] {
  if (!Array.isArray(value)) return []
  return value.filter((candidate): candidate is WorkflowArtifactRefV1 => {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate))
      return false
    const record = candidate as Record<string, unknown>
    return (
      typeof record.artifactId === 'string' &&
      typeof record.digest === 'string' &&
      /^sha256:[a-f0-9]{64}$/.test(record.digest) &&
      typeof record.mediaType === 'string'
    )
  })
}

function uniqueArtifactRefs(refs: readonly WorkflowArtifactRefV1[]) {
  return [...new Map(refs.map((ref) => [ref.artifactId, ref])).values()]
}

async function contextReferences(refs: readonly WorkflowArtifactRefV1[], store: ArtifactStore) {
  return Promise.all(
    refs.slice(0, 32).map(async (ref) => {
      let summary = 'Dependency result is available as a parent-owned artifact.'
      try {
        const serialized = JSON.stringify(await store.read(ref.artifactId))
        summary = boundedUtf8Summary(serialized, 1_024)
      } catch {
        // A durable ref remains useful even when a remote or retained artifact
        // is temporarily unavailable; execution snapshot records the exact ref.
      }
      return {
        kind: 'result' as const,
        ref: `artifact://${ref.artifactId}`,
        digest: ref.digest,
        summary,
      }
    }),
  )
}

/**
 * Grants a Child read-only access to exactly the parent-owned input artifact
 * closure it was admitted with. This includes overflow output and evidence
 * manifests referenced by a Workflow result wrapper, while excluding every
 * unrelated artifact in the parent store.
 */
export async function inheritedArtifactAccessV1(
  refs: readonly WorkflowArtifactRefV1[],
  store: ArtifactStore,
): Promise<ChildBootstrapProfileV3['artifactAccess'] | undefined> {
  if (refs.length === 0) return undefined
  const pending = refs.map(({ artifactId }) => artifactId)
  const granted = new Set<string>()
  while (pending.length > 0) {
    const artifactId = pending.shift()!
    if (granted.has(artifactId)) continue
    let value: unknown
    try {
      value = await store.read(artifactId)
    } catch {
      throw workflowWorkerError(
        'WORKFLOW_INPUT_ARTIFACT_UNAVAILABLE',
        'A persisted Workflow input artifact is unavailable to the admitted Child.',
      )
    }
    granted.add(artifactId)
    for (const nested of nestedArtifactIds(value)) {
      if (!granted.has(nested)) pending.push(nested)
    }
  }
  return {
    root: resolve(store.rootDirectory()),
    artifactIds: [...granted].sort(),
  }
}

function nestedArtifactIds(value: unknown): readonly string[] {
  const found = new Set<string>()
  const pending: unknown[] = [value]
  const visited = new Set<object>()
  while (pending.length > 0) {
    const candidate = pending.pop()
    if (typeof candidate === 'string') {
      const match = /^artifact:\/\/(artifact-[a-f0-9]{64})$/.exec(candidate)
      if (match !== null) found.add(match[1]!)
      continue
    }
    if (typeof candidate !== 'object' || candidate === null || visited.has(candidate)) continue
    visited.add(candidate)
    if (Array.isArray(candidate)) pending.push(...candidate)
    else pending.push(...Object.values(candidate as Record<string, unknown>))
  }
  return [...found]
}

/**
 * Context-packet string limits are UTF-8 byte limits, not JavaScript UTF-16
 * code-unit limits. Preserve whole Unicode code points while leaving room for
 * the truncation marker so multilingual dependency results remain admissible.
 */
export function boundedUtf8Summary(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value
  const marker = '...'
  const contentLimit = Math.max(0, maxBytes - Buffer.byteLength(marker, 'utf8'))
  let bytes = 0
  let summary = ''
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8')
    if (bytes + characterBytes > contentLimit) break
    summary += character
    bytes += characterBytes
  }
  return `${summary}${marker}`
}

/**
 * A workflow objective may use the context packet's full 8 KiB allowance, while
 * the human-readable step title is deliberately capped at 1 KiB. Keep the full
 * objective in its authoritative field and derive a compact, UTF-8-safe title
 * instead of duplicating an arbitrarily long objective into the title field.
 */
export function workflowStepTitle(objective: string): string {
  const firstNonEmptyLine = objective
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  return boundedUtf8Summary(firstNonEmptyLine ?? 'Delegated workflow step', 1_024)
}

function capabilityGrant(value: unknown) {
  const input = (typeof value === 'object' && value !== null ? value : {}) as {
    tools?: readonly string[]
    skills?: readonly string[]
    mcpServers?: readonly string[]
    workspace?: 'none' | 'read' | 'write'
    network?: boolean
  }
  return {
    tools: input.tools ?? ['*'],
    skills: input.skills ?? ['*'],
    mcpServers: input.mcpServers ?? ['*'],
    workspace: input.workspace ?? 'read',
    network: input.network === true,
  }
}

function capabilityAttenuation(
  requestedValue: unknown,
  admitted: ReturnType<typeof capabilityGrant>,
  tools: readonly string[],
  skills: readonly string[],
  mcpTools: readonly string[],
) {
  const requested = capabilityGrant(requestedValue)
  const denied: Array<Readonly<{ kind: string; id: string; reason: string }>> = []
  const admittedName = (name: string, values: readonly string[]) =>
    values.includes('*') || values.includes(name)
  if (!requested.tools.includes('*')) {
    for (const name of requested.tools) {
      if (!admittedName(name, admitted.tools)) {
        denied.push({ kind: 'tool', id: name, reason: 'parent_or_profile_denied' })
      } else if (!tools.includes(name) && !mcpTools.includes(name)) {
        denied.push({ kind: 'tool', id: name, reason: 'not_available' })
      }
    }
  }
  if (!requested.skills.includes('*')) {
    for (const id of requested.skills) {
      if (!admittedName(id, admitted.skills)) {
        denied.push({ kind: 'skill', id, reason: 'parent_or_profile_denied' })
      } else if (!skills.includes(id)) {
        denied.push({ kind: 'skill', id, reason: 'not_available' })
      }
    }
  }
  if (!requested.mcpServers.includes('*')) {
    for (const id of requested.mcpServers) {
      if (!admittedName(id, admitted.mcpServers)) {
        denied.push({ kind: 'mcp', id, reason: 'parent_or_profile_denied' })
      } else if (!admitted.network) {
        denied.push({ kind: 'mcp', id, reason: 'network_denied' })
      } else if (!mcpTools.some((name) => selectedExternal(name, [id]))) {
        denied.push({ kind: 'mcp', id, reason: 'not_available' })
      }
    }
  }
  if (requested.network && !admitted.network) {
    denied.push({ kind: 'network', id: 'network', reason: 'parent_denied' })
  }
  if (requested.workspace !== admitted.workspace) {
    denied.push({ kind: 'workspace', id: requested.workspace, reason: 'parent_denied' })
  }
  return {
    requested,
    admitted,
    effective: {
      tools,
      skills,
      mcpTools,
      workspace: admitted.workspace,
      network: admitted.network,
    },
    denied,
  }
}

function selected(name: string, requested: readonly string[]): boolean {
  return requested.includes('*') || requested.includes(name)
}

function selectBuiltinTools(
  candidates: readonly ChildToolCandidate[],
  requested: readonly string[],
  access: 'read_only' | 'workspace_write',
) {
  return candidates.filter(({ source, definition }) => {
    if (source !== 'builtin' || !selected(definition.name, requested)) return false
    const effect = definition.execution?.sideEffect
    return (
      access === 'workspace_write' || effect === undefined || effect === 'none' || effect === 'read'
    )
  })
}

function selectSkills(candidates: readonly ChildSkillCandidate[], requested: readonly string[]) {
  return candidates.filter(({ id }) => selected(id, requested))
}

function selectMcp(
  candidates: readonly RuntimeTool[],
  requested: readonly string[],
  access: 'read_only' | 'workspace_write',
) {
  return candidates.filter(({ definition }) => {
    const effect = definition.execution?.sideEffect
    return (
      selectedExternal(definition.name, requested) &&
      (access === 'workspace_write' ||
        effect === undefined ||
        effect === 'none' ||
        effect === 'read')
    )
  })
}

function selectedExternal(name: string, requested: readonly string[]): boolean {
  if (selected(name, requested)) return true
  return requested.some((serverId) => name.includes(`__${boundedNamePart(serverId, 8)}__`))
}

function boundedNamePart(value: string, visibleBytes: number): string {
  const visible =
    value
      .normalize('NFKC')
      .replace(/[^A-Za-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, visibleBytes) || 'id'
  return `${visible}_${createHash('sha256').update(value).digest('hex').slice(0, 8)}`
}

function mcpGrant(tool: RuntimeTool, childRunId: string): McpToolGrant {
  return {
    name: tool.definition.name,
    definition: structuredClone(tool.definition),
    definitionDigest: digestToolDefinition(tool.definition),
    brokerCapabilityId: `mcp-${createHash('sha256').update(`${childRunId}:${tool.definition.name}`).digest('hex').slice(0, 24)}`,
  }
}

function taskBudget(
  task: WorkflowTaskClaimV1['task'],
  parent: Readonly<ExecutionBudget>,
): ExecutionBudget {
  const requested =
    typeof task.payload.budget === 'object' && task.payload.budget !== null
      ? (task.payload.budget as import('@praxis/core-sdk').AgentBudgetRequestV1)
      : undefined
  const deadlineAt = earliestCanonicalDeadline(
    ...[task.deadlineAt, parent.deadlineAt].filter((value): value is string => value !== undefined),
  )
  return {
    maxTurns: Math.max(
      1,
      Math.min(parent.maxTurns, requested?.maxTurns ?? LONG_LIVED_EXECUTION_POLICY_V1.maxTurns),
    ),
    maxToolCalls: Math.max(
      1,
      Math.min(
        parent.maxToolCalls,
        requested?.maxToolCalls ?? LONG_LIVED_EXECUTION_POLICY_V1.maxToolCalls,
      ),
    ),
    ...(parent.maxTokens === undefined && requested?.maxTokens === undefined
      ? {}
      : {
          maxTokens: Math.max(
            1,
            Math.min(
              parent.maxTokens ?? Number.MAX_SAFE_INTEGER,
              requested?.maxTokens ?? Number.MAX_SAFE_INTEGER,
            ),
          ),
        }),
    maxChildRuns: 0,
    maxParallelChildren: 0,
    maxDepth: 0,
    deadlineAt,
  }
}

function workspaceWriteStep(
  claim: WorkflowTaskClaimV1,
  parentBudget: Readonly<ExecutionBudget>,
): import('@praxis/core-sdk').SessionStepProjectionV3 {
  return {
    stepId: claim.task.nodeId,
    title: String(claim.task.payload.objective),
    order: 0,
    state: 'verifying',
    dependencies: [],
    access: { mode: 'workspace_write', paths: ['.'] },
    capabilities: [],
    conflictKeys: claim.task.conflictKeys.includes('workspace')
      ? claim.task.conflictKeys
      : ['workspace', ...claim.task.conflictKeys],
    criteria: [],
    budget: taskBudget(claim.task, parentBudget),
    maxAttempts: claim.task.retry.maxAttempts,
    attemptIds: [claim.task.attemptId],
    attempts: [],
  }
}

export function mergeableWorkspaceResult(
  result: import('@praxis/core-sdk').SubagentResultV1,
): import('@praxis/core-sdk').SubagentResultV1 | undefined {
  if (result.status === 'succeeded') return result
  if (
    result.status !== 'cancelled' ||
    result.error?.code !== 'CHILD_DEADLINE_EXCEEDED' ||
    result.changedFiles.length === 0 ||
    result.evidenceRefs.length === 0
  ) {
    return undefined
  }
  const { error: _error, ...completed } = result
  return {
    ...completed,
    status: 'succeeded',
    summary: `${result.summary} Completed workspace mutations were preserved for parent verification.`,
    retryable: false,
  }
}

function parentUsage(usage: Readonly<BudgetUsage>) {
  return {
    turns: usage.turns,
    toolCalls: usage.toolCalls,
    ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
    ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
    ...(usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadTokens }),
    ...(usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: usage.cacheWriteTokens }),
    ...(usage.costUsd === undefined ? {} : { costUsd: usage.costUsd }),
  }
}

function passThroughVerifier(verifier: 'mechanical'): SupervisorVerifierV1 {
  return {
    verify: async () => ({
      verifier,
      status: 'passed',
      evidenceRefs: [],
      code: 'WORKSPACE_CANDIDATE_STRUCTURALLY_VALID',
      retryable: false,
    }),
  }
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function workflowWorkerError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code, category: 'planner', retryable: false })
}

export function dependencyResultRefsV1(
  projection: WorkflowProjectionV1,
  nodeId: string,
): readonly WorkflowArtifactRefV1[] {
  const predecessorIds = new Set(
    projection.spec.edges.filter(({ to }) => to === nodeId).map(({ from }) => from),
  )
  return projection.nodes.flatMap((node) =>
    predecessorIds.has(node.nodeId) && node.resultRef !== undefined ? [node.resultRef] : [],
  )
}
