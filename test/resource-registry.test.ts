import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  FileResourceSelectionStore,
  ResourceCatalog,
} from '../apps/runtime/src/extensions/resourceRegistry.js'

test('ResourceCatalog validates stable Skill metadata and persists an exact workspace selection', async () => {
  const home = await mkdtemp(join(tmpdir(), 'praxis-resource-home-'))
  const workspace = await mkdtemp(join(tmpdir(), 'praxis-resource-workspace-'))
  const root = join(workspace, '.praxis', 'skills')
  try {
    await skillFixture(
      root,
      'review',
      [
        '---',
        'name: review',
        'description: Review a change without expanding tool authority.',
        'license: Apache-2.0',
        'compatibility: Praxis 0.1 or newer',
        'disable-model-invocation: false',
        'metadata:',
        '  author: Praxis',
        '  maturity: stable',
        '---',
        '',
        '# Review',
        '',
        'Inspect the change and report evidence.',
      ].join('\n'),
    )

    const store = new FileResourceSelectionStore(home)
    const catalog = new ResourceCatalog(store)
    const result = await catalog.refresh(workspace, [
      {
        path: root,
        namespace: 'project',
        origin: `project:${workspace}`,
        sourceType: 'project',
        trusted: false,
      },
    ])
    assert.equal(result.resources.length, 1)
    assert.deepEqual(result.resources[0]?.metadata, {
      license: 'Apache-2.0',
      compatibility: 'Praxis 0.1 or newer',
      values: { author: 'Praxis', maturity: 'stable' },
      disableModelInvocation: false,
    })
    await assert.rejects(
      catalog.enable(workspace, 'project/review'),
      hasCode('RESOURCE_TRUST_REQUIRED'),
    )

    const selected = await catalog.enable(workspace, 'project/review', {
      projectTrusted: true,
    })
    assert.equal(selected.enabled, true)
    assert.match(selected.provenance.digest, /^sha256:[a-f0-9]{64}$/)

    const restored = new ResourceCatalog(store)
    await restored.refresh(workspace, [
      {
        path: root,
        namespace: 'project',
        origin: `project:${workspace}`,
        sourceType: 'project',
        trusted: false,
      },
    ])
    assert.equal(restored.list(workspace, 'skill')[0]?.enabled, true)
  } finally {
    await rm(home, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  }
})

test('a changed Skill cannot replace the digest fixed by workspace selection', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'praxis-resource-pinned-'))
  const root = join(workspace, '.praxis', 'skills')
  try {
    const path = await skillFixture(
      root,
      'pinned',
      '---\nname: pinned\ndescription: Initial content.\n---\nFirst body.\n',
    )
    const catalog = new ResourceCatalog()
    const source = {
      path: root,
      namespace: 'project',
      origin: `project:${workspace}`,
      sourceType: 'project' as const,
      trusted: false,
    }
    await catalog.refresh(workspace, [source])
    await catalog.enable(workspace, 'project/pinned', { projectTrusted: true })
    const snapshot = catalog.snapshot(workspace)

    await writeFile(
      path,
      '---\nname: pinned\ndescription: Changed content.\n---\nSecond body.\n',
      'utf8',
    )
    await catalog.refresh(workspace, [source])

    assert.equal(catalog.list(workspace)[0]?.enabled, false)
    assert.match(snapshot.skills[0]?.content ?? '', /First body/)
    assert.doesNotMatch(snapshot.skills[0]?.content ?? '', /Second body/)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('collisions and authority-bearing frontmatter fail closed', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'praxis-resource-collision-'))
  const first = join(workspace, 'first')
  const second = join(workspace, 'second')
  try {
    await skillFixture(
      first,
      'same',
      '---\nname: duplicate\ndescription: First candidate.\n---\nNo code.\n',
    )
    await skillFixture(
      second,
      'same',
      '---\nname: duplicate\ndescription: Second candidate.\n---\nNo code.\n',
    )
    await skillFixture(
      first,
      'unsafe',
      '---\nname: unsafe\ndescription: Unsafe metadata.\nhooks: ./run.mjs\n---\nDo not load.\n',
    )

    const catalog = new ResourceCatalog()
    const result = await catalog.refresh(workspace, [
      {
        path: first,
        namespace: 'project',
        origin: 'project:first',
        sourceType: 'project',
        trusted: false,
      },
      {
        path: second,
        namespace: 'project',
        origin: 'project:second',
        sourceType: 'project',
        trusted: false,
      },
    ])

    assert.equal(result.collisions[0]?.id, 'project/duplicate')
    assert.equal(result.rejected[0]?.code, 'SKILL_FRONTMATTER_UNSUPPORTED')
    await assert.rejects(
      catalog.enable(workspace, 'project/duplicate', { projectTrusted: true }),
      hasCode('RESOURCE_ID_COLLISION'),
    )
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

async function skillFixture(root: string, folder: string, content: string): Promise<string> {
  const directory = join(root, folder)
  await mkdir(directory, { recursive: true })
  const path = join(directory, 'SKILL.md')
  await writeFile(path, content, 'utf8')
  return path
}

function hasCode(code: string) {
  return (error: unknown) =>
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code
}
