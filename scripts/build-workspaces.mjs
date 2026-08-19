import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const targets = {
  'core-sdk': {
    entry: 'packages/core-sdk/src/index.ts',
    output: 'packages/core-sdk/dist/index.js',
    dependencies: ['plugin-protocol'],
    external: [],
  },
  protocol: {
    entry: 'packages/protocol/src/index.ts',
    output: 'packages/protocol/dist/index.js',
    external: ['ajv', 'ajv/*'],
  },
  'plugin-protocol': {
    entry: 'packages/plugin-protocol/src/index.ts',
    output: 'packages/plugin-protocol/dist/index.js',
    external: [],
  },
  'plugin-sdk': {
    entry: 'packages/plugin-sdk/src/index.ts',
    output: 'packages/plugin-sdk/dist/index.js',
    dependencies: ['plugin-protocol'],
    external: [],
  },
  client: {
    entry: 'packages/client/src/index.ts',
    output: 'packages/client/dist/index.js',
    dependencies: ['protocol'],
    external: [],
  },
  runtime: {
    entries: [
      { entry: 'apps/runtime/src/entry.ts', output: 'apps/runtime/dist/entry.js' },
      { entry: 'apps/runtime/src/process.ts', output: 'apps/runtime/dist/process.js' },
      { entry: 'apps/runtime/src/run.ts', output: 'apps/runtime/dist/run.js' },
      { entry: 'apps/runtime/src/storage.ts', output: 'apps/runtime/dist/storage.js' },
    ],
    dependencies: ['client', 'core-sdk', 'protocol', 'plugin-protocol'],
    external: ['ajv', 'ajv/*', 'openai', 'openai/*'],
  },
  cli: {
    entry: 'apps/cli/src/cli.tsx',
    output: 'apps/cli/dist/cli.js',
    dependencies: ['client', 'runtime'],
    external: [
      '@commander-js/extra-typings',
      '@commander-js/extra-typings/*',
      'ajv',
      'ajv/*',
      'chalk',
      'chalk/*',
      'ink',
      'ink/*',
      'react',
      'react/*',
      'react/jsx-runtime',
    ],
    banner: '#!/usr/bin/env node',
  },
}

const requested = process.argv[2] ?? 'all'
const built = new Set()

if (requested === 'all') {
  for (const target of Object.keys(targets)) await buildTarget(target)
} else {
  await buildTarget(requested)
}

async function buildTarget(name) {
  if (built.has(name)) return
  const target = targets[name]
  if (!target) throw new Error(`Unknown workspace build target: ${name}`)

  for (const dependency of target.dependencies ?? []) await buildTarget(dependency)
  const entries = target.entries ?? [{ entry: target.entry, output: target.output }]
  for (const entry of entries) {
    const output = resolve(root, entry.output)
    await mkdir(dirname(output), { recursive: true })
    await build({
      entryPoints: [resolve(root, entry.entry)],
      outfile: output,
      bundle: true,
      platform: 'node',
      target: 'node20',
      format: 'esm',
      external: target.external,
      banner: target.banner ? { js: target.banner } : undefined,
    })
  }
  built.add(name)
}
