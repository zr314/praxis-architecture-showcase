import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import type { PromptInput, SessionExportResult, SessionTranscriptResult } from '@praxis/protocol'
import { render } from 'ink'
import React from 'react'
import { MockRuntimeBridge } from '../apps/cli/src/bridge/mockBridge.js'
import { App } from '../apps/cli/src/ui/App.js'
import { TUI_RENDER_OPTIONS } from '../apps/cli/src/ui/renderOptions.js'
import { NativeTerminalOutput } from '../apps/cli/src/ui/terminalOutput.js'
import { SemanticTerminal, waitForCondition } from '../scripts/support/semantic-terminal.mjs'

test('a resumed TUI renders persisted conversation and starts with follow_up', {
  timeout: 10_000,
}, async () => {
  const stdin = new TestInput()
  const sink = new TestOutput(80, 24)
  const stdout = new NativeTerminalOutput(sink as unknown as NodeJS.WriteStream)
  const bridge = new PersistedBridge()
  const app = render(
    React.createElement(App, {
      bridge,
      session: {
        sessionId: 'persisted-session',
        state: 'idle',
        cwd: 'D:\\praxis',
        provider: 'mock',
        model: 'mock-v1',
        messageCount: 2,
      },
    }),
    {
      ...TUI_RENDER_OPTIONS,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: sink as unknown as NodeJS.WriteStream,
    },
  )

  try {
    await waitForCondition(
      async () => {
        const transcript = await sink.text()
        return transcript.includes('persisted question') && transcript.includes('persisted answer')
      },
      3_000,
      'persisted transcript',
      () => sink.diagnostics(),
    )

    stdin.write('/model mock-v1')
    stdin.write('\u001b[13;5u')
    await waitForCondition(
      () => bridge.configureCalls === 1,
      3_000,
      'same-session model configuration',
      () => sink.diagnostics(),
    )
    assert.equal(
      bridge.transcriptCalls,
      1,
      'same-session metadata changes must not reload the transcript',
    )
    assert.equal(bridge.exportCalls, 0, 'TUI history must not load complete Session exports')

    bridge.triggerRuntimeEpoch()
    await waitForCondition(
      () => bridge.transcriptCalls === 2,
      3_000,
      'durable transcript reload after a Runtime epoch change',
      () => sink.diagnostics(),
    )
    assert.equal(bridge.exportCalls, 0)

    stdin.write('continue from history')
    stdin.write('\u001b[13;5u')
    await waitForCondition(
      () => bridge.followUpCalls === 1,
      3_000,
      'follow-up submission',
      () => sink.diagnostics(),
    )

    assert.equal(bridge.promptCalls, 0)
    assert.equal(bridge.followUpCalls, 1)
  } finally {
    app.unmount()
    stdout.finish()
    await bridge.dispose()
    sink.dispose()
  }
})

class PersistedBridge extends MockRuntimeBridge {
  exportCalls = 0
  transcriptCalls = 0
  configureCalls = 0
  promptCalls = 0
  followUpCalls = 0
  readonly #runtimeEpoch: Promise<void>
  #triggerRuntimeEpoch: (() => void) | undefined

  constructor() {
    super()
    this.#runtimeEpoch = new Promise((resolveEpoch) => {
      this.#triggerRuntimeEpoch = resolveEpoch
    })
  }

  triggerRuntimeEpoch(): void {
    this.#triggerRuntimeEpoch?.()
    this.#triggerRuntimeEpoch = undefined
  }

  override async *events() {
    await this.#runtimeEpoch
    yield { type: 'runtime_ready' as const, runtimeId: 'replacement-runtime' }
  }

  override async exportSession(sessionId: string): Promise<SessionExportResult> {
    this.exportCalls += 1
    return {
      exportVersion: 1,
      exportedAt: new Date(0).toISOString(),
      session: {
        ...(await this.resumeSession(sessionId)),
        messageCount: 2,
      },
      messages: [
        { role: 'user', content: 'persisted question', intent: 'prompt' },
        { role: 'assistant', content: 'persisted answer' },
      ],
      memory: {},
    }
  }

  override async transcriptSession(sessionId: string): Promise<SessionTranscriptResult> {
    this.transcriptCalls += 1
    return {
      sessionId,
      start: 0,
      end: 2,
      totalMessages: 2,
      hasMore: false,
      messages: [
        { role: 'user', content: 'persisted question', intent: 'prompt' },
        { role: 'assistant', content: 'persisted answer' },
      ],
    }
  }

  override prompt(input: PromptInput) {
    this.promptCalls += 1
    return super.prompt(input)
  }

  override followUp(input: PromptInput) {
    this.followUpCalls += 1
    return super.prompt(input)
  }

  override async configureSession(sessionId: string, provider: string, model: string) {
    this.configureCalls += 1
    return super.configureSession(sessionId, provider, model)
  }
}

class TestInput extends PassThrough {
  readonly isTTY = true
  isRaw = false

  setRawMode(mode: boolean): this {
    this.isRaw = mode
    return this
  }

  ref(): this {
    return this
  }

  unref(): this {
    return this
  }
}

class TestOutput extends PassThrough {
  readonly isTTY = true
  readonly #screen: SemanticTerminal

  constructor(
    public columns: number,
    public rows: number,
  ) {
    super()
    this.#screen = new SemanticTerminal(columns, rows)
    this.on('data', (chunk: Buffer) => {
      this.#screen.write(chunk)
    })
  }

  getColorDepth(): number {
    return 24
  }

  hasColors(): boolean {
    return true
  }

  scrollBuffer(): string[] {
    return this.#screen.scrollBufferLines()
  }

  async text(): Promise<string> {
    await this.#screen.viewportText()
    return this.#screen.scrollBufferText()
  }

  diagnostics(): string {
    return this.#screen.diagnostics()
  }

  dispose(): void {
    this.#screen.dispose()
  }
}
