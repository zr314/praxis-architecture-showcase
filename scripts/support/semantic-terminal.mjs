import xterm from '@xterm/headless'

const XtermTerminal = xterm.Terminal

export class SemanticTerminal {
  #terminal
  #rawOutput = ''

  constructor(columns, rows) {
    this.columns = columns
    this.rows = rows
    this.#terminal = new XtermTerminal({
      allowProposedApi: true,
      cols: columns,
      rows,
      scrollback: 1_000,
    })
  }

  write(chunk) {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    this.#rawOutput += text
    this.#terminal.write(text)
  }

  resize(columns, rows) {
    this.columns = columns
    this.rows = rows
    this.#terminal.resize(columns, rows)
  }

  rawOutput() {
    return this.#rawOutput
  }

  async viewportLines() {
    await this.#flush()
    return this.#viewportLinesNow()
  }

  async viewportText() {
    return (await this.viewportLines()).join('\n')
  }

  scrollBufferLines() {
    const lines = []
    const buffer = this.#terminal.buffer.active
    for (let row = 0; row < buffer.length; row += 1) {
      lines.push(buffer.getLine(row)?.translateToString(true) ?? '')
    }
    return lines
  }

  scrollBufferText() {
    return this.scrollBufferLines().join('\n')
  }

  baseY() {
    return this.#terminal.buffer.active.baseY
  }

  diagnostics() {
    return `Raw output: ${safeOutputExcerpt(this.#rawOutput)} Semantic screen: ${safeOutputExcerpt(this.#viewportLinesNow().join('\n'))}`
  }

  dispose() {
    this.#terminal.dispose()
  }

  #flush() {
    return new Promise((resolve) => this.#terminal.write('', resolve))
  }

  #viewportLinesNow() {
    const buffer = this.#terminal.buffer.active
    const lines = []
    for (let row = 0; row < this.rows; row += 1) {
      lines.push(
        buffer.getLine(buffer.viewportY + row)?.translateToString(true, 0, this.columns) ?? '',
      )
    }
    return lines
  }
}

export async function waitForCondition(
  condition,
  timeoutMilliseconds,
  description,
  diagnostics = () => '',
) {
  const deadline = Date.now() + timeoutMilliseconds
  while (Date.now() < deadline) {
    if (await condition()) return
    await poll()
  }
  if (await condition()) return
  throw new Error(
    `Timed out after ${timeoutMilliseconds}ms waiting for ${description}.${diagnosticSuffix(diagnostics)}`,
  )
}

export async function waitForChildCondition(
  child,
  condition,
  timeoutMilliseconds,
  description,
  capture,
) {
  const deadline = Date.now() + timeoutMilliseconds
  while (Date.now() < deadline) {
    if (await condition()) return
    const exit = currentExit(child)
    if (exit) {
      throw new Error(
        `PTY exited before ${description} (${formatExit(exit)}). ${capture.diagnostics()}`,
      )
    }
    await poll()
  }
  if (await condition()) return
  const exit = currentExit(child)
  throw new Error(
    exit
      ? `PTY exited before ${description} (${formatExit(exit)}). ${capture.diagnostics()}`
      : `Timed out after ${timeoutMilliseconds}ms waiting for ${description}; child still running. ${capture.diagnostics()}`,
  )
}

export function waitForChildExit(child, timeoutMilliseconds, capture) {
  const exited = currentExit(child)
  if (exited) return Promise.resolve(exited)
  return new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => {
      cleanup()
      rejectExit(
        new Error(
          `Timed out after ${timeoutMilliseconds}ms waiting for PTY exit. ${capture.diagnostics()}`,
        ),
      )
    }, timeoutMilliseconds)
    const onError = (error) => {
      cleanup()
      rejectExit(error)
    }
    const onExit = (code, signal) => {
      cleanup()
      resolveExit({ code, signal })
    }
    const cleanup = () => {
      clearTimeout(timer)
      child.off('error', onError)
      child.off('exit', onExit)
    }
    child.once('error', onError)
    child.once('exit', onExit)
  })
}

export function formatExit(exit) {
  return `code=${exit.code ?? 'null'}, signal=${exit.signal ?? 'null'}`
}

export function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function currentExit(child) {
  return child.exitCode === null && child.signalCode === null
    ? undefined
    : { code: child.exitCode, signal: child.signalCode }
}

function diagnosticSuffix(diagnostics) {
  const value = diagnostics()
  return value ? ` ${value}` : ''
}

function poll() {
  return new Promise((resolve) => setTimeout(resolve, 20))
}

function safeOutputExcerpt(source) {
  const sanitized = stripTerminalControls(source)
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, '[REDACTED_KEY]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{8,}/giu, 'Bearer [REDACTED]')
    .replace(/\b(api[_-]?key|token|secret)\s*[:=]\s*\S+/giu, '$1=[REDACTED]')
    .replace(/\s+/gu, ' ')
    .trim()
  if (!sanitized) return '<no output>'
  const limit = 1_200
  return sanitized.length <= limit ? sanitized : `…${sanitized.slice(-limit)}`
}

function stripTerminalControls(source) {
  let output = ''
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index)
    if (code === 27 && source[index + 1] === '[') {
      index += 2
      while (index < source.length) {
        const sequenceCode = source.charCodeAt(index)
        if (sequenceCode >= 0x40 && sequenceCode <= 0x7e) break
        index += 1
      }
      continue
    }
    if (code === 27 && source[index + 1] === ']') {
      index += 2
      while (index < source.length) {
        const sequenceCode = source.charCodeAt(index)
        if (sequenceCode === 7) break
        if (sequenceCode === 27 && source[index + 1] === '\\') {
          index += 1
          break
        }
        index += 1
      }
      continue
    }
    if (code === 27) {
      index += 1
      continue
    }
    output += code < 32 || (code >= 0x7f && code <= 0x9f) ? ' ' : source[index]
  }
  return output
}
