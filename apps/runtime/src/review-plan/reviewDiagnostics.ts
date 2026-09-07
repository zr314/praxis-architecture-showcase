import type { ReviewFailureDiagnosticV1 } from './semanticReviewer.js'

/** Local diagnostics, not an Agent message. Best-effort redaction is not a secret scanner. */
export function safeReviewFailureV1(failure: ReviewFailureDiagnosticV1): ReviewFailureDiagnosticV1 {
  if (failure.submittedResponse === undefined) return failure
  const response = JSON.stringify(redact(failure.submittedResponse))
  const bytes = Buffer.from(response, 'utf8')
  return {
    ...failure,
    submittedResponse:
      bytes.length <= 64 * 1024
        ? JSON.parse(response)
        : {
            truncated: true,
            redactedBytes: bytes.length,
            excerpt: bytes
              .subarray(0, 64 * 1024)
              .toString('utf8')
              .replace(/\uFFFD$/u, ''),
          },
  }
}

function redact(value: unknown): unknown {
  if (typeof value === 'string')
    return value
      .replace(/\b(?:sk|pk|api)[-_][A-Za-z0-9_-]{12,}\b/gu, '[REDACTED_TOKEN]')
      .replace(/\bBearer\s+[^\s"']+/giu, 'Bearer [REDACTED]')
      .replace(
        /((?:password|api[_-]?key|access[_-]?token|secret)\s*[=:]\s*)[^\s,;"']+/giu,
        '$1[REDACTED]',
      )
  if (Array.isArray(value)) return value.map(redact)
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      /password|authorization|cookie|secret|api[_-]?key|access[_-]?token|reasoning|thinking|chain.?of.?thought/iu.test(
        key,
      )
        ? '[REDACTED]'
        : redact(item),
    ]),
  )
}
