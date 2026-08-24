import { spawnSync } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const requestedOutput = process.argv[2]
if (!requestedOutput) {
  throw new Error(
    'Pass an output .mjs path, for example: node scripts/build-eval-bundle.mjs D:/agent-evals/artifacts/praxis-cli.mjs',
  )
}

const skipWorkspaceBuild = process.argv.slice(3).includes('--skip-workspace-build')
if (!skipWorkspaceBuild) {
  const steps = [
    ['scripts/clean-dist.mjs', 'all'],
    ['node_modules/typescript/bin/tsc', '--build', '--force', '--pretty', 'false'],
    ['scripts/build-workspaces.mjs', 'all'],
    ['scripts/mirror-legacy-dist.mjs'],
  ]
  for (const args of steps) {
    const workspaceBuild = spawnSync(process.execPath, args, {
      cwd: root,
      stdio: 'inherit',
    })
    if (workspaceBuild.error) throw workspaceBuild.error
    if (workspaceBuild.status !== 0) {
      throw new Error(
        `Workspace build step ${args[0]} failed with exit code ${String(workspaceBuild.status)}.`,
      )
    }
  }
}

const output = resolve(requestedOutput)
await mkdir(dirname(output), { recursive: true })
await build({
  entryPoints: [resolve(root, 'apps/cli/src/cli.tsx')],
  outfile: output,
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  banner: {
    js: "import { createRequire as __praxisCreateRequire } from 'node:module'; const require = __praxisCreateRequire(import.meta.url);",
  },
})
process.stdout.write(`${output}\n`)
