import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ProjectInstructionLoader,
  type ProjectInstructionFileSystem,
} from '../apps/runtime/src/prompt/projectInstructionLoader.js'

const root = 'D:/workspace'

test('ProjectInstructionLoader loads root AGENTS.md before PRAXIS.md', async () => {
  const loader = new ProjectInstructionLoader(
    fakeFileSystem({
      'AGENTS.md': { content: 'Use package scripts for verification.' },
      'PRAXIS.md': { content: 'Keep prompt manifests content-free.' },
    }),
  )

  const result = await loader.load(root)

  assert.deepEqual(
    result.instructions.map((instruction) => instruction.name),
    ['AGENTS.md', 'PRAXIS.md'],
  )
  assert.deepEqual(
    result.instructions.map((instruction) => instruction.content),
    ['Use package scripts for verification.', 'Keep prompt manifests content-free.'],
  )
  assert.deepEqual(
    result.decisions.map((decision) => decision.status),
    ['loaded', 'loaded'],
  )
  assert.equal(JSON.stringify(result.decisions).includes('Use package scripts'), false)
})

test('ProjectInstructionLoader clips files in declared order within the 16 KiB and 24 KiB limits', async () => {
  const readRequests: Array<{ path: string; maximumBytes: number }> = []
  const loader = new ProjectInstructionLoader(
    fakeFileSystem(
      {
        'AGENTS.md': { content: 'a'.repeat(20 * 1024) },
        'PRAXIS.md': { content: 'b'.repeat(20 * 1024) },
      },
      readRequests,
    ),
  )

  const result = await loader.load(root)

  assert.deepEqual(
    result.instructions.map((instruction) => instruction.renderedBytes),
    [16 * 1024, 8 * 1024],
  )
  assert.ok(result.instructions.every((instruction) => instruction.clipped))
  assert.equal(
    result.instructions.reduce((total, instruction) => total + instruction.renderedBytes, 0),
    24 * 1024,
  )
  assert.deepEqual(
    readRequests.map((request) => request.maximumBytes),
    [16 * 1024, 8 * 1024],
  )
  assert.deepEqual(
    result.decisions.map((decision) => decision.sourceTruncated),
    [true, true],
  )
})

test('ProjectInstructionLoader rejects symbolic links and resolved paths outside the workspace', async () => {
  const loader = new ProjectInstructionLoader(
    fakeFileSystem({
      'AGENTS.md': {
        content: 'outside instructions',
        symbolicLink: true,
        realpath: 'D:/outside/AGENTS.md',
      },
      'PRAXIS.md': { content: 'inside instructions' },
    }),
  )

  const result = await loader.load(root)

  assert.deepEqual(
    result.instructions.map((instruction) => instruction.name),
    ['PRAXIS.md'],
  )
  assert.deepEqual(
    result.decisions.map((decision) => [decision.name, decision.status, decision.reason]),
    [
      ['AGENTS.md', 'rejected', 'symbolic_link'],
      ['PRAXIS.md', 'loaded', undefined],
    ],
  )
})

type FakeEntry = {
  content: string
  symbolicLink?: boolean
  realpath?: string
}

function fakeFileSystem(
  entries: Record<string, FakeEntry>,
  readRequests: Array<{ path: string; maximumBytes: number }> = [],
): ProjectInstructionFileSystem {
  return {
    async lstat(path) {
      const entry = entries[filename(path)]
      if (!entry) throw missingFile()
      return {
        size: Buffer.byteLength(entry.content, 'utf8'),
        isFile: () => true,
        isSymbolicLink: () => entry.symbolicLink === true,
      }
    },
    async realpath(path) {
      if (path === root) return root
      const entry = entries[filename(path)]
      if (!entry) throw missingFile()
      return entry.realpath ?? path
    },
    async readPrefix(path, maximumBytes) {
      const entry = entries[filename(path)]
      if (!entry) throw missingFile()
      readRequests.push({ path, maximumBytes })
      return clipUtf8(entry.content, maximumBytes)
    },
  }
}

function clipUtf8(content: string, maximumBytes: number): string {
  let rendered = ''
  let usedBytes = 0
  for (const character of content) {
    const characterBytes = Buffer.byteLength(character, 'utf8')
    if (usedBytes + characterBytes > maximumBytes) break
    rendered += character
    usedBytes += characterBytes
  }
  return rendered
}

function filename(path: string): string {
  const normalized = path.replaceAll('\\', '/')
  return normalized.slice(normalized.lastIndexOf('/') + 1)
}

function missingFile(): NodeJS.ErrnoException {
  return Object.assign(new Error('missing'), { code: 'ENOENT' })
}
