import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const artifacts = resolve(root, 'artifacts')
const checksumPath = resolve(artifacts, 'SHA256SUMS')
const source = await readFile(checksumPath, 'utf8')
const lines = source.split(/\r?\n/u).filter(Boolean)
assert.ok(lines.length > 0, 'SHA256SUMS is empty.')

const seen = new Set()
for (const line of lines) {
  const match = /^([a-f0-9]{64}) {2}([^\r\n]+)$/u.exec(line)
  assert.ok(match, 'SHA256SUMS contains an invalid line.')
  const [, expected, filename] = match
  assert.equal(filename, basename(filename), 'Checksum filename must be a basename.')
  assert.equal(seen.has(filename), false, `Duplicate checksum entry: ${filename}`)
  seen.add(filename)
  const path = resolve(artifacts, filename)
  assert.equal((await stat(path)).isFile(), true, `${filename} is not a regular file.`)
  const actual = createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
  assert.equal(actual, expected, `Checksum mismatch: ${filename}`)
}

process.stdout.write(`Verified ${lines.length} SHA-256 checksums.\n`)
