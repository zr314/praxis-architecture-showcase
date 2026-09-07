import { canonicalJsonV1, type MechanicalCriterionSpecV1 } from '@praxis/core-sdk'

export type RegisteredReviewCheckV1 = Readonly<{
  id: string
  version: string
  /** Host-owned immutable implementation/configuration identity. */
  digest: `sha256:${string}`
  description: string
  expectedExitCodes: readonly number[]
  evaluate: (
    input: Readonly<{
      parameters: Readonly<Record<string, string | number | boolean>>
      evidence: readonly Readonly<{ ref: string; value: unknown }>[]
      signal: AbortSignal
    }>,
  ) => Promise<Readonly<{ exitCode: number; reason: string; evidenceRefs: readonly string[] }>>
}>

/** Only the trusted host can register code. Models select pinned checks, never supply executables. */
export class RegisteredReviewChecksV1 {
  readonly #checks = new Map<string, RegisteredReviewCheckV1>()

  constructor(checks: readonly RegisteredReviewCheckV1[] = []) {
    for (const check of checks) {
      if (
        this.#checks.has(check.id) ||
        !/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/u.test(check.id) ||
        !check.version ||
        !/^sha256:[a-f0-9]{64}$/u.test(check.digest) ||
        check.expectedExitCodes.length === 0 ||
        check.expectedExitCodes.some((code) => !Number.isSafeInteger(code))
      )
        throw new TypeError('Invalid or duplicate registered review checker.')
      this.#checks.set(
        check.id,
        Object.freeze({ ...check, expectedExitCodes: Object.freeze([...check.expectedExitCodes]) }),
      )
    }
  }

  definitions(): readonly Record<string, unknown>[] {
    return [...this.#checks.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((check) => ({
        type: 'object',
        additionalProperties: false,
        description: check.description,
        required: ['checker', 'checkerId', 'checkerVersion', 'checkerDigest', 'expectedExitCodes'],
        properties: {
          checker: { const: 'registered_check' },
          checkerId: { const: check.id },
          checkerVersion: { const: check.version },
          checkerDigest: { const: check.digest },
          expectedExitCodes: { const: [...check.expectedExitCodes] },
          parameters: {
            type: 'object',
            additionalProperties: { type: ['string', 'number', 'boolean'] },
          },
        },
      }))
  }

  async evaluate(
    spec: Extract<MechanicalCriterionSpecV1, { checker: 'registered_check' }>,
    evidence: readonly Readonly<{ ref: string; value: unknown }>[],
    signal: AbortSignal,
  ): Promise<
    Readonly<{
      status: 'passed' | 'failed' | 'unverifiable'
      reason: string
      evidenceRefs: readonly string[]
    }>
  > {
    const check = this.#checks.get(spec.checkerId)
    if (
      check === undefined ||
      check.version !== spec.checkerVersion ||
      check.digest !== spec.checkerDigest ||
      canonicalJsonV1(check.expectedExitCodes) !== canonicalJsonV1(spec.expectedExitCodes)
    ) {
      return {
        status: 'unverifiable',
        reason: 'The pinned Host checker or its success contract is unavailable.',
        evidenceRefs: [],
      }
    }
    if (signal.aborted) throw signal.reason
    try {
      const result = await check.evaluate({
        parameters: structuredClone(spec.parameters ?? {}),
        evidence: structuredClone(evidence),
        signal,
      })
      if (signal.aborted) throw signal.reason
      const allowed = new Set(evidence.map(({ ref }) => ref))
      if (
        !Number.isSafeInteger(result.exitCode) ||
        !result.reason ||
        result.reason.length > 8_192 ||
        !Array.isArray(result.evidenceRefs) ||
        result.evidenceRefs.length === 0 ||
        result.evidenceRefs.some((ref) => !allowed.has(ref))
      )
        throw new TypeError('Invalid checker result.')
      return {
        status: check.expectedExitCodes.includes(result.exitCode) ? 'passed' : 'failed',
        reason: result.reason,
        evidenceRefs: [...result.evidenceRefs],
      }
    } catch (error) {
      if (signal.aborted) throw error
      return {
        status: 'unverifiable',
        reason: 'The Host checker failed to produce a valid evidence-bound result.',
        evidenceRefs: [],
      }
    }
  }
}
