import type { PromptBuildInput } from '@praxis/core-sdk'
import {
  ProjectInstructionLoader,
  type ProjectInstructionLoad,
} from './projectInstructionLoader.js'

export type ContextBuildRequest = Omit<PromptBuildInput, 'workspace'> & {
  cwd: string
}

export type ProjectInstructionSource = {
  load(cwd: string): Promise<ProjectInstructionLoad>
}

/** Supplies only runtime facts that H1 explicitly permits as prompt sources. */
export class ContextBuilder {
  constructor(
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly projectInstructions: ProjectInstructionSource = new ProjectInstructionLoader(),
  ) {}

  async build(request: ContextBuildRequest): Promise<PromptBuildInput> {
    const projectInstructions = await this.projectInstructions.load(request.cwd)
    return {
      ...request,
      workspace: {
        cwd: request.cwd,
        platform: this.platform,
        shell: this.platform === 'win32' ? 'powershell' : 'posix',
      },
      projectInstructions: projectInstructions.instructions,
      projectInstructionDecisions: projectInstructions.decisions,
    }
  }
}
