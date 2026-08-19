import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  PromptBuildInput,
  PromptManifest,
  PromptProjectInstructionDecision,
  PromptSection,
  SystemPromptBuild,
} from '@praxis/core-sdk'

test('prompt contracts keep section content out of the manifest', () => {
  const section: PromptSection = {
    id: 'identity',
    source: 'builtin',
    order: 10,
    cacheScope: 'request',
    content: 'You are Praxis.',
  }
  const input: PromptBuildInput = {
    workspace: { cwd: 'D:/workspace', platform: 'win32', shell: 'powershell' },
    tools: [],
    maxSystemPromptTokens: 256,
  }
  const manifest: PromptManifest = {
    estimatedTokens: 4,
    maxTokens: 256,
    program: {
      variant: 'baseline-v1',
      trustedInstructions: {
        id: 'praxis.trusted-instructions',
        version: 'test-v1',
        owner: 'runtime',
        blockCount: 1,
        digest: `sha256:${'0'.repeat(64)}`,
        estimatedTokens: 4,
        componentIds: ['identity'],
      },
    },
    sections: [
      {
        id: section.id,
        source: section.source,
        order: section.order,
        cacheScope: section.cacheScope,
        characters: section.content.length,
        estimatedTokens: 4,
        included: true,
        digest: 'sha256:test',
      },
    ],
  }
  const decision: PromptProjectInstructionDecision = {
    name: 'AGENTS.md',
    status: 'loaded',
    sourceTruncated: true,
  }
  const build: SystemPromptBuild = {
    instructions: section.content,
    contextMessages: [
      { role: 'user', content: '<system-reminder>project guidance</system-reminder>' },
    ],
    manifest,
  }

  assert.equal(input.workspace.shell, 'powershell')
  assert.equal(build.contextMessages[0]?.role, 'user')
  assert.equal(decision.sourceTruncated, true)
  assert.equal(Object.hasOwn(build.manifest.sections[0] ?? {}, 'content'), false)
  assert.equal(build.manifest.sections[0]?.digest, 'sha256:test')
})
