import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import xterm from '@xterm/headless'
import { NativeTerminalOutput } from '../apps/cli/src/ui/terminalOutput.js'

const XtermTerminal = xterm.Terminal

test('native output grows terminal scrollback without taking mouse control', async () => {
  const terminal = new XtermTerminal({
    allowProposedApi: true,
    cols: 20,
    rows: 4,
    scrollback: 100,
  })
  const sink = new TestOutput(terminal, 20, 4)
  const output = new NativeTerminalOutput(sink as unknown as NodeJS.WriteStream)

  try {
    output.write('one\ntwo\nthree\nfour')
    await sink.flush()
    output.write('one\ntwo\nthree\nfour\nfive\nsix')
    await sink.flush()

    const buffer = sink.buffer()
    assert.ok(terminal.buffer.active.baseY > 0)
    assert.deepEqual(buffer.filter(Boolean).slice(-6), [
      'one',
      'two',
      'three',
      'four',
      'five',
      'six',
    ])
    assert.ok(
      sink.writes.every((write) =>
        ['1000', '1002', '1003', '1006'].every((mode) => !write.includes(`\u001b[?${mode}h`)),
      ),
    )
    assert.ok(sink.writes.every((write) => !write.includes('\u001b[?1049h')))
  } finally {
    output.finish()
    terminal.dispose()
  }
})

test('stable-size streaming updates preserve scrollback and a scrolled viewport', async () => {
  const terminal = new XtermTerminal({
    allowProposedApi: true,
    cols: 30,
    rows: 4,
    scrollback: 100,
  })
  const sink = new TestOutput(terminal, 30, 4)
  const output = new NativeTerminalOutput(sink as unknown as NodeJS.WriteStream)

  try {
    output.write('one\ntwo\nthree\nfour\npartial')
    await sink.flush()
    terminal.scrollLines(-1)
    const viewportBefore = terminal.buffer.active.viewportY

    output.write('one\ntwo\nthree\nfour\npartial response')
    await sink.flush()

    assert.equal(terminal.buffer.active.viewportY, viewportBefore)
    assert.match(sink.buffer().join('\n'), /partial response/)
    assert.ok(sink.writes.slice(1).every((write) => !write.includes('\u001b[2J')))
    assert.ok(sink.writes.slice(1).every((write) => !write.includes('\u001b[3J')))
  } finally {
    output.finish()
    terminal.dispose()
  }
})

class TestOutput extends PassThrough {
  readonly isTTY = true
  readonly writes: string[] = []

  constructor(
    private readonly terminal: InstanceType<typeof XtermTerminal>,
    public columns: number,
    public rows: number,
  ) {
    super()
    this.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      this.writes.push(text)
      this.terminal.write(text)
    })
  }

  getColorDepth(): number {
    return 24
  }

  hasColors(): boolean {
    return true
  }

  buffer(): string[] {
    const lines: string[] = []
    const buffer = this.terminal.buffer.active
    for (let row = 0; row < buffer.length; row += 1) {
      lines.push(buffer.getLine(row)?.translateToString(true) ?? '')
    }
    return lines
  }

  flush(): Promise<void> {
    return new Promise((resolve) => this.terminal.write('', resolve))
  }
}
