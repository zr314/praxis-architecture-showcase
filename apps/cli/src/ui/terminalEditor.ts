import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type EditorKeybindings = {
  submit: 'enter' | 'ctrl-enter'
  newline: 'shift-enter' | 'ctrl-enter'
  externalEditor: 'ctrl-e'
}

export class TerminalEditorModel {
  value = ''
  readonly #history: string[] = []
  #historyIndex = 0
  #historyDraft = ''
  #cursorIndex = 0
  #preferredColumn: number | undefined
  #completions: readonly string[]

  constructor(completions: readonly string[] = []) {
    this.#completions = completions
  }

  get cursorIndex(): number {
    return this.#cursorIndex
  }

  setCompletions(completions: readonly string[]): void {
    this.#completions = Object.freeze([...completions])
  }

  insert(text: string): void {
    const normalized = normalizePaste(text)
    if (!normalized) return
    this.value =
      this.value.slice(0, this.#cursorIndex) + normalized + this.value.slice(this.#cursorIndex)
    this.#cursorIndex += normalized.length
    this.#finishEdit()
  }

  newline(): void {
    this.insert('\n')
  }

  backspace(): void {
    if (this.#cursorIndex === 0) return
    const start = previousGraphemeBoundary(this.value, this.#cursorIndex)
    this.value = this.value.slice(0, start) + this.value.slice(this.#cursorIndex)
    this.#cursorIndex = start
    this.#finishEdit()
  }

  deleteForward(): void {
    if (this.#cursorIndex >= this.value.length) return
    const end = nextGraphemeBoundary(this.value, this.#cursorIndex)
    this.value = this.value.slice(0, this.#cursorIndex) + this.value.slice(end)
    this.#finishEdit()
  }

  moveLeft(): boolean {
    if (this.#cursorIndex === 0) return false
    this.#cursorIndex = previousGraphemeBoundary(this.value, this.#cursorIndex)
    this.#preferredColumn = undefined
    return true
  }

  moveRight(): boolean {
    if (this.#cursorIndex >= this.value.length) return false
    this.#cursorIndex = nextGraphemeBoundary(this.value, this.#cursorIndex)
    this.#preferredColumn = undefined
    return true
  }

  moveWordLeft(): boolean {
    if (this.#cursorIndex === 0) return false
    let next = this.#cursorIndex
    while (next > 0) {
      const previous = previousGraphemeBoundary(this.value, next)
      if (!isWhitespace(this.value.slice(previous, next))) break
      next = previous
    }
    while (next > 0) {
      const previous = previousGraphemeBoundary(this.value, next)
      if (isWhitespace(this.value.slice(previous, next))) break
      next = previous
    }
    this.#cursorIndex = next
    this.#preferredColumn = undefined
    return true
  }

  moveWordRight(): boolean {
    if (this.#cursorIndex >= this.value.length) return false
    let next = this.#cursorIndex
    while (next < this.value.length) {
      const end = nextGraphemeBoundary(this.value, next)
      if (!isWhitespace(this.value.slice(next, end))) break
      next = end
    }
    while (next < this.value.length) {
      const end = nextGraphemeBoundary(this.value, next)
      if (isWhitespace(this.value.slice(next, end))) break
      next = end
    }
    this.#cursorIndex = next
    this.#preferredColumn = undefined
    return true
  }

  moveToLineStart(): boolean {
    const next = lineStartAt(this.value, this.#cursorIndex)
    if (next === this.#cursorIndex) return false
    this.#cursorIndex = next
    this.#preferredColumn = undefined
    return true
  }

  moveToLineEnd(): boolean {
    const newline = this.value.indexOf('\n', this.#cursorIndex)
    const next = newline === -1 ? this.value.length : newline
    if (next === this.#cursorIndex) return false
    this.#cursorIndex = next
    this.#preferredColumn = undefined
    return true
  }

  moveUp(): boolean {
    const lineStart = lineStartAt(this.value, this.#cursorIndex)
    if (lineStart === 0) return false
    const previousLineEnd = lineStart - 1
    const previousLineStart = this.value.lastIndexOf('\n', previousLineEnd - 1) + 1
    const column =
      this.#preferredColumn ?? graphemeCount(this.value.slice(lineStart, this.#cursorIndex))
    this.#preferredColumn = column
    this.#cursorIndex = indexAtGraphemeColumn(
      this.value,
      previousLineStart,
      previousLineEnd,
      column,
    )
    return true
  }

  moveDown(): boolean {
    const lineStart = lineStartAt(this.value, this.#cursorIndex)
    const lineEnd = this.value.indexOf('\n', this.#cursorIndex)
    if (lineEnd === -1) return false
    const nextLineStart = lineEnd + 1
    const nextNewline = this.value.indexOf('\n', nextLineStart)
    const nextLineEnd = nextNewline === -1 ? this.value.length : nextNewline
    const column =
      this.#preferredColumn ?? graphemeCount(this.value.slice(lineStart, this.#cursorIndex))
    this.#preferredColumn = column
    this.#cursorIndex = indexAtGraphemeColumn(this.value, nextLineStart, nextLineEnd, column)
    return true
  }

  clear(): void {
    this.value = ''
    this.#cursorIndex = 0
    this.#historyIndex = this.#history.length
    this.#historyDraft = ''
    this.#preferredColumn = undefined
  }

  submit(): string | undefined {
    const value = this.value.trim()
    if (!value) return undefined
    if (this.#history.at(-1) !== value) this.#history.push(value)
    this.clear()
    return value
  }

  previousHistory(): string {
    if (this.#history.length === 0) return this.value
    if (this.#historyIndex === this.#history.length) this.#historyDraft = this.value
    this.#historyIndex = Math.max(0, this.#historyIndex - 1)
    this.value = this.#history[this.#historyIndex] ?? ''
    this.#cursorIndex = this.value.length
    this.#preferredColumn = undefined
    return this.value
  }

  nextHistory(): string {
    if (this.#history.length === 0) return this.value
    this.#historyIndex = Math.min(this.#history.length, this.#historyIndex + 1)
    this.value =
      this.#historyIndex === this.#history.length
        ? this.#historyDraft
        : (this.#history[this.#historyIndex] ?? '')
    this.#cursorIndex = this.value.length
    this.#preferredColumn = undefined
    return this.value
  }

  complete(): string {
    const token = this.value.trimStart()
    if (!token.startsWith('/') || token.includes(' ')) return this.value
    const matches = this.#completions.filter((command) => command.startsWith(token))
    if (matches.length === 1) {
      this.value = `${matches[0]} `
      this.#cursorIndex = this.value.length
      this.#finishEdit()
    }
    return this.value
  }

  replace(value: string): void {
    this.value = normalizePaste(value)
    this.#cursorIndex = this.value.length
    this.#finishEdit()
  }

  #finishEdit(): void {
    this.#historyIndex = this.#history.length
    this.#historyDraft = ''
    this.#preferredColumn = undefined
  }
}

export function editorKeybindings(environment: NodeJS.ProcessEnv = process.env): EditorKeybindings {
  const submit = environment.PRAXIS_SUBMIT_KEY === 'ctrl-enter' ? 'ctrl-enter' : 'enter'
  return {
    submit,
    newline: submit === 'enter' ? 'shift-enter' : 'ctrl-enter',
    externalEditor: 'ctrl-e',
  }
}

/**
 * Ink 6 labels the legacy DEL byte (`0x7f`) as `key.delete`, although common
 * terminals emit it for Backspace. Preserve a real forward Delete (`CSI 3~`)
 * while matching the legacy, Kitty, and modifyOtherKeys Backspace forms.
 */
export function isBackwardDeleteSequence(sequence: string): boolean {
  if (sequence === '\u007f' || sequence === '\u001b\u007f') return true
  if (!sequence.startsWith('\u001b[')) return false
  const controlSequence = sequence.slice(2)
  return /^127(?:;[0-9:]+)*u$/u.test(controlSequence) || /^27;[0-9:]+;127~$/u.test(controlSequence)
}

export async function editInExternalEditor(
  initial: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const editor = environment.VISUAL ?? environment.EDITOR
  if (!editor) return initial
  const directory = await mkdtemp(join(tmpdir(), 'praxis-editor-'))
  const path = join(directory, 'prompt.md')
  try {
    await writeFile(path, initial, 'utf8')
    await runEditor(editor, path)
    return await readFile(path, 'utf8')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

function normalizePaste(text: string): string {
  return text.split('\u001b[200~').join('').split('\u001b[201~').join('').replace(/\r\n?/g, '\n')
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

function graphemeSegments(text: string): Intl.SegmentData[] {
  return [...graphemeSegmenter.segment(text)]
}

function previousGraphemeBoundary(text: string, index: number): number {
  const segments = graphemeSegments(text.slice(0, index))
  return segments.at(-1)?.index ?? 0
}

function nextGraphemeBoundary(text: string, index: number): number {
  const segment = graphemeSegments(text.slice(index))[0]
  return segment ? index + segment.segment.length : text.length
}

function graphemeCount(text: string): number {
  return graphemeSegments(text).length
}

function indexAtGraphemeColumn(
  text: string,
  lineStart: number,
  lineEnd: number,
  column: number,
): number {
  if (column <= 0) return lineStart
  const segments = graphemeSegments(text.slice(lineStart, lineEnd))
  if (column >= segments.length) return lineEnd
  return lineStart + (segments[column]?.index ?? lineEnd - lineStart)
}

function lineStartAt(text: string, index: number): number {
  return index <= 0 ? 0 : text.lastIndexOf('\n', index - 1) + 1
}

function isWhitespace(value: string): boolean {
  return /^\s$/u.test(value)
}

function runEditor(command: string, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [path], {
      stdio: 'inherit',
      shell: process.platform === 'win32',
      windowsHide: true,
    })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`External editor exited with code ${code}.`))
    })
  })
}
