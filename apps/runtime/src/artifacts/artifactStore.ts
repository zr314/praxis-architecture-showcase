import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ArtifactReference } from '@praxis/core-sdk'

const ARTIFACT_ID = /^artifact-[a-f0-9]{64}$/

export type ArtifactReadGrantV1 = Readonly<{
  root: string
  artifactIds: readonly string[]
}>

export class ArtifactStore {
  private readonly readGrants: readonly Readonly<{ root: string; artifactIds: ReadonlySet<string> }>[]

  constructor(
    private readonly root = join(
      process.env.PRAXIS_HOME ?? join(homedir(), '.praxis'),
      'artifacts',
    ),
    readGrants: readonly ArtifactReadGrantV1[] = [],
  ) {
    this.readGrants = readGrants.map((grant) => ({
      root: grant.root,
      artifactIds: new Set(grant.artifactIds),
    }))
  }

  rootDirectory(): string {
    return this.root
  }

  async put(value: unknown, mimeType = 'application/json'): Promise<ArtifactReference> {
    const content = JSON.stringify(value)
    const bytes = Buffer.byteLength(content, 'utf8')
    const hex = createHash('sha256').update(content).digest('hex')
    const artifactId = `artifact-${hex}`
    await mkdir(this.root, { recursive: true })
    const envelope = JSON.stringify({
      version: 2,
      artifactId,
      digest: `sha256:${hex}`,
      mimeType,
      bytes,
      createdAt: new Date().toISOString(),
      value,
    })
    try {
      await writeFile(join(this.root, `${artifactId}.json`), envelope, {
        encoding: 'utf8',
        flag: 'wx',
      })
    } catch (error) {
      if (!isAlreadyExists(error)) throw error
    }
    return {
      artifactId,
      digest: `sha256:${hex}`,
      mimeType,
      bytes,
    }
  }

  async read(artifactId: string): Promise<unknown> {
    if (!ARTIFACT_ID.test(artifactId)) throw new TypeError('Invalid artifact ID.')
    const roots = [
      this.root,
      ...this.readGrants
        .filter((grant) => grant.artifactIds.has(artifactId))
        .map((grant) => grant.root),
    ]
    let missing: unknown
    for (const root of roots) {
      try {
        const parsed = JSON.parse(
          await readFile(join(root, `${artifactId}.json`), 'utf8'),
        ) as unknown
        return unwrapArtifact(parsed, artifactId)
      } catch (error) {
        if (!isNotFound(error)) throw error
        missing ??= error
      }
    }
    throw missing
  }

  async readSlice(
    artifactId: string,
    offset: number,
    limit: number,
  ): Promise<{ content: string; offset: number; total: number; truncated: boolean }> {
    if (!ARTIFACT_ID.test(artifactId)) throw new TypeError('Invalid artifact ID.')
    const content = JSON.stringify(await this.read(artifactId))
    return {
      content: content.slice(offset, offset + limit),
      offset,
      total: content.length,
      truncated: offset + limit < content.length,
    }
  }

  async list(): Promise<
    Array<ArtifactReference & { createdAt?: string }>
  > {
    let names: string[]
    try {
      names = await readdir(this.root)
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []
      throw error
    }
    const artifacts: Array<ArtifactReference & { createdAt?: string }> = []
    for (const name of names.sort()) {
      const match = /^(artifact-[a-f0-9]{64})\.json$/.exec(name)
      if (!match) continue
      const value = JSON.parse(await readFile(join(this.root, name), 'utf8')) as unknown
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue
      const envelope = value as Record<string, unknown>
      if (
        envelope.version !== 2 ||
        envelope.artifactId !== match[1] ||
        typeof envelope.digest !== 'string' ||
        typeof envelope.mimeType !== 'string' ||
        typeof envelope.bytes !== 'number'
      ) {
        continue
      }
      artifacts.push({
        artifactId: match[1],
        digest: envelope.digest,
        mimeType: envelope.mimeType,
        bytes: envelope.bytes,
        ...(typeof envelope.createdAt === 'string' ? { createdAt: envelope.createdAt } : {}),
      })
    }
    return artifacts
  }
}

function unwrapArtifact(value: unknown, artifactId: string): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const envelope = value as Record<string, unknown>
  if (envelope.version !== 2) return value
  if (
    envelope.artifactId !== artifactId ||
    typeof envelope.digest !== 'string' ||
    !('value' in envelope)
  ) {
    throw new SyntaxError('Invalid artifact record.')
  }
  const content = JSON.stringify(envelope.value)
  const digest = `sha256:${createHash('sha256').update(content).digest('hex')}`
  if (digest !== envelope.digest) throw new SyntaxError('Artifact checksum mismatch.')
  return envelope.value
}

function isAlreadyExists(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'EEXIST'
  )
}

function isNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  )
}
