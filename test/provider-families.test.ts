import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { type ChatProvider, type ProviderChunk, runtimeError } from '@praxis/core-sdk'
import { CredentialService } from '../apps/runtime/src/credentials/credentialService.js'
import { FileCredentialStore } from '../apps/runtime/src/credentials/credentialStore.js'
import { createBuiltinProviders } from '../apps/runtime/src/llm-provider/builtinProviders.js'
import { ProviderRouter } from '../apps/runtime/src/provider-router/providerRouter.js'
import { AnthropicProvider } from '../apps/runtime/src/providers/anthropicProvider.js'
import { providerContentText } from '../apps/runtime/src/providers/contentConversion.js'
import {
  DeepSeekProvider,
  deepSeekReasoningBody,
} from '../apps/runtime/src/providers/deepSeekProvider.js'
import { kimiReasoningBody } from '../apps/runtime/src/providers/kimiProvider.js'
import { createMiniMaxProviders } from '../apps/runtime/src/providers/minimaxProvider.js'
import { ModelCatalog } from '../apps/runtime/src/providers/modelCatalog.js'
import { OpenAIResponsesProvider } from '../apps/runtime/src/providers/openAIResponsesProvider.js'
import {
  createLocalOpenAICompatibleProvider,
  OpenAICompatibleProvider,
  openAICompatibleCacheReadTokens,
  openAICompatibleJsonSchema,
  openAICompatibleRequestBody,
} from '../apps/runtime/src/providers/openAiCompatibleProvider.js'
import { createQwenTokenPlanProviders } from '../apps/runtime/src/providers/qwenTokenPlanProvider.js'

test('model catalog is versioned and returns defensive capability descriptors', () => {
  const catalog = new ModelCatalog()
  const first = catalog.resolve('anthropic', 'claude-sonnet-4-6')
  assert.equal(catalog.version, 1)
  assert.equal(first?.family, 'anthropic-messages')
  assert.equal(first?.capabilities.tools.mode, 'native')
  first!.capabilities.tools.mode = 'none'
  assert.equal(catalog.resolve('anthropic', 'claude-sonnet-4-6')?.capabilities.tools.mode, 'native')
  assert.equal(
    catalog.withCompatibility('kimi', 'kimi-k2.6', {
      disableParallelToolCalls: true,
    })?.compatibility?.disableParallelToolCalls,
    true,
  )
  assert.equal(catalog.list('kimi').length, 10)
  assert.equal(catalog.resolve('kimi', 'kimi-k3')?.name, 'Kimi K3')
  assert.equal(catalog.resolve('kimi', 'kimi-k3')?.capabilities.limits.maxContextTokens, 1_048_576)
  assert.equal(catalog.list('deepseek').length, 2)
  assert.equal(
    catalog.resolve('deepseek', 'deepseek-v4-pro')?.capabilities.limits.maxContextTokens,
    1_000_000,
  )
  assert.equal(catalog.list('anthropic').length, 15)
  assert.equal(catalog.list('openai').length, 38)
  assert.equal(catalog.list('qwen-token-plan').length, 5)
  assert.equal(catalog.list('qwen-token-plan-cn').length, 5)
  assert.equal(catalog.resolve('qwen-token-plan-cn', 'qwen3.7-max')?.family, 'openai-chat')
  assert.equal(catalog.list('minimax').length, 3)
  assert.equal(catalog.list('minimax-cn').length, 3)
  assert.equal(
    catalog.resolve('minimax', 'MiniMax-M3')?.capabilities.limits.maxContextTokens,
    1_000_000,
  )
})

test('OpenAI-compatible cache usage recognizes OpenAI, DeepSeek, and Anthropic-compatible fields', () => {
  assert.equal(
    openAICompatibleCacheReadTokens({ prompt_tokens_details: { cached_tokens: 1_024 } }),
    1_024,
  )
  assert.equal(openAICompatibleCacheReadTokens({ prompt_cache_hit_tokens: 2_048 }), 2_048)
  assert.equal(openAICompatibleCacheReadTokens({ cache_read_input_tokens: 4_096 }), 4_096)
  assert.equal(
    openAICompatibleCacheReadTokens({
      prompt_tokens_details: { cached_tokens: 8_192 },
      prompt_cache_hit_tokens: 16_384,
    }),
    16_384,
  )
  assert.equal(openAICompatibleCacheReadTokens({}), undefined)
})

test('Anthropic Messages maps text, reasoning, tools, usage, and stop reason to Provider v2', async () => {
  let requestBody: Record<string, unknown> | undefined
  const provider = new AnthropicProvider({
    apiKey: 'test',
    fetch: async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return sseResponse([
        {
          type: 'message_start',
          message: {
            usage: {
              input_tokens: 0,
              output_tokens: 0,
              cache_read_input_tokens: 1,
              cache_creation_input_tokens: 2,
            },
          },
        },
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'thinking' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'reason' },
        },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'text' },
        },
        {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'text_delta', text: 'answer' },
        },
        { type: 'content_block_stop', index: 1 },
        {
          type: 'content_block_start',
          index: 2,
          content_block: { type: 'tool_use', id: 'call-1', name: 'read' },
        },
        {
          type: 'content_block_delta',
          index: 2,
          delta: { type: 'input_json_delta', partial_json: '{"path":"a"}' },
        },
        { type: 'content_block_stop', index: 2 },
        {
          type: 'message_delta',
          delta: { stop_reason: 'tool_use' },
          usage: {
            input_tokens: 7,
            output_tokens: 5,
            cache_read_input_tokens: 3,
            cache_creation_input_tokens: 4,
          },
        },
      ])
    },
  })

  const chunks = await collect(
    provider.stream({
      ...providerRequest(),
      maxOutputTokens: 17,
      toolChoice: { name: 'read' },
    }),
  )
  assert.equal(requestBody?.max_tokens, 17)
  assert.deepEqual(requestBody?.tool_choice, { type: 'tool', name: 'read' })
  assert.deepEqual(
    chunks.map((chunk) => chunk.type),
    [
      'message_start',
      'reasoning_start',
      'reasoning_delta',
      'reasoning_end',
      'text_start',
      'text_delta',
      'text_end',
      'tool_call_start',
      'tool_call_delta',
      'tool_call_end',
      'completed',
    ],
  )
  assert.deepEqual(chunks.at(-1), {
    type: 'completed',
    stopReason: 'tool_use',
    usage: {
      inputTokens: 7,
      outputTokens: 5,
      cacheReadTokens: 3,
      cacheWriteTokens: 4,
    },
  })
})

test('Anthropic Messages honors a selected model catalog output ceiling', async () => {
  let requestBody: Record<string, unknown> | undefined
  const provider = new AnthropicProvider({
    apiKey: 'test',
    fetch: async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return sseResponse([
        {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { output_tokens: 1 },
        },
      ])
    },
  })

  await collect(provider.stream({ ...providerRequest(), maxOutputTokens: 128_000 }))

  assert.equal(requestBody?.max_tokens, 128_000)
})

test('OpenAI Responses maps output and usage to the same Provider v2 contract', async () => {
  let requestBody: Record<string, unknown> | undefined
  const provider = new OpenAIResponsesProvider({
    apiKey: 'test',
    fetch: async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return sseResponse([
        { type: 'response.output_text.delta', output_index: 0, delta: 'hello' },
        {
          type: 'response.completed',
          response: { usage: { input_tokens: 3, output_tokens: 2 } },
        },
      ])
    },
  })
  const chunks = await collect(
    provider.stream({
      ...providerRequest(),
      maxOutputTokens: 19,
      toolChoice: { name: 'read' },
      reasoning: { mode: 'default', effort: 'high' },
    }),
  )
  assert.equal(requestBody?.max_output_tokens, 19)
  assert.deepEqual(requestBody?.tool_choice, { type: 'function', name: 'read' })
  assert.deepEqual(requestBody?.reasoning, { effort: 'high' })
  assert.deepEqual(
    chunks.map((chunk) => chunk.type),
    ['message_start', 'text_start', 'text_delta', 'text_end', 'completed'],
  )
  assert.deepEqual(chunks.at(-1), {
    type: 'completed',
    stopReason: 'end_turn',
    usage: { inputTokens: 3, outputTokens: 2, cacheReadTokens: undefined },
  })
})

test('OpenAI Responses standalone compaction returns and replays the canonical opaque window', async () => {
  const bodies: Array<{ url: string; body: Record<string, unknown> }> = []
  const provider = new OpenAIResponsesProvider({
    apiKey: 'test',
    fetch: async (input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      const url = String(input)
      bodies.push({ url, body })
      if (url.endsWith('/v1/responses/compact')) {
        return new Response(
          JSON.stringify({
            output: [
              { type: 'compaction', id: 'cmp-1', encrypted_content: 'opaque-state' },
              { type: 'message', role: 'user', content: 'retained' },
            ],
            usage: { input_tokens: 900, output_tokens: 80 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      return sseResponse([
        { type: 'response.output_text.delta', output_index: 0, delta: 'continued' },
        { type: 'response.completed', response: { usage: { input_tokens: 20, output_tokens: 2 } } },
      ])
    },
  })
  const request = { ...providerRequest(), model: 'gpt-5.2', instructions: 'trusted' }
  const compacted = await provider.compact(request)
  assert.equal(compacted.format, 'openai.responses.compact.v1')
  assert.equal(compacted.items[0]?.type, 'compaction')
  assert.deepEqual(compacted.usage, {
    inputTokens: 900,
    outputTokens: 80,
    cacheReadTokens: undefined,
  })

  await collect(
    provider.stream({
      ...request,
      messages: [{ role: 'user', content: 'next' }],
      nativeContext: {
        schemaVersion: 1,
        provider: 'openai',
        model: 'gpt-5.2',
        format: compacted.format,
        items: compacted.items,
        messageStart: 0,
        messageEnd: 1,
        sourceDigest: `sha256:${'a'.repeat(64)}`,
        instructionsDigest: `sha256:${'b'.repeat(64)}`,
        estimatedTokens: 100,
        createdAt: new Date(0).toISOString(),
      },
    }),
  )

  assert.match(bodies[0]!.url, /\/v1\/responses\/compact$/)
  assert.deepEqual((bodies[1]!.body.input as unknown[]).slice(0, 2), compacted.items)
  assert.equal(((bodies[1]!.body.input as unknown[])[2] as { role?: string }).role, 'user')
})

test('provider conversion preserves reasoning and citation content with explicit markers', () => {
  const converted = providerContentText([
    { type: 'text', text: 'answer' },
    { type: 'reasoning', text: 'because' },
    {
      type: 'citation',
      title: 'source',
      url: 'https://example.test/source',
      startIndex: 3,
      endIndex: 9,
    },
  ])

  assert.match(converted, /answer/)
  assert.match(converted, /\[reasoning\]\nbecause\n\[\/reasoning\]/)
  assert.match(converted, /\[citation\]/)
  assert.match(converted, /https:\/\/example\.test\/source/)
  assert.match(converted, /"startIndex":3/)
  assert.equal(
    providerContentText([
      { type: 'text', text: 'adjacent' },
      { type: 'text', text: ' text' },
    ]),
    'adjacent text',
  )
})

test('provider conversion rejects unresolved binary references with exact block types', () => {
  assert.throws(
    () =>
      providerContentText([
        { type: 'image_ref', artifactId: 'image-1' },
        { type: 'audio_ref', artifactId: 'audio-1', transcript: 'spoken words' },
      ]),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'PROVIDER_CAPABILITY_UNSUPPORTED')
      assert.deepEqual(
        (error as { data?: { unsupportedBlocks?: unknown } }).data?.unsupportedBlocks,
        ['audio_ref', 'image_ref'],
      )
      return true
    },
  )
})

test('built-in HTTP adapters advertise only end-to-end rich-content capabilities', () => {
  const anthropic = new AnthropicProvider({ apiKey: 'test' })
  const openai = new OpenAIResponsesProvider({ apiKey: 'test' })

  assert.equal(anthropic.capabilities.modalities.vision, false)
  assert.equal(anthropic.capabilities.output.citations, false)
  assert.equal(openai.capabilities.modalities.vision, false)
  assert.equal(openai.capabilities.output.citations, false)
})

test('Qwen Token Plan and MiniMax register explicit global and China providers', () => {
  const qwen = createQwenTokenPlanProviders({
    QWEN_TOKEN_PLAN_API_KEY: 'global-qwen',
    QWEN_TOKEN_PLAN_CN_API_KEY: 'china-qwen',
  })
  const minimax = createMiniMaxProviders({
    MINIMAX_API_KEY: 'global-minimax',
    MINIMAX_CN_API_KEY: 'china-minimax',
  })

  assert.deepEqual(
    qwen.map(({ id, defaultModel }) => ({ id, defaultModel })),
    [
      { id: 'qwen-token-plan', defaultModel: 'qwen3.7-max' },
      { id: 'qwen-token-plan-cn', defaultModel: 'qwen3.7-max' },
    ],
  )
  assert.deepEqual(
    minimax.map(({ id, defaultModel }) => ({ id, defaultModel })),
    [
      { id: 'minimax', defaultModel: 'MiniMax-M2.7' },
      { id: 'minimax-cn', defaultModel: 'MiniMax-M2.7' },
    ],
  )
  assert.ok(
    [...qwen, ...minimax].every((provider) => provider.authState().status === 'authenticated'),
  )
  assert.equal(qwen[0]?.capabilities?.modalities.vision, false)
  assert.equal(minimax[0]?.capabilities?.modalities.vision, false)
})

test('Qwen-compatible request bodies disable unselected thinking and omit empty tools', () => {
  const body = openAICompatibleRequestBody(
    { ...providerRequest(), tools: [] },
    { enable_thinking: false },
  )

  assert.equal(body.enable_thinking, false)
  assert.equal('tools' in body, false)
})

test('OpenAI-compatible requests can require one named structured-output Tool', () => {
  const body = openAICompatibleRequestBody({
    ...providerRequest(),
    toolChoice: { name: 'read' },
  })
  assert.deepEqual(body.tool_choice, { type: 'function', function: { name: 'read' } })
})

test('OpenAI-compatible schemas add explicit types required by strict vendors', () => {
  assert.deepEqual(
    openAICompatibleJsonSchema({
      type: 'object',
      properties: {
        workspace: { enum: ['none', 'read', 'write'] },
        reasons: { type: 'array', items: { enum: ['MULTI_DOMAIN'] } },
      },
    }),
    {
      type: 'object',
      properties: {
        workspace: { enum: ['none', 'read', 'write'], type: 'string' },
        reasons: {
          type: 'array',
          items: { enum: ['MULTI_DOMAIN'], type: 'string' },
        },
      },
    },
  )
})

test('Kimi disables thinking only for explicitly compact K2.5/K2.6 requests', () => {
  assert.deepEqual(kimiReasoningBody({ model: 'kimi-k2.6', reasoning: { mode: 'compact' } }), {
    thinking: { type: 'disabled' },
  })
  assert.deepEqual(kimiReasoningBody({ model: 'kimi-k3', reasoning: { mode: 'compact' } }), {})
  assert.deepEqual(kimiReasoningBody({ model: 'kimi-k2.6' }), {})
})

test('DeepSeek V4 maps neutral reasoning hints to its thinking contract', () => {
  assert.deepEqual(deepSeekReasoningBody({ reasoning: { mode: 'default', effort: 'high' } }), {
    thinking: { type: 'enabled' },
    reasoning_effort: 'high',
  })
  assert.deepEqual(deepSeekReasoningBody({ reasoning: { mode: 'compact' } }), {
    thinking: { type: 'disabled' },
  })
  assert.deepEqual(
    deepSeekReasoningBody({
      reasoning: { mode: 'default', effort: 'high' },
      toolChoice: { name: 'submit_plan' },
    }),
    { thinking: { type: 'disabled' } },
  )
})

test('DeepSeek thinking Tool history replays reasoning_content and non-null content', async () => {
  const provider = new DeepSeekProvider('fixture-key')
  let requestBody: Record<string, unknown> | undefined
  Reflect.set(provider, 'client', {
    chat: {
      completions: {
        create: async (body: Record<string, unknown>) => {
          requestBody = body
          return {
            async *[Symbol.asyncIterator]() {
              yield {
                choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                usage: { prompt_tokens: 8, completion_tokens: 1 },
              }
            },
          }
        },
      },
    },
  })

  await collect(
    provider.stream({
      ...providerRequest(),
      model: 'deepseek-v4-flash',
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'retained reasoning' },
            { type: 'tool_call', id: 'call-1', name: 'read', input: { path: 'a' } },
          ],
        },
        { role: 'tool', toolCallId: 'call-1', name: 'read', content: 'result' },
      ],
      reasoning: { mode: 'default', effort: 'high' },
    }),
  )

  assert.deepEqual(requestBody?.thinking, { type: 'enabled' })
  assert.equal(requestBody?.reasoning_effort, 'high')
  const messages = requestBody?.messages as Array<Record<string, unknown>>
  assert.equal(messages[0]?.content, '')
  assert.equal(messages[0]?.reasoning_content, 'retained reasoning')
})

test('shipping Provider registry includes DeepSeek and regional Qwen and MiniMax adapters', () => {
  const providers = createBuiltinProviders()
  assert.ok(
    providers.some(
      ({ id, defaultModel }) => id === 'deepseek' && defaultModel === 'deepseek-v4-flash',
    ),
  )
  assert.deepEqual(
    providers
      .map((provider) => provider.id)
      .filter((id) => id.includes('qwen') || id.includes('minimax')),
    ['qwen-token-plan', 'qwen-token-plan-cn', 'minimax', 'minimax-cn'],
  )
})

test('default credential resolution recognizes DeepSeek, Qwen, and MiniMax environment keys', async () => {
  const providers = [
    new DeepSeekProvider(''),
    ...createQwenTokenPlanProviders({}),
    ...createMiniMaxProviders({}),
  ]
  const service = new CredentialService(
    async (id) => providers.find((provider) => provider.id === id),
    {
      environment: {
        DEEPSEEK_API_KEY: 'deepseek-value',
        QWEN_TOKEN_PLAN_API_KEY: 'qwen-value',
        MINIMAX_CN_API_KEY: 'minimax-value',
      },
    },
  )

  assert.equal((await service.resolve('deepseek', 'apiKey')).value, 'deepseek-value')
  assert.equal((await service.resolve('qwen-token-plan', 'apiKey')).value, 'qwen-value')
  assert.equal((await service.resolve('minimax-cn', 'apiKey')).value, 'minimax-value')
})

test('local OpenAI-compatible configuration supports Ollama, LM Studio, and vLLM endpoints', () => {
  const provider = createLocalOpenAICompatibleProvider({
    PRAXIS_OPENAI_COMPATIBLE_URL: 'http://localhost:1234/v1',
    PRAXIS_OPENAI_COMPATIBLE_MODEL: 'local-test',
  })
  assert.equal(provider.id, 'openai-compatible')
  assert.equal(provider.defaultModel, 'local-test')
  assert.equal(provider.authState().status, 'authenticated')
})

test('OpenAI-compatible streams enforce a no-progress timeout between chunks', async () => {
  const provider = new OpenAICompatibleProvider({
    id: 'timeout-fixture',
    apiKey: 'fixture',
    baseURL: 'https://example.invalid/v1',
    defaultModel: 'test',
    timeoutMs: 1_000,
    noProgressTimeoutMs: 25,
  })
  const fakeClient = {
    chat: {
      completions: {
        create: async (_body: unknown, options: { signal: AbortSignal }) => ({
          [Symbol.asyncIterator]() {
            let index = 0
            return {
              next: async () => {
                if (index++ === 0) return { done: false, value: { choices: [] } }
                return await new Promise<never>((_resolve, reject) => {
                  options.signal.addEventListener(
                    'abort',
                    () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
                    { once: true },
                  )
                })
              },
            }
          },
        }),
      },
    },
  }
  Reflect.set(provider, 'client', fakeClient)

  await assert.rejects(collect(provider.stream(providerRequest())), hasCode('PROVIDER_TIMEOUT'))
})

test('OpenAI-compatible clean iterator close after abort remains a timeout', async () => {
  const provider = new OpenAICompatibleProvider({
    id: 'clean-timeout-fixture',
    apiKey: 'fixture',
    baseURL: 'https://example.invalid/v1',
    defaultModel: 'test',
    timeoutMs: 25,
    noProgressTimeoutMs: 1_000,
  })
  const fakeClient = {
    chat: {
      completions: {
        create: async (_body: unknown, options: { signal: AbortSignal }) => ({
          [Symbol.asyncIterator]() {
            return {
              next: async () =>
                await new Promise<{ done: true; value: undefined }>((resolve) => {
                  options.signal.addEventListener(
                    'abort',
                    () => resolve({ done: true, value: undefined }),
                    { once: true },
                  )
                }),
            }
          },
        }),
      },
    },
  }
  Reflect.set(provider, 'client', fakeClient)

  await assert.rejects(collect(provider.stream(providerRequest())), hasCode('PROVIDER_TIMEOUT'))
})

test('router owns backoff, exposes health, and opens then cools down a circuit', async () => {
  let now = 1000
  const sleeps: number[] = []
  const failing: ChatProvider = {
    id: 'failing',
    defaultModel: 'test',
    authState: () => ({ status: 'authenticated' }),
    async *stream() {
      throw runtimeError(
        'PROVIDER_RATE_LIMITED',
        'provider',
        'rate limited',
        { retryAfterMs: 40, rateLimitRemaining: 0 },
        true,
      )
    },
  }
  const router = new ProviderRouter(async () => failing, {
    retryAttempts: 0,
    circuitFailureThreshold: 1,
    circuitCooldownMs: 100,
    clock: () => now,
    random: () => 0,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds)
    },
  })

  await assert.rejects(collect(router.stream('failing', providerRequest())))
  assert.deepEqual(router.health('failing'), {
    state: 'circuit_open',
    consecutiveFailures: 1,
    circuitOpenedAt: new Date(1000).toISOString(),
    rateLimit: { remaining: 0, resetMs: undefined, retryAfterMs: 40 },
  })
  await assert.rejects(
    collect(router.stream('failing', providerRequest())),
    hasCode('PROVIDER_CIRCUIT_OPEN'),
  )
  now += 101
  assert.equal(router.health('failing').state, 'degraded')
  assert.deepEqual(sleeps, [])
})

test('credential precedence is CLI, restrictive store, environment, with refresh support', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-credentials-'))
  try {
    const store = new FileCredentialStore(root)
    const provider: ChatProvider = {
      id: 'openai',
      defaultModel: 'test',
      authState: () => ({ status: 'authenticated' }),
      async *stream() {
        yield { type: 'completed' }
      },
    }
    const service = new CredentialService(async () => provider, {
      store,
      environment: { OPENAI_API_KEY: 'environment-value' },
    })
    assert.deepEqual(await service.resolve('openai', 'apiKey'), {
      value: 'environment-value',
      source: 'environment',
    })
    await service.save('openai', 'apiKey', 'stored-value', new Date(0).toISOString())
    service.registerRefresher('openai', 'apiKey', async () => ({
      value: 'refreshed-value',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    }))
    assert.deepEqual(await service.resolve('openai', 'apiKey'), {
      value: 'refreshed-value',
      source: 'store',
    })
    assert.deepEqual(await service.resolve('openai', 'apiKey', 'cli-value'), {
      value: 'cli-value',
      source: 'cli',
    })
    assert.equal('value' in (await store.list('openai'))[0]!, false)
    assert.equal(
      (await readFile(join(root, 'credentials.json'), 'utf8')).includes('refreshed-value'),
      true,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

function providerRequest() {
  return {
    model: 'test',
    messages: [{ role: 'user' as const, content: 'hello' }],
    tools: [{ name: 'read', description: 'read', parameters: { type: 'object' } }],
    signal: new AbortController().signal,
  }
}

function sseResponse(events: Array<Record<string, unknown>>): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

async function collect(stream: AsyncIterable<ProviderChunk>): Promise<ProviderChunk[]> {
  const chunks: ProviderChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

function hasCode(code: string) {
  return (error: unknown) =>
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code
}
