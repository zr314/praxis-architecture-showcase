import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  publishWorkspaces,
  resolveNpmInvocation,
  resolvePrivateRegistry,
} from './publish-workspaces-lib.mjs'

const root = resolve(import.meta.dirname, '..')
const version = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')).version
const registry = resolvePrivateRegistry(process.env.PRAXIS_NPM_REGISTRY_URL)
const npmInvocation = resolveNpmInvocation({
  execPath: process.execPath,
  npmExecPath: process.env.npm_execpath,
})

await publishWorkspaces({ version, registry, runNpm: npm })

function npm(args, allowFailure = false) {
  const result = spawnSync(npmInvocation.command, [...npmInvocation.prefixArgs, ...args], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  })
  if (result.error) throw result.error
  if (!allowFailure && result.status !== 0) {
    throw new Error(`npm ${args[0]} failed: ${result.stderr.trim()}`)
  }
  return result
}
