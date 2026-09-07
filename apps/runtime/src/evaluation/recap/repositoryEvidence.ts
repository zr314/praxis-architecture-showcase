import { createHash } from 'node:crypto'
import { lstat, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Host-side receipts: command text alone cannot prove that a source file changed. */
export async function repositoryFileState(workspace: string, validationScope = false) {
  const files: Record<string, string> = {}
  async function visit(path: string, name: string): Promise<void> {
    const stat = await lstat(path).catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return undefined
      throw e
    })
    if (!stat) return
    if (stat.isSymbolicLink()) throw new Error('Repository evidence refuses symbolic links')
    if (stat.isDirectory()) {
      for (const child of await readdir(path)) {
        if (['__pycache__', '.pytest_cache', '.git'].includes(child)) continue
        await visit(join(path, child), `${name}/${child}`)
      }
    } else if (stat.isFile())
      files[name] = createHash('sha256')
        .update(await readFile(path))
        .digest('hex')
  }
  for (const name of ['src', 'tests']) await visit(join(workspace, name), name)
  if (validationScope)
    for (const name of [
      'pyproject.toml',
      'setup.cfg',
      'setup.py',
      'tox.ini',
      'pytest.ini',
      'conftest.py',
      'reproduce_upload.py',
    ])
      await visit(join(workspace, name), name)
  return files
}

export function repositoryChangedFiles(
  before: Record<string, string>,
  after: Record<string, string>,
) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((p) => before[p] !== after[p])
    .sort()
}
