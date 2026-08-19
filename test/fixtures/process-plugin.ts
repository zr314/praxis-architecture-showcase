import { createInterface } from 'node:readline'

const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
const pendingInvocations = new Map<
  string,
  { requestId: string; invocationId: string; lateSuccess: boolean }
>()
input.on('line', (line) => {
  const request = JSON.parse(line) as {
    id: string
    method: string
    params: Record<string, unknown>
  }
  if (request.method === 'initialize') {
    write(request.id, {
      manifest: {
        id: 'fixture-plugin',
        version: '1.0.0',
        apiVersion: 1,
        isolation: 'process',
        capabilities: ['tool'],
      },
      capabilities: [
        {
          id: 'fixture.echo',
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
  } else if (request.method === 'capability.invoke') {
    const invocationId = String(request.params.invocationId)
    const cancellationId = String(request.params.cancellationId)
    if (
      typeof request.params.input === 'object' &&
      request.params.input !== null &&
      (request.params.input as { waitForCancel?: unknown }).waitForCancel === true
    ) {
      const pending = {
        requestId: request.id,
        invocationId,
        lateSuccess:
          (request.params.input as { lateSuccessAfterCancel?: unknown }).lateSuccessAfterCancel ===
          true,
      }
      pendingInvocations.set(invocationId, pending)
      pendingInvocations.set(cancellationId, pending)
    } else if (
      typeof request.params.input === 'object' &&
      request.params.input !== null &&
      (request.params.input as { readEnvironment?: unknown }).readEnvironment === true
    ) {
      write(request.id, {
        invocationId,
        output: {
          secret: process.env.PRAXIS_PLUGIN_SENTINEL_SECRET ?? null,
          pathAvailable: typeof process.env.PATH === 'string' && process.env.PATH.length > 0,
        },
      })
    } else {
      write(request.id, { invocationId, output: request.params.input })
    }
  } else if (request.method === 'capability.cancel') {
    const invocationId = String(request.params.invocationId)
    const pending = pendingInvocations.get(invocationId)
    write(request.id, { invocationId, accepted: true })
    if (pending) {
      for (const [key, value] of pendingInvocations) {
        if (value === pending) pendingInvocations.delete(key)
      }
      setTimeout(() => {
        if (pending.lateSuccess) {
          write(pending.requestId, {
            invocationId: pending.invocationId,
            output: { value: 'late success must be ignored' },
          })
        } else {
          writeError(pending.requestId, {
            code: 'PROCESS_PLUGIN_CANCELLED',
            category: 'cancelled',
            message: 'Plugin invocation was cancelled.',
            retryable: false,
          })
        }
      }, 10)
    }
  } else if (request.method === 'shutdown') {
    write(request.id, { accepted: true })
    input.close()
  }
})

function write(id: string, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
}

function writeError(id: string, error: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error })}\n`)
}
