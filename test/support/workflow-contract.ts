import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { load: loadYaml } = require('js-yaml') as { load(source: string): unknown }

const CANONICAL_GITHUB_TOKEN_EXPRESSION = `\${{ github.token }}`

function isAsciiTokenCharacter(value: string | undefined): boolean {
  if (value === undefined) return false
  const code = value.charCodeAt(0)
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    code === 95 ||
    (code >= 97 && code <= 122)
  )
}

function toAsciiLowercase(value: string): string {
  let normalized = ''
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    normalized += String.fromCharCode(code >= 65 && code <= 90 ? code + 32 : code)
  }
  return normalized
}

function containsTokenWord(value: string, token: string): boolean {
  const normalizedValue = toAsciiLowercase(value)
  const normalizedToken = toAsciiLowercase(token)
  let index = normalizedValue.indexOf(normalizedToken)
  while (index >= 0) {
    const before = normalizedValue[index - 1]
    const after = normalizedValue[index + normalizedToken.length]
    if (!isAsciiTokenCharacter(before) && !isAsciiTokenCharacter(after)) return true
    index = normalizedValue.indexOf(normalizedToken, index + normalizedToken.length)
  }
  return false
}

function assertNoTokenWord(value: string, token: string, path: string): void {
  assert.equal(containsTokenWord(value, token), false, `${path} must not contain ${token}`)
}

export type WorkflowStep = {
  name?: string
  run?: string
  uses?: string
  if?: string
  env?: Record<string, unknown>
  with?: Record<string, unknown>
  'continue-on-error'?: boolean
}

export type WorkflowJob = {
  if?: string
  'continue-on-error'?: boolean
  needs?: string | string[]
  'runs-on'?: string | string[]
  permissions?: unknown
  strategy?: { matrix?: Record<string, unknown> }
  steps?: WorkflowStep[]
}

export type Workflow = {
  on?: {
    push?: { tags?: string[] }
    pull_request?: unknown
    release?: { types?: string[] }
    workflow_dispatch?: {
      inputs?: Record<string, { description?: string; required?: boolean; type?: string }>
    }
  }
  permissions?: unknown
  concurrency?: { group?: string; 'cancel-in-progress'?: boolean }
  jobs?: Record<string, WorkflowJob>
}

export function parseWorkflow(source: string): Workflow {
  const parsed = loadYaml(source)
  assert.ok(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed))
  return parsed as Workflow
}

export function assertDefaultSuccessJob(
  job: WorkflowJob | undefined,
  jobId: string,
): asserts job is WorkflowJob {
  assert.ok(job, `${jobId} job is required`)
  assert.equal(job.if, undefined, `${jobId} must retain the default success condition`)
  assert.equal(
    job['continue-on-error'],
    undefined,
    `${jobId} must not tolerate an upstream or job failure`,
  )
}

export function assertNoSecretsOrProviderEnvironment(
  value: unknown,
  path = 'workflow',
  implicitExpression = false,
): void {
  if (typeof value === 'string') {
    if (implicitExpression || value.includes(`\${{`)) assertNoTokenWord(value, 'secrets', path)
    assert.doesNotMatch(
      value,
      /(?:api[_-]?key|access[_-]?token|secret[_-]?key|credential)/iu,
      `${path} must not contain Provider credential environment names`,
    )
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      assertNoSecretsOrProviderEnvironment(item, `${path}[${index}]`, implicitExpression)
    })
    return
  }
  if (value === null || typeof value !== 'object') return
  for (const [key, nested] of Object.entries(value)) {
    assert.notEqual(key, 'secrets', `${path} must not contain a secrets key`)
    assertNoSecretsOrProviderEnvironment(key, `${path} key`)
    assertNoSecretsOrProviderEnvironment(nested, `${path}.${key}`, key === 'if')
  }
}

export function assertNoGitHubContextReference(
  value: unknown,
  path: string,
  implicitExpression = false,
): void {
  if (typeof value === 'string') {
    if (implicitExpression || value.includes(`\${{`)) assertNoTokenWord(value, 'github', path)
    assertNoTokenWord(value, 'GH_TOKEN', path)
    assertNoTokenWord(value, 'GITHUB_TOKEN', path)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      assertNoGitHubContextReference(item, `${path}[${index}]`, implicitExpression)
    })
    return
  }
  if (value === null || typeof value !== 'object') return
  for (const [key, nested] of Object.entries(value)) {
    assertNoGitHubContextReference(key, `${path} key`)
    assertNoGitHubContextReference(nested, `${path}.${key}`, key === 'if')
  }
}

export function assertCanonicalReleaseTokenJob(job: WorkflowJob | undefined, jobId: string): void {
  assert.ok(job, `${jobId} job is required`)
  const { steps, ...jobOutsideSteps } = job
  assertNoGitHubContextReference(jobOutsideSteps, `release job ${jobId}`)
  let canonicalMappings = 0
  for (const [index, step] of (steps ?? []).entries()) {
    const { env, ...stepOutsideEnvironment } = step
    assertNoGitHubContextReference(stepOutsideEnvironment, `release job ${jobId} step ${index}`)
    for (const [key, value] of Object.entries(env ?? {})) {
      if (key === 'GH_TOKEN') {
        assert.equal(
          value,
          CANONICAL_GITHUB_TOKEN_EXPRESSION,
          `${jobId} GH_TOKEN must use the canonical github.token expression`,
        )
        canonicalMappings += 1
      } else {
        assertNoGitHubContextReference(key, `release job ${jobId} step ${index} env key`)
        assertNoGitHubContextReference(value, `release job ${jobId} step ${index} env ${key}`)
      }
    }
  }
  assert.equal(canonicalMappings, 1, `${jobId} must have exactly one canonical GH_TOKEN mapping`)
}
