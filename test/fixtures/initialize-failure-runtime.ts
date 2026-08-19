import { writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const marker = process.argv[2]
if (marker) writeFileSync(marker, String(process.pid))

const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
input.on('line', (line) => {
  const request = JSON.parse(line) as { id: string; method: string }
  if (request.method === 'initialize') {
    process.stdout.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: request.id,
        error: {
          code: 'PROTOCOL_VERSION_UNSUPPORTED',
          message: 'Fixture rejects initialize.',
        },
      })}\n`,
    )
  }
})
