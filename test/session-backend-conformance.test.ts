import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JsonlRepository } from '../apps/runtime/src/session-db/jsonlRepository.js'
import {
  registerSessionBackendConformance,
  type SessionBackendConformanceHarness,
} from './support/session-backend-conformance.js'

registerSessionBackendConformance('JSONL Session backend', jsonlHarness)

async function jsonlHarness(): Promise<SessionBackendConformanceHarness> {
  const root = await mkdtemp(join(tmpdir(), 'praxis-session-conformance-'))
  const repository = new JsonlRepository(root)
  return {
    repository,
    async openPeer() {
      const peer = new JsonlRepository(root)
      await peer.initialize()
      return peer
    },
    async injectTruncatedTail(sessionId) {
      await appendFile(
        join(root, 'history', `${sessionId}.jsonl`),
        '{"version":2,"partial"',
        'utf8',
      )
    },
    async injectInvalidCompleteEntry(sessionId) {
      await appendFile(
        join(root, 'history', `${sessionId}.jsonl`),
        `${JSON.stringify({
          version: 2,
          sequence: 3,
          committedAt: '2026-01-01T00:00:03.000Z',
          message: { role: 'assistant', content: 'invalid-checksum' },
          checksum: 'sha256:invalid',
        })}\n`,
        'utf8',
      )
    },
    async corruptCatalog() {
      const path = join(root, 'sessions.json')
      const catalog = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
      catalog.checksum = `sha256:${'0'.repeat(64)}`
      await writeFile(path, `${JSON.stringify(catalog)}\n`, 'utf8')
    },
    async replaceCatalogWithUnsupportedVersion() {
      await writeFile(
        join(root, 'sessions.json'),
        `${JSON.stringify({ version: 999, sessions: [] })}\n`,
        'utf8',
      )
    },
    async cleanup() {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    },
  }
}
