import type { ProviderChunk, ProviderRequest } from '@praxis/core-sdk'
import { MockProvider } from '../../apps/runtime/src/providers/mockProvider.js'
import { RuntimeKernel } from '../../apps/runtime/src/framework/runtimeKernel.js'

/** Deterministic transport fixture, not a semantic quality benchmark. */
class MemoryProbeProvider extends MockProvider {
  override async *stream(request: ProviderRequest): AsyncIterable<ProviderChunk> {
    if (
      JSON.stringify(request.messages).includes('MEMORY_TOOL_SAVE') &&
      request.messages.at(-1)?.role !== 'tool'
    ) {
      yield {
        type: 'tool_calls',
        calls: [
          {
            id: 'save-memory',
            name: 'memory.upsert',
            input: {
              key: 'user.delivery',
              kind: 'preference',
              content: 'TOOL_APPROVED_MEMORY',
              expectedRevision: 0,
            },
          },
        ],
      }
      yield {
        type: 'completed',
        stopReason: 'tool_calls',
        usage: { inputTokens: 10, outputTokens: 10 },
      }
      return
    }
    const memory = (request.contextMessages ?? []).filter(
      (m) => typeof m.content === 'string' && m.content.includes('kind="long_term_memory"'),
    )
    yield {
      type: 'text_delta',
      text: JSON.stringify({
        memory,
        tools: request.tools.map((t) => t.name),
        last: request.messages.at(-1),
      }),
    }
    yield { type: 'completed', stopReason: 'stop', usage: { inputTokens: 10, outputTokens: 10 } }
  }
}
new RuntimeKernel({ providers: [new MemoryProbeProvider()], replaceProviders: true }).start()
