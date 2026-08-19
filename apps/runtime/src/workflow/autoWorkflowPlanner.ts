import type {
  AgentRun,
  CapabilityRequestV1,
  RuntimeTool,
  WorkflowAuthorityPortV1,
  WorkflowModePolicyV1,
  WorkflowProjectionV1,
} from '@praxis/core-sdk'
import { promptDigest } from '@praxis/core-sdk'
import { LONG_LIVED_EXECUTION_POLICY_V1 } from '../longLivedExecutionPolicy.js'
import type { AgentLoop } from '../loop/index.js'
import type { Planner, PlannerExecution } from '../planner-api/index.js'
import type { ToolRuntime } from '../tools/toolRuntime.js'
import { AgentDelegateToolV1, type WorkflowAgentWorkerPortV1 } from './agentDelegateTool.js'
import { AgentHandoffToolV1 } from './agentHandoffTool.js'
import { SubworkflowToolV1 } from './subworkflowTool.js'
import { WorkflowCompensationToolV1 } from './workflowCompensationTool.js'
import { WorkflowEffectBrokerV1 } from './workflowEffectBroker.js'
import { WorkflowExpandToolV1 } from './workflowExpandTool.js'
import { WorkflowLoopToolV1 } from './workflowLoopTool.js'
import { registerBuiltinAgentProfilesV1, WorkflowOrchestratorV1 } from './workflowOrchestrator.js'
import { WorkflowWaitToolV1 } from './workflowWaitTools.js'

type WorkflowRuntimeRun = AgentRun & {
  tools: ToolRuntime
  workflowId?: string
  terminalOutcome?: 'completed' | 'failed' | 'aborted'
  terminalCode?: string
  finalizeWorkflow?: (terminal: Readonly<{ ok: boolean; errorCode?: string }>) => Promise<void>
}

export type AutoWorkflowPlannerOptionsV1 = Readonly<{
  authority: WorkflowAuthorityPortV1
  loop: AgentLoop
  mode(input: PlannerExecution): WorkflowModePolicyV1
  grant(input: PlannerExecution): CapabilityRequestV1
  worker(input: PlannerExecution): WorkflowAgentWorkerPortV1 | Promise<WorkflowAgentWorkerPortV1>
  artifacts: ConstructorParameters<typeof WorkflowEffectBrokerV1>[1]
  emitProjection?(projection: WorkflowProjectionV1, input: PlannerExecution): void
}>

/** One execution path: every prompt is a durable Workflow with a root AgentTask. */
export class AutoWorkflowPlannerV1 implements Planner {
  readonly #orchestrator: WorkflowOrchestratorV1
  #initialized?: Promise<void>

  constructor(private readonly options: AutoWorkflowPlannerOptionsV1) {
    this.#orchestrator = new WorkflowOrchestratorV1(options.authority)
  }

  async execute(input: PlannerExecution): Promise<void> {
    await this.initialize()
    const run = input.run as WorkflowRuntimeRun
    const mode = this.options.mode(input)
    const projection = await this.#orchestrator.start({
      sessionId: input.session.sessionId,
      parentRunId: input.run.id,
      objective: input.run.text,
      modePolicy: mode,
      cwd: input.session.cwd,
      rootGrant: this.options.grant(input),
      budget: workflowBudget(input.run),
      executionTarget: { providerId: input.session.provider, model: input.session.model },
    })
    run.workflowId = projection.workflowId
    this.options.emitProjection?.(projection, input)
    const claim = await this.#orchestrator.claimRoot(
      projection.workflowId,
      `root-worker-${input.run.id}`,
    )
    const running = await this.#orchestrator.markRunning(claim)
    this.options.emitProjection?.(running, input)
    let workflowFinalized = false
    run.finalizeWorkflow = async (terminal) => {
      if (workflowFinalized) return
      const completed = await this.#orchestrator.complete(claim, { ...terminal, usage: run.usage })
      workflowFinalized = true
      this.options.emitProjection?.(completed, input)
    }
    let compensationRegistered = false
    let workflowTools: ToolRuntime
    const effectBroker = new WorkflowEffectBrokerV1(
      this.#orchestrator,
      this.options.artifacts,
      projection.workflowId,
      (next) => this.options.emitProjection?.(next, input),
      () => {
        if (compensationRegistered) return
        compensationRegistered = true
        workflowTools.register(
          new WorkflowCompensationToolV1(this.#orchestrator, projection.workflowId, (next) =>
            this.options.emitProjection?.(next, input),
          ),
        )
      },
      mode,
    )
    workflowTools = run.tools.fork([], { executionBroker: effectBroker })
    run.tools = workflowTools
    const worker = await this.options.worker(input)
    const modelTools: RuntimeTool[] =
      mode === 'solo'
        ? []
        : [
            new AgentDelegateToolV1(
              this.#orchestrator,
              worker,
              projection.workflowId,
              'root',
              (next) => this.options.emitProjection?.(next, input),
            ),
            new AgentHandoffToolV1(
              this.#orchestrator,
              worker,
              projection.workflowId,
              'root',
              (next) => this.options.emitProjection?.(next, input),
            ),
            new SubworkflowToolV1(this.#orchestrator, worker, projection.workflowId, (next) =>
              this.options.emitProjection?.(next, input),
            ),
            new WorkflowExpandToolV1(this.#orchestrator, worker, projection.workflowId, (next) =>
              this.options.emitProjection?.(next, input),
            ),
            new WorkflowLoopToolV1(this.#orchestrator, worker, projection.workflowId, (next) =>
              this.options.emitProjection?.(next, input),
            ),
            new WorkflowWaitToolV1(this.#orchestrator, projection.workflowId, (next) =>
              this.options.emitProjection?.(next, input),
            ),
          ]
    for (const tool of modelTools) workflowTools.register(tool)
    const toolDefinitions = workflowTools.definitions()
    const executionSnapshot = await this.options.artifacts.put(
      {
        schemaVersion: 1,
        kind: 'workflow_execution_snapshot',
        workflowId: projection.workflowId,
        taskId: claim.task.taskId,
        attemptId: claim.task.attemptId,
        runId: input.run.id,
        sessionId: input.session.sessionId,
        provider: input.session.provider,
        model: input.session.model,
        workspace: input.session.cwd,
        mode,
        grant: this.options.grant(input),
        budget: input.run.budget,
        profileRef: claim.task.profileRef,
        capabilities: toolDefinitions.map((definition) => ({
          name: definition.name,
          digest: promptDigest(JSON.stringify(definition)),
        })),
        createdAt: new Date().toISOString(),
      },
      'application/vnd.praxis.workflow-execution-snapshot+json',
    )
    await this.options.authority.bindTaskCapabilityBundle(claim.task.taskId, claim.lease.token, {
      id: executionSnapshot.artifactId,
      version: 1,
      digest: executionSnapshot.digest as `sha256:${string}`,
    })
    const heartbeat = setInterval(() => {
      void this.options.authority
        .heartbeat(claim.task.taskId, claim.lease.token, false)
        .catch(() => undefined)
    }, 30_000)
    heartbeat.unref?.()
    try {
      await this.options.loop.execute(input.session, run)
      if (!workflowFinalized) {
        const ok = run.terminalOutcome === 'completed'
        await run.finalizeWorkflow({
          ok,
          errorCode: ok
            ? undefined
            : (run.terminalCode ?? `ROOT_AGENT_${(run.terminalOutcome ?? 'failed').toUpperCase()}`),
        })
      }
    } catch (error) {
      await run.finalizeWorkflow({ ok: false, errorCode: errorCode(error) }).catch(() => undefined)
      throw error
    } finally {
      clearInterval(heartbeat)
      delete run.finalizeWorkflow
    }
  }

  private initialize(): Promise<void> {
    this.#initialized ??= this.options.authority
      .initialize()
      .then(() => registerBuiltinAgentProfilesV1(this.options.authority))
    return this.#initialized
  }
}

function workflowBudget(run: AgentRun) {
  const budget = run.budget
  const childRuns = budget?.maxChildRuns ?? LONG_LIVED_EXECUTION_POLICY_V1.maxChildRuns
  const remaining =
    budget?.deadlineAt === undefined
      ? LONG_LIVED_EXECUTION_POLICY_V1.maxWallClockMs
      : Math.max(1, Date.parse(budget.deadlineAt) - Date.now())
  return {
    maxWallClockMs: remaining,
    maxTokens: Math.max(1, budget?.maxTokens ?? LONG_LIVED_EXECUTION_POLICY_V1.maxWorkflowTokens),
    maxToolCalls: Math.max(
      1,
      budget?.maxToolCalls ?? LONG_LIVED_EXECUTION_POLICY_V1.maxWorkflowToolCalls,
    ),
    // Root is represented as one AgentTask in addition to delegated Child
    // runs. Saturate the v4 unlimited sentinel instead of overflowing beyond
    // JavaScript's safe-integer contract.
    maxAgentTasks:
      childRuns >= Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : Math.max(1, childRuns + 1),
    maxParallelTasks: Math.max(
      1,
      budget?.maxParallelChildren ?? LONG_LIVED_EXECUTION_POLICY_V1.maxParallelChildren,
    ),
  }
}

function errorCode(error: unknown): string {
  return error instanceof Error && typeof Reflect.get(error, 'code') === 'string'
    ? Reflect.get(error, 'code')
    : 'WORKFLOW_ROOT_FAILED'
}
