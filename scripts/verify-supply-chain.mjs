import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'))
const allowlist = JSON.parse(
  await readFile(join(root, 'security', 'install-script-allowlist.json'), 'utf8'),
)
const policy = JSON.parse(
  await readFile(join(root, 'security', 'supply-chain-policy.json'), 'utf8'),
)
const npmConfiguration = await readFile(join(root, '.npmrc'), 'utf8')
assert.equal(allowlist.version, 1)
assert.equal(policy.version, 1)
assert.ok(policy.minimumReleaseAgeMinutes >= 1_440)
assert.match(npmConfiguration, /^ignore-scripts=true$/mu)
const allowedScripts = new Set(
  allowlist.packages.map((entry) => {
    assert.match(entry.name, /^[a-z0-9@/._-]+$/)
    assert.ok(entry.reason.length >= 20)
    return entry.name
  }),
)

for (const path of await packageManifests(root)) {
  const manifest = JSON.parse(await readFile(path, 'utf8'))
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    for (const [name, version] of Object.entries(manifest[section] ?? {})) {
      if (name.startsWith('@praxis/')) continue
      assert.match(
        version,
        /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/,
        `${path}: direct external dependency ${name} must be pinned exactly`,
      )
    }
  }
}

for (const [path, entry] of Object.entries(lock.packages ?? {})) {
  if (!path || entry.link) continue
  if (entry.hasInstallScript) {
    const name = entry.name ?? path.replace(/^node_modules\//, '')
    assert.equal(
      allowedScripts.has(name),
      true,
      `${name} has a lifecycle install script but is not reviewed`,
    )
  }
  if (entry.resolved && !String(entry.resolved).startsWith('file:')) {
    assert.match(entry.integrity ?? '', /^sha512-/, `${path} is missing sha512 lockfile integrity`)
  }
}

for (const workflow of await readdir(join(root, '.github', 'workflows'))) {
  if (!/\.ya?ml$/u.test(workflow)) continue
  const text = await readFile(join(root, '.github', 'workflows', workflow), 'utf8')
  for (const match of text.matchAll(/uses:\s+[^@\s]+@([^\s#]+)/gu)) {
    assert.match(
      match[1],
      /^[a-f0-9]{40}$/,
      `${workflow}: GitHub Action references must use a full commit SHA`,
    )
  }
}

process.stdout.write('Supply-chain policy is valid.\n')

async function packageManifests(directory) {
  const results = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['.git', 'node_modules', 'dist'].includes(entry.name)) continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) results.push(...(await packageManifests(path)))
    else if (entry.name === 'package.json') results.push(path)
  }
  return results
}
