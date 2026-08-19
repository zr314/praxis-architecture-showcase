import { lstatSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'
import { runtimeError } from '@praxis/core-sdk'
import type { ToolTargetIdentity } from '@praxis/core-sdk'

export type ResolvedWorkspacePath = {
  workspace: string
  requested: string
  canonical: string
  contained: boolean
  identity: ToolTargetIdentity
}

export function resolveWorkspacePath(cwd: string, requested: string): ResolvedWorkspacePath {
  const workspaceTarget = canonicalTarget(resolve(cwd))
  const workspace = workspaceTarget.canonical
  const absolute = resolve(workspace, requested)
  const target = canonicalTarget(absolute)
  const canonical = target.canonical
  const relation = relative(workspace, canonical)
  return {
    workspace,
    requested,
    canonical,
    contained:
      relation !== '..' &&
      !relation.startsWith('../') &&
      !relation.startsWith('..\\') &&
      !isAbsolute(relation),
    identity: captureIdentity(target.exists ? target.canonical : target.existingAncestor),
  }
}

export function matchesTargetIdentity(expected: ToolTargetIdentity): boolean {
  try {
    const current = captureIdentity(expected.path)
    return (
      current.device === expected.device &&
      current.inode === expected.inode &&
      current.birthtimeNs === expected.birthtimeNs
    )
  } catch {
    return false
  }
}

function canonicalTarget(target: string): {
  canonical: string
  existingAncestor: string
  exists: boolean
} {
  const missing: string[] = []
  let candidate = target
  while (true) {
    try {
      const canonical = canonicalExistingPath(candidate)
      return {
        canonical: resolve(canonical, ...missing.reverse()),
        existingAncestor: canonical,
        exists: missing.length === 0,
      }
    } catch (error) {
      if (!isMissing(error)) throw pathError()
      if (existsWithoutResolution(candidate)) throw pathError()
      const parent = dirname(candidate)
      if (parent === candidate) throw pathError()
      missing.push(basename(candidate))
      candidate = parent
    }
  }
}

function captureIdentity(path: string): ToolTargetIdentity {
  try {
    const stats = statSync(path, { bigint: true })
    return {
      path,
      device: stats.dev.toString(),
      inode: stats.ino.toString(),
      birthtimeNs: stats.birthtimeNs.toString(),
    }
  } catch {
    throw pathError()
  }
}

function canonicalExistingPath(path: string): string {
  try {
    return realpathSync.native(path)
  } catch (error) {
    if (isMissing(error)) throw error
    throw pathError()
  }
}

function existsWithoutResolution(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if (isMissing(error)) return false
    throw pathError()
  }
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    ['ENOENT', 'ENOTDIR'].includes(String((error as NodeJS.ErrnoException).code))
  )
}

function pathError() {
  return runtimeError(
    'TOOL_PATH_UNRESOLVABLE',
    'permission',
    'Tool target could not be resolved safely.',
  )
}
