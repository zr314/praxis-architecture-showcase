import type { ProviderChunk, ProviderRequest } from '@praxis/core-sdk'
import { RuntimeKernel } from '../../apps/runtime/src/framework/runtimeKernel.js'
import { MockProvider } from '../../apps/runtime/src/providers/mockProvider.js'
import { ReadTool } from '../../apps/runtime/src/tools/readTool.js'

class LongProbe extends MockProvider {
  override async *stream(request: ProviderRequest): AsyncIterable<ProviderChunk> {
    const count = request.messages.filter((m) => m.role === 'tool').length
    if (
      request.messages.some(
        (m) => typeof m.content === 'string' && m.content.includes('Plan probe'),
      )
    ) {
      if (!request.tools.some((t) => t.name === 'plan.create'))
        throw new Error('Plan tools missing')
      if (count < 2)
        yield {
          type: 'tool_calls',
          calls: [
            {
              id: `plan-${count}`,
              name: count === 0 ? 'plan.create' : 'plan.progress',
              input:
                count === 0
                  ? { objective: 'Read and verify', items: [{ id: 'verify', title: 'Verify' }] }
                  : { itemId: 'verify', status: 'done' },
            },
          ],
        }
      else {
        if (!JSON.stringify(request.contextMessages).includes('working_plan'))
          throw new Error('Durable Plan context missing')
        yield { type: 'text_delta', text: 'Plan retained.' }
      }
      yield {
        type: 'completed',
        stopReason: count < 2 ? 'tool_calls' : 'stop',
        usage: { inputTokens: 10, outputTokens: 10 },
      }
      return
    }
    if (count < 20) {
      yield {
        type: 'tool_calls',
        calls: [{ id: `probe-${count}`, name: 'read', input: { path: 'input.txt' } }],
      }
    } else {
      yield { type: 'text_delta', text: 'Twenty calls completed.' }
    }
    yield {
      type: 'completed',
      stopReason: count < 20 ? 'tool_calls' : 'stop',
      usage: { inputTokens: 10, outputTokens: 10 },
    }
  }
}
new RuntimeKernel({
  unbudgetedSoloRuns: true,
  memoryService: false,
  providers: [new LongProbe()],
  replaceProviders: true,
  tools: [new ReadTool()],
}).start()
