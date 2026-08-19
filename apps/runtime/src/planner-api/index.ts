import type { AgentRun, AgentSession } from '@praxis/core-sdk'

export type {
  SubagentCancellationRequestV1,
  SubagentExecutionRequestV1,
  SubagentExecutor,
  SubagentResultV1,
  SubagentVersionedRefV1,
} from '@praxis/core-sdk'

export type PlannerExecution = {
  session: AgentSession
  run: AgentRun
}

export interface Planner {
  execute(input: PlannerExecution): Promise<void>
}
