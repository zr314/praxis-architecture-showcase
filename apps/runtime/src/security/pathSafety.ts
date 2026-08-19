import { isAbsolute, normalize, relative, resolve, sep } from 'node:path'
import { runtimeError } from '@praxis/core-sdk'

const WORKSPACE_PLACEHOLDER = '$' + '{workspace}'

export function canonicalGrantPath(workspace: string, requested: string): string {
  const root = resolve(workspace)
  const target = resolve(root, requested.replaceAll(WORKSPACE_PLACEHOLDER, root))
  const relation = relative(root, target)
  if (relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw securityError('GRANT_PATH_ESCAPE')
  }
  return target
}

export function validateArchiveEntryPaths(entries: readonly string[]): void {
  for (const entry of entries) {
    const normalized = normalize(entry)
    if (
      entry.includes('\0') ||
      isAbsolute(entry) ||
      normalized === '..' ||
      normalized.startsWith(`..${sep}`) ||
      /^[A-Za-z]:/u.test(entry)
    ) {
      throw securityError('ARCHIVE_TRAVERSAL_REJECTED')
    }
  }
}

function securityError(code: string) {
  return runtimeError(code, 'permission', `Security validation failed (${code}).`)
}
