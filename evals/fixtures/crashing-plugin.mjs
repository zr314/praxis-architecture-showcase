import { createInterface } from 'node:readline'

const input = createInterface({ input: process.stdin, crlfDelay: Infinity })

input.on('line', (line) => {
  const request = JSON.parse(line)
  if (request.method === 'initialize') {
    respond(request.id, {
      manifest: {
        id: 'evaluation-crash-plugin',
        version: '1.0.0',
        apiVersion: 1,
        isolation: 'process',
        capabilities: ['tool'],
      },
      capabilities: [
        {
          id: 'fixture.crash',
          kind: 'tool',
          inputSchema: {},
          outputSchema: {},
          execution: {
            sideEffect: 'process',
            target: { kind: 'workspace' },
            parallelSafe: false,
            conflictScope: 'workspace',
            maxInlineBytes: 65_536,
          },
        },
      ],
    })
    return
  }
  if (request.method === 'capability.invoke') process.exit(17)
})

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
}
