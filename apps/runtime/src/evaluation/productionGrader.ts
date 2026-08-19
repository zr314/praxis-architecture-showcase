import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type { SessionExportResult } from '@praxis/protocol'
import { isPortableRelativeEvaluationPath } from './portablePath.js'

export type ProductionWorkspaceExpectation = {
  path: string
  content?: string
  digest?: string
}

export type ProductionWorkspaceGrade = {
  passed: boolean
  failures: string[]
  files: Array<{ path: string; digest: string }>
}

export async function gradeProductionWorkspace(
  workspace: string,
  expected: readonly ProductionWorkspaceExpectation[],
): Promise<ProductionWorkspaceGrade> {
  const expectedFiles = new Map<string, string | undefined>()
  for (const file of expected) {
    if (!isPortableRelativeEvaluationPath(file.path) || expectedFiles.has(file.path)) {
      throw new TypeError('Production workspace expectations require unique portable paths.')
    }
    const digest =
      file.digest ??
      (file.content === undefined
        ? undefined
        : `sha256:${createHash('sha256').update(file.content).digest('hex')}`)
    expectedFiles.set(file.path, digest)
  }

  const files = await snapshotFiles(workspace)
  const actual = new Map(files.map((file) => [file.path, file.digest]))
  const failures: string[] = []
  for (const [path, digest] of expectedFiles) {
    const observed = actual.get(path)
    if (observed === undefined) failures.push(`missing:${path}`)
    else if (digest !== undefined && observed !== digest) failures.push(`digest:${path}`)
  }
  for (const path of actual.keys()) {
    if (!expectedFiles.has(path)) failures.push(`unexpected:${path}`)
  }
  return { passed: failures.length === 0, failures, files }
}

export function gradeProductionSession(
  exported: SessionExportResult,
  expected: {
    terminal: NonNullable<SessionExportResult['session']['lastTerminalState']>
    minimumMessages: number
    requiredRoles: Array<'user' | 'assistant' | 'tool'>
    checkpoint: boolean
  },
): { passed: boolean; failures: string[] } {
  const failures: string[] = []
  if (exported.session.lastTerminalState !== expected.terminal) failures.push('terminal')
  if (exported.messages.length < expected.minimumMessages) failures.push('message_count')
  const roles = new Set(
    exported.messages.flatMap((message) =>
      isRecord(message) &&
      (message.role === 'user' || message.role === 'assistant' || message.role === 'tool')
        ? [message.role]
        : [],
    ),
  )
  for (const role of expected.requiredRoles) {
    if (!roles.has(role)) failures.push(`role:${role}`)
  }
  const hasCheckpoint =
    isRecord(exported.memory) &&
    isRecord(exported.memory.checkpoint) &&
    typeof exported.memory.checkpoint.id === 'string'
  if (hasCheckpoint !== expected.checkpoint) failures.push('checkpoint')
  return { passed: failures.length === 0, failures }
}

async function snapshotFiles(root: string): Promise<Array<{ path: string; digest: string }>> {
  const files: Array<{ path: string; digest: string }> = []
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new TypeError('Production workspace grader rejects links.')
      if (entry.isDirectory()) {
        await visit(path)
      } else if (entry.isFile()) {
        files.push({
          path: relative(root, path).replaceAll('\\', '/'),
          digest: `sha256:${createHash('sha256')
            .update(await readFile(path))
            .digest('hex')}`,
        })
      }
    }
  }
  await visit(root)
  return files
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
