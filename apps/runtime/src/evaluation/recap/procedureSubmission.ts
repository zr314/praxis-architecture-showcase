/** Accept one complete JSON document, optionally enclosed in a Markdown JSON fence. */
export function parseProcedureText(text: string): unknown {
  const trimmed = text.trim()
  const fenced = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/iu.exec(trimmed)
  return JSON.parse(fenced ? fenced[1]! : trimmed) as unknown
}
