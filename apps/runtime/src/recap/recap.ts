import {
  canonicalJsonV1,
  contentText,
  type ProviderMessage,
  type ProviderUsage,
  promptDigest,
  providerToolCalls,
} from '@praxis/core-sdk'

export const RECAP_KINDS = ['fact', 'decision', 'failure', 'open_question', 'constraint'] as const
/** The extractive snapshot can retain every eligible source candidate; injection is token-packed. */
export const MAX_EXTRACTIVE_NOTES = 256
export type RecapKind = (typeof RECAP_KINDS)[number]
export type RecapStrategy = 'none' | 'compact' | 'recap' | 'structured' | 'extractive'
export type RecapEvidence = Readonly<{
  id: string
  role: 'user' | 'assistant' | 'tool'
  text: string
}>
export type RecapSource = Readonly<{
  version: 1
  projectId: string
  episodeId: string
  entries: readonly RecapEvidence[]
  digest: string
}>
export type RecapNote = Readonly<{
  id: string
  kind: RecapKind
  content: string
  applicability: string
  invalidation: string
  evidenceRefs: readonly string[]
}>
export type RecapSnapshot = Readonly<{
  version: 1
  projectId: string
  sourceDigest: string
  strategy: RecapStrategy
  generator: string
  notes: readonly RecapNote[]
  digest: string
  usage?: ProviderUsage
}>

/** Project only public conversation and Tool observations, never reasoning or grader metadata. */
export function recapSource(
  projectId: string,
  episodeId: string,
  messages: readonly ProviderMessage[],
): RecapSource {
  text(projectId, 160)
  text(episodeId, 160)
  const entries = messages.map(
    (message, index): RecapEvidence => ({
      id: `m${index}`,
      role: message.role,
      text:
        message.role === 'assistant'
          ? canonicalJsonV1({
              text: contentText(message.content),
              calls: providerToolCalls(message),
            })
          : message.role === 'tool'
            ? canonicalJsonV1({
                name: message.name,
                callId: message.toolCallId,
                result: contentText(message.content),
              })
            : contentText(message.content),
    }),
  )
  return validateRecapSource({
    version: 1,
    projectId,
    episodeId,
    entries,
    digest: digest({ projectId, episodeId, entries }),
  })
}

export function validateRecapSource(value: unknown): RecapSource {
  const s = object(value, ['version', 'projectId', 'episodeId', 'entries', 'digest'])
  if (s.version !== 1 || !Array.isArray(s.entries) || s.entries.length > 4096) invalid('source')
  text(s.projectId, 160)
  text(s.episodeId, 160)
  const ids = new Set<string>()
  for (const entry of s.entries) {
    const e = object(entry, ['id', 'role', 'text'])
    text(e.id, 160)
    if (
      !/^m\d+$/u.test(e.id as string) ||
      !['user', 'assistant', 'tool'].includes(String(e.role)) ||
      typeof e.text !== 'string' ||
      ids.has(e.id as string)
    )
      invalid('evidence')
    ids.add(e.id as string)
  }
  if (Buffer.byteLength(canonicalJsonV1(s), 'utf8') > 2 * 1024 * 1024)
    invalid('source exceeds 2 MiB; select an explicit earlier boundary')
  if (s.digest !== digest({ projectId: s.projectId, episodeId: s.episodeId, entries: s.entries }))
    invalid('source digest')
  return structuredClone(s) as RecapSource
}

/** Reference validation establishes provenance, not semantic truth or execution authority. */
export function makeRecapSnapshot(
  sourceInput: RecapSource,
  strategy: RecapStrategy,
  generator: string,
  output: unknown,
  usage?: ProviderUsage,
): RecapSnapshot {
  const source = validateRecapSource(sourceInput)
  text(generator, 240)
  if (!['none', 'compact', 'recap', 'structured', 'extractive'].includes(strategy))
    invalid('strategy')
  const allowed = new Set(source.entries.map((e) => e.id))
  const payload = object(output, ['notes'])
  if (
    !Array.isArray(payload.notes) ||
    payload.notes.length > (strategy === 'extractive' ? MAX_EXTRACTIVE_NOTES : 32)
  )
    invalid('notes')
  const notes = payload.notes.map((value, index): RecapNote => {
    const n = object(value, ['kind', 'content', 'applicability', 'invalidation', 'evidenceRefs'])
    if (!RECAP_KINDS.includes(n.kind as RecapKind)) invalid('kind')
    text(n.content, 16000)
    text(n.applicability, 2000)
    text(n.invalidation, 2000)
    if (
      !Array.isArray(n.evidenceRefs) ||
      n.evidenceRefs.length === 0 ||
      n.evidenceRefs.length > 4096 ||
      n.evidenceRefs.some((r) => typeof r !== 'string' || !allowed.has(r))
    )
      invalid('unknown evidence reference')
    return {
      id: `n${index}`,
      kind: n.kind as RecapKind,
      content: n.content as string,
      applicability: n.applicability as string,
      invalidation: n.invalidation as string,
      evidenceRefs: [...new Set(n.evidenceRefs as string[])],
    }
  })
  if (strategy === 'none' && notes.length) invalid('none strategy contains notes')
  if (strategy === 'recap' && (notes.length > 1 || notes.some((n) => n.kind !== 'fact')))
    invalid('ordinary recap must be a single narrative fact note')
  const body = {
    version: 1 as const,
    projectId: source.projectId,
    sourceDigest: source.digest,
    strategy,
    generator,
    notes,
  }
  return {
    ...body,
    digest: digest(body),
    ...(usage === undefined ? {} : { usage: structuredClone(usage) }),
  }
}

export function validateRecapSnapshot(value: unknown): RecapSnapshot {
  const s = object(value, [
    'version',
    'projectId',
    'sourceDigest',
    'strategy',
    'generator',
    'notes',
    'digest',
    'usage',
  ])
  if (
    s.version !== 1 ||
    !Array.isArray(s.notes) ||
    s.notes.length > (s.strategy === 'extractive' ? MAX_EXTRACTIVE_NOTES : 32) ||
    !['none', 'compact', 'recap', 'structured', 'extractive'].includes(String(s.strategy))
  )
    invalid('snapshot')
  text(s.projectId, 160)
  text(s.sourceDigest, 80)
  if (!/^sha256:[a-f0-9]{64}$/u.test(s.sourceDigest as string)) invalid('source digest format')
  text(s.generator, 240)
  const ids = new Set<string>()
  for (const note of s.notes) {
    const n = object(note, [
      'id',
      'kind',
      'content',
      'applicability',
      'invalidation',
      'evidenceRefs',
    ])
    text(n.id, 160)
    if (ids.has(n.id as string) || !RECAP_KINDS.includes(n.kind as RecapKind))
      invalid('note identity')
    ids.add(n.id as string)
    text(n.content, 16000)
    text(n.applicability, 2000)
    text(n.invalidation, 2000)
    if (
      !Array.isArray(n.evidenceRefs) ||
      !n.evidenceRefs.length ||
      n.evidenceRefs.some((r) => typeof r !== 'string' || !/^m\d+$/u.test(r))
    )
      invalid('note evidence')
  }
  if (s.strategy === 'none' && s.notes.length) invalid('none snapshot')
  const { digest: actual, usage: _usage, ...body } = s
  if (actual !== digest(body)) invalid('snapshot digest')
  return structuredClone(s) as RecapSnapshot
}

export function digest(value: unknown): string {
  return promptDigest(canonicalJsonV1(value))
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !keys.includes(k))
  )
    invalid('unexpected fields')
  return value as Record<string, unknown>
}
function text(value: unknown, limit: number): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) invalid('text')
}
function invalid(detail: string): never {
  throw new TypeError(`RECAP_INVALID: ${detail}`)
}
