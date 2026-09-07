import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

// No Provider credentials are passed to this process. Only the selected script is readable.
const code = readFileSync(process.argv[2]!, 'utf8')
const cases = JSON.parse(readFileSync(0, 'utf8')) as { input: unknown; policy: unknown }[]
const outputs = cases.map((entry) => {
  try {
    const context = Object.assign(Object.create(null) as Record<string, string>, {
      inputJson: JSON.stringify(entry.input),
      policyJson: JSON.stringify(entry.policy),
    })
    const serialized = runInNewContext(
      `${code}\nJSON.stringify(solve(JSON.parse(inputJson), JSON.parse(policyJson)))`,
      context,
      {
        timeout: 10000,
        microtaskMode: 'afterEvaluate',
        contextCodeGeneration: { strings: false, wasm: false },
      },
    )
    return { ok: true, value: JSON.parse(serialized) as unknown }
  } catch {
    return {
      ok: false,
      error:
        'PROGRAM_EVALUATION_FAILED: invalid code, unsupported API, non-JSON result, or per-test computation timeout.',
    }
  }
})
process.stdout.write(JSON.stringify(outputs))
