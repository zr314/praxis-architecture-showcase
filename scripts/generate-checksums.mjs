import { createHash } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const artifacts = resolve(root, 'artifacts')
const version = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')).version
const files = (await readdir(artifacts, { withFileTypes: true }))
  .filter(
    (entry) =>
      entry.isFile() &&
      (entry.name === 'praxis.cdx.json' ||
        entry.name === 'RELEASE_NOTES.md' ||
        (entry.name.startsWith('praxis-') &&
          entry.name.includes(version) &&
          !entry.name.endsWith('.map'))),
  )
  .map((entry) => entry.name)
  .sort((left, right) => left.localeCompare(right, 'en'))

const lines = []
for (const filename of files) {
  const digest = createHash('sha256')
    .update(await readFile(resolve(artifacts, filename)))
    .digest('hex')
  lines.push(`${digest}  ${filename}`)
}
await writeFile(resolve(artifacts, 'SHA256SUMS'), `${lines.join('\n')}\n`, 'utf8')
process.stdout.write(`Wrote SHA256SUMS for ${files.length} artifacts.\n`)
