import { appendFile, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { RuntimeTool } from '@praxis/core-sdk'
import { RuntimeKernel } from '../../framework/runtimeKernel.js'
import { digest } from '../../recap/recap.js'
import type { RecapContext } from '../../recap/recapContext.js'
import { ReadTool } from '../../tools/readTool.js'
import { WriteTool } from '../../tools/writeTool.js'
import { ProgramTool } from './programTool.js'
import { RepositoryTool } from './repositoryTool.js'
import { RecapSmokeProvider } from './smokeProvider.js'

// This private launch file contains only this trial's inputs. No suite, future tasks or graders.
const config = JSON.parse(await readFile(process.argv[2]!, 'utf8')) as {
  smoke: boolean
  unlimited?: boolean
  programMode?: boolean
  repositoryContainer?: string
  workspace: string
  readableFiles: string[]
  telemetry: string
  recapContext?: RecapContext
}
// Fixture inputs are immutable; the model cannot inspect the grader or any earlier workspace.
const boundedTool = (tool: RuntimeTool, names: readonly string[]): RuntimeTool => ({
  definition: tool.definition,
  async execute(request) {
    const target = request.resolvedTarget ?? resolve(request.cwd, String(request.input.path))
    if (!names.some((name) => target === resolve(config.workspace, name)))
      return { ok: false, summary: 'Path is outside this episode’s fixture capability.' }
    return tool.execute(request)
  },
})
new RuntimeKernel({
  unbudgetedSoloRuns: config.unlimited === true,
  memoryService: false,
  tools: config.repositoryContainer
    ? [new RepositoryTool(config.repositoryContainer, config.workspace)]
    : [
        boundedTool(new ReadTool(), [
          ...config.readableFiles,
          config.programMode ? 'solution.js' : 'answer.json',
        ]),
        boundedTool(new WriteTool(), [config.programMode ? 'solution.js' : 'answer.json']),
        ...(config.programMode ? [new ProgramTool(config.workspace)] : []),
      ],
  exposeArtifactTool: false,
  ...(config.smoke ? { providers: [new RecapSmokeProvider()], replaceProviders: true } : {}),
  ...(config.recapContext
    ? { recapContext: { ...config.recapContext, workspace: config.workspace } }
    : {}),
  middleware: [
    {
      name: 'recap-experiment-manifest',
      beforeModel: async (_context, request) => {
        const manifest = request.promptManifest as { recap?: unknown; budget?: unknown } | undefined
        const recapMessages = [...(request.contextMessages ?? []), ...request.messages].filter(
          (m) =>
            typeof m.content === 'string' &&
            m.content.startsWith('<praxis-context kind="project_recap">'),
        )
        await appendFile(
          config.telemetry,
          `${JSON.stringify({
            recap: manifest?.recap,
            actualRecapDigest: digest(recapMessages),
            actualRecapCount: recapMessages.length,
            budget: manifest?.budget,
            tools: request.tools.map((t) => t.name),
          })}\n`,
        )
        return undefined
      },
      afterModel: async (_context, result) => {
        if (config.repositoryContainer)
          await appendFile(
            `${config.telemetry}.usage.jsonl`,
            `${JSON.stringify({
              at: new Date().toISOString(),
              usage: result.usage,
              stopReason: result.stopReason,
              note: 'Main-loop successful model return only; auxiliary compaction and failed streams are not included.',
            })}\n`,
          )
      },
    },
  ],
}).start()
