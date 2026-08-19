import { readdir } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'

const IGNORED_DIRECTORIES = new Set(['.git', 'node_modules', '.praxis'])

export async function walkFiles(options: {
  root: string
  start?: string
  maximum: number
  signal: AbortSignal
}): Promise<string[]> {
  const files: string[] = []
  await visit(
    options.root,
    resolve(options.root, options.start ?? '.'),
    files,
    options.maximum,
    options.signal,
  )
  return files
}

async function visit(
  root: string,
  directory: string,
  files: string[],
  maximum: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted || files.length >= maximum) return
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (signal.aborted || files.length >= maximum) return
    if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue
    const fullPath = resolve(directory, entry.name)
    if (entry.isDirectory()) await visit(root, fullPath, files, maximum, signal)
    else if (entry.isFile()) files.push(relative(root, fullPath).split(sep).join('/'))
  }
}

export function globPattern(pattern: string): RegExp {
  if (pattern === '**/*') return /^.*$/
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '搂/')
    .replace(/\*\*/g, '搂搂')
    .replace(/\*/g, '[^/]*')
    .replace(/搂\//g, '(?:.*/)?')
    .replace(/搂搂/g, '.*')
    .replace(/\?/g, '[^/]')
  return new RegExp(`^${escaped}$`)
}
