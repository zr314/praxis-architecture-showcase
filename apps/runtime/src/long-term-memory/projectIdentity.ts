import { execFile } from 'node:child_process'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)

export type ProjectLocationV1 = Readonly<{ identity: string; root: string; git: boolean }>

/** Git worktrees share the common directory; remotes are deliberately not identities. */
export async function projectLocationV1(workspace: string): Promise<ProjectLocationV1> {
  const root = await realpath(resolve(workspace))
  if (!(await stat(root)).isDirectory())
    throw new TypeError('Memory workspace must be a directory.')
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key]
  try {
    const result = await execute(
      'git',
      ['-C', root, 'rev-parse', '--path-format=absolute', '--git-common-dir', '--show-toplevel'],
      {
        env,
        timeout: 5_000,
        maxBuffer: 16_384,
        windowsHide: true,
      },
    )
    const [common, top] = result.stdout.trim().split(/\r?\n/u)
    if (common && top) {
      return {
        identity: `git:${await realpath(resolve(root, common))}`,
        root: await realpath(top),
        git: true,
      }
    }
  } catch (error) {
    const failure = error as { code?: unknown; stderr?: string }
    // Only an actual non-repository (or an absent Git binary) may use directory identity.
    if (failure.code !== 'ENOENT' && !failure.stderr?.includes('not a git repository')) throw error
  }
  return { identity: `directory:${root}`, root, git: false }
}

export function pathWithinV1(root: string, path: string): boolean {
  const suffix = relative(root, path)
  return (
    suffix === '' ||
    (!isAbsolute(suffix) &&
      suffix !== '..' &&
      !suffix.startsWith('../') &&
      !suffix.startsWith('..\\'))
  )
}
