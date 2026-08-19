import { createHash } from 'node:crypto'
import {
  type CompactionGeneratorIdentity,
  type CompactionProvenance,
  type CompactionSummary,
  type CompactPlan,
  contentText,
  type ProviderMessage,
  type ProviderUsage,
  providerToolCalls,
  runtimeError,
  type SkillInvocationEntry,
  type SummaryCheckpoint,
} from '@praxis/core-sdk'
import {
  type CompactionPolicy,
  type ContextPolicy,
  compactionPolicy,
  contextPolicy,
} from './compactionPolicy.js'
import { ConservativeTokenizer, type TokenizerAdapter } from './tokenizer.js'

export type CompactionGeneratorInput = {
  previous?: CompactionSummary
  /** Runtime-extracted state that a semantic generator must preserve or enrich. */
  baseline?: CompactionSummary
  messages: readonly ProviderMessage[]
  plan?: CompactPlan
  focus?: string
  signal?: AbortSignal
  maxSummaryTokens?: number
}

export type CompactionGeneratorOutput =
  | CompactionSummary
  | Readonly<{
      summary: CompactionSummary
      usage?: ProviderUsage
    }>

export interface CompactionSummaryGenerator {
  readonly identity: CompactionGeneratorIdentity
  generate(input: CompactionGeneratorInput): Promise<CompactionGeneratorOutput>
}

export class DeterministicSummaryGenerator implements CompactionSummaryGenerator {
  readonly identity = {
    kind: 'deterministic',
    id: 'praxis-deterministic-v1',
  } as const satisfies CompactionGeneratorIdentity

  async generate(input: CompactionGeneratorInput): Promise<CompactionSummary> {
    const summary = cloneSummary(input.previous)
    if (input.plan) {
      summary.objective ??= bounded(input.plan.objective)
      addMany(
        summary.activePlan,
        input.plan.steps
          .filter((step) => step.state === 'pending' || step.state === 'in_progress')
          .map((step) => `${step.state}: ${step.title}`),
      )
    }

    const activeTask = latestActiveUserTask(input.messages)
    if (activeTask !== undefined) {
      summary.objective = boundedObjective(activeTask)
      collectUserContractState(summary, activeTask)
    }
    const contextPacket = latestContextPacket(input.messages)
    if (contextPacket !== undefined) collectContextPacketState(summary, contextPacket)
    const successfulCalls = successfulToolCallIds(input.messages)

    for (const message of focusOrderedMessages(input.messages, input.focus)) {
      if (message.role === 'tool') {
        collectToolState(summary, message)
        continue
      }
      if (message.role === 'assistant') {
        collectSuccessfulToolCallState(summary, message, successfulCalls)
        collectAssistantContinuationState(summary, contentText(message.content))
        continue
      }
      if (message.role === 'user' && message.intent !== 'context' && message.trust !== 'low') {
        collectUserContractState(summary, contentText(message.content))
      }
    }
    return summary
  }
}

export type CompactionServiceOptions = {
  tokenizer?: TokenizerAdapter
  generator?: CompactionSummaryGenerator
  fallbackGenerator?: CompactionSummaryGenerator
  contextPolicy?: Partial<ContextPolicy>
  compactionPolicy?: Partial<CompactionPolicy>
  /** Compatibility override; the selected cut is still moved to a complete-turn boundary. */
  retainRecentMessages?: number
}

export type CompactionAttemptResult =
  | Readonly<{
      status: 'compacted'
      checkpoint: SummaryCheckpoint
      usage?: ProviderUsage
    }>
  | Readonly<{
      status: 'no_range'
      checkpoint?: SummaryCheckpoint
      previousEnd: number
      candidateEnd: number
    }>
  | Readonly<{
      status: 'low_gain'
      checkpoint?: SummaryCheckpoint
      previousEnd: number
      candidateEnd: number
      estimatedGainTokens: number
      minimumGainTokens: number
    }>

export class CompactionService {
  readonly #tokenizer: TokenizerAdapter
  readonly #generator: CompactionSummaryGenerator
  readonly #fallbackGenerator?: CompactionSummaryGenerator
  readonly #contextPolicy: ContextPolicy
  readonly #compactionPolicy: CompactionPolicy
  readonly #retainRecentMessages?: number

  constructor(options: CompactionServiceOptions = {}) {
    this.#tokenizer = options.tokenizer ?? new ConservativeTokenizer()
    const deterministic = new DeterministicSummaryGenerator()
    this.#generator = options.generator ?? deterministic
    this.#fallbackGenerator =
      options.generator === undefined ? undefined : (options.fallbackGenerator ?? deterministic)
    validateGeneratorIdentity(this.#generator.identity)
    if (this.#fallbackGenerator) validateGeneratorIdentity(this.#fallbackGenerator.identity)
    this.#contextPolicy = contextPolicy(options.contextPolicy)
    this.#compactionPolicy = compactionPolicy(options.compactionPolicy)
    this.#retainRecentMessages =
      options.retainRecentMessages === undefined
        ? undefined
        : Math.max(1, Math.floor(options.retainRecentMessages))
  }

  async compact(input: {
    sessionId: string
    messages: readonly ProviderMessage[]
    previous?: SummaryCheckpoint
    plan?: CompactPlan
    scope?: 'parent' | 'child'
    focus?: string
    reason?: 'manual' | 'threshold' | 'overflow'
    signal?: AbortSignal
  }): Promise<SummaryCheckpoint | undefined> {
    const result = await this.compactDetailed(input)
    return result.checkpoint
  }

  async compactDetailed(input: {
    sessionId: string
    messages: readonly ProviderMessage[]
    previous?: SummaryCheckpoint
    plan?: CompactPlan
    scope?: 'parent' | 'child'
    focus?: string
    reason?: 'manual' | 'threshold' | 'overflow'
    signal?: AbortSignal
  }): Promise<CompactionAttemptResult> {
    throwIfCompactionCancelled(input.signal)
    const focus = optionalCompactionFocus(input.focus)
    const scope = { kind: input.scope ?? ('parent' as const), sessionId: input.sessionId }
    if (
      input.previous &&
      (input.previous.scope === undefined
        ? scope.kind === 'child'
        : input.previous.scope.sessionId !== input.sessionId ||
          input.previous.scope.kind !== scope.kind)
    ) {
      throw runtimeError(
        'COMPACTION_SCOPE_MISMATCH',
        'persistence',
        'Compaction checkpoint belongs to another Session scope.',
      )
    }
    const messageEnd = compactionCutPoint(
      input.messages,
      this.#tokenizer,
      this.#contextPolicy.keepRecentTokens,
      this.#retainRecentMessages,
      input.reason,
    )
    const previousEnd = Math.min(input.previous?.messageEnd ?? 0, input.messages.length)
    if (messageEnd <= previousEnd) {
      return {
        status: 'no_range',
        ...(input.previous === undefined ? {} : { checkpoint: input.previous }),
        previousEnd,
        candidateEnd: messageEnd,
      }
    }

    const generated = await this.generateSummary({
      ...(input.previous === undefined
        ? {}
        : {
            previous:
              input.previous.summary ??
              ({
                decisions: [bounded(input.previous.content)],
                constraints: [],
                readFiles: [],
                modifiedFiles: [],
                unresolved: [],
                activePlan: [],
              } satisfies CompactionSummary),
          }),
      messages: input.messages.slice(previousEnd, messageEnd),
      ...(input.plan === undefined ? {} : { plan: input.plan }),
      ...(focus === undefined ? {} : { focus }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      maxSummaryTokens: this.#compactionPolicy.maxSummaryTokens,
    })
    throwIfCompactionCancelled(input.signal)
    const summary = fitSummaryToTokens(
      preserveActiveTaskContract(
        generated.summary,
        input.previous?.summary,
        input.messages.slice(previousEnd, messageEnd),
      ),
      this.#tokenizer,
      this.#compactionPolicy.maxSummaryTokens,
    )
    const { provenance } = generated
    const content = renderSummary(summary)
    const digest = `sha256:${createHash('sha256').update(content).digest('hex')}`
    const skillInvocations = collectSkillInvocations(
      input.previous?.skillInvocations ?? [],
      input.messages.slice(previousEnd, messageEnd),
    )
    const estimatedTokens = this.#tokenizer.countText(content)
    const coveredTokens = input.messages
      .slice(input.previous?.messageStart ?? 0, messageEnd)
      .reduce((total, message) => total + this.#tokenizer.countMessage(message), 0)
    const replayTokens = this.#tokenizer.countText(JSON.stringify(skillInvocations))
    const estimatedGainTokens = Math.max(0, coveredTokens - estimatedTokens - replayTokens)
    if (estimatedGainTokens < this.#compactionPolicy.minimumGain) {
      return {
        status: 'low_gain',
        ...(input.previous === undefined ? {} : { checkpoint: input.previous }),
        previousEnd,
        candidateEnd: messageEnd,
        estimatedGainTokens,
        minimumGainTokens: this.#compactionPolicy.minimumGain,
      }
    }
    return {
      status: 'compacted',
      checkpoint: {
        id: `cp-${input.sessionId}-${messageEnd}-${digest.slice(-12)}`,
        trust: 'low',
        scope,
        messageStart: input.previous?.messageStart ?? 0,
        messageEnd,
        content,
        digest,
        estimatedTokens,
        estimatedGainTokens,
        createdAt: new Date().toISOString(),
        ...(input.reason === undefined ? {} : { reason: input.reason }),
        summary,
        provenance,
        ...(skillInvocations.length === 0 ? {} : { skillInvocations }),
        ...(input.previous?.nativeContext === undefined
          ? {}
          : { nativeContext: structuredClone(input.previous.nativeContext) }),
      },
      ...(generated.usage === undefined ? {} : { usage: generated.usage }),
    }
  }

  private async generateSummary(input: CompactionGeneratorInput): Promise<{
    summary: CompactionSummary
    provenance: CompactionProvenance
    usage?: ProviderUsage
  }> {
    // A schema-valid model response can still be semantically empty. Always
    // extract a conservative Runtime-owned baseline and overlay it on either
    // the semantic result or the configured fallback so omissions cannot erase
    // modified files, failure evidence, or the continuation frontier.
    const runtimeBaseline = validateAndBoundSummary(
      await new DeterministicSummaryGenerator().generate(input),
    )
    const generatorInput = { ...input, baseline: runtimeBaseline }
    try {
      const generated = await this.generateBounded(this.#generator, generatorInput)
      return {
        ...generated,
        summary: mergeSummaryWithRuntimeBaseline(generated.summary, runtimeBaseline),
        provenance: {
          schemaVersion: 1,
          generator: cloneGeneratorIdentity(this.#generator.identity),
        },
      }
    } catch (error) {
      if (errorCode(error) === 'COMPACTION_CANCELLED') throw error
      if (!this.#fallbackGenerator) throw error
      const generated = await this.generateBounded(this.#fallbackGenerator, generatorInput)
      return {
        ...generated,
        summary: mergeSummaryWithRuntimeBaseline(generated.summary, runtimeBaseline),
        provenance: {
          schemaVersion: 1,
          generator: cloneGeneratorIdentity(this.#fallbackGenerator.identity),
          fallbackFrom: cloneGeneratorIdentity(this.#generator.identity),
        },
      }
    }
  }

  private async generateBounded(
    generator: CompactionSummaryGenerator,
    input: CompactionGeneratorInput,
  ): Promise<{ summary: CompactionSummary; usage?: ProviderUsage }> {
    const controller = new AbortController()
    const cancel = () => controller.abort('compaction_cancelled')
    if (input.signal?.aborted) throw compactionCancelled()
    input.signal?.addEventListener('abort', cancel, { once: true })
    const timer = setTimeout(
      () => controller.abort('compaction_generator_deadline'),
      this.#compactionPolicy.generatorDeadlineMs,
    )
    try {
      const output = await Promise.race([
        generator.generate({ ...input, signal: controller.signal }),
        new Promise<never>((_resolve, reject) => {
          controller.signal.addEventListener(
            'abort',
            () =>
              reject(
                controller.signal.reason === 'compaction_cancelled'
                  ? compactionCancelled()
                  : runtimeError(
                      'COMPACTION_GENERATOR_DEADLINE',
                      'provider',
                      'Compaction generator exceeded its deadline.',
                    ),
              ),
            { once: true },
          )
        }),
      ])
      const unpacked = unpackGeneratorOutput(output)
      if (
        this.#compactionPolicy.generatorMaxCostUsd !== undefined &&
        (unpacked.usage?.costUsd ?? 0) > this.#compactionPolicy.generatorMaxCostUsd
      ) {
        throw runtimeError(
          'COMPACTION_GENERATOR_COST_EXCEEDED',
          'provider',
          'Compaction generator exceeded its cost limit.',
        )
      }
      const summary = validateAndBoundSummary(unpacked.summary)
      if (
        this.#tokenizer.countText(renderSummary(summary)) <= this.#compactionPolicy.maxSummaryTokens
      ) {
        return { summary, ...(unpacked.usage === undefined ? {} : { usage: unpacked.usage }) }
      }
      return {
        summary: fitSummaryToTokens(
          summary,
          this.#tokenizer,
          this.#compactionPolicy.maxSummaryTokens,
        ),
        ...(unpacked.usage === undefined ? {} : { usage: unpacked.usage }),
      }
    } finally {
      clearTimeout(timer)
      input.signal?.removeEventListener('abort', cancel)
    }
  }
}

function focusOrderedMessages(
  messages: readonly ProviderMessage[],
  focus: string | undefined,
): readonly ProviderMessage[] {
  const terms = focusTerms(focus)
  if (terms.length === 0) return messages
  const ordinary: ProviderMessage[] = []
  const focused: ProviderMessage[] = []
  for (const message of messages) {
    const text = contentText(message.content).toLocaleLowerCase('en-US')
    const target = terms.some((term) => text.includes(term)) ? focused : ordinary
    target.push(message)
  }
  return [...ordinary, ...focused]
}

function focusTerms(focus: string | undefined): string[] {
  if (focus === undefined) return []
  return [
    ...new Set(
      (focus.toLocaleLowerCase('en-US').match(/[\p{L}\p{N}][\p{L}\p{N}._/-]{1,63}/gu) ?? []).slice(
        0,
        16,
      ),
    ),
  ]
}

function optionalCompactionFocus(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 1_024 ||
    Buffer.byteLength(value, 'utf8') > 4_096
  ) {
    throw runtimeError(
      'COMPACTION_FOCUS_INVALID',
      'protocol',
      'Compaction focus is outside the bounded contract.',
    )
  }
  return value
}

function throwIfCompactionCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw compactionCancelled()
}

function compactionCancelled() {
  return runtimeError('COMPACTION_CANCELLED', 'cancelled', 'Compaction was cancelled.')
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' &&
    error !== null &&
    typeof Reflect.get(error, 'code') === 'string'
    ? (Reflect.get(error, 'code') as string)
    : undefined
}

function compactionCutPoint(
  messages: readonly ProviderMessage[],
  tokenizer: TokenizerAdapter,
  keepRecentTokens: number,
  retainRecentMessages: number | undefined,
  reason: 'manual' | 'threshold' | 'overflow' | undefined,
): number {
  if (messages.length === 0) return 0
  const boundaries = stableCompactionBoundaries(messages)
  if (boundaries.length === 1) return 0

  // An explicit user request should compact any complete historical turns even
  // when the whole Session is smaller than the automatic keep-recent token
  // window. Retain the newest complete turn instead of compacting everything.
  if (reason === 'manual') {
    return boundaries.filter((boundary) => boundary < messages.length).at(-1) ?? 0
  }

  if (retainRecentMessages !== undefined) {
    const target = Math.max(0, messages.length - retainRecentMessages)
    let cut = 0
    for (const boundary of boundaries.slice(1)) {
      if (boundary > target) break
      cut = boundary
    }
    return cut
  }

  const suffixTokens = new Array<number>(messages.length + 1).fill(0)
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    suffixTokens[index] = suffixTokens[index + 1]! + tokenizer.countMessage(messages[index]!)
  }
  for (let index = boundaries.length - 1; index >= 0; index -= 1) {
    const boundary = boundaries[index]!
    if (suffixTokens[boundary]! >= keepRecentTokens) return boundary
  }
  return 0
}

/** A boundary is safe only when it cannot separate a Tool call from any of its results. */
function stableCompactionBoundaries(messages: readonly ProviderMessage[]): number[] {
  const boundaries = new Set<number>([0])
  let pendingToolCalls: Set<string> | undefined

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!
    if (index > 0 && message.role === 'user' && pendingToolCalls === undefined) {
      boundaries.add(index)
    }
    if (message.role === 'assistant') {
      const toolCallIds = assistantToolCallIds(message)
      if (toolCallIds.length > 0 && pendingToolCalls === undefined) {
        pendingToolCalls = new Set(toolCallIds)
      }
      continue
    }
    if (message.role !== 'tool' || pendingToolCalls === undefined) continue
    if (!pendingToolCalls.delete(message.toolCallId)) {
      pendingToolCalls = undefined
      continue
    }
    if (pendingToolCalls.size === 0) {
      pendingToolCalls = undefined
      boundaries.add(index + 1)
    }
  }
  return [...boundaries].sort((left, right) => left - right)
}

function assistantToolCallIds(message: Extract<ProviderMessage, { role: 'assistant' }>): string[] {
  const ids = new Set<string>()
  for (const call of message.toolCalls ?? []) ids.add(call.id)
  if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (block.type === 'tool_call') ids.add(block.id)
    }
  }
  return [...ids]
}

function unpackGeneratorOutput(output: CompactionGeneratorOutput): {
  summary: unknown
  usage?: ProviderUsage
} {
  if (isRecord(output) && Object.hasOwn(output, 'summary')) {
    const envelope = output as Record<string, unknown>
    const usage = envelope.usage
    if (usage !== undefined) validateGeneratorUsage(usage)
    return { summary: envelope.summary, ...(usage === undefined ? {} : { usage }) }
  }
  return { summary: output }
}

function validateGeneratorUsage(value: unknown): asserts value is ProviderUsage {
  if (
    !isRecord(value) ||
    !Object.keys(value).every((key) =>
      ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'costUsd'].includes(
        key,
      ),
    )
  ) {
    throw invalidSummary()
  }
  for (const key of [
    'inputTokens',
    'outputTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
  ] as const) {
    const count = value[key]
    if (count !== undefined && (!Number.isSafeInteger(count) || (count as number) < 0)) {
      throw invalidSummary()
    }
  }
  if (
    value.costUsd !== undefined &&
    (typeof value.costUsd !== 'number' || !Number.isFinite(value.costUsd) || value.costUsd < 0)
  ) {
    throw invalidSummary()
  }
}

function fitSummaryToTokens(
  input: CompactionSummary,
  tokenizer: TokenizerAdapter,
  maxTokens: number,
): CompactionSummary {
  const summary = cloneSummary(input)
  // Transcript-like evidence is cheaper to rediscover than the continuation
  // frontier. In particular, do not let a long objective or a model-generated
  // reference list evict the only record that a file was changed and still
  // needs to be rebuilt, installed, or verified.
  const disposableFields = ['readFiles', 'decisions'] as const
  const frontierFields = ['constraints', 'modifiedFiles', 'unresolved', 'activePlan'] as const
  while (tokenizer.countText(renderSummary(summary)) > maxTokens) {
    const disposable = largestPopulatedField(summary, disposableFields)
    if (disposable !== undefined) {
      summary[disposable].shift()
      continue
    }
    if ((summary.relevantRefs?.length ?? 0) > 0) {
      summary.relevantRefs!.shift()
      continue
    }
    if (shrinkSummaryObjective(summary, 512)) continue

    // Prefer retaining at least one item from every continuation field. When
    // several entries exist, discard the oldest before erasing a field.
    const redundantFrontier = largestPopulatedField(summary, frontierFields, 2)
    if (redundantFrontier !== undefined) {
      summary[redundantFrontier].shift()
      continue
    }
    if (shrinkSummaryObjective(summary, 128)) continue

    const frontier = largestPopulatedField(summary, frontierFields)
    if (frontier !== undefined) {
      summary[frontier].shift()
      continue
    }
    if (shrinkSummaryObjective(summary, 0)) continue
    throw invalidSummary()
  }
  return summary
}

function largestPopulatedField<const Field extends keyof CompactionSummary>(
  summary: CompactionSummary,
  fields: readonly Field[],
  minimumLength = 1,
): Field | undefined {
  return fields.reduce<Field | undefined>((largest, candidate) => {
    const value = summary[candidate]
    if (!Array.isArray(value) || value.length < minimumLength) return largest
    if (largest === undefined) return candidate
    const largestValue = summary[largest]
    return Array.isArray(largestValue) && value.length > largestValue.length ? candidate : largest
  }, undefined)
}

function shrinkSummaryObjective(summary: CompactionSummary, floor: number): boolean {
  if (summary.objective === undefined) return false
  const points = Array.from(summary.objective)
  if (points.length <= floor) {
    if (floor > 0) return false
    delete summary.objective
    return true
  }
  summary.objective = boundedObjective(
    summary.objective,
    Math.max(floor, Math.floor(points.length * 0.75)),
  )
  return true
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function collectSkillInvocations(
  previous: readonly SkillInvocationEntry[],
  messages: readonly ProviderMessage[],
): SkillInvocationEntry[] {
  const collected = [...previous]
  for (const message of messages) {
    if ('skillInvocation' in message && message.skillInvocation) {
      collected.push(structuredClone(message.skillInvocation))
    }
  }
  return collected.slice(-8).map((invocation) => structuredClone(invocation))
}

function collectToolState(
  summary: CompactionSummary,
  message: Extract<ProviderMessage, { role: 'tool' }>,
): void {
  try {
    const result = JSON.parse(contentText(message.content)) as {
      ok?: unknown
      output?: {
        path?: unknown
        artifact?: unknown
        stdout?: unknown
        stderr?: unknown
      }
      error?: { code?: unknown }
    }
    const path = typeof result.output?.path === 'string' ? result.output.path : undefined
    if (path) {
      if (message.name === 'write' || message.name === 'edit') add(summary.modifiedFiles, path)
      else add(summary.readFiles, path)
    }
    if (result.ok === false) {
      add(
        summary.unresolved,
        `${message.name}: ${typeof result.error?.code === 'string' ? result.error.code : 'failed'}`,
      )
    }
    const failure = toolFailureEvidence(result.output?.stdout, result.output?.stderr)
    if (failure !== undefined) add(summary.unresolved, `${message.name}: ${failure}`)
  } catch {
    // Legacy non-JSON Tool messages do not contribute structured state.
  }
}

function successfulToolCallIds(messages: readonly ProviderMessage[]): ReadonlySet<string> {
  const successful = new Set<string>()
  for (const message of messages) {
    if (message.role !== 'tool') continue
    try {
      const result = JSON.parse(contentText(message.content)) as { ok?: unknown }
      if (result.ok === true) successful.add(message.toolCallId)
    } catch {
      // Legacy non-JSON Tool results do not prove that a mutation succeeded.
    }
  }
  return successful
}

function collectSuccessfulToolCallState(
  summary: CompactionSummary,
  message: Extract<ProviderMessage, { role: 'assistant' }>,
  successfulCalls: ReadonlySet<string>,
): void {
  for (const call of providerToolCalls(message)) {
    if (!successfulCalls.has(call.id) || !isRecord(call.input)) continue
    const path = call.input.path
    if (
      (call.name === 'edit' || call.name === 'write') &&
      typeof path === 'string' &&
      path.trim() !== ''
    ) {
      add(summary.modifiedFiles, bounded(path.trim()))
      continue
    }
    if (call.name !== 'shell' || typeof call.input.command !== 'string') continue
    for (const candidate of shellMutationPaths(call.input.command)) {
      add(summary.modifiedFiles, candidate)
    }
  }
}

const SHELL_MUTATION_SIGNAL =
  /(?:^|[;&|\n]\s*|\b)(?:sed\b[^\n;&|]*\s-i(?:\s|$)|perl\b[^\n;&|]*\s-pi(?:\s|$)|(?:cp|mv|rm|touch|mkdir|install|patch|tee)\b|git\s+(?:apply|checkout|restore|rm|mv)\b|>{1,2}(?!&))/iu
const SHELL_PATH_CANDIDATE =
  /(?:[A-Za-z]:[\\/]|\.{0,2}[\\/])?[\p{L}\p{N}_@+.,=~%()-]+(?:[\\/][\p{L}\p{N}_@+.,=~%()-]+)*\.(?:pyx?|pxd|tsx?|jsx?|mjs|cjs|c|cc|cpp|cxx|h|hh|hpp|rs|go|java|kt|kts|cs|fs|fsx|rb|php|swift|scala|sh|bash|zsh|fish|ps1|sql|toml|json|ya?ml|xml|html?|css|scss|less|md|txt|csv|ini|cfg|conf)\b/giu

function shellMutationPaths(command: string): string[] {
  if (!SHELL_MUTATION_SIGNAL.test(command)) return []
  SHELL_PATH_CANDIDATE.lastIndex = 0
  const paths: string[] = []
  for (const match of command.matchAll(SHELL_PATH_CANDIDATE)) {
    const candidate = bounded(match[0]!.trim())
    if (candidate && !candidate.startsWith('-')) add(paths, candidate)
  }
  return paths.slice(-32)
}

function mergeSummaryWithRuntimeBaseline(
  generated: CompactionSummary,
  baseline: CompactionSummary,
): CompactionSummary {
  const merged = cloneSummary(generated)
  // Field ownership is deliberate. A semantic model may summarize decisions
  // and continuation state, but it cannot manufacture task authority or Tool
  // evidence. Those fields come only from the user/ContextPacket contract,
  // the previous admitted checkpoint, and successful Runtime Tool records.
  if (baseline.objective === undefined) delete merged.objective
  else merged.objective = baseline.objective
  if (baseline.relevantRefs === undefined) delete merged.relevantRefs
  else merged.relevantRefs = [...baseline.relevantRefs]
  merged.constraints = [...baseline.constraints]
  merged.readFiles = [...baseline.readFiles]
  merged.modifiedFiles = [...baseline.modifiedFiles]
  addMany(merged.decisions, baseline.decisions)
  addMany(merged.unresolved, baseline.unresolved)
  addMany(merged.activePlan, baseline.activePlan)
  return merged
}

function collectUserContractState(summary: CompactionSummary, content: string): void {
  for (const line of content.split(/\r?\n/u)) {
    const fact = bounded(line.trim())
    if (!fact) continue
    if (/\b(decision|decided|accepted|agreed)\b/iu.test(fact)) add(summary.decisions, fact)
    if (
      /\b(?:must|mustn't|shall|shall not|never|required|only|cannot|can't|do not|don't|except)\b/iu.test(
        fact,
      )
    ) {
      add(summary.constraints, fact)
    }
  }
}

function collectAssistantContinuationState(summary: CompactionSummary, content: string): void {
  for (const line of content.split(/\r?\n/u)) {
    const fact = bounded(line.trim())
    if (!fact) continue
    if (/\b(decision|decided|accepted|agreed)\b/iu.test(fact)) add(summary.decisions, fact)
    if (describesOpenLoop(fact)) add(summary.unresolved, fact)
    if (describesNextAction(fact)) add(summary.activePlan, `pending: ${fact}`)
  }
}

function describesOpenLoop(value: string): boolean {
  if (
    /\b(?:all|every)\s+(?:tests?|checks?|verifications?)\s+(?:pass|passed|succeeded)\b/iu.test(
      value,
    )
  ) {
    return false
  }
  return /\b(?:todo|unresolved|failing|failed|failure|error|blocked|broken|pending|not yet|remain(?:s|ing)?|need(?:s|ed)? to|still (?:need|fail|missing|broken)|rebuild|reinstall|retry|rerun|re-run)\b/iu.test(
    value,
  )
}

function describesNextAction(value: string): boolean {
  return (
    /\b(?:need(?:s|ed)? to|must still|next|pending)\b/iu.test(value) ||
    /\b(?:now|then)\b.{0,80}\b(?:run|rebuild|reinstall|verify|test|fix|inspect|check|apply|write|update|retry)\b/iu.test(
      value,
    )
  )
}

function toolFailureEvidence(stdout: unknown, stderr: unknown): string | undefined {
  const text = [stdout, stderr]
    .filter((value): value is string => typeof value === 'string')
    .join('\n')
  if (!text) return undefined
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = bounded(rawLine.trim())
    if (!line || /\b0 failed\b/iu.test(line)) continue
    if (
      /(?:^|\b)(?:FAILED|FAILURES?|ERROR|Exception|Traceback|NameError|AssertionError|[1-9][0-9]* failed)(?:\b|:)/u.test(
        line,
      )
    ) {
      return line
    }
  }
  return undefined
}

function renderSummary(summary: CompactionSummary): string {
  return [
    '# Session summary',
    ...(summary.objective ? [`Objective: ${summary.objective}`] : []),
    section('Relevant references', summary.relevantRefs ?? []),
    section('Decisions', summary.decisions),
    section('Constraints', summary.constraints),
    section('Read files', summary.readFiles),
    section('Modified files', summary.modifiedFiles),
    section('Unresolved verification', summary.unresolved),
    section('Active plan', summary.activePlan),
  ]
    .filter(Boolean)
    .join('\n')
}

function section(title: string, values: readonly string[]): string {
  return values.length === 0 ? '' : `${title}:\n${values.map((value) => `- ${value}`).join('\n')}`
}

function cloneSummary(previous: CompactionSummary | undefined): CompactionSummary {
  return {
    ...(previous?.objective === undefined ? {} : { objective: previous.objective }),
    ...(previous?.relevantRefs === undefined ? {} : { relevantRefs: [...previous.relevantRefs] }),
    decisions: [...(previous?.decisions ?? [])],
    constraints: [...(previous?.constraints ?? [])],
    readFiles: [...(previous?.readFiles ?? [])],
    modifiedFiles: [...(previous?.modifiedFiles ?? [])],
    unresolved: [...(previous?.unresolved ?? [])],
    activePlan: [...(previous?.activePlan ?? [])],
  }
}

function validateAndBoundSummary(value: unknown): CompactionSummary {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidSummary()
  }
  const summary = value as Record<string, unknown>
  const objective = summary.objective
  if (objective !== undefined && typeof objective !== 'string') throw invalidSummary()
  const relevantRefs = summary.relevantRefs
  if (
    relevantRefs !== undefined &&
    (!Array.isArray(relevantRefs) || !relevantRefs.every((item) => typeof item === 'string'))
  ) {
    throw invalidSummary()
  }
  const arrays = [
    'decisions',
    'constraints',
    'readFiles',
    'modifiedFiles',
    'unresolved',
    'activePlan',
  ] as const
  for (const name of arrays) {
    if (!Array.isArray(summary[name]) || !summary[name].every((item) => typeof item === 'string')) {
      throw invalidSummary()
    }
  }
  return {
    ...(objective === undefined ? {} : { objective: boundedObjective(objective) }),
    ...(relevantRefs === undefined
      ? {}
      : { relevantRefs: boundedValues(relevantRefs as string[]).slice(-32) }),
    decisions: boundedValues(summary.decisions as string[]),
    constraints: boundedValues(summary.constraints as string[]),
    readFiles: boundedValues(summary.readFiles as string[]),
    modifiedFiles: boundedValues(summary.modifiedFiles as string[]),
    unresolved: boundedValues(summary.unresolved as string[]),
    activePlan: boundedValues(summary.activePlan as string[]),
  }
}

function boundedValues(values: readonly string[]): string[] {
  const result: string[] = []
  for (const value of values) add(result, bounded(value))
  return result
}

function validateGeneratorIdentity(identity: CompactionGeneratorIdentity): void {
  if (
    !identity ||
    !['deterministic', 'model'].includes(identity.kind) ||
    !safeIdentityPart(identity.id) ||
    (identity.kind === 'model' &&
      (!safeIdentityPart(identity.provider) || !safeIdentityPart(identity.model)))
  ) {
    throw runtimeError(
      'COMPACTION_GENERATOR_INVALID',
      'configuration',
      'Compaction generator identity is invalid.',
    )
  }
}

function cloneGeneratorIdentity(
  identity: CompactionGeneratorIdentity,
): CompactionGeneratorIdentity {
  return identity.kind === 'deterministic'
    ? { kind: identity.kind, id: identity.id }
    : {
        kind: identity.kind,
        id: identity.id,
        provider: identity.provider,
        model: identity.model,
      }
}

function safeIdentityPart(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(value)
}

function invalidSummary() {
  return runtimeError(
    'COMPACTION_SUMMARY_INVALID',
    'provider',
    'Compaction summary output did not match the bounded structured contract.',
  )
}

function addMany(target: string[], values: readonly string[]): void {
  for (const value of values) add(target, value)
}

function add(target: string[], value: string): void {
  if (!value || target.includes(value)) return
  target.push(value)
  if (target.length > 24) target.shift()
}

function bounded(value: string): string {
  return value.trim().slice(0, 240)
}

const TASK_OBJECTIVE_MAX_CHARACTERS = 2_048
const TASK_OBJECTIVE_TRUNCATION_MARKER = '\n…[task contract truncated]…\n'

/**
 * Preserve both the beginning (goal/setup) and end (completion/output contract)
 * of a long user request. JavaScript string slicing is avoided so surrogate
 * pairs cannot be split before the checkpoint is persisted.
 */
function boundedObjective(value: string, maximum = TASK_OBJECTIVE_MAX_CHARACTERS): string {
  const points = Array.from(value.trim())
  if (points.length <= maximum) return points.join('')
  const marker = Array.from(TASK_OBJECTIVE_TRUNCATION_MARKER)
  if (maximum <= marker.length + 2) return points.slice(0, maximum).join('')
  const available = maximum - marker.length
  const head = Math.ceil(available * 0.6)
  const tail = available - head
  return [...points.slice(0, head), ...marker, ...points.slice(-tail)].join('')
}

function latestActiveUserTask(messages: readonly ProviderMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!
    if (message.role !== 'user' || message.intent === 'context' || message.trust === 'low') continue
    const content = contentText(message.content).trim()
    if (content) return contextPacketFromContent(content)?.objective ?? content
  }
  return undefined
}

type ChildContextPacket = Readonly<{
  objective: string
  constraints: readonly string[]
  prohibitions: readonly string[]
  instructions?: string
  successCriteria: readonly Readonly<{ id: string; description?: string }>[]
  relevantRefs: readonly string[]
  workspaceAccess?: string
}>

function latestContextPacket(messages: readonly ProviderMessage[]): ChildContextPacket | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!
    if (message.role !== 'user') continue
    const packet = contextPacketFromContent(contentText(message.content))
    if (packet !== undefined) return packet
  }
  return undefined
}

function contextPacketFromContent(content: string): ChildContextPacket | undefined {
  const startMarker = '--- PRAXIS_CONTEXT_PACKET_V1 ---'
  const endMarker = '--- END_PRAXIS_CONTEXT_PACKET_V1 ---'
  const start = content.indexOf(startMarker)
  const end = content.indexOf(endMarker, start + startMarker.length)
  if (start < 0 || end < 0) return undefined
  try {
    const value = JSON.parse(content.slice(start + startMarker.length, end).trim()) as unknown
    if (!isRecord(value) || typeof value.objective !== 'string' || value.objective.trim() === '') {
      return undefined
    }
    const step = isRecord(value.step) ? value.step : undefined
    const workspace = isRecord(value.workspace) ? value.workspace : undefined
    return {
      objective: value.objective,
      constraints: stringValues(value.constraints),
      prohibitions: stringValues(value.prohibitions),
      ...(typeof step?.instructions === 'string' ? { instructions: step.instructions } : {}),
      successCriteria: criteriaValues(value.successCriteria),
      relevantRefs: contextReferenceValues(value.relevantRefs),
      ...(typeof workspace?.access === 'string' ? { workspaceAccess: workspace.access } : {}),
    }
  } catch {
    return undefined
  }
}

function collectContextPacketState(summary: CompactionSummary, packet: ChildContextPacket): void {
  summary.objective = boundedObjective(packet.objective)
  summary.relevantRefs ??= []
  addMany(summary.relevantRefs, packet.relevantRefs)
  addMany(summary.constraints, [...packet.constraints, ...packet.prohibitions])
  if (packet.workspaceAccess !== undefined) {
    add(summary.constraints, `Workspace access: ${packet.workspaceAccess}`)
  }
  if (packet.instructions !== undefined) {
    addMany(
      summary.constraints,
      packet.instructions
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, 16),
    )
  }
  addMany(
    summary.activePlan,
    packet.successCriteria.map(
      (criterion) =>
        `pending: ${criterion.id}${criterion.description ? `: ${criterion.description}` : ''}`,
    ),
  )
}

function contextReferenceValues(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) =>
    isRecord(item) && typeof item.ref === 'string' && item.ref.trim() !== '' ? [item.ref] : [],
  )
}

function stringValues(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function criteriaValues(
  value: unknown,
): ReadonlyArray<Readonly<{ id: string; description?: string }>> {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.id !== 'string') return []
    return [
      {
        id: item.id,
        ...(typeof item.description === 'string' ? { description: item.description } : {}),
      },
    ]
  })
}

/**
 * A model-generated summary is advisory. The Runtime-owned active task
 * contract is overlaid deterministically so a weak/failed summarizer cannot
 * erase the instruction that the Agent is still executing.
 */
function preserveActiveTaskContract(
  generated: CompactionSummary,
  previous: CompactionSummary | undefined,
  messages: readonly ProviderMessage[],
): CompactionSummary {
  const protectedSummary = cloneSummary(generated)
  const packet = latestContextPacket(messages)
  const objective =
    packet?.objective ??
    latestActiveUserTask(messages) ??
    previous?.objective ??
    generated.objective
  if (previous?.relevantRefs !== undefined) {
    protectedSummary.relevantRefs ??= []
    addMany(protectedSummary.relevantRefs, previous.relevantRefs)
  }
  if (packet !== undefined) collectContextPacketState(protectedSummary, packet)
  if (objective !== undefined) protectedSummary.objective = boundedObjective(objective)
  return protectedSummary
}
