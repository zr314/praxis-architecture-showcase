import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type {
  ProjectInstructionName,
  PromptProjectInstruction,
  PromptProjectInstructionDecision,
} from '@praxis/core-sdk'

const FILE_NAMES: ProjectInstructionName[] = ['AGENTS.md', 'PRAXIS.md']
const MAX_FILE_BYTES = 16 * 1024
const MAX_TOTAL_BYTES = 24 * 1024

export type ProjectInstructionFileSystem = {
  lstat(path: string): Promise<{ size: number; isFile(): boolean; isSymbolicLink(): boolean }>
  realpath(path: string): Promise<string>
  readPrefix(path: string, maximumBytes: number): Promise<string>
}

export type ProjectInstructionLoad = {
  instructions: PromptProjectInstruction[]
  decisions: PromptProjectInstructionDecision[]
}

const nodeFileSystem: ProjectInstructionFileSystem = {
  lstat,
  realpath,
  readPrefix: readUtf8Prefix,
}

/** Loads only explicitly supported instruction files from the session workspace root. */
export class ProjectInstructionLoader {
  constructor(private readonly fileSystem: ProjectInstructionFileSystem = nodeFileSystem) {}

  async load(cwd: string): Promise<ProjectInstructionLoad> {
    const root = await this.fileSystem.realpath(cwd)
    const instructions: PromptProjectInstruction[] = []
    const decisions: PromptProjectInstructionDecision[] = []
    let remainingBytes = MAX_TOTAL_BYTES

    for (const name of FILE_NAMES) {
      const path = join(root, name)
      let metadata: { size: number; isFile(): boolean; isSymbolicLink(): boolean }
      try {
        metadata = await this.fileSystem.lstat(path)
      } catch (error) {
        if (isMissing(error)) continue
        decisions.push({ name, status: 'rejected', reason: 'not_accessible' })
        continue
      }
      if (metadata.isSymbolicLink()) {
        decisions.push({ name, status: 'rejected', reason: 'symbolic_link' })
        continue
      }
      if (!metadata.isFile()) {
        decisions.push({ name, status: 'rejected', reason: 'not_regular_file' })
        continue
      }

      let resolved: string
      try {
        resolved = await this.fileSystem.realpath(path)
      } catch {
        decisions.push({ name, status: 'rejected', reason: 'not_accessible' })
        continue
      }
      if (!isWithin(root, resolved)) {
        decisions.push({ name, status: 'rejected', reason: 'outside_workspace' })
        continue
      }
      if (remainingBytes === 0) {
        decisions.push({ name, status: 'skipped', reason: 'total_limit' })
        continue
      }

      const maximumBytes = Math.min(MAX_FILE_BYTES, remainingBytes)
      let content: string
      try {
        content = await this.fileSystem.readPrefix(resolved, maximumBytes)
      } catch {
        decisions.push({ name, status: 'rejected', reason: 'not_accessible' })
        continue
      }
      const renderedBytes = Buffer.byteLength(content, 'utf8')
      const sourceTruncated = metadata.size > maximumBytes
      const clipped = sourceTruncated || renderedBytes < metadata.size
      const digest = `sha256:${createHash('sha256').update(content).digest('hex')}`
      instructions.push({ name, content, bytes: metadata.size, renderedBytes, digest, clipped })
      decisions.push({
        name,
        status: 'loaded',
        bytes: metadata.size,
        renderedBytes,
        digest,
        clipped,
        sourceTruncated,
      })
      remainingBytes -= renderedBytes
    }

    return { instructions, decisions }
  }
}

async function readUtf8Prefix(path: string, maximumBytes: number): Promise<string> {
  if (maximumBytes <= 0) return ''
  const decoder = new StringDecoder('utf8')
  let content = ''
  for await (const chunk of createReadStream(path, { start: 0, end: maximumBytes - 1 })) {
    content += decoder.write(chunk)
  }
  return content
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return (
    path === '' ||
    (!path.startsWith('../') && !path.startsWith('..\\') && path !== '..' && !isAbsolute(path))
  )
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
  )
}
