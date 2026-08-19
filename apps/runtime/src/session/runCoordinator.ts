import type { AgentEvent, AgentRun, SessionMemory, SessionRecord } from '@praxis/core-sdk'
import type { ManagedSession, SessionService } from './sessionService.js'

export type TerminalAgentEvent = Extract<
  AgentEvent,
  { type: 'prompt_completed' | 'prompt_failed' | 'prompt_aborted' }
>

export class RunCoordinator {
  constructor(private readonly sessions: SessionService<AgentRun>) {}

  async finalize(
    session: ManagedSession<AgentRun>,
    run: AgentRun,
    event: TerminalAgentEvent,
  ): Promise<TerminalAgentEvent> {
    try {
      await this.sessions.finalizeRun(session, run.id, {
        memory: terminalMemory(session.memory, event),
        terminal: terminalState(event),
        usage: terminalUsage(run),
        ...(event.type === 'prompt_failed' ? { errorCode: event.code } : {}),
      })
      return event
    } catch {
      this.sessions.failFinalization(session, run.id)
      return {
        type: 'prompt_failed',
        runId: run.id,
        code: 'PERSISTENCE_OPERATION_FAILED',
        category: 'persistence',
        error: 'Session finalization failed; resume the session before continuing.',
      }
    }
  }
}

function terminalMemory(memory: SessionMemory, event: TerminalAgentEvent): SessionMemory {
  const currentPlan = memory.plan
  return {
    sessionId: memory.sessionId,
    ...(memory.checkpoint === undefined ? {} : { checkpoint: memory.checkpoint }),
    ...(currentPlan === undefined
      ? {}
      : {
          plan: {
            ...currentPlan,
            steps: currentPlan.steps.map((step) =>
              step.id === 'execute'
                ? {
                    ...step,
                    state: event.type === 'prompt_completed' ? 'completed' : 'blocked',
                  }
                : step,
            ),
            revision: currentPlan.revision + 1,
            updatedAt: new Date().toISOString(),
          },
        }),
  }
}

function terminalState(event: TerminalAgentEvent): 'completed' | 'failed' | 'aborted' {
  if (event.type === 'prompt_completed') return 'completed'
  if (event.type === 'prompt_aborted') return 'aborted'
  return 'failed'
}

function terminalUsage(run: AgentRun): SessionRecord['usage'] {
  return {
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
}
