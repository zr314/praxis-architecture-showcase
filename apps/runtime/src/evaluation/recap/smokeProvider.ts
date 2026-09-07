import type { ProviderChunk, ProviderRequest } from '@praxis/core-sdk'
import { MockProvider } from '../../providers/mockProvider.js'

/** Transport fixture only: never evidence of recall accuracy, learning, or model quality. */
export class RecapSmokeProvider extends MockProvider {
  override async *stream(request: ProviderRequest): AsyncIterable<ProviderChunk> {
    yield { type: 'reasoning_start', contentIndex: 0 }
    yield { type: 'reasoning_delta', contentIndex: 0, text: 'PRIVATE_SMOKE_CANARY' }
    yield { type: 'reasoning_end', contentIndex: 0 }
    const submit = request.tools.find((t) =>
      ['submit_recap', 'select_excerpts', 'submit_compaction_summary'].includes(t.name),
    )
    if (submit) {
      const input =
        submit.name === 'select_excerpts'
          ? { candidateIds: ['c0'] }
          : submit.name === 'submit_recap'
            ? {
                notes: [
                  {
                    kind: 'fact',
                    content: 'LOCAL_CONVENTION was observed in the earlier episode.',
                    applicability: 'same project',
                    invalidation: 'newer evidence',
                    evidenceRefs: ['m0'],
                  },
                ],
              }
            : {
                objective: 'Inspect local convention',
                relevantRefs: [],
                decisions: [],
                constraints: ['LOCAL_CONVENTION'],
                readFiles: ['policy.txt'],
                modifiedFiles: [],
                unresolved: [],
                activePlan: [],
              }
      yield { type: 'tool_calls', calls: [{ id: 'submit', name: submit.name, input }] }
    } else if (request.messages.at(-1)?.role !== 'tool') {
      const target = request.messages.some(
        (m) =>
          typeof m.content === 'string' && m.content.startsWith('Write the transport probe result'),
      )
      yield {
        type: 'tool_calls',
        calls: [
          {
            id: 'probe',
            name: target ? 'write' : 'read',
            input: target
              ? { path: 'answer.json', content: '{"transport":"ok"}' }
              : { path: 'policy.txt' },
          },
        ],
      }
    } else {
      yield {
        type: 'text_delta',
        text: 'LOCAL_CONVENTION observed; newer evidence takes precedence. Transport fixture complete.',
      }
    }
    yield {
      type: 'completed',
      stopReason: submit || request.messages.at(-1)?.role !== 'tool' ? 'tool_calls' : 'stop',
      usage: { inputTokens: 20, outputTokens: 10 },
    }
  }
}
