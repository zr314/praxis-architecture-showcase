import type { PlannerCapability } from '@praxis/core-sdk'
import type { AgentLoop } from '../loop/index.js'
import type { PlannerExecution } from '../planner-api/index.js'

/** Executes one admitted agent task through the shared AgentLoop. */
export class AgentTaskPlanner implements PlannerCapability {
  constructor(private readonly loop: AgentLoop) {}

  async execute(input: unknown): Promise<void> {
    const execution = input as PlannerExecution
    await this.loop.execute(execution.session, execution.run)
  }
}
