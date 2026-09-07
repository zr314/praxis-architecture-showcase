// Separate entry point: the running frozen v2 cohort continues using runtime.ts.
import { appendFile, readFile } from 'node:fs/promises'
import type { RecapContext } from '../../recap/recapContext.js'
import { RuntimeKernel } from '../../framework/runtimeKernel.js'
import { digest } from '../../recap/recap.js'
import { RepositoryTool } from './repositoryTool.js'
import { withRepositoryCheckpoints } from './checkpointTool.js'
import { PublicVerificationLedger } from './publicVerification.js'

const config = JSON.parse(await readFile(process.argv[2]!, 'utf8')) as {
  repositoryContainer: string
  workspace: string
  checkpoints: string
  telemetry: string
  publicVerification?: string
  recapContext?: RecapContext
}
const tool = await withRepositoryCheckpoints(
  new RepositoryTool(config.repositoryContainer, config.workspace),
  config.workspace,
  config.checkpoints,
)
const verification = config.publicVerification
  ? await PublicVerificationLedger.open(config.workspace, config.publicVerification)
  : undefined
new RuntimeKernel({
  unbudgetedSoloRuns: true,
  memoryService: false,
  tools: [verification ? verification.wrap(tool) : tool],
  exposeArtifactTool: false,
  ...(config.recapContext
    ? { recapContext: { ...config.recapContext, workspace: config.workspace } }
    : {}),
  middleware: [
    {
      name: 'checkpoint-experiment-observation',
      beforeModel: async (_context, request) => {
        const manifest = request.promptManifest as { recap?: unknown; budget?: unknown } | undefined
        const memories = [...(request.contextMessages ?? []), ...request.messages].filter(
          (m) =>
            typeof m.content === 'string' &&
            m.content.startsWith('<praxis-context kind="project_recap">'),
        )
        await appendFile(
          config.telemetry,
          JSON.stringify({
            at: new Date().toISOString(),
            recap: manifest?.recap,
            budget: manifest?.budget,
            actualRecapDigest: digest(memories),
            actualRecapCount: memories.length,
            tools: request.tools.map((t) => t.name),
          }) + '\n',
        )
        return verification
          ? {
              ...request,
              contextMessages: [...(request.contextMessages ?? []), await verification.message()],
            }
          : undefined
      },
      afterModel: async (_context, result) => {
        await appendFile(
          `${config.telemetry}.usage.jsonl`,
          JSON.stringify({
            at: new Date().toISOString(),
            usage: result.usage,
            stopReason: result.stopReason,
            note: 'Successful main-loop returns only; auxiliary usage is reported separately.',
          }) + '\n',
        )
      },
    },
  ],
}).start()
