import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const version = optionValue('--version')
if (!version) throw new Error('Pass --version <version>.')

const changelog = (await readFile(resolve(root, 'CHANGELOG.md'), 'utf8')).replaceAll('\r\n', '\n')
const heading = `## [${version}]`
const start = changelog.indexOf(heading)
if (start < 0) throw new Error(`CHANGELOG.md has no ${version} release entry.`)
const contentStart = changelog.indexOf('\n', start)
const nextHeading = changelog.indexOf('\n## ', contentStart + 1)
const notes = changelog
  .slice(contentStart + 1, nextHeading < 0 ? changelog.length : nextHeading)
  .trim()
if (!notes) throw new Error(`CHANGELOG.md release ${version} has no notes.`)

const artifacts = resolve(root, 'artifacts')
await mkdir(artifacts, { recursive: true })
await writeFile(resolve(artifacts, 'RELEASE_NOTES.md'), `# Praxis ${version}\n\n${notes}\n`, 'utf8')
process.stdout.write(`Wrote release notes for ${version}.\n`)

function optionValue(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}
