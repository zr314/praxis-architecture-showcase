import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { promptDigest, type PromptBuildInput } from '@praxis/core-sdk'
import { SystemPromptComposer } from '../apps/runtime/src/prompt/systemPromptComposer.js'

const sourceFiles = [
  'packages/core-sdk/src/prompt.ts',
  'apps/runtime/src/prompt/promptRegistry.ts',
  'apps/runtime/src/prompt/systemPromptComposer.ts',
  'apps/runtime/src/prompt/promptAssembler.ts',
  'apps/runtime/src/memory/contextWindow.ts',
  'apps/runtime/src/extensions/skillInvocationService.ts',
  'apps/runtime/src/planner/providerPlanGenerator.ts',
  'apps/runtime/src/planner/providerSemanticVerifier.ts',
  'apps/runtime/src/framework/runtimeKernel.ts',
] as const

const fixture: PromptBuildInput = {
  workspace: { cwd: 'D:/workspace/praxis', platform: 'win32', shell: 'powershell' },
  tools: [
    {
      name: 'read',
      description: 'Read a bounded UTF-8 file.',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
    },
    {
      name: 'agent.delegate',
      description: 'Delegate a bounded objective.',
      parameters: { type: 'object', properties: {} },
    },
    {
      name: 'workflow.expand',
      description: 'Expand a durable graph.',
      parameters: { type: 'object', properties: {} },
    },
  ],
  workflow: { role: 'root', mode: 'auto' },
  maxSystemPromptTokens: 1_536,
  skills: [
    {
      id: 'project/review',
      name: 'review',
      description: 'Review a bounded change.',
      modelInvocable: true,
    },
  ],
  projectInstructions: [
    {
      name: 'AGENTS.md',
      content: 'Use the repository test command before reporting success.',
      bytes: 57,
      renderedBytes: 57,
      digest: promptDigest('Use the repository test command before reporting success.'),
      clipped: false,
    },
  ],
  projectInstructionDecisions: [
    {
      name: 'AGENTS.md',
      status: 'loaded',
      bytes: 57,
      renderedBytes: 57,
      digest: promptDigest('Use the repository test command before reporting success.'),
      clipped: false,
    },
  ],
}

const composer = new SystemPromptComposer()
const baseline = composer.compose(fixture)
const lean = composer.compose({ ...fixture, variant: 'iron-law-lean-v1' })
const leanVisible = [lean.instructions, ...lean.contextMessages.map(({ content }) => content)].join(
  '\n\n',
)
const forbiddenModelTerms = [
  ...leanVisible.matchAll(/low-trust|untrusted guidance|high-trust|low confidence/giu),
].map((match) => match[0])

console.log(
  JSON.stringify(
    {
      fixture: 'prompt-program-root-win32-v1',
      sourceBundle: {
        algorithm: 'sha256(path NUL bytes NUL, sorted paths)',
        files: sourceFiles,
        digest: sourceBundleDigest(sourceFiles),
      },
      baseline: summary(baseline),
      candidate: {
        ...summary(lean),
        trustedBlockHeaders:
          lean.instructions.match(/^# Praxis Trusted Instructions$/gmu)?.length ?? 0,
        forbiddenModelTerms,
      },
      reduction: {
        trustedTokensPercent: percentReduction(
          baseline.manifest.program.trustedInstructions.estimatedTokens,
          lean.manifest.program.trustedInstructions.estimatedTokens,
        ),
        totalPromptTokensPercent: percentReduction(
          baseline.manifest.estimatedTokens,
          lean.manifest.estimatedTokens,
        ),
      },
    },
    null,
    2,
  ),
)

function summary(build: ReturnType<SystemPromptComposer['compose']>) {
  return {
    variant: build.manifest.program.variant,
    trustedInstructionsId: build.manifest.program.trustedInstructions.id,
    trustedInstructionsVersion: build.manifest.program.trustedInstructions.version,
    trustedInstructionsDigest: promptDigest(build.instructions),
    trustedCharacters: build.instructions.length,
    trustedTokens: build.manifest.program.trustedInstructions.estimatedTokens,
    totalPromptTokens: build.manifest.estimatedTokens,
    contextMessages: build.contextMessages.length,
    sectionIds: build.manifest.sections.map(({ id }) => id),
  }
}

function percentReduction(baselineValue: number, candidateValue: number): number {
  if (baselineValue === 0) return 0
  return Math.round((1 - candidateValue / baselineValue) * 1_000) / 10
}

function sourceBundleDigest(files: readonly string[]): `sha256:${string}` {
  const hash = createHash('sha256')
  for (const path of [...files].sort()) {
    hash.update(path)
    hash.update('\0')
    hash.update(readFileSync(path))
    hash.update('\0')
  }
  return `sha256:${hash.digest('hex')}`
}
