import { appendFile, cp, mkdir, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { RuntimeTool } from '@praxis/core-sdk'
import { digest } from '../../recap/recap.js'
import { repositoryFileState } from './repositoryEvidence.js'

/** Private source snapshots for retrospective grading; no score reaches the agent. */
export async function withRepositoryCheckpoints(
  inner: RuntimeTool,
  workspace: string,
  output: string,
): Promise<RuntimeTool> {
  const inside = relative(resolve(workspace), resolve(output))
  if (!inside || (!(inside === '..' || inside.startsWith(`..${sep}`)) && !isAbsolute(inside)))
    throw new Error('Checkpoints must be outside the model workspace')
  await mkdir(output) // Preserve existing evidence instead of overwriting it.
  let ordinal = 0
  const sourceState = async (root: string) =>
    Object.fromEntries(
      Object.entries(await repositoryFileState(root)).filter(([path]) => path.startsWith('src/')),
    )
  let previous: string | undefined
  async function capture(toolOrdinal: number) {
    const files = await sourceState(workspace)
    const sourceDigest = digest(files)
    if (sourceDigest === previous) return { sourceDigest, created: false }
    const at = join(output, `checkpoint-${toolOrdinal}`)
    await mkdir(at)
    await cp(join(workspace, 'src'), join(at, 'src'), { recursive: true })
    if (
      digest(await sourceState(at)) !== sourceDigest ||
      digest(await sourceState(workspace)) !== sourceDigest
    )
      throw new Error('Source changed while capturing checkpoint')
    await writeFile(
      join(at, 'receipt.json'),
      JSON.stringify({ toolOrdinal, sourceDigest, files }) + '\n',
    )
    previous = sourceDigest
    return { sourceDigest, created: true }
  }
  await capture(0)
  return {
    definition: {
      ...inner.definition,
      execution: {
        sideEffect: 'process',
        target: { kind: 'workspace' },
        conflictScope: 'workspace',
        maxInlineBytes: 52000,
        ...inner.definition.execution,
        parallelSafe: false,
      },
    },
    async execute(request) {
      const toolOrdinal = ++ordinal
      const startedAt = new Date().toISOString()
      try {
        return await inner.execute(request)
      } finally {
        const commandEndedAt = new Date().toISOString()
        const captureStarted = performance.now()
        const checkpoint = await capture(toolOrdinal)
        await appendFile(
          join(output, 'timeline.jsonl'),
          JSON.stringify({
            toolOrdinal,
            startedAt,
            commandEndedAt,
            captureMs: performance.now() - captureStarted,
            invocation: request.executionContext?.invocation,
            ...checkpoint,
          }) + '\n',
        )
      }
    },
  }
}
