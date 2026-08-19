/** Parses one Provider JSON value while tolerating common prose and Markdown wrapping. */
export function parseProviderJsonV1(source: string): unknown {
  const trimmed = source.trim()
  if (!trimmed) return undefined
  const direct = parseJson(trimmed)
  if (direct !== undefined) return direct

  const fenced = [...trimmed.matchAll(/```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```/giu)]
  if (fenced.length > 1) return undefined
  if (fenced.length === 1) return parseJson(fenced[0]![1]!.trim())

  const embedded = embeddedJsonValues(trimmed)
  return embedded.length === 1 ? parseJson(embedded[0]!) : undefined
}

function parseJson(source: string): unknown {
  try {
    return JSON.parse(source)
  } catch {
    return undefined
  }
}

function embeddedJsonValues(source: string): string[] {
  const values: string[] = []
  let start = -1
  let depth = 0
  let quote = false
  let escaped = false
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!
    if (start < 0) {
      if (character === '{' || character === '[') {
        start = index
        depth = 1
      }
      continue
    }
    if (quote) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') quote = false
      continue
    }
    if (character === '"') quote = true
    else if (character === '{' || character === '[') depth += 1
    else if (character === '}' || character === ']') {
      depth -= 1
      if (depth === 0) {
        values.push(source.slice(start, index + 1))
        start = -1
      }
    }
  }
  return values.filter((value) => parseJson(value) !== undefined)
}
