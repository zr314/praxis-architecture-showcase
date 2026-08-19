import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import type { PromptInput, SessionEvent } from '@praxis/protocol'
import { render } from 'ink'
import React from 'react'
import { MockRuntimeBridge } from '../apps/cli/src/bridge/mockBridge.js'
import { App } from '../apps/cli/src/ui/App.js'
import { TUI_RENDER_OPTIONS } from '../apps/cli/src/ui/renderOptions.js'
import { NativeTerminalOutput } from '../apps/cli/src/ui/terminalOutput.js'
import { SemanticTerminal, waitForCondition } from '../scripts/support/semantic-terminal.mjs'

test('active-run inputs stay ordered and a completion race becomes follow_up', {
  timeout: 12_000,
}, async () => {
  const stdin = new TestInput()
  const sink = new TestOutput(80, 24)
  const stdout = new NativeTerminalOutput(sink as unknown as NodeJS.WriteStream)
  const bridge = new SteerRaceBridge()
  const app = render(
    React.createElement(App, {
      bridge,
      session: {
        sessionId: 'steer-session',
        state: 'idle',
        cwd: 'D:\\praxis',
        provider: 'mock',
        model: 'mock-v1',
      },
    }),
    {
      ...TUI_RENDER_OPTIONS,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: sink as unknown as NodeJS.WriteStream,
    },
  )

  const bridgeDiagnostics = () =>
    `steer=${JSON.stringify(bridge.steerTexts)}, runIds=${JSON.stringify(bridge.steerRunIds)}, followUp=${JSON.stringify(bridge.followUpTexts)}; ${sink.diagnostics()}`
  try {
    submit(stdin, 'initial request')
    await waitForCondition(
      async () => {
        const screen = await sink.viewportText()
        return screen.includes('RUNNING') && screen.includes('INPUT ACTIVE')
      },
      3_000,
      'active-run input',
      () => sink.diagnostics(),
    )
    assert.equal(bridge.promptStartedConsumed, true)
    submit(stdin, 'first correction')
    submit(stdin, 'second correction')
    submit(stdin, 'after completion')
    submit(stdin, 'fourth correction')
    await waitForCondition(
      () =>
        bridge.steerTexts.length === 4 &&
        bridge.steerRunIds[3] === 'follow-up-run' &&
        bridge.followUpTexts.length === 1 &&
        bridge.followUpStartedConsumed,
      3_000,
      'ordered steer delivery across the replacement-run handoff',
      bridgeDiagnostics,
    )

    assert.deepEqual(bridge.steerTexts, [
      'first correction',
      'second correction',
      'after completion',
      'fourth correction',
    ])
    assert.equal(bridge.steerRunIds[3], 'follow-up-run')
    assert.deepEqual(bridge.followUpTexts, ['after completion'])

    bridge.releaseInitialPrompt()
    await waitForCondition(
      () => bridge.initialPromptFinished,
      2_000,
      'the superseded prompt terminal event',
      bridgeDiagnostics,
    )
    const activeScreen = await sink.viewportText()
    submit(stdin, 'fifth correction')
    await waitForCondition(
      () => bridge.steerTexts.length === 5,
      2_000,
      'steering after the superseded prompt settles',
      bridgeDiagnostics,
    )

    assert.match(activeScreen, /RUNNING/u)
    assert.match(activeScreen, /INPUT ACTIVE/u)
    assert.deepEqual(bridge.steerTexts, [
      'first correction',
      'second correction',
      'after completion',
      'fourth correction',
      'fifth correction',
    ])
    assert.equal(bridge.steerRunIds[3], 'follow-up-run')
    assert.equal(bridge.steerRunIds[4], 'follow-up-run')
    assert.deepEqual(bridge.followUpTexts, ['after completion'])

    bridge.releaseFollowUp()
    await waitForCondition(
      () => bridge.followUpCompletedConsumed,
      2_000,
      'replacement follow-up completion',
      bridgeDiagnostics,
    )
  } finally {
    bridge.releaseInitialPrompt()
    bridge.releaseFollowUp()
    app.unmount()
    stdout.finish()
    await bridge.dispose()
    sink.dispose()
  }
})

class SteerRaceBridge extends MockRuntimeBridge {
  readonly steerTexts: string[] = []
  readonly steerRunIds: string[] = []
  readonly followUpTexts: string[] = []
  promptStartedConsumed = false
  initialPromptFinished = false
  followUpStartedConsumed = false
  followUpCompletedConsumed = false
  readonly #initialPromptGate: Promise<void>
  readonly #followUpGate: Promise<void>
  #releaseInitialPrompt: (() => void) | undefined
  #releaseFollowUp: (() => void) | undefined

  constructor() {
    super()
    this.#initialPromptGate = new Promise((resolveInitialPrompt) => {
      this.#releaseInitialPrompt = resolveInitialPrompt
    })
    this.#followUpGate = new Promise((resolveFollowUp) => {
      this.#releaseFollowUp = resolveFollowUp
    })
  }

  releaseInitialPrompt(): void {
    this.#releaseInitialPrompt?.()
    this.#releaseInitialPrompt = undefined
  }

  releaseFollowUp(): void {
    this.#releaseFollowUp?.()
    this.#releaseFollowUp = undefined
  }

  override async *prompt(input: PromptInput): AsyncIterable<SessionEvent> {
    yield {
      type: 'prompt_started',
      sessionId: input.sessionId,
      runId: 'active-run',
      prompt: input.text,
      promptKind: 'prompt',
    }
    this.promptStartedConsumed = true
    await this.#initialPromptGate
    yield { type: 'prompt_completed', runId: 'active-run' }
    this.initialPromptFinished = true
  }

  override async steer(input: {
    sessionId: string
    runId: string
    text: string
  }): Promise<{ accepted: boolean; applyAt: 'next_safe_boundary' }> {
    this.steerTexts.push(input.text)
    this.steerRunIds.push(input.runId)
    if (
      input.runId === 'active-run' &&
      (input.text === 'after completion' || input.text === 'fourth correction')
    ) {
      throw { rpc: { code: 'RUN_NOT_ACTIVE', message: 'Run already ended.' } }
    }
    return { accepted: true, applyAt: 'next_safe_boundary' }
  }

  override async *followUp(input: PromptInput): AsyncIterable<SessionEvent> {
    this.followUpTexts.push(input.text)
    yield {
      type: 'prompt_started',
      sessionId: input.sessionId,
      runId: 'follow-up-run',
      prompt: input.text,
      promptKind: 'follow_up',
    }
    this.followUpStartedConsumed = true
    await this.#followUpGate
    yield { type: 'text_delta', runId: 'follow-up-run', text: 'continued safely' }
    yield { type: 'prompt_completed', runId: 'follow-up-run' }
    this.followUpCompletedConsumed = true
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
    this.on('data', (chunk: Buffer) => this.#screen.write(chunk))
  }

  getColorDepth(): number {
    return 24
  }

  hasColors(): boolean {
    return true
  }

  viewportText(): Promise<string> {
    return this.#screen.viewportText()
  }

  diagnostics(): string {
    return this.#screen.diagnostics()
  }

  dispose(): void {
    this.#screen.dispose()
  }
}

function submit(stdin: TestInput, text: string): void {
  stdin.write(text)
  stdin.write('\u001b[13;5u')
}
