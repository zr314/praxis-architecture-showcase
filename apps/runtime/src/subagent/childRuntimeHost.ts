import { createHash } from 'node:crypto'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { PraxisClient } from '@praxis/client'
import {
  type BudgetUsage,
  type CancellationReason,
  type ExecutionBudget,
  isSkillInvocationEntry,
  runtimeError,
  type SubagentEvidenceRefV1,
} from '@praxis/core-sdk'
import type { PromptInput, SessionEvent } from '@praxis/protocol'
import { PRAXIS_PRODUCT_VERSION } from '@praxis/protocol'
import Ajv2020 from 'ajv/dist/2020.js'
import { type LongDurationTimer, scheduleLongDurationTimer } from '../longDurationTimer.js'
import {
  CompositeProcessIpcController,
  NdjsonProcessConnection,
  type ProcessConnectionFailureContext,
  type ProcessConnectionFailureKind,
  type ProcessMessageCodec,
} from '../process/ndjsonProcessConnection.js'
import { RuntimeProtocolConnection } from '../process/runtimeProtocolConnection.js'
import {
  type ChildBootstrapProfileInputV3,
  createChildBootstrapLaunch,
} from './childBootstrapProfile.js'
import { cleanupChildRuntimeComposition } from './childComposition.js'
import {
  assertChildExecutionMvp,
  type ChildPermissionDecisionPort,
  ChildPermissionGate,
} from './childPermissionGate.js'
import { CHILD_RESULT_SUBMISSION_TOOL_NAME } from './childResultSubmissionTool.js'
import {
  assertContextPacketAuthority,
  type ContextPacketV1,
  createSubagentResultV1,
  renderContextPacketPrompt,
  SUBAGENT_RESULT_MAX_EVIDENCE_REFS,
  type SubagentResultV1,
} from './contextPacket.js'
import { ChildCredentialBrokerIpcServer } from './credentialBrokerIpc.js'
import type { ChildCredentialBrokerPort } from './credentialDelegation.js'
import {
  DisabledSubagentRegistry,
  type PreparedSubagent,
  type SubagentAdmission,
  type SubagentAdmissionLedger,
  type SubagentCancellationPort,
  type SubagentParentUsage,
} from './index.js'
import { ChildMcpBrokerIpcServer, type ChildMcpBrokerPort } from './mcpBrokerIpc.js'

export type ChildRuntimeLaunch = { command: string; args?: string[]; cwd?: string }

export type ChildRuntimeHostOptions = {
  ledger: SubagentAdmissionLedger
  cancellation: SubagentCancellationPort
  registry?: DisabledSubagentRegistry
  /** @deprecated Use handshakeTimeoutMs. */
  requestTimeoutMs?: number
  handshakeTimeoutMs?: number
  shutdownGraceMs?: number
  /** Abort a child that emits no model/tool progress for this interval. Omitted means disabled. */
  noProgressTimeoutMs?: number
  environment?: NodeJS.ProcessEnv
  permissionDecisions?: ChildPermissionDecisionPort
  trace?: ChildRuntimeTracePort
  credentialDelegation?: Readonly<{
    revokeChild(parentRunId: string, childRunId: string): void | Promise<void>
  }>
  credentialBroker?: Pick<ChildCredentialBrokerPort, 'invoke' | 'compact'>
  mcpBroker?: ChildMcpBrokerPort
  resultOverflow?: Readonly<{
    store(input: {
      parentRunId: string
      childRunId: string
      text: string
    }): Promise<SubagentEvidenceRefV1>
  }>
  evidenceOverflow?: Readonly<{
    store(input: {
      parentRunId: string
      childRunId: string
      evidenceRefs: readonly SubagentEvidenceRefV1[]
    }): Promise<SubagentEvidenceRefV1>
  }>
  progress?: ChildRuntimeProgressPortV1
}

export type ChildRuntimeProgressEventV1 = Extract<
  SessionEvent,
  { type: 'thinking_delta' | 'tool_start' | 'tool_update' | 'tool_end' }
>

export type ChildRuntimeProgressPortV1 = Readonly<{
  publish(input: {
    parentRunId: string
    childRunId: string
    stepId: string
    event: ChildRuntimeProgressEventV1
  }): void
}>

type ChildRuntimeBaseRun = {
  parentRunId: string
  childRunId: string
  requestedBudget: ExecutionBudget
  parentUsage: SubagentParentUsage
  launch: ChildRuntimeLaunch
}

type ChildRuntimeBootstrapProfile = Omit<
  ChildBootstrapProfileInputV3,
  'parentRunId' | 'childRunId' | 'budget' | 'admission'
>

export type ChildRuntimeRun = {
  packet: ContextPacketV1
  parentUsage: SubagentParentUsage
  launch: ChildRuntimeLaunch
  bootstrapProfile: ChildRuntimeBootstrapProfile
  permissionDecisions?: ChildPermissionDecisionPort
}

export type ChildRuntimeRequest = { method: string; params: Record<string, unknown> }

export type ChildRuntimeTraceEventV1 = Readonly<{
  schemaVersion: 1
  phase: 'launch' | 'accepted' | 'terminal'
  timestamp: string
  parentRunId: string
  childRunId: string
  traceId: string
  parentTraceId?: string
  outcome?: 'succeeded' | 'failed' | 'cancelled'
  code?: string
  stderr?: Readonly<{
    capturedBytes: number
    totalBytes: number
    truncated: boolean
    digest: `sha256:${string}`
  }>
}>

export type ChildRuntimeTracePort = Readonly<{
  record(event: ChildRuntimeTraceEventV1): void | Promise<void>
}>

/** Test-only transport input. It intentionally does not model a production child session. */
export type ChildRuntimeFixtureRun = ChildRuntimeBaseRun & {
  bootstrapProfile?: ChildRuntimeBootstrapProfile
  request: ChildRuntimeRequest
}

export type ChildRuntimeTerminalEvent = Extract<
  SessionEvent,
  { type: 'prompt_completed' | 'prompt_failed' | 'prompt_aborted' }
>

type ClosableChildConnection = {
  close(): Promise<void>
  cancel?(reason: CancellationReason): void
  cancellationReason?(): CancellationReason | undefined
  complete?(): void
  readonly stderr?: string
  readonly stderrCapturedBytes?: number
  readonly stderrTotalBytes?: number
  readonly stderrTruncated?: boolean
}

type ChildExecutionContext = Readonly<{
  prepared: PreparedSubagent
  bootstrapLaunch?: ReturnType<typeof createChildBootstrapLaunch>
  attachConnection(connection: ClosableChildConnection): void
  acceptExecution(): void
}>

type ChildExecutionResult<T> = Readonly<{
  result: T
  usage?: BudgetUsage
  failed?: boolean
}>

/** Launches a bounded child Runtime and connects it to the existing budget/cancellation ledger. */
export class ChildRuntimeHost {
  private readonly registry: DisabledSubagentRegistry
  private readonly handshakeTimeoutMs: number
  private readonly shutdownGraceMs: number
  private readonly noProgressTimeoutMs?: number
  private readonly children = new Map<string, ClosableChildConnection>()

  constructor(private readonly options: ChildRuntimeHostOptions) {
    this.registry = options.registry ?? new DisabledSubagentRegistry()
    this.handshakeTimeoutMs = Math.max(
      1,
      Math.floor(options.handshakeTimeoutMs ?? options.requestTimeoutMs ?? 5_000),
    )
    this.shutdownGraceMs = Math.max(50, Math.floor(options.shutdownGraceMs ?? 1_000))
    this.noProgressTimeoutMs =
      options.noProgressTimeoutMs === undefined
        ? undefined
        : Math.max(1_000, Math.floor(options.noProgressTimeoutMs))
  }

  /** Execute one child prompt over the formal Runtime session protocol. */
  async run(input: ChildRuntimeRun): Promise<SubagentResultV1> {
    assertFormalSessionMethods(input.bootstrapProfile.methodAllowlist)
    const packet = assertContextPacketAuthority(input.packet, {
      workspace: input.bootstrapProfile.workspace,
      provider: input.bootstrapProfile.provider,
      capabilityBundle: input.bootstrapProfile.capabilityBundle,
    })
    assertChildExecutionMvp(packet, input.bootstrapProfile.capabilityBundle)
    const execution: ChildRuntimeBaseRun = {
      parentRunId: packet.parentRunId,
      childRunId: packet.childRunId,
      requestedBudget: packet.budget,
      parentUsage: input.parentUsage,
      launch: input.launch,
    }
    const pinnedContext = renderContextPacketPrompt(packet)
    return this.execute(
      execution,
      {
        ...input.bootstrapProfile,
        pinnedContext,
        resultSubmission: {
          toolName: CHILD_RESULT_SUBMISSION_TOOL_NAME,
          schema: packet.outputSchema.schema,
          criterionIds: packet.successCriteria.map(({ id }) => id),
        },
      },
      async (context) => {
        const launch = requireBootstrapLaunch(context.bootstrapLaunch)
        const budget = promptBudget(context.prepared.budget)
        const credential = launch.profile.capabilityBundle.provider.credential
        const credentialIpc =
          credential.kind === 'broker_handle'
            ? new ChildCredentialBrokerIpcServer({
                broker: this.options.credentialBroker,
                parentRunId: packet.parentRunId,
                childRunId: packet.childRunId,
                target: launch.profile.provider,
                handleId: credential.handleId,
              })
            : undefined
        const mcp = launch.profile.capabilityBundle.mcp
        const mcpIpc =
          mcp.mode === 'parent_broker'
            ? new ChildMcpBrokerIpcServer({
                broker: this.options.mcpBroker,
                parentRunId: packet.parentRunId,
                childRunId: packet.childRunId,
                workspace: packet.workspace.root,
                bundleId: launch.profile.capabilityBundle.bundleId,
                bundleDigest: launch.profile.capabilityBundle.digest,
                grants: mcp.toolGrants,
              })
            : undefined
        const privateIpcControllers = [
          ...(credentialIpc === undefined ? [] : [credentialIpc]),
          ...(mcpIpc === undefined ? [] : [mcpIpc]),
        ]
        const privateIpc =
          privateIpcControllers.length === 0
            ? undefined
            : new CompositeProcessIpcController(privateIpcControllers)
        const connection = new RuntimeProtocolConnection(
          execution.launch.command,
          execution.launch.args ?? [],
          {
            cwd: execution.launch.cwd,
            requestTimeoutMs: this.handshakeTimeoutMs,
            closeTimeoutMs: this.shutdownGraceMs,
            maxLineBytes: 64 * 1024,
            maxStderrBytes: 16 * 1024,
            stderr: process.env.PRAXIS_DEBUG_CHILD_STDERR === '1' ? 'inherit' : 'capture',
            env: childRuntimeEnvironment(this.options.environment ?? process.env),
            dedicatedInput: {
              environment: launch.environment,
              payloadForPid: launch.payloadForPid,
            },
            ...(privateIpc === undefined ? {} : { ipc: privateIpc }),
            failure: childRuntimeFailure,
            protocolFailure: () =>
              childRuntimeError(
                'CHILD_RUNTIME_PROTOCOL_INVALID',
                'Child Runtime emitted schema-invalid protocol output.',
              ),
          },
        )
        const client = new PraxisClient(async () => connection, {
          reconnectAttempts: 0,
          client: { name: '@praxis/runtime-child-host', version: PRAXIS_PRODUCT_VERSION },
        })
        const control = new FormalChildControl(connection, client, this.shutdownGraceMs)
        context.attachConnection(control)
        const permissionGate = new ChildPermissionGate(
          {
            parentRunId: packet.parentRunId,
            childRunId: packet.childRunId,
            workspace: packet.workspace.root,
            capabilityBundle: input.bootstrapProfile.capabilityBundle,
          },
          input.permissionDecisions ?? this.options.permissionDecisions,
        )

        await client.connect()
        assertExecutionDeadline(launch.profile.deadlineAt)
        const preAcceptanceCancellation = this.options.cancellation.reasonFor(packet.childRunId)
        if (preAcceptanceCancellation !== undefined) {
          throw childRuntimeError(
            cancellationCode(preAcceptanceCancellation),
            'Child Runtime was cancelled before execution acceptance.',
            preAcceptanceCancellation === 'deadline_exceeded',
          )
        }
        context.acceptExecution()
        const session = await client.createSession({
          cwd: launch.profile.workspace.root,
          provider: launch.profile.provider.providerId,
          model: launch.profile.provider.model,
          permissionMode: 'interactive',
        })
        let text = ''
        let submittedText: string | undefined
        let terminal: ChildRuntimeTerminalEvent | undefined
        const toolNames = new Map<string, string>()
        const toolInputs = new Map<string, Record<string, unknown>>()
        let evidenceRefs: readonly SubagentEvidenceRefV1[] = []
        const addEvidence = async (evidence: SubagentEvidenceRefV1) => {
          evidenceRefs = await compactSubagentEvidenceRefsV1(
            packet,
            [...evidenceRefs, evidence],
            this.options.evidenceOverflow,
          )
        }
        const changedFiles = new Map<string, SubagentResultV1['changedFiles'][number]>()
        let mutationFailure: Readonly<{ code: string; summary: string }> | undefined
        const prompt = await client.request<{ runId: string; accepted: true }>('session.prompt', {
          sessionId: session.sessionId,
          text: renderContextPacketPrompt(packet),
          clientRequestId: `subagent-${packet.packetId}`,
          budget,
          timeoutMs: remainingDeadlineMs(launch.profile.deadlineAt),
        })
        control.bind(session.sessionId, prompt.runId)
        control.armDeadline(launch.profile.deadlineAt, () =>
          this.cancel(packet.childRunId, 'deadline_exceeded'),
        )
        if (this.noProgressTimeoutMs !== undefined) {
          control.armNoProgress(this.noProgressTimeoutMs, () =>
            this.cancel(packet.childRunId, 'deadline_exceeded'),
          )
        }
        for await (const event of client.events()) {
          if (!('runId' in event) || event.runId !== prompt.runId) continue
          if (isChildActivityEvent(event)) control.noteProgress()
          if (isChildProgressEvent(event)) {
            try {
              this.options.progress?.publish({
                parentRunId: packet.parentRunId,
                childRunId: packet.childRunId,
                stepId: packet.step.stepId,
                event,
              })
            } catch {
              // Progress observers cannot interrupt or widen the authenticated child execution.
            }
          }
          if (event.type === 'text_delta') text = appendBoundedOutput(text, event.text)
          if (event.type === 'tool_start') {
            toolNames.set(event.toolCallId, event.name)
            if (event.name === CHILD_RESULT_SUBMISSION_TOOL_NAME && isRecord(event.input)) {
              toolInputs.set(event.toolCallId, event.input)
            }
          }
          if (event.type === 'tool_end') {
            const toolName = toolNames.get(event.toolCallId)
            if (event.ok) {
              const evidence = childToolEvidence(event, toolName, launch.profile.capabilityBundle)
              if (evidence !== undefined) await addEvidence(evidence)
              const mutation = childWorkspaceMutation(event, toolName, packet.workspace.root)
              if (mutation !== undefined) {
                const previous = changedFiles.get(mutation.path)
                changedFiles.set(
                  mutation.path,
                  previous?.change === 'created'
                    ? Object.freeze({ ...mutation, change: 'created' })
                    : mutation,
                )
              }
              if (toolName === CHILD_RESULT_SUBMISSION_TOOL_NAME) {
                const submitted = toolInputs.get(event.toolCallId)
                if (submitted !== undefined) submittedText = JSON.stringify(submitted)
              }
            } else if (toolName === 'write' || toolName === 'edit') {
              mutationFailure = Object.freeze({
                code: stableTerminalCode(event.error?.code ?? 'CHILD_WORKSPACE_MUTATION_FAILED'),
                summary: event.summary ?? 'Child workspace mutation failed.',
              })
            }
          }
          if (event.type === 'permission_request') {
            await client.decidePermission(event.requestId, await permissionGate.decide(event))
          }
          if (isTerminalEvent(event)) terminal = event
          if (terminal !== undefined) break
        }
        if (terminal === undefined) {
          throw childRuntimeError(
            'CHILD_RUNTIME_PROTOCOL_INVALID',
            'Child Runtime ended its event stream without a terminal event.',
          )
        }
        control.complete()
        await client.request<{ accepted: true }>('shutdown', {})
        const usage = terminalUsage(terminal)
        const resultText = submittedText ?? text
        if (Buffer.byteLength(resultText, 'utf8') > packet.outputSchema.maxInlineBytes) {
          const overflow = await this.options.resultOverflow?.store({
            parentRunId: packet.parentRunId,
            childRunId: packet.childRunId,
            text: resultText,
          })
          if (overflow === undefined) {
            throw runtimeError(
              'SUBAGENT_RESULT_OVERSIZED',
              'subagent',
              'Child output exceeded maxInlineBytes and no parent overflow store was available.',
            )
          }
          await addEvidence(overflow)
        } else if (resultText.trim().length > 0 && this.options.resultOverflow !== undefined) {
          // Preserve the exact model result as a durable parent-owned artifact. The
          // compact SubagentResult remains the stable join payload.
          await addEvidence(
            await this.options.resultOverflow.store({
              parentRunId: packet.parentRunId,
              childRunId: packet.childRunId,
              text: resultText,
            }),
          )
        }
        const result = terminalResult(
          packet,
          resultText,
          terminal,
          usage,
          evidenceRefs,
          Object.freeze([...changedFiles.values()]),
          mutationFailure,
          control.cancellationReason(),
          control.deadlineKind(),
        )
        return {
          result,
          usage,
          failed: result.status !== 'succeeded',
        }
      },
    )
  }

  /** Exercise the generic NDJSON fixture transport for bounded fault injection only. */
  async runFixture(input: ChildRuntimeFixtureRun): Promise<unknown> {
    const bootstrapProfile = input.bootstrapProfile
    if (bootstrapProfile) {
      assertAuthorizedMethods(bootstrapProfile.methodAllowlist, input.request.method)
    }
    return this.execute(input, bootstrapProfile, async (context) => {
      const connection = new NdjsonProcessConnection<never>(
        input.launch.command,
        input.launch.args ?? [],
        {
          cwd: input.launch.cwd,
          codec: childRuntimeCodec,
          failure: childRuntimeFailure,
          requestTimeoutMs: this.handshakeTimeoutMs,
          closeTimeoutMs: this.shutdownGraceMs,
          maxLineBytes: 64 * 1024,
          stderr: 'capture',
          env: childRuntimeEnvironment(this.options.environment ?? process.env),
          ...(context.bootstrapLaunch
            ? {
                dedicatedInput: {
                  environment: context.bootstrapLaunch.environment,
                  payloadForPid: context.bootstrapLaunch.payloadForPid,
                },
              }
            : {}),
        },
      )
      context.attachConnection(connection)
      let nextRequestId = 1
      const request = (method: string, params: Record<string, unknown>) =>
        connection.request<unknown>({
          jsonrpc: '2.0',
          id: `child-fixture-${nextRequestId++}`,
          method,
          params,
        })
      await request('initialize', {
        parentRunId: context.prepared.parentRunId,
        childRunId: context.prepared.childRunId,
        budget: context.prepared.budget,
      })
      context.acceptExecution()
      const result = await request(input.request.method, input.request.params)
      await request('shutdown', {})
      return { result, usage: { turns: 1, toolCalls: 0, subagents: 0 } }
    })
  }

  cancel(runId: string, reason: CancellationReason): Array<[string, CancellationReason]> {
    const cancelled = this.options.cancellation.cancel(runId, reason)
    for (const [childRunId, childReason] of cancelled) {
      const child = this.children.get(childRunId)
      if (child?.cancel) child.cancel(childReason)
      else void child?.close()
    }
    return cancelled
  }

  private async execute<T>(
    input: ChildRuntimeBaseRun,
    bootstrapProfile: ChildRuntimeBootstrapProfile | undefined,
    operation: (context: ChildExecutionContext) => Promise<ChildExecutionResult<T>>,
  ): Promise<T> {
    const prepared = this.registry.prepareSpawn({
      parentRunId: input.parentRunId,
      childRunId: input.childRunId,
      requestedBudget: input.requestedBudget,
      parentUsage: input.parentUsage,
      cancellation: this.options.cancellation,
      ledger: this.options.ledger,
    })
    let bootstrapLaunch: ReturnType<typeof createChildBootstrapLaunch> | undefined
    try {
      bootstrapLaunch = bootstrapProfile
        ? childBootstrapLaunch(input, bootstrapProfile, prepared.budget, prepared.admission)
        : undefined
    } catch (error) {
      this.registry.releaseAdmission(prepared)
      throw error
    }
    this.recordTrace(prepared, bootstrapLaunch, 'launch')

    let failed = true
    let accepted = false
    let executionFailed = false
    let executionError: unknown
    let result: T | undefined
    let terminalUsage: BudgetUsage | undefined
    const context: ChildExecutionContext = {
      prepared,
      bootstrapLaunch,
      attachConnection: (connection) => {
        this.children.set(prepared.childRunId, connection)
      },
      acceptExecution: () => {
        if (accepted) return
        this.registry.acceptExecution(prepared)
        accepted = true
        this.recordTrace(prepared, bootstrapLaunch, 'accepted')
      },
    }
    try {
      const executed = await operation(context)
      result = executed.result
      terminalUsage = executed.usage
      failed = executed.failed ?? false
      const reason = this.options.cancellation.reasonFor(prepared.childRunId)
      this.recordTrace(
        prepared,
        bootstrapLaunch,
        'terminal',
        reason === undefined ? (failed ? 'failed' : 'succeeded') : 'cancelled',
        reason === undefined ? undefined : cancellationCode(reason),
      )
    } catch (error) {
      executionFailed = true
      executionError = error
      const cancellationReason = this.options.cancellation.reasonFor(prepared.childRunId)
      if (cancellationReason === undefined) {
        this.options.cancellation.cancel(prepared.childRunId, 'plugin_failure')
      }
      this.recordTrace(
        prepared,
        bootstrapLaunch,
        'terminal',
        cancellationReason === undefined ? 'failed' : 'cancelled',
        cancellationReason === undefined
          ? stableErrorCode(error)
          : cancellationCode(cancellationReason),
      )
    } finally {
      const connection = this.children.get(prepared.childRunId)
      this.children.delete(prepared.childRunId)
      const finalizationErrors: unknown[] = []
      try {
        await connection?.close()
      } catch (error) {
        finalizationErrors.push(error)
      }
      if (bootstrapLaunch) {
        try {
          await cleanupChildRuntimeComposition(bootstrapLaunch.profile, { failed })
        } catch (error) {
          finalizationErrors.push(error)
        }
      }
      try {
        await this.options.credentialDelegation?.revokeChild(
          prepared.parentRunId,
          prepared.childRunId,
        )
      } catch (error) {
        finalizationErrors.push(error)
      }
      try {
        if (accepted) {
          this.registry.settleTerminal(
            prepared,
            executionFailed || terminalUsage === undefined
              ? { disposition: 'conservative_unknown' }
              : { disposition: 'reported', usage: terminalUsage },
          )
        } else {
          this.registry.releaseAdmission(prepared)
        }
      } catch (error) {
        finalizationErrors.push(error)
      }
      if (!executionFailed && finalizationErrors.length > 0) {
        executionFailed = true
        executionError = finalizationErrors[0]
      }
    }
    if (executionFailed) throw executionError
    return result as T
  }

  private recordTrace(
    prepared: PreparedSubagent,
    launch: ReturnType<typeof createChildBootstrapLaunch> | undefined,
    phase: ChildRuntimeTraceEventV1['phase'],
    outcome?: ChildRuntimeTraceEventV1['outcome'],
    code?: string,
  ): void {
    if (!launch || !this.options.trace) return
    const connection = this.children.get(prepared.childRunId)
    const event: ChildRuntimeTraceEventV1 = Object.freeze({
      schemaVersion: 1,
      phase,
      timestamp: new Date().toISOString(),
      parentRunId: prepared.parentRunId,
      childRunId: prepared.childRunId,
      traceId: launch.profile.trace.traceId,
      ...(launch.profile.trace.parentTraceId === undefined
        ? {}
        : { parentTraceId: launch.profile.trace.parentTraceId }),
      ...(outcome === undefined ? {} : { outcome }),
      ...(code === undefined ? {} : { code }),
      ...(connection === undefined ? {} : { stderr: stderrTrace(connection) }),
    })
    try {
      const recorded = this.options.trace.record(event)
      void Promise.resolve(recorded).catch(() => undefined)
    } catch {
      // Trace is observability-only and cannot change child execution authority.
    }
  }
}

export async function compactSubagentEvidenceRefsV1(
  packet: Pick<ContextPacketV1, 'parentRunId' | 'childRunId'>,
  evidenceRefs: readonly SubagentEvidenceRefV1[],
  overflow?: ChildRuntimeHostOptions['evidenceOverflow'],
): Promise<readonly SubagentEvidenceRefV1[]> {
  if (evidenceRefs.length <= SUBAGENT_RESULT_MAX_EVIDENCE_REFS) return evidenceRefs
  let compacted: readonly SubagentEvidenceRefV1[] = evidenceRefs
  while (compacted.length >= SUBAGENT_RESULT_MAX_EVIDENCE_REFS) {
    const chunk = compacted.slice(0, SUBAGENT_RESULT_MAX_EVIDENCE_REFS - 1)
    const manifest =
      (await overflow?.store({
        parentRunId: packet.parentRunId,
        childRunId: packet.childRunId,
        evidenceRefs: chunk,
      })) ??
      Object.freeze({
        kind: 'result' as const,
        ref: `evidence-manifest:${packet.childRunId}:${digestResult(chunk).slice(7, 31)}`,
        digest: digestResult(chunk),
        mediaType: 'application/vnd.praxis.subagent-evidence-manifest+json',
        summary: `Digest manifest for ${chunk.length} Child evidence references.`,
      })
    compacted = Object.freeze([manifest, ...compacted.slice(chunk.length)])
  }
  return compacted
}

class FormalChildControl implements ClosableChildConnection {
  #sessionId?: string
  #runId?: string
  #reason?: CancellationReason
  #deadlineTimer?: LongDurationTimer
  #noProgressTimer?: LongDurationTimer
  #noProgressTimeoutMs?: number
  #onNoProgress?: () => void
  #deadlineKind?: 'total' | 'no_progress'
  #forceCloseTimer?: NodeJS.Timeout
  #abortStarted = false

  constructor(
    private readonly connection: RuntimeProtocolConnection,
    private readonly client: PraxisClient,
    private readonly shutdownGraceMs: number,
  ) {}

  get stderr(): string {
    return this.connection.stderr
  }

  get stderrCapturedBytes(): number {
    return this.connection.stderrCapturedBytes
  }

  get stderrTotalBytes(): number {
    return this.connection.stderrTotalBytes
  }

  get stderrTruncated(): boolean {
    return this.connection.stderrTruncated
  }

  bind(sessionId: string, runId: string): void {
    this.#sessionId = sessionId
    this.#runId = runId
    if (this.#reason !== undefined) this.#startAbort()
  }

  armDeadline(deadlineAt: string, onDeadline: () => void): void {
    const delay = Math.max(0, Date.parse(deadlineAt) - Date.now())
    this.#deadlineTimer = scheduleLongDurationTimer(() => {
      this.#noProgressTimer?.cancel()
      this.#deadlineKind = 'total'
      onDeadline()
    }, delay)
  }

  armNoProgress(timeoutMs: number, onNoProgress: () => void): void {
    this.#noProgressTimeoutMs = timeoutMs
    this.#onNoProgress = onNoProgress
    this.noteProgress()
  }

  noteProgress(): void {
    this.#noProgressTimer?.cancel()
    if (this.#noProgressTimeoutMs === undefined || this.#onNoProgress === undefined) return
    this.#noProgressTimer = scheduleLongDurationTimer(() => {
      this.#deadlineTimer?.cancel()
      this.#deadlineKind = 'no_progress'
      this.#onNoProgress?.()
    }, this.#noProgressTimeoutMs)
  }

  cancel(reason: CancellationReason): void {
    this.#reason ??= reason
    this.#startAbort()
  }

  cancellationReason(): CancellationReason | undefined {
    return this.#reason
  }

  deadlineKind(): 'total' | 'no_progress' | undefined {
    return this.#deadlineKind
  }

  complete(): void {
    this.#deadlineTimer?.cancel()
    this.#noProgressTimer?.cancel()
    if (this.#forceCloseTimer) clearTimeout(this.#forceCloseTimer)
    this.#deadlineTimer = undefined
    this.#noProgressTimer = undefined
    this.#forceCloseTimer = undefined
  }

  async close(): Promise<void> {
    this.complete()
    await this.connection.close()
  }

  #startAbort(): void {
    if (this.#abortStarted) return
    if (this.#sessionId === undefined || this.#runId === undefined) {
      return
    }
    this.#abortStarted = true
    void this.client
      .request<{ accepted: true }>('session.abort', {
        sessionId: this.#sessionId,
        runId: this.#runId,
      })
      .catch(() => this.connection.close())
    this.#forceCloseTimer = setTimeout(() => {
      void this.connection.close()
    }, this.shutdownGraceMs)
  }
}

const CHILD_ENVIRONMENT_ALLOWLIST = [
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'TEMP',
  'TMP',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TERM',
  'COLORTERM',
  'NO_COLOR',
  'FORCE_COLOR',
] as const

function childRuntimeEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const entries = new Map(Object.entries(source).map(([key, value]) => [key.toUpperCase(), value]))
  return Object.fromEntries(
    CHILD_ENVIRONMENT_ALLOWLIST.flatMap((name) => {
      const value = entries.get(name)
      return value === undefined ? [] : [[name, value]]
    }),
  )
}

function childBootstrapLaunch(
  input: Pick<ChildRuntimeBaseRun, 'parentRunId' | 'childRunId'>,
  profile: ChildRuntimeBootstrapProfile,
  budget: ExecutionBudget,
  admission: SubagentAdmission,
): ReturnType<typeof createChildBootstrapLaunch> {
  const deadlineAt = earlierDeadline(profile.deadlineAt, budget.deadlineAt)
  return createChildBootstrapLaunch({
    ...profile,
    parentRunId: input.parentRunId,
    childRunId: input.childRunId,
    budget: { ...budget, deadlineAt },
    admission,
    deadlineAt,
  })
}

function earlierDeadline(configured: string, budget: string | undefined): string {
  if (budget === undefined) return configured
  return Date.parse(budget) < Date.parse(configured) ? budget : configured
}

function promptBudget(budget: Readonly<ExecutionBudget>): NonNullable<PromptInput['budget']> {
  return {
    maxTurns: budget.maxTurns,
    maxToolCalls: budget.maxToolCalls,
    ...(budget.maxTokens === undefined ? {} : { maxTokens: budget.maxTokens }),
  }
}

function terminalUsage(terminal: ChildRuntimeTerminalEvent): BudgetUsage {
  const usage = terminal.usage
  if (
    usage === undefined ||
    !nonNegativeInteger(usage.turns) ||
    !nonNegativeInteger(usage.toolCalls) ||
    !nonNegativeInteger(usage.subagents) ||
    !optionalNonNegativeInteger(usage.inputTokens) ||
    !optionalNonNegativeInteger(usage.outputTokens) ||
    !optionalNonNegativeInteger(usage.cacheReadTokens) ||
    !optionalNonNegativeInteger(usage.cacheWriteTokens) ||
    (usage.costUsd !== undefined &&
      (typeof usage.costUsd !== 'number' || !Number.isFinite(usage.costUsd) || usage.costUsd < 0))
  ) {
    throw childRuntimeError(
      'CHILD_RUNTIME_USAGE_INVALID',
      'Child Runtime terminal usage is missing or invalid.',
    )
  }
  return {
    turns: usage.turns,
    toolCalls: usage.toolCalls,
    ...(usage?.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
    ...(usage?.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
    ...(usage?.cacheReadTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadTokens }),
    ...(usage?.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: usage.cacheWriteTokens }),
    ...(usage?.costUsd === undefined ? {} : { costUsd: usage.costUsd }),
    subagents: usage.subagents,
  }
}

function appendBoundedOutput(current: string, delta: string): string {
  if (Buffer.byteLength(current, 'utf8') + Buffer.byteLength(delta, 'utf8') > 1024 * 1024) {
    throw runtimeError(
      'SUBAGENT_RESULT_OVERSIZED',
      'subagent',
      'Child Runtime output exceeded the bounded parent overflow buffer.',
    )
  }
  return current + delta
}

function terminalResult(
  packet: ContextPacketV1,
  text: string,
  terminal: ChildRuntimeTerminalEvent,
  usage: BudgetUsage,
  evidenceRefs: readonly SubagentEvidenceRefV1[],
  changedFiles: SubagentResultV1['changedFiles'],
  mutationFailure?: Readonly<{ code: string; summary: string }>,
  cancellationReason?: CancellationReason,
  deadlineKind?: 'total' | 'no_progress',
): SubagentResultV1 {
  if (terminal.type === 'prompt_completed') {
    if (mutationFailure !== undefined && changedFiles.length === 0) {
      return createSubagentResultV1({
        childRunId: packet.childRunId,
        status: 'failed',
        summary: mutationFailure.summary,
        evidenceRefs,
        changedFiles,
        checks: [],
        usage,
        retryable: false,
        error: {
          code: mutationFailure.code,
          category: 'execution',
          message:
            'The child completed after its requested workspace mutation was denied or failed.',
          retryable: false,
        },
      })
    }
    const structured = parseStructuredChildOutputV1(
      packet.successCriteria,
      text,
      evidenceRefs,
      packet.outputSchema.schema,
    )
    if (structured === undefined && packet.successCriteria.length > 0) {
      return createSubagentResultV1({
        childRunId: packet.childRunId,
        status: 'failed',
        summary:
          'Child Runtime completed, but its result did not match the required result envelope and success-criterion IDs.',
        evidenceRefs,
        changedFiles,
        checks: [],
        usage,
        retryable: false,
        error: {
          code: 'CHILD_RESULT_SCHEMA_INVALID',
          category: 'execution',
          message: 'The completed child output could not be validated against the ContextPacket.',
          retryable: false,
        },
      })
    }
    const unsatisfied = structured?.checks.some(({ status }) => status !== 'passed') === true
    return createSubagentResultV1({
      childRunId: packet.childRunId,
      status: unsatisfied ? 'failed' : 'succeeded',
      summary: structured?.summary ?? (text || 'Child Runtime completed without inline output.'),
      evidenceRefs,
      changedFiles,
      checks: structured?.checks ?? [],
      usage,
      retryable: false,
      ...(unsatisfied
        ? {
            error: {
              code: 'CHILD_SUCCESS_CRITERION_FAILED',
              category: 'execution' as const,
              message: 'At least one required child success criterion was not satisfied.',
              retryable: false,
            },
          }
        : {}),
    })
  }
  if (terminal.type === 'prompt_aborted') {
    const retryable = cancellationReason === 'deadline_exceeded'
    const partial = text.trim()
    const cancellationSummary = retryable
      ? deadlineKind === 'no_progress'
        ? 'Child Runtime exceeded its no-progress deadline.'
        : 'Child Runtime exceeded its total deadline.'
      : 'Child Runtime execution was cancelled.'
    return createSubagentResultV1({
      childRunId: packet.childRunId,
      status: 'cancelled',
      summary: partial
        ? `${cancellationSummary} Partial output preserved:\n${partial}`
        : `${cancellationSummary} ${evidenceRefs.length} tool evidence reference(s) preserved.`,
      evidenceRefs,
      changedFiles,
      checks: [],
      usage,
      retryable,
      error: {
        code:
          cancellationReason === undefined
            ? 'CHILD_PROMPT_ABORTED'
            : cancellationCode(cancellationReason),
        category: 'cancellation',
        message:
          cancellationReason === 'deadline_exceeded'
            ? cancellationSummary
            : 'The child prompt ended with a cancellation terminal event.',
        retryable,
      },
    })
  }
  const failureCode = stableTerminalCode(terminal.code)
  const retryable =
    failureCode === 'CHILD_CREDENTIAL_RATE_LIMITED' ||
    failureCode === 'CHILD_CREDENTIAL_PROVIDER_UNAVAILABLE'
  return createSubagentResultV1({
    childRunId: packet.childRunId,
    status: 'failed',
    summary: 'Child Runtime execution failed.',
    evidenceRefs,
    changedFiles,
    checks: [],
    usage,
    retryable,
    error: {
      code: failureCode,
      category: 'execution',
      message: 'The child prompt ended with a failure terminal event.',
      retryable,
    },
  })
}

export function parseStructuredChildOutputV1(
  successCriteria: ContextPacketV1['successCriteria'],
  text: string,
  evidenceRefs: readonly SubagentEvidenceRefV1[],
  outputSchema?: Readonly<Record<string, unknown>>,
):
  | {
      summary: string
      checks: ReadonlyArray<{
        id: string
        status: 'passed' | 'failed' | 'skipped'
        summary: string
        evidenceRef?: string
      }>
    }
  | undefined {
  let value: unknown
  try {
    value = JSON.parse(jsonPayload(text))
  } catch {
    return undefined
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  if (outputSchema !== undefined) {
    try {
      if (!new Ajv2020({ allErrors: true, strict: false }).compile(outputSchema)(value)) {
        return undefined
      }
    } catch {
      return undefined
    }
  }
  const record = value as Record<string, unknown>
  if (typeof record.summary !== 'string' || !Array.isArray(record.criteria)) return undefined
  const expected = new Set(successCriteria.map((criterion) => criterion.id))
  const availableEvidence = new Set(evidenceRefs.map((evidence) => evidence.ref))
  const checks = record.criteria.flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return []
    const check = candidate as Record<string, unknown>
    if (
      typeof check.id !== 'string' ||
      !expected.has(check.id) ||
      !['passed', 'failed', 'skipped'].includes(String(check.status)) ||
      typeof check.summary !== 'string'
    ) {
      return []
    }
    const evidenceRef =
      typeof check.evidenceRef === 'string' && availableEvidence.has(check.evidenceRef)
        ? check.evidenceRef
        : undefined
    return [
      {
        id: check.id,
        status: check.status as 'passed' | 'failed' | 'skipped',
        summary: check.summary,
        ...(evidenceRef === undefined ? {} : { evidenceRef }),
      },
    ]
  })
  if (
    checks.length !== expected.size ||
    new Set(checks.map((check) => check.id)).size !== expected.size
  ) {
    return undefined
  }
  return { summary: record.summary, checks }
}

function jsonPayload(text: string): string {
  const trimmed = text.trim()
  try {
    JSON.parse(trimmed)
    return trimmed
  } catch {
    const fenced = [...trimmed.matchAll(/```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```/giu)]
    return fenced.length === 1 ? fenced[0]![1] : trimmed
  }
}

function childWorkspaceMutation(
  event: Extract<SessionEvent, { type: 'tool_end' }>,
  toolName: string | undefined,
  workspace: string,
): SubagentResultV1['changedFiles'][number] | undefined {
  if ((toolName !== 'write' && toolName !== 'edit') || !isRecord(event.output)) return undefined
  const path = event.output.path
  const afterDigest = event.output.afterDigest
  if (
    typeof path !== 'string' ||
    !isAbsolute(path) ||
    typeof afterDigest !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/u.test(afterDigest)
  ) {
    throw childRuntimeError(
      'CHILD_WORKSPACE_MUTATION_RESULT_INVALID',
      'Child workspace mutation returned an invalid result.',
    )
  }
  const portable = relative(resolve(workspace), resolve(path)).split(sep).join('/')
  if (
    portable === '' ||
    portable === '..' ||
    portable.startsWith('../') ||
    isAbsolute(portable) ||
    portable.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw childRuntimeError(
      'CHILD_WORKSPACE_MUTATION_RESULT_INVALID',
      'Child workspace mutation escaped its signed workspace.',
    )
  }
  return Object.freeze({
    path: portable,
    change: toolName === 'write' && event.output.created === true ? 'created' : 'modified',
    digest: afterDigest as `sha256:${string}`,
  })
}

function childToolEvidence(
  event: Extract<SessionEvent, { type: 'tool_end' }>,
  toolName: string | undefined,
  bundle: ChildRuntimeBootstrapProfile['capabilityBundle'],
): SubagentEvidenceRefV1 | undefined {
  if (toolName === CHILD_RESULT_SUBMISSION_TOOL_NAME) return undefined
  if (toolName === 'skill') {
    const output = event.output
    if (!isSkillInvocationEntry(output)) {
      throw childRuntimeError(
        'CHILD_SKILL_RESULT_INVALID',
        'Child Skill invocation returned an invalid result.',
      )
    }
    const grant = bundle.skills.find((skill) => skill.id === output.capabilityId)
    if (grant === undefined || grant.origin !== output.origin || grant.digest !== output.digest) {
      throw childRuntimeError(
        'CHILD_SKILL_RESULT_INVALID',
        'Child Skill invocation result drifted from its signed grant.',
      )
    }
    return Object.freeze({
      kind: 'result',
      ref: `skill-result:${grant.id}:${event.toolCallId}`,
      digest: digestResult(output),
      mediaType: 'application/vnd.praxis.skill-invocation+json',
      summary: `Invoked signed Skill ${grant.id}.`,
    })
  }
  const grant =
    bundle.mcp.mode === 'parent_broker'
      ? bundle.mcp.toolGrants.find((candidate) => candidate.name === toolName)
      : undefined
  if (grant === undefined) {
    const sideEffect = bundle.tools.find((candidate) => candidate.name === toolName)?.definition
      .execution?.sideEffect
    return Object.freeze({
      kind: 'result',
      ref: `tool-result:${toolName ?? 'unknown'}:${event.toolCallId}`,
      digest: digestResult({ tool: toolName, output: event.output }),
      mediaType: 'application/vnd.praxis.tool-result+json',
      summary: `Executed ${sideEffect ?? 'bounded'} Tool ${toolName ?? 'unknown'}.`,
    })
  }
  return Object.freeze({
    kind: 'result',
    ref: `mcp-result:${grant.brokerCapabilityId}:${event.toolCallId}`,
    digest: digestResult({ tool: grant.name, output: event.output }),
    mediaType: 'application/vnd.praxis.mcp-tool-result+json',
    summary: `Executed parent-brokered read-only MCP Tool ${grant.name}.`,
  })
}

function isChildActivityEvent(event: SessionEvent): boolean {
  return (
    event.type === 'thinking_delta' ||
    event.type === 'text_delta' ||
    event.type === 'tool_planning' ||
    event.type === 'tool_start' ||
    event.type === 'tool_update' ||
    event.type === 'tool_end'
  )
}

function digestResult(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(value) ?? 'null')
    .digest('hex')}`
}

function stableTerminalCode(code: string | undefined): string {
  return code !== undefined && /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/.test(code)
    ? code
    : 'CHILD_PROMPT_FAILED'
}

function requireBootstrapLaunch(
  launch: ReturnType<typeof createChildBootstrapLaunch> | undefined,
): ReturnType<typeof createChildBootstrapLaunch> {
  if (launch) return launch
  throw childRuntimeError(
    'CHILD_RUNTIME_BOOTSTRAP_REQUIRED',
    'Formal child execution requires an authenticated bootstrap profile.',
  )
}

function assertFormalSessionMethods(methodAllowlist: readonly string[]): void {
  for (const method of [
    'initialize',
    'events.subscribe',
    'session.create',
    'session.prompt',
    'permission.decide',
    'session.abort',
    'shutdown',
  ]) {
    if (!methodAllowlist.includes(method)) {
      throw runtimeError(
        'CHILD_RUNTIME_METHOD_NOT_ALLOWED',
        'subagent',
        'The formal child session protocol is not authorized by its launch profile.',
      )
    }
  }
}

function assertAuthorizedMethods(methodAllowlist: readonly string[], requestMethod: string): void {
  if (
    methodAllowlist.includes('initialize') &&
    methodAllowlist.includes('shutdown') &&
    methodAllowlist.includes(requestMethod)
  ) {
    return
  }
  throw runtimeError(
    'CHILD_RUNTIME_METHOD_NOT_ALLOWED',
    'subagent',
    'The child Runtime method is not authorized by its launch profile.',
  )
}

function isTerminalEvent(event: SessionEvent): event is ChildRuntimeTerminalEvent {
  return (
    event.type === 'prompt_completed' ||
    event.type === 'prompt_failed' ||
    event.type === 'prompt_aborted'
  )
}

function isChildProgressEvent(event: SessionEvent): event is ChildRuntimeProgressEventV1 {
  return (
    event.type === 'thinking_delta' ||
    event.type === 'tool_start' ||
    event.type === 'tool_update' ||
    event.type === 'tool_end'
  )
}

const childRuntimeCodec: ProcessMessageCodec<never> = {
  decode(value) {
    if (!isRecord(value) || value.jsonrpc !== '2.0' || typeof value.id !== 'string') {
      throw childRuntimeError(
        'CHILD_RUNTIME_PROTOCOL_INVALID',
        'Child Runtime emitted an invalid response.',
      )
    }
    if (Object.hasOwn(value, 'error')) {
      return { type: 'response', id: value.id, error: value.error }
    }
    if (Object.hasOwn(value, 'result')) {
      return { type: 'response', id: value.id, result: value.result }
    }
    throw childRuntimeError(
      'CHILD_RUNTIME_PROTOCOL_INVALID',
      'Child Runtime emitted an invalid response.',
    )
  },
}

function assertExecutionDeadline(deadlineAt: string): void {
  if (Date.parse(deadlineAt) <= Date.now()) {
    throw childRuntimeError(
      'CHILD_RUNTIME_DEADLINE_EXCEEDED',
      'Child Runtime execution deadline expired before execution acceptance.',
      true,
    )
  }
}

function remainingDeadlineMs(deadlineAt: string): number {
  return Math.max(1, Math.min(2_147_483_647, Date.parse(deadlineAt) - Date.now()))
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

function optionalNonNegativeInteger(value: unknown): boolean {
  return value === undefined || nonNegativeInteger(value)
}

function stderrTrace(
  connection: ClosableChildConnection,
): NonNullable<ChildRuntimeTraceEventV1['stderr']> {
  const stderr = connection.stderr ?? ''
  const capturedBytes = connection.stderrCapturedBytes ?? Buffer.byteLength(stderr, 'utf8')
  const totalBytes = connection.stderrTotalBytes ?? capturedBytes
  return Object.freeze({
    capturedBytes,
    totalBytes,
    truncated: connection.stderrTruncated ?? totalBytes > capturedBytes,
    digest: `sha256:${createHash('sha256').update(stderr).digest('hex')}`,
  })
}

function cancellationCode(reason: CancellationReason): string {
  switch (reason) {
    case 'deadline_exceeded':
      return 'CHILD_DEADLINE_EXCEEDED'
    case 'parent_cancelled':
      return 'CHILD_PARENT_CANCELLED'
    case 'budget_exhausted':
      return 'CHILD_BUDGET_EXHAUSTED'
    case 'runtime_shutdown':
      return 'CHILD_RUNTIME_SHUTDOWN'
    case 'user_abort':
      return 'CHILD_USER_ABORTED'
    case 'plugin_failure':
      return 'CHILD_PLUGIN_FAILURE'
  }
}

function stableErrorCode(error: unknown): string {
  if (
    isRecord(error) &&
    typeof error.code === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/.test(error.code)
  ) {
    return error.code
  }
  return 'CHILD_RUNTIME_FAILED'
}

function childRuntimeFailure(
  kind: ProcessConnectionFailureKind,
  context: ProcessConnectionFailureContext,
): Error {
  switch (kind) {
    case 'closed':
      return childRuntimeError('CHILD_RUNTIME_CLOSED', 'Child Runtime is already closed.')
    case 'timeout':
      return childRuntimeError(
        'CHILD_RUNTIME_TIMEOUT',
        'Child Runtime request exceeded its deadline.',
        true,
      )
    case 'malformed_stdout':
      return childRuntimeError(
        'CHILD_RUNTIME_PROTOCOL_INVALID',
        'Child Runtime emitted malformed stdout.',
      )
    case 'oversized_stdout':
      return childRuntimeError(
        'CHILD_RUNTIME_PROTOCOL_INVALID',
        'Child Runtime emitted an oversized stdout line.',
      )
    case 'write_failed':
      return childRuntimeError(
        'CHILD_RUNTIME_WRITE_FAILED',
        'Child Runtime request could not be written.',
        true,
        context.cause,
      )
    case 'launch_input_failed':
      return childRuntimeError(
        'CHILD_RUNTIME_BOOTSTRAP_FAILED',
        'Child Runtime bootstrap input could not be delivered.',
        false,
        context.cause,
      )
    case 'spawn_failed':
    case 'stdout_closed':
    case 'exited':
      return childRuntimeError(
        'CHILD_RUNTIME_EXITED',
        'Child Runtime exited before completing its request.',
        true,
        context.cause,
      )
  }
}

function childRuntimeError(code: string, message: string, retryable = false, cause?: Error): Error {
  return Object.assign(
    new Error(message, cause ? { cause } : undefined),
    runtimeError(code, 'subagent', message, undefined, retryable),
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
