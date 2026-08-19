import { copyFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const copies = [
  ['apps/cli/dist/cli.js', 'dist/cli.js'],
  ['apps/runtime/dist/entry.js', 'dist/runtime/entry.js'],
]

for (const [source, destination] of copies) {
  const target = resolve(root, destination)
  await mkdir(dirname(target), { recursive: true })
  await copyFile(resolve(root, source), target)
}
