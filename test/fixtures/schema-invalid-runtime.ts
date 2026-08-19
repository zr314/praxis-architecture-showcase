import { createInterface } from 'node:readline'

const input = createInterface({ input: process.stdin, crlfDelay: Infinity })

input.on('line', (line) => {
  const request = JSON.parse(line) as { id: string; method: string }
  if (request.method !== 'initialize') return
  process.stdout.write(
    `${JSON.stringify({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        protocolVersion: 1,
        runtime: { runtimeId: 'schema-invalid-runtime' },
      },
    })}\n`,
  )
})
