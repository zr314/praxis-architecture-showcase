import { Writable } from 'node:stream'

const BEGIN_SYNCHRONIZED_OUTPUT = '\u001b[?2026h'
const END_SYNCHRONIZED_OUTPUT = '\u001b[?2026l'
const HIDE_CURSOR = '\u001b[?25l'
const SHOW_CURSOR = '\u001b[?25h'
const ANSI_CSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g')

/**
 * Ink's debug renderer emits one complete layout per write. This stream turns
 * those layouts into native-scrollback, cursor-addressed line updates. The
 * terminal remains in its main screen and owns wheel scrolling, selection,
 * and copy while Praxis retains deterministic cross-platform frame updates.
 */
export class NativeTerminalOutput extends Writable {
  readonly isTTY: boolean

  private previousLines: string[] = []
  private hardwareCursorRow = 0
  private previousViewportTop = 0
  private previousColumns = 0
  private previousRows = 0
  private finished = false
  private readonly resize = () => this.emit('resize')

  constructor(private readonly destination: NodeJS.WriteStream) {
    super()
    this.isTTY = destination.isTTY === true
    destination.on('resize', this.resize)
  }

  get columns(): number {
    return this.destination.columns ?? 80
  }

  get rows(): number {
    return this.destination.rows ?? 24
  }

  getColorDepth(environment?: Record<string, string | undefined>): number {
    return this.destination.getColorDepth?.(environment) ?? 8
  }

  hasColors(count?: number, environment?: Record<string, string | undefined>): boolean {
    if (!this.destination.hasColors) return this.isTTY
    return count === undefined
      ? this.destination.hasColors()
      : this.destination.hasColors(count, environment)
  }

  finish(): void {
    if (this.finished) return
    this.finished = true
    this.destination.off('resize', this.resize)

    let output = BEGIN_SYNCHRONIZED_OUTPUT
    if (this.previousLines.length > 0) {
      const finalRow = this.previousLines.length - 1
      output += this.moveToLogicalRow(finalRow)
      output += '\r\n'
    }
    output += SHOW_CURSOR + END_SYNCHRONIZED_OUTPUT
    this.destination.write(output)
  }

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (this.finished) {
      callback()
      return
    }

    try {
      const frame = chunk.toString()
      // Ink's debug renderer emits a single newline while unmounting its
      // reconciler tree. That is not an application frame and must not erase
      // the last visible conversation.
      if (!frame || !hasVisibleContent(frame)) {
        callback()
        return
      }
      const output = this.update(frame)
      if (!output) {
        callback()
        return
      }
      this.destination.write(output, callback)
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private update(frame: string): string {
    const nextLines = frame.endsWith('\n') ? frame.slice(0, -1).split('\n') : frame.split('\n')

    const dimensionsChanged =
      this.previousColumns !== 0 &&
      (this.previousColumns !== this.columns || this.previousRows !== this.rows)

    if (this.previousLines.length === 0) {
      return this.fullRender(nextLines, false)
    }

    if (dimensionsChanged) {
      return this.fullRender(nextLines, true)
    }

    let firstChanged = -1
    let lastChanged = -1
    const maximumLines = Math.max(nextLines.length, this.previousLines.length)
    for (let index = 0; index < maximumLines; index += 1) {
      if ((nextLines[index] ?? '') === (this.previousLines[index] ?? '')) continue
      if (firstChanged === -1) firstChanged = index
      lastChanged = index
    }
    if (firstChanged === -1) return ''

    const shrinking = nextLines.length < this.previousLines.length
    // Rows above previousViewportTop already belong to native scrollback and
    // cannot be cursor-addressed. Treat them as immutable history. A complete
    // rebuild is only necessary when a shrink removes every visible logical row.
    if (shrinking && nextLines.length - 1 < this.previousViewportTop) {
      return this.fullRender(nextLines, true)
    }

    const appendedAtEnd =
      nextLines.length > this.previousLines.length &&
      firstChanged === this.previousLines.length &&
      firstChanged > 0
    const firstRowToWrite = Math.max(
      this.previousViewportTop,
      shrinking ? Math.min(firstChanged, nextLines.length - 1) : firstChanged,
    )
    const lastRowToWrite = shrinking
      ? nextLines.length - 1
      : Math.min(lastChanged, nextLines.length - 1)
    if (firstRowToWrite > lastRowToWrite) {
      this.remember(nextLines, this.hardwareCursorRow, this.previousViewportTop)
      return ''
    }
    const moveTarget = appendedAtEnd ? firstRowToWrite - 1 : firstRowToWrite
    let viewportTop = this.previousViewportTop
    let hardwareCursorRow = this.hardwareCursorRow
    let output = BEGIN_SYNCHRONIZED_OUTPUT

    const previousViewportBottom = viewportTop + this.rows - 1
    if (moveTarget > previousViewportBottom) {
      const currentScreenRow = clamp(hardwareCursorRow - viewportTop, 0, this.rows - 1)
      output += moveRows(this.rows - 1 - currentScreenRow)
      const scroll = moveTarget - previousViewportBottom
      output += '\r\n'.repeat(scroll)
      viewportTop += scroll
      hardwareCursorRow = moveTarget
    } else {
      const currentScreenRow = hardwareCursorRow - viewportTop
      const targetScreenRow = moveTarget - viewportTop
      output += moveRows(targetScreenRow - currentScreenRow)
      hardwareCursorRow = moveTarget
    }

    output += appendedAtEnd ? '\r\n' : '\r'
    if (appendedAtEnd) {
      hardwareCursorRow = firstRowToWrite
      viewportTop = Math.max(viewportTop, hardwareCursorRow - this.rows + 1)
    }

    for (let index = firstRowToWrite; index <= lastRowToWrite; index += 1) {
      if (index > firstRowToWrite) {
        output += '\r\n'
        hardwareCursorRow = index
        viewportTop = Math.max(viewportTop, hardwareCursorRow - this.rows + 1)
      }
      output += `\u001b[2K${nextLines[index] ?? ''}`
    }

    const removedRows = Math.max(0, this.previousLines.length - nextLines.length)
    for (let index = 0; index < removedRows; index += 1) {
      output += '\r\n\u001b[2K'
      hardwareCursorRow += 1
    }
    if (removedRows > 0) {
      output += moveRows(-removedRows)
      hardwareCursorRow -= removedRows
    }

    output += END_SYNCHRONIZED_OUTPUT
    this.remember(nextLines, hardwareCursorRow, viewportTop)
    return output
  }

  private fullRender(lines: string[], clear: boolean): string {
    let output = BEGIN_SYNCHRONIZED_OUTPUT + HIDE_CURSOR
    if (clear) output += '\u001b[2J\u001b[H\u001b[3J'
    output += lines.join('\r\n')
    output += END_SYNCHRONIZED_OUTPUT

    const finalRow = Math.max(0, lines.length - 1)
    const viewportTop = Math.max(0, lines.length - this.rows)
    this.remember(lines, finalRow, viewportTop)
    return output
  }

  private moveToLogicalRow(targetRow: number): string {
    const currentScreenRow = this.hardwareCursorRow - this.previousViewportTop
    const targetScreenRow = targetRow - this.previousViewportTop
    this.hardwareCursorRow = targetRow
    return moveRows(targetScreenRow - currentScreenRow)
  }

  private remember(lines: string[], hardwareCursorRow: number, viewportTop: number): void {
    this.previousLines = lines
    this.hardwareCursorRow = hardwareCursorRow
    this.previousViewportTop = viewportTop
    this.previousColumns = this.columns
    this.previousRows = this.rows
  }
}

function moveRows(delta: number): string {
  if (delta > 0) return `\u001b[${delta}B`
  if (delta < 0) return `\u001b[${-delta}A`
  return ''
}

function hasVisibleContent(frame: string): boolean {
  return frame.replace(ANSI_CSI_PATTERN, '').trim().length > 0
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}
