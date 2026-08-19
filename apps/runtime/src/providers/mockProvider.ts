import { providerContentText } from './contentConversion.js'
import type { ChatProvider, ProviderCapabilities, ProviderChunk, ProviderRequest } from './types.js'

const capabilities: ProviderCapabilities = {
  streaming: { text: true, reasoning: false, usage: true },
  tools: { mode: 'native', parallelCalls: false },
  modalities: { text: true, vision: false, audio: false },
  output: { jsonSchema: false, citations: false },
  limits: {},
}

export class MockProvider implements ChatProvider {
  readonly id = 'mock'
  readonly defaultModel = 'mock-v1'
  readonly capabilities = capabilities

  authState() {
    return { status: 'authenticated' as const, accountLabel: 'Mock Provider' }
  }

  async *stream(request: ProviderRequest): AsyncIterable<ProviderChunk> {
    if (request.tools.some((tool) => tool.name === 'submit_supervisor_plan')) {
      const proposal = JSON.stringify({
        objective: 'Execute the requested Supervisor smoke test.',
        steps: [
          {
            key: 'inspect',
            title: 'Inspect the requested scope',
            access: { mode: 'read_only', paths: ['.'] },
            capabilities: [],
            criteria: [
              { kind: 'schema', description: 'Child result matches the admitted schema.' },
            ],
          },
          {
            key: 'verify',
            title: 'Independently verify the result',
            dependencies: ['inspect'],
            access: { mode: 'read_only', paths: ['.'] },
            capabilities: [],
            criteria: [
              { kind: 'schema', description: 'Child result matches the admitted schema.' },
            ],
          },
        ],
      })
      yield {
        type: 'tool_call_start',
        index: 0,
        id: 'mock-supervisor-plan',
        name: 'submit_supervisor_plan',
      }
      yield { type: 'tool_call_delta', index: 0, argumentsDelta: proposal }
      yield { type: 'tool_call_end', index: 0 }
      yield {
        type: 'completed',
        stopReason: 'tool_calls',
        usage: { inputTokens: 0, outputTokens: 0 },
      }
      return
    }

    const latest = request.messages.at(-1)
    const packet = contextPacketFromMessages(request)
    const resultSubmissionAvailable = request.tools.some(
      ({ name }) => name === 'praxis_submit_child_result',
    )
    if (
      packet !== undefined &&
      ((typeof request.toolChoice === 'object' &&
        request.toolChoice.name === 'praxis_submit_child_result') ||
        (resultSubmissionAvailable && latest?.role === 'tool'))
    ) {
      const summary =
        latest?.role === 'tool'
          ? `Tool ${latest.name} completed. Result: ${providerContentText(latest.content)}`
          : 'Praxis child Runtime completed the admitted Mock Provider step.'
      yield {
        type: 'tool_calls',
        calls: [
          {
            id: 'mock-child-result',
            name: 'praxis_submit_child_result',
            input: structuredChildResultValue(packet, summary),
          },
        ],
      }
      yield {
        type: 'completed',
        stopReason: 'tool_calls',
        usage: { inputTokens: 0, outputTokens: 0 },
      }
      return
    }

    if (latest?.role === 'user') {
      const prompt = providerContentText(latest.content)
      const toolCall =
        parseMockToolCall(prompt) ?? parseMockToolCall(contextPacketInstructions(prompt))
      if (toolCall) {
        yield { type: 'tool_calls', calls: [toolCall] }
        yield {
          type: 'completed',
          stopReason: 'tool_calls',
          usage: { inputTokens: 0, outputTokens: 0 },
        }
        return
      }
      if (packet !== undefined && resultSubmissionAvailable) {
        yield {
          type: 'tool_calls',
          calls: [
            {
              id: 'mock-child-result',
              name: 'praxis_submit_child_result',
              input: structuredChildResultValue(
                packet,
                'Praxis child Runtime completed the admitted Mock Provider step.',
              ),
            },
          ],
        }
        yield {
          type: 'completed',
          stopReason: 'tool_calls',
          usage: { inputTokens: 0, outputTokens: 0 },
        }
        return
      }
    }

    if (latest?.role === 'tool') {
      const summary = `Tool ${latest.name} completed. Result: ${providerContentText(latest.content)}`
      const chunks = packet === undefined ? [summary] : [structuredChildResult(packet, summary)]
      for (const text of chunks) {
        await delay(45, request.signal)
        yield { type: 'text_delta', text }
      }
      yield {
        type: 'completed',
        stopReason: 'end_turn',
        usage: { inputTokens: 0, outputTokens: 0 },
      }
      return
    }

    const prompt = latest ? providerContentText(latest.content) : ''
    const chunks =
      packet === undefined
        ? [
            'Praxis Runtime has accepted this request. ',
            'This response comes from the deterministic Mock Provider. ',
            `Conversation turns: ${request.messages.length}. `,
            `Latest prompt: ${prompt}`,
          ]
        : [
            structuredChildResult(
              packet,
              'Praxis child Runtime completed the admitted Mock Provider step.',
            ),
          ]
    for (const text of chunks) {
      await delay(45, request.signal)
      yield { type: 'text_delta', text }
    }
    yield {
      type: 'completed',
      stopReason: 'end_turn',
      usage: { inputTokens: 0, outputTokens: 0 },
    }
  }
}

type MockContextPacket = Readonly<{
  instructions: string
  criteria: readonly Readonly<{ id: string; description: string }>[]
  outputSchema?: Readonly<Record<string, unknown>>
}>

function contextPacketFromMessages(request: ProviderRequest): MockContextPacket | undefined {
  for (let index = request.messages.length - 1; index >= 0; index -= 1) {
    const message = request.messages[index]
    if (message?.role !== 'user') continue
    const packet = parseContextPacket(providerContentText(message.content))
    if (packet !== undefined) return packet
  }
  return undefined
}

function contextPacketInstructions(prompt: string): string {
  return parseContextPacket(prompt)?.instructions ?? ''
}

function parseContextPacket(prompt: string): MockContextPacket | undefined {
  const match =
    /--- PRAXIS_CONTEXT_PACKET_V1 ---\n([\s\S]*?)\n--- END_PRAXIS_CONTEXT_PACKET_V1 ---/u.exec(
      prompt,
    )
  if (!match?.[1]) return undefined
  try {
    const packet: unknown = JSON.parse(match[1])
    if (
      !isRecord(packet) ||
      !isRecord(packet.step) ||
      typeof packet.step.instructions !== 'string' ||
      !Array.isArray(packet.successCriteria)
    ) {
      return undefined
    }
    const criteria = packet.successCriteria.flatMap((candidate) =>
      isRecord(candidate) &&
      typeof candidate.id === 'string' &&
      typeof candidate.description === 'string'
        ? [{ id: candidate.id, description: candidate.description }]
        : [],
    )
    if (criteria.length !== packet.successCriteria.length || criteria.length === 0) return undefined
    return {
      instructions: packet.step.instructions,
      criteria,
      ...(isRecord(packet.outputSchema) && isRecord(packet.outputSchema.schema)
        ? { outputSchema: packet.outputSchema.schema }
        : {}),
    }
  } catch {
    return undefined
  }
}

function structuredChildResult(packet: MockContextPacket, summary: string): string {
  return JSON.stringify(structuredChildResultValue(packet, summary))
}

function structuredChildResultValue(
  packet: MockContextPacket,
  summary: string,
): Record<string, unknown> {
  const value: Record<string, unknown> = {
    summary,
    criteria: packet.criteria.map((criterion) => ({
      id: criterion.id,
      status: 'passed',
      summary: criterion.description,
    })),
  }
  const properties = isRecord(packet.outputSchema?.properties)
    ? packet.outputSchema.properties
    : undefined
  if (properties !== undefined && Object.hasOwn(properties, 'result')) {
    value.result = mockSchemaValue(properties.result, summary)
  }
  return value
}

function mockSchemaValue(schema: unknown, summary: string): unknown {
  if (!isRecord(schema)) return null
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0]
  if (schema.type === 'string') return summary
  if (schema.type === 'number' || schema.type === 'integer') return 0
  if (schema.type === 'boolean') return true
  if (schema.type === 'array') return []
  if (schema.type === 'object' || isRecord(schema.properties)) {
    const properties = isRecord(schema.properties) ? schema.properties : {}
    const required = Array.isArray(schema.required)
      ? schema.required.filter((item): item is string => typeof item === 'string')
      : []
    return Object.fromEntries(
      required.map((name) => [name, mockSchemaValue(properties[name], summary)]),
    )
  }
  return null
}

function parseMockToolCall(
  prompt: string,
): { id: string; name: string; input: unknown } | undefined {
  const match = /^tool:([A-Za-z0-9_]{1,128})\s+(.+)$/s.exec(prompt.trim())
  if (!match) return undefined
  try {
    return { id: 'mock-tool-1', name: match[1], input: JSON.parse(match[2]) }
  } catch {
    return { id: 'mock-tool-1', name: match[1], input: {} }
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, ms)
    const abort = () => {
      clearTimeout(timeout)
      reject(new Error('Provider request aborted.'))
    }
    signal.addEventListener('abort', abort, { once: true })
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
