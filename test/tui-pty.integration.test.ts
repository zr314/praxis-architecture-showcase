import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import {
  formatExit,
  SemanticTerminal,
  shellQuote,
  waitForChildCondition,
  waitForChildExit,
} from '../scripts/support/semantic-terminal.mjs'

const PTY_COLUMNS = 120
const PTY_ROWS = 30

test('PTY screen capture reconstructs visible text split by cursor controls', async () => {
  const capture = new SemanticTerminal(20, 4)
  try {
    capture.write('INPUT')
    capture.write('\u001b[1CACTIVE')

    assert.equal(capture.rawOutput().includes('INPUT ACTIVE'), false)
    assert.match(await capture.viewportText(), /INPUT ACTIVE/)
  } finally {
    capture.dispose()
  }
})

test('Linux PTY accepts session navigation and restores the terminal on idle Ctrl+C', {
  skip: process.platform !== 'linux',
  timeout: 35_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'praxis-tui-pty-'))
  const capture = new SemanticTerminal(PTY_COLUMNS, PTY_ROWS)
  let child: ChildProcessWithoutNullStreams | undefined
  try {
    const command = [
      `stty cols ${PTY_COLUMNS} rows ${PTY_ROWS}`,
      '&&',
      shellQuote(process.execPath),
      '--import',
      'tsx',
      shellQuote(resolve('apps', 'cli', 'src', 'cli.tsx')),
      '--provider',
      'mock',
    ].join(' ')
    child = spawn('script', ['-qfec', command, '/dev/null'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PRAXIS_HOME: home,
        MOONSHOT_API_KEY: '',
        TSX_TSCONFIG_PATH: resolve('tsconfig.check.json'),
        TERM: 'xterm-256color',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    child.stdout.setEncoding('utf8').on('data', (chunk) => capture.write(chunk))
    child.stderr.setEncoding('utf8').on('data', (chunk) => capture.write(chunk))

    await waitForChildCondition(
      child,
      async () => (await capture.viewportText()).includes('INPUT ACTIVE'),
      12_000,
      'TUI input readiness',
      capture,
    )
    child.stdin.write('/session')
    await waitForChildCondition(
      child,
      async () => (await capture.viewportText()).includes('/session'),
      3_000,
      'session command input echo',
      capture,
    )
    child.stdin.write('\r')
    await waitForChildCondition(
      child,
      async () => (await capture.viewportText()).includes('RESUME HISTORY'),
      7_000,
      'session picker',
      capture,
    )
    const pickerScreen = await capture.viewportText()

    child.stdin.write('\u001b')
    await waitForChildCondition(
      child,
      async () => {
        const screen = await capture.viewportText()
        return screen.includes('PROMPT') && !screen.includes('RESUME HISTORY')
      },
      4_000,
      'session picker dismissal',
      capture,
    )

    child.stdin.write('\u0003')
    const exit = await waitForChildExit(child, 4_000, capture)

    assert.match(pickerScreen, /RESUME HISTORY/)
    assert.doesNotMatch(
      capture.rawOutput(),
      /Raw mode is not supported|secure terminal input is unavailable/i,
    )
    assert.ok(
      exit.code === 0 || exit.code === 130,
      `unexpected PTY exit ${formatExit(exit)}. ${capture.diagnostics()}`,
    )
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await waitForChildExit(child, 2_000, capture).catch(() => undefined)
    }
    capture.dispose()
    await rm(home, { recursive: true, force: true })
  }
})
