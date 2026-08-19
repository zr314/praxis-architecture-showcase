import {
  normalizeProviderStopReason,
  type ProviderChunk,
  type ProviderContentBlock,
  type ProviderStopReason,
  type ProviderToolCall,
  type ProviderUsage,
} from './llm.js'

export type ProviderTurnResult = {
  content: ProviderContentBlock[]
  toolCalls: ProviderToolCall[]
  stopReason: ProviderStopReason
  usage?: ProviderUsage
}

export class ProviderStreamProtocolError extends Error {
  readonly code = 'PROVIDER_STREAM_INVALID'

  constructor(message: string) {
    super(message)
    this.name = 'ProviderStreamProtocolError'
  }
}

type TextBlockState = {
  type: 'text' | 'reasoning'
  text: string
  active: boolean
}

type ToolCallState = {
  id: string
  name: string
  argumentsText: string
  active: boolean
}

export class ProviderStreamAccumulator {
  readonly #contentBlocks = new Map<number, TextBlockState>()
  readonly #toolCallStates = new Map<number, ToolCallState>()
  readonly #toolCalls: ProviderToolCall[] = []
  readonly #toolCallIds = new Set<string>()
  #legacyText = ''
  #legacyToolCalls = false
  #messageStarted = false
  #terminal?: { stopReason: ProviderStopReason; usage?: ProviderUsage }

  accept(chunk: ProviderChunk): void {
    if (this.#terminal) {
      throw new ProviderStreamProtocolError(
        `Provider emitted ${chunk.type} after its terminal chunk`,
      )
    }

    switch (chunk.type) {
      case 'message_start':
        if (this.#messageStarted) {
          throw new ProviderStreamProtocolError('Provider emitted message_start more than once')
        }
        this.#messageStarted = true
        return
      case 'text_start':
        this.#startTextBlock(chunk.contentIndex, 'text')
        return
      case 'text_delta':
        if (chunk.contentIndex === undefined) {
          this.#legacyText += chunk.text
          return
        }
        this.#appendTextBlock(chunk.contentIndex, 'text', chunk.text)
        return
      case 'text_end':
        this.#endTextBlock(chunk.contentIndex, 'text')
        return
      case 'reasoning_start':
        this.#startTextBlock(chunk.contentIndex, 'reasoning')
        return
      case 'reasoning_delta':
        this.#appendTextBlock(chunk.contentIndex, 'reasoning', chunk.text)
        return
      case 'reasoning_end':
        this.#endTextBlock(chunk.contentIndex, 'reasoning')
        return
      case 'tool_call_start':
        this.#startToolCall(chunk.index, chunk.id, chunk.name)
        return
      case 'tool_call_delta':
        this.#appendToolCall(chunk.index, chunk.argumentsDelta)
        return
      case 'tool_call_end':
        this.#endToolCall(chunk.index, chunk.input)
        return
      case 'tool_calls':
        this.#legacyToolCalls = true
        for (const call of chunk.calls) this.#addToolCall(call)
        return
      case 'completed':
        this.#terminal = {
          stopReason: normalizeProviderStopReason(chunk.stopReason),
          ...(chunk.usage === undefined ? {} : { usage: validateUsage(chunk.usage) }),
        }
    }
  }

  finish(): ProviderTurnResult {
    const terminal =
      this.#terminal ?? (this.#legacyToolCalls ? { stopReason: 'tool_calls' as const } : undefined)
    if (!terminal) {
      throw new ProviderStreamProtocolError('Provider stream ended without a terminal chunk')
    }

    for (const [contentIndex, block] of this.#contentBlocks) {
      if (block.active) {
        throw new ProviderStreamProtocolError(
          `Provider stream ended while ${block.type} block ${contentIndex} was active`,
        )
      }
    }
    for (const [index, call] of this.#toolCallStates) {
      if (call.active) {
        throw new ProviderStreamProtocolError(
          `Provider stream ended while Tool call ${index} was active`,
        )
      }
    }

    const content: ProviderContentBlock[] = [...this.#contentBlocks.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, block]) => ({ type: block.type, text: block.text }))
    if (this.#legacyText.length > 0) {
      content.push({ type: 'text', text: this.#legacyText })
    }
    content.push(
      ...this.#toolCalls.map(
        ({ id, name, input }): ProviderContentBlock => ({
          type: 'tool_call',
          id,
          name,
          input,
        }),
      ),
    )

    return {
      content,
      toolCalls: this.#toolCalls.map((call) => ({ ...call })),
      stopReason: terminal.stopReason,
      ...(terminal.usage === undefined ? {} : { usage: { ...terminal.usage } }),
    }
  }

  #startTextBlock(contentIndex: number, type: TextBlockState['type']): void {
    assertIndex(contentIndex, 'contentIndex')
    if (this.#contentBlocks.has(contentIndex)) {
      throw new ProviderStreamProtocolError(`Provider reused content index ${contentIndex}`)
    }
    this.#contentBlocks.set(contentIndex, { type, text: '', active: true })
  }

  #appendTextBlock(contentIndex: number, type: TextBlockState['type'], text: string): void {
    const block = this.#activeTextBlock(contentIndex, type)
    block.text += text
  }

  #endTextBlock(contentIndex: number, type: TextBlockState['type']): void {
    const block = this.#activeTextBlock(contentIndex, type)
    block.active = false
  }

  #activeTextBlock(contentIndex: number, type: TextBlockState['type']): TextBlockState {
    const block = this.#contentBlocks.get(contentIndex)
    if (!block?.active) {
      throw new ProviderStreamProtocolError(`Provider ${type} block ${contentIndex} was not active`)
    }
    if (block.type !== type) {
      throw new ProviderStreamProtocolError(
        `Provider content block ${contentIndex} is ${block.type}, not ${type}`,
      )
    }
    return block
  }

  #startToolCall(index: number, id: string, name: string): void {
    assertIndex(index, 'Tool call index')
    if (this.#toolCallStates.has(index)) {
      throw new ProviderStreamProtocolError(`Provider reused Tool call index ${index}`)
    }
    if (this.#toolCallIds.has(id)) {
      throw new ProviderStreamProtocolError(`Provider reused Tool call id ${id}`)
    }
    if (id.length === 0 || name.length === 0) {
      throw new ProviderStreamProtocolError('Provider Tool call id and name must be non-empty')
    }
    this.#toolCallIds.add(id)
    this.#toolCallStates.set(index, {
      id,
      name,
      argumentsText: '',
      active: true,
    })
  }

  #appendToolCall(index: number, delta: string): void {
    const call = this.#toolCallStates.get(index)
    if (!call?.active) {
      throw new ProviderStreamProtocolError(`Provider Tool call ${index} was not active`)
    }
    call.argumentsText += delta
  }

  #endToolCall(index: number, input: unknown): void {
    const call = this.#toolCallStates.get(index)
    if (!call?.active) {
      throw new ProviderStreamProtocolError(`Provider Tool call ${index} was not active`)
    }

    let parsedInput = input
    if (input === undefined) {
      if (call.argumentsText.length === 0) {
        parsedInput = {}
      } else {
        try {
          parsedInput = JSON.parse(call.argumentsText) as unknown
        } catch {
          throw new ProviderStreamProtocolError(
            `Provider Tool call ${index} arguments were not valid JSON`,
          )
        }
      }
    }

    call.active = false
    this.#addToolCall({ id: call.id, name: call.name, input: parsedInput }, true)
  }

  #addToolCall(call: ProviderToolCall, idAlreadyReserved = false): void {
    if (!idAlreadyReserved && this.#toolCallIds.has(call.id)) {
      throw new ProviderStreamProtocolError(`Provider reused Tool call id ${call.id}`)
    }
    if (call.id.length === 0 || call.name.length === 0) {
      throw new ProviderStreamProtocolError('Provider Tool call id and name must be non-empty')
    }
    this.#toolCallIds.add(call.id)
    this.#toolCalls.push({ ...call })
  }
}

function assertIndex(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ProviderStreamProtocolError(`${label} must be a non-negative integer`)
  }
}

function validateUsage(usage: ProviderUsage): ProviderUsage {
  const result: ProviderUsage = {}
  for (const field of [
    'inputTokens',
    'outputTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
    'costUsd',
  ] as const) {
    const value = usage[field]
    if (value === undefined) continue
    if (!Number.isFinite(value) || value < 0) {
      throw new ProviderStreamProtocolError(
        `Provider usage ${field} must be a finite non-negative number`,
      )
    }
    result[field] = value
  }
  return result
}
