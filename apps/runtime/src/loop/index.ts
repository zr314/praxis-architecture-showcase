import { createHash } from 'node:crypto'
import type {
  AgentEvent,
  AgentRun,
  AgentSession,
  CancellationReason,
  ChatProvider,
  PermissionDecision,
  PermissionRequirement,
  PreparedToolInvocation,
  PromptManifest,
  ProviderCapabilities,
  ProviderMessage,
  ProviderNativeContext,
  ProviderRequest,
  ProviderTarget,
  ProviderToolCall,
  ProviderToolDefinition,
  ProviderTurnResult,
  ProviderUsage,
  RuntimeError,
  SystemPromptBuild,
  ToolProgressUpdate,
  ToolResult,
  TraceAttributes,
  TraceContext,
  TraceRecord,
} from '@praxis/core-sdk'
import {
  isRuntimeError,
  isSkillInvocationEntry,
  ProviderStreamProtocolError,
  runtimeError,
} from '@praxis/core-sdk'
import {
  type CompactionPolicy,
  type ContextPolicy,
  compactionPolicy,
  contextPolicy,
  shouldCompactAtThreshold,
  thresholdCompactionRearmed,
} from '../memory/compactionPolicy.js'
import {
  consumeProviderTurn,
  executeToolBatch,
  LoopProgressGuard,
  typedSteerMessage,
} from './units.js'

export type { AgentRun, AgentSession } from '@praxis/core-sdk'

export type AgentToolPort = {
  definitions(): ProviderToolDefinition[]
  validateInput(name: string, input: Record<string, unknown>): ToolResult | undefined
  prepare(name: string, input: Record<string, unknown>, cwd: string): PreparedToolInvocation
  executePrepared(
    prepared: PreparedToolInvocation,
    signal: AbortSignal,
    onUpdate?: (update: ToolProgressUpdate) => void,
  ): Promise<ToolResult>
}

export type AgentLoopPorts = {
  providerFor(id: string): Promise<ChatProvider | undefined>
  providerForRun?(
    session: AgentSession,
    run: AgentRun,
    id: string,
  ): Promise<ChatProvider | undefined>
  streamProvider(
    provider: ChatProvider,
    request: ProviderRequest,
    trace: TraceContext,
    prepareRequest?: (
      candidate: RoutedProviderCandidate,
      baseRequest: ProviderRequest,
    ) => ProviderRequest | Promise<ProviderRequest>,
  ): AsyncIterable<import('@praxis/core-sdk').ProviderChunk>
  streamProviderForRun?(
    session: AgentSession,
    run: AgentRun,
    provider: ChatProvider,
    request: ProviderRequest,
    trace: TraceContext,
    prepareRequest?: (
      candidate: RoutedProviderCandidate,
      baseRequest: ProviderRequest,
    ) => ProviderRequest | Promise<ProviderRequest>,
  ): AsyncIterable<import('@praxis/core-sdk').ProviderChunk>
  tools(session: AgentSession, run: AgentRun): AgentToolPort
  terminalTool?(session: AgentSession, run: AgentRun): Readonly<{ name: string }> | undefined
  commitMessage(session: AgentSession, run: AgentRun, message: ProviderMessage): Promise<void>
  acknowledgeSteer?(
    session: AgentSession,
    run: AgentRun,
    steer: Readonly<{ id: string; workflowMessageSequence?: number }>,
  ): Promise<void>
  completionGuidance?(session: AgentSession, run: AgentRun): Promise<string | undefined>
  emit(event: AgentEvent, sessionId?: string, runId?: string): void
  requestPermission(
    session: AgentSession,
    run: AgentRun,
    toolCall: ProviderToolCall,
    input: Record<string, unknown>,
    requirement: PermissionRequirement,
  ): Promise<PermissionDecision>
  hasPermissionRule(name: string, requirement: PermissionRequirement, cwd: string): boolean
  finishRun(
    session: AgentSession,
    run: AgentRun,
    event: TerminalAgentEvent,
  ): TerminalAgentEvent | Promise<TerminalAgentEvent>
  buildSystemPrompt(
    session: AgentSession,
    run: AgentRun,
    provider: ChatProvider,
    tools: ProviderToolDefinition[],
  ): SystemPromptBuild | Promise<SystemPromptBuild>
  recordPromptManifest(session: AgentSession, run: AgentRun, manifest: PromptManifest): void
  selectContext(
    session: AgentSession,
    run: AgentRun,
    provider: ChatProvider,
    promptBuild: SystemPromptBuild,
    tools: ProviderToolDefinition[],
    target?: ProviderTarget,
    capabilities?: ProviderCapabilities,
  ):
    | {
        messages: ProviderMessage[]
        contextMessages?: ProviderMessage[]
        nativeContext?: ProviderNativeContext
        report?: ContextReport
        manifest?: PromptManifest
      }
    | Promise<{
        messages: ProviderMessage[]
        contextMessages?: ProviderMessage[]
        nativeContext?: ProviderNativeContext
        report?: ContextReport
        manifest?: PromptManifest
      }>
  outputTokenLimit?(
    session: AgentSession,
    provider: ChatProvider,
    target?: ProviderTarget,
    capabilities?: ProviderCapabilities,
  ): number | undefined
  compactContext?(
    session: AgentSession,
    run: AgentRun,
    reason: 'threshold' | 'overflow',
    native?: Readonly<{
      provider: ChatProvider
      request: ProviderRequest
      /** False when only canonical semantic compaction is safe. */
      nativeEligible?: boolean
    }>,
  ): Promise<{
    compacted: boolean
    checkpointTokens?: number
    omittedMessages?: number
    estimatedGainTokens?: number
    checkpointId?: string
    usage?: ProviderUsage
  }>
  nextMessageId(): string
  nextSteerId(): string
  trace(record: Omit<TraceRecord, 'schemaVersion' | 'timestamp'>): Promise<void>
  nextTurnId(run: AgentRun): string
}

export type RoutedProviderCandidate = {
  target: ProviderTarget
  provider: ChatProvider
  capabilities?: ProviderCapabilities
  candidateIndex: number
}

type TerminalAgentEvent = Extract<
  AgentEvent,
  { type: 'prompt_completed' | 'prompt_failed' | 'prompt_aborted' }
>

type TraceInput = Omit<TraceRecord, 'schemaVersion' | 'timestamp'>

const MAX_PERSISTABLE_TURN_BYTES = 768 * 1_024

/** Provider/tool execution loop. It depends exclusively on ports supplied by the framework. */
export class AgentLoop {
  private readonly runStartedAt = new Map<string, number>()
  private readonly contextPolicy: ContextPolicy
  private readonly compactionPolicy: CompactionPolicy

  constructor(
    private readonly ports: AgentLoopPorts,
    policies: {
      contextPolicy?: Partial<ContextPolicy>
      compactionPolicy?: Partial<CompactionPolicy>
    } = {},
  ) {
    this.contextPolicy = contextPolicy(policies.contextPolicy)
    this.compactionPolicy = compactionPolicy(policies.compactionPolicy)
  }

  async execute(session: AgentSession, run: AgentRun): Promise<void> {
    this.runStartedAt.set(run.id, Date.now())
    await this.trace({ kind: 'run.started', context: run.trace })
    try {
      this.ports.emit(
        {
          type: 'prompt_started',
          sessionId: session.sessionId,
          runId: run.id,
          prompt: run.text,
          promptKind: run.promptKind,
        },
        session.sessionId,
        run.id,
      )
      const provider = await (this.ports.providerForRun
        ? this.ports.providerForRun(session, run, session.provider)
        : this.ports.providerFor(session.provider))
      if (this.shouldStop(run)) return
      if (!provider) throw new Error(`Unknown provider: ${session.provider}`)
      const toolsPort = this.ports.tools(session, run)
      const tools = toolsPort.definitions()
      const terminalTool = this.ports.terminalTool?.(session, run)
      if (
        terminalTool !== undefined &&
        !tools.some((definition) => definition.name === terminalTool.name)
      ) {
        throw runtimeError(
          'TERMINAL_TOOL_UNAVAILABLE',
          'configuration',
          'The configured terminal Tool is not present in this Run capability snapshot.',
          { capabilityId: terminalTool.name },
        )
      }
      const primaryTarget = { provider: session.provider, model: session.model }
      const modelOutputTokenLimit = this.ports.outputTokenLimit?.(session, provider, primaryTarget)
      const promptBuild = await this.ports.buildSystemPrompt(session, run, provider, tools)
      if (this.shouldStop(run)) return
      let promptManifestRecorded = false
      let stopReason: string | undefined
      let usage: ProviderUsage | undefined
      let requireTerminalTool = false
      const progress = new LoopProgressGuard()
      // Absence of an explicit Run budget means unlimited turns. Do not add a
      // hidden loop fallback here: policy is resolved by the Runtime boundary,
      // and embedders are also allowed to run an unbudgeted long-lived loop.
      const turnCeiling = run.budget?.maxTurns
      const maximumTurns =
        turnCeiling === undefined ? undefined : Math.max(0, turnCeiling - (run.usage?.turns ?? 0))
      let thresholdArmed = true
      for (let round = 0; maximumTurns === undefined || round < maximumTurns; round += 1) {
        await this.applySteers(session, run)
        if (this.shouldStop(run)) return

        const turnContext = { ...run.trace, turnId: this.ports.nextTurnId(run) }
        let selected = await this.ports.selectContext(
          session,
          run,
          provider,
          promptBuild,
          tools,
          primaryTarget,
        )
        if (selected.report && thresholdCompactionRearmed(selected.report, this.contextPolicy)) {
          thresholdArmed = true
        }
        if (
          this.ports.compactContext &&
          selected.report &&
          (selected.report.uncoveredOmittedMessages > 0 ||
            (thresholdArmed && shouldCompactAtThreshold(selected.report, this.contextPolicy)))
        ) {
          const compacted = await this.ports.compactContext(
            session,
            run,
            'threshold',
            compactionProviderCandidate(
              provider,
              providerRequestForSelection(
                session,
                run,
                promptBuild,
                tools,
                selected,
                providerOutputLimit(run, modelOutputTokenLimit),
              ),
              selected.report,
            ),
          )
          this.recordAuxiliaryUsage(run, compacted.usage)
          if (this.exhaustedBudget(run)) {
            this.cancel(run, 'budget_exhausted')
            return
          }
          if (compacted.compacted) {
            thresholdArmed = false
            await this.traceCompaction(turnContext, 'threshold', compacted)
            selected = await this.ports.selectContext(
              session,
              run,
              provider,
              promptBuild,
              tools,
              primaryTarget,
            )
          }
        }

        let turn: ProviderTurnResult
        let overflowRetries = 0
        while (true) {
          const selectedManifest = selected.manifest ?? promptBuild.manifest
          if (!promptManifestRecorded) {
            this.ports.recordPromptManifest(session, run, selectedManifest)
            await this.tracePromptManifest(run, selectedManifest)
            promptManifestRecorded = true
          }
          await this.traceContextSelection(turnContext, selected.report)
          const providerRequest: ProviderRequest = {
            model: session.model,
            messages: selected.messages,
            contextMessages: [...promptBuild.contextMessages, ...(selected.contextMessages ?? [])],
            tools,
            instructions: promptBuild.instructions,
            promptManifest: selectedManifest,
            ...(selected.nativeContext === undefined
              ? {}
              : { nativeContext: selected.nativeContext }),
            signal: run.controller.signal,
            ...(requireTerminalTool && terminalTool !== undefined
              ? { toolChoice: { name: terminalTool.name } }
              : {}),
            ...(providerOutputLimit(run, modelOutputTokenLimit) === undefined
              ? {}
              : { maxOutputTokens: providerOutputLimit(run, modelOutputTokenLimit) }),
          }
          try {
            turn = await consumeProviderTurn(
              (
                this.ports.streamProviderForRun ??
                ((_session, _run, ...args) => this.ports.streamProvider(...args))
              )(
                session,
                run,
                provider,
                providerRequest,
                turnContext,
                async (candidate, baseRequest) => {
                  if (candidate.candidateIndex === 0) return baseRequest
                  const fallbackSelection = await this.ports.selectContext(
                    session,
                    run,
                    candidate.provider,
                    promptBuild,
                    tools,
                    candidate.target,
                    candidate.capabilities,
                  )
                  await this.traceContextSelection(turnContext, fallbackSelection.report, {
                    providerId: candidate.target.provider,
                    model: candidate.target.model,
                  })
                  const fallbackOutputLimit = this.ports.outputTokenLimit?.(
                    session,
                    candidate.provider,
                    candidate.target,
                    candidate.capabilities,
                  )
                  const maximumOutputTokens = providerOutputLimit(run, fallbackOutputLimit)
                  return {
                    ...baseRequest,
                    model: candidate.target.model,
                    messages: fallbackSelection.messages,
                    contextMessages: [
                      ...promptBuild.contextMessages,
                      ...(fallbackSelection.contextMessages ?? []),
                    ],
                    promptManifest: fallbackSelection.manifest ?? promptBuild.manifest,
                    ...(fallbackSelection.nativeContext === undefined
                      ? { nativeContext: undefined }
                      : { nativeContext: fallbackSelection.nativeContext }),
                    ...(maximumOutputTokens === undefined
                      ? { maxOutputTokens: undefined }
                      : { maxOutputTokens: maximumOutputTokens }),
                  }
                },
              ),
              {
                shouldStop: () => this.shouldStop(run),
                maxBufferedBytes: MAX_PERSISTABLE_TURN_BYTES,
                onText: (text) => {
                  if (this.shouldStop(run)) return
                  this.ports.emit(
                    { type: 'text_delta', runId: run.id, text },
                    session.sessionId,
                    run.id,
                  )
                },
                onReasoning: (text) => {
                  if (this.shouldStop(run)) return
                  this.ports.emit(
                    { type: 'thinking_delta', runId: run.id, text },
                    session.sessionId,
                    run.id,
                  )
                },
              },
            )
            break
          } catch (error) {
            if (
              overflowRetries >= this.compactionPolicy.overflowRetryLimit ||
              !this.ports.compactContext ||
              !isRuntimeError(error) ||
              error.code !== 'PROVIDER_CONTEXT_LIMIT'
            ) {
              throw error
            }
            const before = selected.report
            const compacted = await this.ports.compactContext(
              session,
              run,
              'overflow',
              compactionProviderCandidate(provider, providerRequest, selected.report),
            )
            this.recordAuxiliaryUsage(run, compacted.usage)
            if (this.exhaustedBudget(run)) {
              this.cancel(run, 'budget_exhausted')
              return
            }
            if (!compacted.compacted) throw noCompactionProgress()
            overflowRetries += 1
            await this.traceCompaction(turnContext, 'overflow', compacted)
            selected = await this.ports.selectContext(
              session,
              run,
              provider,
              promptBuild,
              tools,
              primaryTarget,
            )
            if (!compactionAdvanced(before, selected.report, this.compactionPolicy)) {
              throw noCompactionProgress()
            }
          }
        }
        if (this.shouldStop(run)) return
        const toolCalls = turn.toolCalls
        stopReason = turn.stopReason
        usage = turn.usage
        this.recordUsage(run, usage, toolCalls.length)
        const callProgressGuidance = progress.observeToolCalls(toolCalls)
        if (this.exhaustedBudget(run)) {
          this.cancel(run, 'budget_exhausted')
          return
        }
        if (this.shouldStop(run)) return

        if (turn.content.length > 0) {
          if (this.shouldStop(run)) return
          await this.ports.commitMessage(session, run, {
            role: 'assistant',
            content: turn.content,
          })
          if (this.shouldStop(run)) return
        }

        if (toolCalls.length === 0 && stopReason === 'max_output_tokens') {
          this.ports.emit(
            {
              type: 'message_committed',
              runId: run.id,
              messageId: this.ports.nextMessageId(),
              role: 'assistant',
            },
            session.sessionId,
            run.id,
          )
          await this.finish(session, run, {
            type: 'prompt_failed',
            runId: run.id,
            code: 'PROVIDER_OUTPUT_TRUNCATED',
            category: 'provider',
            error: 'The Provider reached the bounded output limit before completing the response.',
          })
          return
        }

        if (toolCalls.length > 0) {
          const truncated = stopReason === 'max_output_tokens'
          const toolsPort = this.ports.tools(session, run)
          const rejections = new Map<string, ToolResult>()
          const prepared = new Map<string, PreparedToolInvocation>()
          for (const toolCall of toolCalls) {
            const validation = isRecord(toolCall.input)
              ? toolsPort.validateInput(toolCall.name, toolCall.input)
              : {
                  ok: false,
                  summary: 'Tool input must be a JSON object.',
                  error: {
                    code: 'TOOL_INPUT_INVALID',
                    category: 'validation' as const,
                    retryable: true,
                  },
                }
            if (validation) rejections.set(toolCall.id, validation)
          }
          const outcomes = await executeToolBatch(
            toolCalls,
            (toolCall) =>
              this.executeToolCall(
                session,
                run,
                toolCall,
                turnContext,
                truncated
                  ? {
                      ok: false,
                      summary: 'Tool call was rejected because Provider output was truncated.',
                      error: {
                        code: 'TOOL_CALL_TRUNCATED',
                        category: 'truncated',
                        retryable: true,
                      },
                    }
                  : rejections.get(toolCall.id),
                prepared.get(toolCall.id),
              ),
            () => this.shouldStop(run),
            {
              maxParallel: 2,
              descriptor: (toolCall) => {
                const input = isRecord(toolCall.input) ? toolCall.input : undefined
                if (!input || rejections.has(toolCall.id)) return undefined
                try {
                  const invocation =
                    prepared.get(toolCall.id) ??
                    toolsPort.prepare(toolCall.name, input, session.cwd)
                  prepared.set(toolCall.id, invocation)
                  return invocation.permission ? undefined : invocation.descriptor
                } catch {
                  return undefined
                }
              },
              settle: ({ call, result }) => this.settleToolCall(session, run, call, result),
            },
          )
          if (this.shouldStop(run)) return
          const committedTerminalResult =
            terminalTool === undefined
              ? undefined
              : outcomes.find(({ call, result }) => call.name === terminalTool.name && result.ok)
          if (committedTerminalResult !== undefined) {
            this.ports.emit(
              {
                type: 'message_committed',
                runId: run.id,
                messageId: this.ports.nextMessageId(),
                role: 'assistant',
              },
              session.sessionId,
              run.id,
            )
            await this.finish(session, run, {
              type: 'prompt_completed',
              runId: run.id,
              stopReason: 'terminal_tool',
              usage,
            })
            return
          }
          const resultProgressGuidance = progress.observeToolResults(
            outcomes.map(({ result }) => result),
            outcomes.map(({ call }) => call),
          )
          const progressGuidance = resultProgressGuidance ?? callProgressGuidance
          if (progressGuidance) {
            await this.ports.commitMessage(session, run, {
              role: 'user',
              content: progressGuidance,
              intent: 'context',
              trust: 'low',
            })
          }
          continue
        }
        if (run.steerQueue.length > 0) continue
        if (terminalTool !== undefined) {
          requireTerminalTool = true
          await this.ports.commitMessage(session, run, {
            role: 'user',
            content: `Commit the completed result now by calling ${terminalTool.name} exactly once. Its arguments must match the signed output schema. Do not return the result as prose.`,
            intent: 'context',
            trust: 'low',
          })
          continue
        }
        const completionGuidance = await this.ports.completionGuidance?.(session, run)
        if (completionGuidance !== undefined) {
          await this.ports.commitMessage(session, run, {
            role: 'user',
            content: completionGuidance,
            intent: 'context',
            trust: 'low',
          })
          continue
        }
        this.ports.emit(
          {
            type: 'message_committed',
            runId: run.id,
            messageId: this.ports.nextMessageId(),
            role: 'assistant',
          },
          session.sessionId,
          run.id,
        )
        await this.finish(session, run, {
          type: 'prompt_completed',
          runId: run.id,
          stopReason: stopReason ?? 'end_turn',
          usage,
        })
        return
      }
      // An unbudgeted loop has no natural fall-through; this branch is reached
      // only after an explicit cumulative turn ceiling is exhausted.
      throw runtimeError(
        'AGENT_TURN_LIMIT_EXCEEDED',
        'planner',
        `Agent reached the ${turnCeiling!}-turn cumulative limit before producing a final response. Continue the session or raise the maximum turn limit.`,
        { maxTurns: turnCeiling! },
        true,
      )
    } catch (error) {
      if (!this.shouldStop(run)) {
        const failure = toFailure(error)
        await this.finish(session, run, {
          type: 'prompt_failed',
          runId: run.id,
          code: failure.code,
          category: failure.category,
          error: failure.message,
        })
      }
    } finally {
      if (run.aborted && !run.terminal) {
        await this.finish(session, run, {
          type: 'prompt_aborted',
          runId: run.id,
          reason: run.cancellationReason ?? 'user_abort',
        })
      }
    }
  }

  cancel(run: AgentRun, reason: CancellationReason): void {
    if (run.aborted) return
    run.aborted = true
    run.cancellationReason = reason
    run.controller.abort()
  }

  async finish(session: AgentSession, run: AgentRun, event: TerminalAgentEvent): Promise<void> {
    if (run.terminal) return
    run.terminal = true
    try {
      const finalized = await this.ports.finishRun(session, run, event)
      event = finalized
    } finally {
      await this.trace(this.terminalTrace(run, event))
      this.runStartedAt.delete(run.id)
    }
  }

  async queueSteer(
    session: AgentSession,
    run: AgentRun,
    text: string,
    beforeQueue?: (steerId: string) => Promise<number | undefined>,
  ): Promise<string> {
    if (this.shouldStop(run)) {
      throw runtimeError('RUN_NOT_ACTIVE', 'protocol', 'Cannot steer an aborted or terminal run.', {
        runId: run.id,
      })
    }
    const steerId = this.ports.nextSteerId()
    const workflowMessageSequence = await beforeQueue?.(steerId)
    run.steerQueue.push({
      id: steerId,
      text,
      ...(workflowMessageSequence === undefined ? {} : { workflowMessageSequence }),
    })
    this.ports.emit({ type: 'steer_queued', runId: run.id, steerId }, session.sessionId, run.id)
    return steerId
  }

  private async applySteers(session: AgentSession, run: AgentRun): Promise<void> {
    for (const steer of run.steerQueue.splice(0)) {
      if (this.shouldStop(run)) return
      await this.ports.commitMessage(session, run, typedSteerMessage(steer.text))
      await this.ports.acknowledgeSteer?.(session, run, steer)
      this.ports.emit(
        { type: 'steer_applied', runId: run.id, steerId: steer.id },
        session.sessionId,
        run.id,
      )
      if (this.shouldStop(run)) return
    }
  }

  private async executeToolCall(
    session: AgentSession,
    run: AgentRun,
    toolCall: ProviderToolCall,
    turnContext: TraceContext,
    rejected?: ToolResult,
    preparedInvocation?: PreparedToolInvocation,
  ): Promise<ToolResult> {
    const input = isRecord(toolCall.input) ? toolCall.input : {}
    const toolContext = { ...turnContext, toolCallId: toolCall.id }
    if (this.shouldStop(run)) return cancelledToolResult()
    this.ports.emit(
      { type: 'tool_planning', runId: run.id, toolCallId: toolCall.id, name: toolCall.name, input },
      session.sessionId,
      run.id,
    )
    const startedAt = Date.now()
    await this.trace({
      kind: 'tool.started',
      context: toolContext,
      attributes: { toolName: toolCall.name },
    })

    let result: ToolResult
    let toolOutcome: NonNullable<TraceAttributes['toolOutcome']> = 'invocation_failed'
    let errorCode: string | undefined
    const tools = this.ports.tools(session, run)
    try {
      if (rejected) {
        toolOutcome = 'input_blocked'
        errorCode = rejected.error?.code ?? 'TOOL_CALL_REJECTED'
        result = rejected
      } else if (!isRecord(toolCall.input)) {
        toolOutcome = 'input_blocked'
        errorCode = 'TOOL_INPUT_INVALID'
        result = {
          ok: false,
          summary: 'Tool input must be a JSON object.',
          error: { code: errorCode, category: 'validation', retryable: true },
        }
      } else {
        const prepared = preparedInvocation ?? tools.prepare(toolCall.name, input, session.cwd)
        if (
          prepared.permission &&
          this.ports.hasPermissionRule(toolCall.name, prepared.permission, session.cwd)
        ) {
          await this.trace({
            kind: 'permission.decided',
            context: toolContext,
            attributes: { toolName: toolCall.name, permissionDecision: 'allow_always' },
          })
          result = await this.runTool(session, run, toolCall, input, prepared)
        } else if (prepared.permission) {
          const decision = await this.ports.requestPermission(
            session,
            run,
            toolCall,
            input,
            prepared.permission,
          )
          await this.trace({
            kind: 'permission.decided',
            context: toolContext,
            attributes: { toolName: toolCall.name, permissionDecision: decision.type },
          })
          if (decision.type === 'deny' || this.shouldStop(run)) {
            toolOutcome = 'policy_blocked'
            errorCode = this.shouldStop(run) ? 'TOOL_CANCELLED' : 'TOOL_PERMISSION_DENIED'
            result = {
              ok: false,
              summary:
                decision.type === 'deny'
                  ? (decision.reason ?? 'Permission denied by user.')
                  : 'Tool invocation was cancelled.',
              error: {
                code: errorCode,
                category: 'permission',
                retryable: decision.type !== 'deny',
              },
            }
          } else {
            result = await this.runTool(session, run, toolCall, input, prepared)
          }
        } else {
          result = await this.runTool(session, run, toolCall, input, prepared)
        }
      }
    } catch (error) {
      if (isUnrecoverableToolBoundary(error)) {
        const failure = toolFailure(error)
        await this.trace({
          kind: 'tool.failed',
          context: toolContext,
          attributes: {
            toolName: toolCall.name,
            toolOutcome: 'invocation_failed',
            errorCode: failure.code,
            errorCategory: failure.category,
          },
          metrics: { durationMs: elapsed(startedAt) },
        })
        throw error
      }
      const failure = toolFailure(error)
      errorCode = failure.code
      result = {
        ok: false,
        summary: failure.message,
        error: {
          code: failure.code,
          category: failure.toolCategory,
          retryable: failure.retryable,
        },
      }
    }

    if (toolOutcome === 'invocation_failed') {
      toolOutcome = result.ok ? 'completed' : 'invocation_failed'
      if (!result.ok) errorCode = result.error?.code ?? 'TOOL_RETURNED_ERROR'
    }
    await this.trace({
      kind: toolOutcome === 'completed' ? 'tool.completed' : 'tool.failed',
      context: toolContext,
      attributes: {
        toolName: toolCall.name,
        toolOutcome,
        ...(errorCode === undefined ? {} : { errorCode }),
        ...(result.error === undefined ? {} : { errorCategory: result.error.category }),
      },
      metrics: { durationMs: elapsed(startedAt) },
    })

    return result
  }

  private async settleToolCall(
    session: AgentSession,
    run: AgentRun,
    toolCall: ProviderToolCall,
    result: ToolResult,
  ): Promise<void> {
    if (this.shouldStop(run)) return
    this.recordSpawnedAgents(run, toolCall.name, result)
    this.ports.emit(
      {
        type: 'tool_end',
        runId: run.id,
        toolCallId: toolCall.id,
        ok: result.ok,
        summary: result.summary,
        ...(result.output === undefined ? {} : { output: result.output }),
        ...(result.error === undefined ? {} : { error: result.error }),
      },
      session.sessionId,
      run.id,
    )
    await this.ports.commitMessage(session, run, {
      role: 'tool',
      toolCallId: toolCall.id,
      name: toolCall.name,
      content: JSON.stringify(result),
      ...(isSkillInvocationEntry(result.output)
        ? { skillInvocation: structuredClone(result.output) }
        : {}),
    })
  }

  private recordSpawnedAgents(run: AgentRun, toolName: string, result: ToolResult): void {
    const output = result.output
    if (!isRecord(output)) return
    let count = 0
    if (toolName === 'agent.delegate' || toolName === 'agent.handoff') {
      count = typeof output.nodeId === 'string' ? 1 : 0
    } else if (toolName === 'workflow.subworkflow') {
      count = typeof output.childWorkflowId === 'string' ? 1 : 0
    } else if (toolName === 'workflow.expand') {
      count =
        typeof output.results === 'object' && output.results !== null
          ? Object.keys(output.results).length
          : 0
    } else if (toolName === 'workflow.loop') {
      count = Array.isArray(output.iterations) ? output.iterations.length : 0
    }
    if (count === 0) return
    const usage = run.usage ?? { turns: 0, toolCalls: 0, subagents: 0 }
    usage.subagents += count
    run.usage = usage
  }

  private async runTool(
    session: AgentSession,
    run: AgentRun,
    toolCall: ProviderToolCall,
    input: Record<string, unknown>,
    prepared: PreparedToolInvocation,
  ) {
    this.ports.emit(
      { type: 'tool_start', runId: run.id, toolCallId: toolCall.id, name: toolCall.name, input },
      session.sessionId,
      run.id,
    )
    return this.ports
      .tools(session, run)
      .executePrepared(prepared, run.controller.signal, (update) => {
        if (this.shouldStop(run)) return
        this.ports.emit(
          {
            type: 'tool_update',
            runId: run.id,
            toolCallId: toolCall.id,
            message: update.message,
            ...(update.stream === undefined ? {} : { stream: update.stream }),
            ...(update.delta === undefined ? {} : { delta: update.delta }),
            ...(update.bytes === undefined ? {} : { bytes: update.bytes }),
          },
          session.sessionId,
          run.id,
        )
      })
  }

  private async trace(record: TraceInput): Promise<void> {
    try {
      await this.ports.trace(record)
    } catch {
      // Trace persistence is diagnostic-only and cannot affect Agent lifecycle state.
    }
  }

  private async traceContextSelection(
    context: TraceContext,
    report: ContextReport | undefined,
    attributes?: TraceAttributes,
  ): Promise<void> {
    if (!report) return
    await this.trace({
      kind: 'context.selected',
      context,
      ...(attributes ? { attributes } : {}),
      metrics: {
        contextLimitTokens: report.contextWindowTokens,
        reservedTokens: report.reservedTokens,
        estimatedTokens: report.selectedTokens,
        uncompactedTokens: report.uncompactedTokens,
        checkpointTokens: report.checkpointTokens,
        selectedMessages: report.selectedMessages,
        omittedMessages: report.omittedMessages,
        ...(report.contextEditing === undefined
          ? {}
          : {
              toolResultTokensBefore: report.contextEditing.toolResultTokensBefore,
              toolResultTokensAfter: report.contextEditing.toolResultTokensAfter,
              truncatedToolResults: report.contextEditing.truncatedToolResults,
              truncatedToolResultTokens: report.contextEditing.truncatedToolResultTokens,
              clearedToolResults: report.contextEditing.clearedToolResults,
              clearedToolResultTokens: report.contextEditing.clearedToolResultTokens,
            }),
        ...(report.reasoningEditing === undefined
          ? {}
          : {
              reasoningTokensBefore: report.reasoningEditing.reasoningTokensBefore,
              reasoningTokensAfter: report.reasoningEditing.reasoningTokensAfter,
              clearedReasoningBlocks: report.reasoningEditing.clearedReasoningBlocks,
              clearedReasoningTurns: report.reasoningEditing.clearedReasoningTurns,
              clearedReasoningTokens: report.reasoningEditing.clearedReasoningTokens,
            }),
      },
    })
  }

  private async traceCompaction(
    context: TraceContext,
    reason: 'threshold' | 'overflow',
    result: {
      checkpointTokens?: number
      omittedMessages?: number
      usage?: ProviderUsage
    },
  ): Promise<void> {
    await this.trace({
      kind: 'context.compacted',
      context,
      attributes: { compactionReason: reason },
      metrics: {
        ...(result.checkpointTokens === undefined
          ? {}
          : { checkpointTokens: result.checkpointTokens }),
        ...(result.omittedMessages === undefined
          ? {}
          : { omittedMessages: result.omittedMessages }),
        ...(result.usage?.inputTokens === undefined
          ? {}
          : { inputTokens: result.usage.inputTokens }),
        ...(result.usage?.outputTokens === undefined
          ? {}
          : { outputTokens: result.usage.outputTokens }),
      },
    })
  }

  private async tracePromptManifest(run: AgentRun, manifest: PromptManifest): Promise<void> {
    // PromptManifest and PromptAssemblyManifest are content-free by contract. Keep the
    // complete assembly decisions in the digest without tracing prompt plaintext.
    const summary = structuredClone(manifest)
    const manifestDigest = `sha256:${createHash('sha256')
      .update(JSON.stringify(summary))
      .digest('hex')}`
    await this.trace({
      kind: 'prompt.manifest',
      context: run.trace,
      attributes: { manifestDigest, promptVariant: summary.program.variant },
      metrics: {
        sectionCount: summary.sections.length,
        estimatedTokens: summary.estimatedTokens,
      },
    })
    for (const section of summary.sections) {
      await this.trace({
        kind: 'prompt.manifest',
        context: run.trace,
        attributes: {
          manifestDigest,
          promptSectionId: section.id,
          promptSectionDigest: section.digest,
          promptSectionSource: section.source,
          promptSectionCacheScope: section.cacheScope,
          promptSectionIncluded: section.included,
        },
        metrics: {
          sectionOrder: section.order,
          characters: section.characters,
          estimatedTokens: section.estimatedTokens,
        },
      })
    }
  }

  private terminalTrace(run: AgentRun, event: TerminalAgentEvent): TraceInput {
    const metrics = {
      durationMs: elapsed(this.runStartedAt.get(run.id) ?? Date.now()),
      ...(run.usage?.inputTokens === undefined ? {} : { inputTokens: run.usage.inputTokens }),
      ...(run.usage?.outputTokens === undefined ? {} : { outputTokens: run.usage.outputTokens }),
      ...(run.usage?.cacheReadTokens === undefined
        ? {}
        : { cacheReadTokens: run.usage.cacheReadTokens }),
      ...(run.usage?.cacheWriteTokens === undefined
        ? {}
        : { cacheWriteTokens: run.usage.cacheWriteTokens }),
      ...(run.usage?.costUsd === undefined ? {} : { costUsd: run.usage.costUsd }),
    }
    if (event.type === 'prompt_completed') {
      return {
        kind: 'run.completed',
        context: run.trace,
        attributes: event.stopReason === undefined ? undefined : { stopReason: event.stopReason },
        metrics,
      }
    }
    if (event.type === 'prompt_aborted') {
      return {
        kind: 'run.aborted',
        context: run.trace,
        attributes: event.reason === undefined ? undefined : { stopReason: event.reason },
        metrics,
      }
    }
    return {
      kind: 'run.failed',
      context: run.trace,
      attributes: {
        ...(event.code === undefined
          ? {}
          : { errorCode: boundedTraceCode(event.code, 'RUNTIME_ERROR') }),
        ...(event.category === undefined ? {} : { errorCategory: event.category }),
      },
      metrics,
    }
  }

  private shouldStop(run: AgentRun): boolean {
    return run.aborted || run.terminal
  }

  private recordUsage(run: AgentRun, usage: ProviderUsage | undefined, toolCalls: number): void {
    const current = run.usage ?? { turns: 0, toolCalls: 0, subagents: 0 }
    current.turns += 1
    current.toolCalls += toolCalls
    if (usage?.inputTokens !== undefined) {
      current.inputTokens = (current.inputTokens ?? 0) + usage.inputTokens
    }
    if (usage?.outputTokens !== undefined) {
      current.outputTokens = (current.outputTokens ?? 0) + usage.outputTokens
    }
    if (usage?.cacheReadTokens !== undefined) {
      current.cacheReadTokens = (current.cacheReadTokens ?? 0) + usage.cacheReadTokens
    }
    if (usage?.cacheWriteTokens !== undefined) {
      current.cacheWriteTokens = (current.cacheWriteTokens ?? 0) + usage.cacheWriteTokens
    }
    if (usage?.costUsd !== undefined) {
      current.costUsd = (current.costUsd ?? 0) + usage.costUsd
    }
    run.usage = current
  }

  private recordAuxiliaryUsage(run: AgentRun, usage: ProviderUsage | undefined): void {
    if (usage === undefined) return
    const current = run.usage ?? { turns: 0, toolCalls: 0, subagents: 0 }
    if (usage.inputTokens !== undefined) {
      current.inputTokens = (current.inputTokens ?? 0) + usage.inputTokens
    }
    if (usage.outputTokens !== undefined) {
      current.outputTokens = (current.outputTokens ?? 0) + usage.outputTokens
    }
    if (usage.cacheReadTokens !== undefined) {
      current.cacheReadTokens = (current.cacheReadTokens ?? 0) + usage.cacheReadTokens
    }
    if (usage.cacheWriteTokens !== undefined) {
      current.cacheWriteTokens = (current.cacheWriteTokens ?? 0) + usage.cacheWriteTokens
    }
    if (usage.costUsd !== undefined) {
      current.costUsd = (current.costUsd ?? 0) + usage.costUsd
    }
    run.usage = current
  }

  private exhaustedBudget(run: AgentRun): boolean {
    const budget = run.budget
    if (!budget || !run.usage) return false
    const tokens = (run.usage.inputTokens ?? 0) + (run.usage.outputTokens ?? 0)
    return (
      run.usage.toolCalls > budget.maxToolCalls ||
      (budget.maxTokens !== undefined && tokens > budget.maxTokens) ||
      (budget.deadlineAt !== undefined && Date.now() >= Date.parse(budget.deadlineAt))
    )
  }
}

function remainingOutputBudget(run: AgentRun): number | undefined {
  const maximum = run.budget?.maxTokens
  if (maximum === undefined) return undefined
  const used = (run.usage?.inputTokens ?? 0) + (run.usage?.outputTokens ?? 0)
  return Math.max(1, maximum - used)
}

function providerOutputLimit(run: AgentRun, modelLimit: number | undefined): number | undefined {
  const remaining = remainingOutputBudget(run)
  if (remaining === undefined) return modelLimit
  if (modelLimit === undefined) return remaining
  return Math.min(remaining, modelLimit)
}

type ProviderSelection = Readonly<{
  messages: ProviderMessage[]
  contextMessages?: ProviderMessage[]
  nativeContext?: ProviderNativeContext
  report?: ContextReport
  manifest?: PromptManifest
}>

function providerRequestForSelection(
  session: AgentSession,
  run: AgentRun,
  promptBuild: SystemPromptBuild,
  tools: ProviderToolDefinition[],
  selected: ProviderSelection,
  maxOutputTokens: number | undefined,
): ProviderRequest {
  return {
    model: session.model,
    messages: selected.messages,
    contextMessages: [...promptBuild.contextMessages, ...(selected.contextMessages ?? [])],
    tools,
    instructions: promptBuild.instructions,
    promptManifest: selected.manifest ?? promptBuild.manifest,
    signal: run.controller.signal,
    ...(selected.nativeContext === undefined ? {} : { nativeContext: selected.nativeContext }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
  }
}

function compactionProviderCandidate(
  provider: ChatProvider,
  request: ProviderRequest,
  report: ContextReport | undefined,
):
  | Readonly<{
      provider: ChatProvider
      request: ProviderRequest
      nativeEligible: boolean
    }>
  | undefined {
  // The same Provider drives the portable semantic summary for every backend;
  // Providers with a native compact endpoint additionally produce opaque state.
  if (report === undefined) return undefined
  return {
    provider,
    request,
    nativeEligible: report.uncoveredOmittedMessages === 0,
  }
}

function toFailure(error: unknown): {
  code: string
  category?: RuntimeError['category']
  message: string
} {
  if (isRuntimeError(error)) {
    return { code: error.code, category: error.category, message: error.message }
  }
  if (error instanceof ProviderStreamProtocolError) {
    return {
      code: error.code,
      category: 'provider',
      message: 'The provider returned a malformed stream.',
    }
  }
  const failure = runtimeError('PROVIDER_ERROR', 'provider', 'The provider request failed.')
  return { code: failure.code, category: failure.category, message: failure.message }
}

function toolFailure(error: unknown): {
  code: string
  category: string
  toolCategory: NonNullable<ToolResult['error']>['category']
  message: string
  retryable: boolean
} {
  if (isRuntimeError(error)) {
    return {
      code: boundedTraceCode(error.code, 'TOOL_ERROR'),
      category: error.category,
      toolCategory: error.category === 'permission' ? 'permission' : 'execution',
      message: error.message,
      retryable: error.retryable,
    }
  }
  return {
    code: 'TOOL_ERROR',
    category: 'tool',
    toolCategory: 'execution',
    message: 'Tool execution failed.',
    retryable: false,
  }
}

function isUnrecoverableToolBoundary(error: unknown): boolean {
  return (
    isRuntimeError(error) &&
    (error.category === 'plugin' ||
      error.category === 'persistence' ||
      error.category === 'subagent')
  )
}

type ContextReport = {
  contextWindowTokens: number
  reservedTokens: number
  uncompactedTokens?: number
  selectedTokens: number
  checkpointTokens: number
  selectedMessages: number
  omittedMessages: number
  uncoveredOmittedMessages: number
  pressure: number
  checkpointId?: string
  contextState?: 'none' | 'semantic_checkpoint' | 'provider_native'
  contextEditing?: Readonly<{
    toolResultTokensBefore: number
    toolResultTokensAfter: number
    truncatedToolResults: number
    truncatedToolResultTokens: number
    clearedToolResults: number
    clearedToolResultTokens: number
  }>
  reasoningEditing?: Readonly<{
    reasoningTokensBefore: number
    reasoningTokensAfter: number
    clearedReasoningBlocks: number
    clearedReasoningTurns: number
    clearedReasoningTokens: number
  }>
}

function compactionAdvanced(
  before: ContextReport | undefined,
  after: ContextReport | undefined,
  policy: CompactionPolicy,
): boolean {
  if (before === undefined || after === undefined) return false
  return (
    (after.checkpointId !== undefined && after.checkpointId !== before.checkpointId) ||
    after.uncoveredOmittedMessages < before.uncoveredOmittedMessages ||
    after.selectedTokens <= before.selectedTokens - Math.max(1, policy.minimumGain)
  )
}

function noCompactionProgress() {
  return runtimeError(
    'CONTEXT_COMPACTION_NO_PROGRESS',
    'provider',
    'Context compaction did not make bounded progress.',
  )
}

function cancelledToolResult(): ToolResult {
  return {
    ok: false,
    summary: 'Tool invocation was cancelled.',
    error: { code: 'TOOL_CANCELLED', category: 'execution', retryable: true },
  }
}

function boundedTraceCode(code: string, fallback: string): string {
  return /^[A-Z0-9_]{1,64}$/.test(code) ? code : fallback
}

function elapsed(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
