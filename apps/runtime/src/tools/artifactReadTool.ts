import type { RuntimeTool, ToolRequest, ToolResult } from './types.js'
import type { ArtifactStore } from '../artifacts/artifactStore.js'

const DEFAULT_LIMIT = 16_384
const MAX_LIMIT = 32_768

export class ArtifactReadTool implements RuntimeTool {
  constructor(private readonly store: ArtifactStore) {}

  readonly definition = {
    name: 'artifact_read',
    description: 'Read a durable Tool artifact in bounded slices.',
    parameters: {
      type: 'object',
      properties: {
        artifactId: { type: 'string', pattern: '^artifact-[a-f0-9]{64}$' },
        offset: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT },
      },
      required: ['artifactId'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      required: ['artifactId', 'content', 'offset', 'total', 'truncated'],
      properties: {
        artifactId: { type: 'string' },
        content: { type: 'string' },
        offset: { type: 'integer', minimum: 0 },
        total: { type: 'integer', minimum: 0 },
        truncated: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    execution: {
      sideEffect: 'read',
      target: { kind: 'none' },
      parallelSafe: true,
      conflictScope: 'target',
      maxInlineBytes: 65_536,
    },
  } as const

  async execute(request: ToolRequest): Promise<ToolResult> {
    const artifactId = String(request.input.artifactId)
    const offset = integerOr(request.input.offset, 0)
    const limit = integerOr(request.input.limit, DEFAULT_LIMIT)
    const slice = await this.store.readSlice(artifactId, offset, limit)
    return {
      ok: true,
      summary: `Read artifact characters ${offset}..${offset + slice.content.length}.`,
      output: { artifactId, ...slice },
    }
  }
}

function integerOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : fallback
}
