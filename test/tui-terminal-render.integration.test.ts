import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { render } from 'ink'
import React from 'react'
import { MockRuntimeBridge } from '../apps/cli/src/bridge/mockBridge.js'
import { App } from '../apps/cli/src/ui/App.js'
import { Composer } from '../apps/cli/src/ui/Composer.js'
import { TUI_RENDER_OPTIONS } from '../apps/cli/src/ui/renderOptions.js'
import { NativeTerminalOutput } from '../apps/cli/src/ui/terminalOutput.js'
import { SemanticTerminal, waitForCondition } from '../scripts/support/semantic-terminal.mjs'

test('narrow xterm edit previews materialize tabs before Ink rendering', async () => {
  const stdin = new TestInput()
  const sink = new TestOutput(32, 12)
  const stdout = new NativeTerminalOutput(sink as unknown as NodeJS.WriteStream)
  const app = render(
    React.createElement(Composer, {
      input: '',
      cursorIndex: 0,
      isRunning: true,
      pendingPermission: {
        type: 'permission_request',
        runId: 'tab-preview',
        requestId: 'tab-preview-permission',
        toolCallId: 'tab-preview-tool',
        tool: 'edit',
        input: {
          oldText: 'before\tbefore\tbefore\tbefore',
          newText: 'after\tafter\tafter\tafter',
        },
        risk: 'high',
      },
      keybindings: { submit: 'enter', newline: 'shift-enter', externalEditor: 'ctrl-e' },
      spinner: 'working',
      compact: false,
      commandSelection: 0,
      editorColumns: 32,
      editorRows: 4,
    }),
    {
      ...TUI_RENDER_OPTIONS,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: sink as unknown as NodeJS.WriteStream,
    },
  )

  try {
    await waitForScreen(
      sink,
      (screen) => screen.includes('AUTHORIZATION') && screen.includes('REQUIRED'),
    )
    const viewport = await sink.viewport()
    assert.ok(sink.writes.every((write) => !write.includes('\t')))
    assert.ok(
      viewport.every((line) => [...line].length <= 32),
      viewport.join('\n'),
    )
  } finally {
    const exited = app.waitUntilExit()
    app.unmount()
    await exited
    stdout.finish()
    sink.dispose()
  }
})

test('narrow xterm write previews sanitize and bound whole-file content', async () => {
  for (const columns of [32, 48]) {
    const stdin = new TestInput()
    const sink = new TestOutput(columns, 12)
    const stdout = new NativeTerminalOutput(sink as unknown as NodeJS.WriteStream)
    const app = render(
      React.createElement(Composer, {
        input: '',
        cursorIndex: 0,
        isRunning: true,
        pendingPermission: {
          type: 'permission_request',
          runId: `write-preview-${columns}`,
          requestId: `write-preview-permission-${columns}`,
          toolCallId: `write-preview-tool-${columns}`,
          tool: 'write',
          input: {
            content: 'first\u001b[31m\tfirst\tfirst\nsecond\tsecond\tsecond',
            createOnly: true,
          },
          risk: 'high',
        },
        keybindings: { submit: 'enter', newline: 'shift-enter', externalEditor: 'ctrl-e' },
        spinner: 'working',
        compact: false,
        commandSelection: 0,
        editorColumns: columns,
        editorRows: 4,
      }),
      {
        ...TUI_RENDER_OPTIONS,
        stdin: stdin as unknown as NodeJS.ReadStream,
        stdout: stdout as unknown as NodeJS.WriteStream,
        stderr: sink as unknown as NodeJS.WriteStream,
      },
    )

    try {
      await waitForScreen(
        sink,
        (screen) => screen.includes('AUTHORIZATION') && screen.includes('REQUIRED'),
      )
      const viewport = await sink.viewport()
      assert.ok(sink.writes.every((write) => !write.includes('\t')))
      assert.match(viewport.join('\n'), /\uFFFD\[31m/u)
      assert.ok(
        viewport.every((line) => [...line].length <= columns),
        viewport.join('\n'),
      )
    } finally {
      const exited = app.waitUntilExit()
      app.unmount()
      await exited
      stdout.finish()
      sink.dispose()
    }
  }
})

test('animated Windows-sized renders keep a bounded visible window without duplicate steer frames', {
  timeout: 10_000,
}, async () => {
  const stdin = new TestInput()
  const sink = new TestOutput(80, 24)
  const stdout = new NativeTerminalOutput(sink as unknown as NodeJS.WriteStream)
  const bridge = new MockRuntimeBridge()
  const app = render(
    React.createElement(App, {
      bridge,
      session: {
        sessionId: 'terminal-render',
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
  let unmounted = false

  try {
    await waitForScreen(sink, (screen) => screen.includes('INPUT ACTIVE'))
    stdin.write('render audit')
    stdin.write('\u001b[13;5u')
    await waitForCondition(
      async () => linesContaining(await sink.viewport(), 'STEER') === 1,
      3_000,
      'running steer frame',
      () => sink.diagnostics(),
    )

    let viewport = await sink.viewport()
    assert.equal(linesContaining(viewport, 'STEER'), 1, viewport.join('\n'))
    assert.equal(
      linesContaining(sink.scrollBuffer(), 'Send a correction'),
      1,
      sink.scrollBuffer().join('\n'),
    )
    assert.ok(sink.writes.every((write) => !write.includes('\u001b[?1000h')))
    assert.ok(sink.writes.every((write) => !write.includes('\u001b[?1006h')))
    assert.ok(sink.writes.every((write) => !write.includes('\u001b[?1049h')))

    stdin.write('keep the result concise')
    stdin.write('\u001b[13;5u')
    await waitForScreen(
      sink,
      (screen) =>
        /render audit/u.test(screen) &&
        /Done/u.test(screen) &&
        screen.includes('PROMPT') &&
        !screen.includes('STEER'),
      'completed first prompt',
    )

    viewport = await sink.viewport()
    const screen = viewport.join('\n')
    assert.match(screen, /› render audit/)
    assert.match(screen, /✓ Done/)
    assert.doesNotMatch(screen, /RUN LOG|LIVE \/\s*\d+ EVENTS/)
    assert.equal(linesContaining(sink.scrollBuffer(), 'Send a correction'), 0)
    assert.ok(
      sink.writes.some(hasCursorMovement),
      'animated updates should use cursor-addressed differential writes',
    )
    assert.ok(
      sink.writes.slice(1).every((write) => !write.includes('\u001b[2J')),
      'animated updates must not clear and repaint the terminal',
    )

    for (const prompt of [
      'second request',
      'third request',
      'fourth request',
      'fifth request',
      'sixth request',
      'seventh request',
      'eighth request',
    ]) {
      stdin.write(prompt)
      stdin.write('\u001b[13;5u')
      await waitForScreen(
        sink,
        (screen) =>
          screen.includes(prompt) &&
          /Done/u.test(screen) &&
          screen.includes('PROMPT') &&
          !screen.includes('STEER'),
        `completed ${prompt}`,
      )
    }
    viewport = await sink.viewport()
    assert.match(viewport.join('\n'), /eighth request/)
    assert.ok(sink.baseY() > 0)
    assert.match(sink.scrollBuffer().join('\n'), /render audit/)
    assert.match(sink.scrollBuffer().join('\n'), /eighth request/)
    assert.equal(linesContaining(viewport, 'PROMPT'), 1, viewport.join('\n'))
    assert.ok(
      sink.writes.slice(1).every((write) => !write.includes('\u001b[2J')),
      'long-session state changes must not clear native scrollback',
    )

    const wideWriteCount = sink.writes.length
    sink.resize(120, 36)
    await waitForCondition(
      () => sink.writes.length > wideWriteCount,
      2_000,
      'wide terminal resize render',
      () => sink.diagnostics(),
    )
    viewport = await sink.viewport()
    assert.equal(
      linesContaining(sink.scrollBuffer(), 'PRAXIS'),
      1,
      `${viewport.join('\n')}\nWRITES ${JSON.stringify(sink.writes.slice(-5))}`,
    )
    assert.match(viewport.join('\n'), /✓ Done/)

    const narrowWriteCount = sink.writes.length
    sink.resize(48, 18)
    await waitForCondition(
      () => sink.writes.length > narrowWriteCount,
      2_000,
      'narrow terminal resize render',
      () => sink.diagnostics(),
    )
    viewport = await sink.viewport()
    assert.equal(
      linesContaining(sink.scrollBuffer(), 'PRAXIS'),
      1,
      `${sink.scrollBuffer().join('\n')}\nWRITES ${JSON.stringify(sink.writes.slice(-5))}`,
    )
    assert.ok(viewport.every((line) => [...line].length <= 48))
    assert.doesNotMatch(viewport.join('\n'), /└[^\n]*(?:WORKSPACE|ENTER)/)

    const exited = app.waitUntilExit()
    app.unmount()
    await exited
    unmounted = true
    stdout.finish()
    assert.ok(sink.writes.every((write) => !write.includes('\u001b[?1006l')))
    assert.ok(sink.writes.every((write) => !write.includes('\u001b[?1000l')))
    viewport = await sink.viewport()
    assert.match(viewport.join('\n'), /› eighth request/)
  } finally {
    if (!unmounted) app.unmount()
    stdout.finish()
    await bridge.dispose()
    sink.dispose()
  }
})

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
  readonly writes: string[] = []
  readonly #screen: SemanticTerminal

  constructor(
    public columns: number,
    public rows: number,
  ) {
    super()
    this.#screen = new SemanticTerminal(columns, rows)
    this.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      this.writes.push(text)
      this.#screen.write(text)
    })
  }

  getColorDepth(): number {
    return 24
  }

  hasColors(): boolean {
    return true
  }

  resize(columns: number, rows: number): void {
    this.columns = columns
    this.rows = rows
    this.#screen.resize(columns, rows)
    this.emit('resize')
  }

  async viewport(): Promise<string[]> {
    return this.#screen.viewportLines()
  }

  scrollBuffer(): string[] {
    return this.#screen.scrollBufferLines()
  }

  baseY(): number {
    return this.#screen.baseY()
  }

  diagnostics(): string {
    return this.#screen.diagnostics()
  }

  dispose(): void {
    this.#screen.dispose()
  }
}

function linesContaining(lines: readonly string[], value: string): number {
  return lines.filter((line) => line.includes(value)).length
}

function hasCursorMovement(write: string): boolean {
  const controlSequence = `${String.fromCharCode(27)}[`
  return write
    .split(controlSequence)
    .slice(1)
    .some((sequence) => /^\d+[AB]/.test(sequence))
}

async function waitForScreen(
  sink: TestOutput,
  condition: (screen: string) => boolean,
  description = 'semantic terminal content',
): Promise<void> {
  await waitForCondition(
    async () => condition((await sink.viewport()).join('\n')),
    3_000,
    description,
    () => sink.diagnostics(),
  )
}
