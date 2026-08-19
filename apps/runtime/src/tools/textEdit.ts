export type TextEditMatchMode = 'exact' | 'line-ending-normalized'
export type TextEditLineEnding = 'crlf' | 'lf' | 'none'

export type PreparedTextEdit =
  | {
      ok: true
      content: string
      matchMode: TextEditMatchMode
      lineEnding: TextEditLineEnding
    }
  | { ok: false; reason: 'not_found' | 'ambiguous' }

type LocatedText = {
  start: number
  end: number
  matchMode: TextEditMatchMode
}

function logicalSource(source: string): { text: string; boundaries: number[] } {
  let text = ''
  const boundaries = [0]
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '\r' && source[index + 1] === '\n') {
      text += '\n'
      index += 1
      boundaries.push(index + 1)
    } else {
      text += source[index]
      boundaries.push(index + 1)
    }
  }
  return { text, boundaries }
}

function occurrence(text: string, query: string): { first: number; duplicate: boolean } {
  const first = text.indexOf(query)
  return {
    first,
    duplicate: first >= 0 && text.indexOf(query, first + 1) >= 0,
  }
}

function locate(source: string, oldText: string): LocatedText | 'not_found' | 'ambiguous' {
  if (!oldText.includes('\n')) {
    const found = occurrence(source, oldText)
    if (found.first < 0) return 'not_found'
    if (found.duplicate) return 'ambiguous'
    return {
      start: found.first,
      end: found.first + oldText.length,
      matchMode: 'exact',
    }
  }

  const logical = logicalSource(source)
  const query = oldText.replace(/\r\n/g, '\n')
  const found = occurrence(logical.text, query)
  if (found.first < 0) return 'not_found'
  if (found.duplicate) return 'ambiguous'
  const start = logical.boundaries[found.first]!
  const end = logical.boundaries[found.first + query.length]!
  return {
    start,
    end,
    matchMode: source.slice(start, end) === oldText ? 'exact' : 'line-ending-normalized',
  }
}

function dominantLineEnding(text: string): TextEditLineEnding {
  let crlf = 0
  let lf = 0
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\r' && text[index + 1] === '\n') {
      crlf += 1
      index += 1
    } else if (text[index] === '\n') {
      lf += 1
    }
  }
  if (crlf === 0 && lf === 0) return 'none'
  return crlf > lf ? 'crlf' : 'lf'
}

function replacementLineEnding(
  source: string,
  matched: string,
  newText: string,
): TextEditLineEnding {
  for (const candidate of [matched, source, newText]) {
    const lineEnding = dominantLineEnding(candidate)
    if (lineEnding !== 'none') return lineEnding
  }
  return 'none'
}

function withLineEnding(text: string, lineEnding: TextEditLineEnding): string {
  if (lineEnding === 'none') return text
  const logical = text.replace(/\r\n/g, '\n')
  return lineEnding === 'crlf' ? logical.replace(/\n/g, '\r\n') : logical
}

export function prepareTextEdit(
  source: string,
  oldText: string,
  newText: string,
): PreparedTextEdit {
  const located = locate(source, oldText)
  if (typeof located === 'string') return { ok: false, reason: located }
  const matched = source.slice(located.start, located.end)
  const lineEnding = replacementLineEnding(source, matched, newText)
  const replacement = withLineEnding(newText, lineEnding)
  return {
    ok: true,
    content: `${source.slice(0, located.start)}${replacement}${source.slice(located.end)}`,
    matchMode: located.matchMode,
    lineEnding,
  }
}
