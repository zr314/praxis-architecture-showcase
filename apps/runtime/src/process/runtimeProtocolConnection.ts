import type { ProtocolConnection } from '@praxis/client'
import type {
  EventNotification,
  JsonRpcRequest,
  ProtocolMessage,
  RpcError,
  RuntimeMethod,
} from '@praxis/protocol'
import { assertProtocolMessage, assertProtocolResult, ProtocolCodecError } from '@praxis/protocol'
import {
  NdjsonProcessConnection,
  type NdjsonProcessConnectionOptions,
  type ProcessConnectionFailureContext,
  type ProcessConnectionFailureKind,
  type ProcessMessageCodec,
} from './ndjsonProcessConnection.js'

export type RuntimeProtocolConnectionOptions = Omit<
  NdjsonProcessConnectionOptions<EventNotification>,
  'codec' | 'failure'
> & {
  failure?: (kind: ProcessConnectionFailureKind, context: ProcessConnectionFailureContext) => Error
  protocolFailure?: (error: Error) => Error
}

export class RuntimeRpcRequestError extends Error {
  readonly code: string
  readonly data?: unknown
  readonly retryable: boolean

  constructor(readonly rpc: RpcError) {
    super(`${rpc.code}: ${rpc.message}`)
    this.name = 'RpcRequestError'
    this.code = rpc.code
    this.data = rpc.data
    this.retryable = rpc.retryable ?? false
  }
}

/** Formal Runtime protocol adapter over the shared bounded NDJSON process transport. */
export class RuntimeProtocolConnection implements ProtocolConnection {
  readonly #connection: NdjsonProcessConnection<EventNotification>

  constructor(
    command: string,
    args: readonly string[],
    options: RuntimeProtocolConnectionOptions = {},
  ) {
    const { failure = runtimeProtocolConnectionFailure, protocolFailure, ...transport } = options
    this.#connection = new NdjsonProcessConnection(command, args, {
      ...transport,
      codec:
        protocolFailure === undefined
          ? runtimeProtocolCodec
          : {
              decode(value, source, context) {
                try {
                  return runtimeProtocolCodec.decode(value, source, context)
                } catch (error) {
                  throw protocolFailure(
                    error instanceof Error ? error : new Error('Invalid Runtime protocol output.'),
                  )
                }
              },
            },
      failure,
      stderr: transport.stderr ?? 'inherit',
    })
  }

  get pid(): number | undefined {
    return this.#connection.pid
  }

  get stderr(): string {
    return this.#connection.stderr
  }

  get stderrCapturedBytes(): number {
    return this.#connection.stderrCapturedBytes
  }

  get stderrTotalBytes(): number {
    return this.#connection.stderrTotalBytes
  }

  get stderrTruncated(): boolean {
    return this.#connection.stderrTruncated
  }

  request<T>(request: JsonRpcRequest): Promise<T> {
    return this.#connection.request<T>(request)
  }

  notifications(): AsyncIterable<EventNotification> {
    return this.#connection.notifications()
  }

  close(): Promise<void> {
    return this.#connection.close()
  }
}

export const runtimeProtocolCodec: ProcessMessageCodec<EventNotification> = {
  decode(value, _source, context) {
    try {
      assertProtocolMessage(value)
    } catch (error) {
      const requestId =
        error instanceof ProtocolCodecError && error.requestId ? error.requestId : undefined
      const method = requestId ? context.pendingMethod(requestId) : undefined
      const focusedError = protocolResultError(value, method)
      throw new Error(
        `Runtime wrote a schema-invalid protocol message to stdout${
          method ? ` for ${method}` : ''
        }: ${
          focusedError ??
          (error instanceof Error ? error.message : 'unknown schema validation error')
        }`,
      )
    }

    const message = value as ProtocolMessage
    if ('method' in message) {
      if (isEventNotification(message)) {
        return { type: 'notification', notification: message }
      }
      throw new Error('Runtime wrote a request on its response stream.')
    }
    if ('error' in message) {
      return {
        type: 'response',
        id: message.id,
        error: new RuntimeRpcRequestError(message.error),
      }
    }
    const method = context.pendingMethod(message.id)
    if (method) assertProtocolResult(method as RuntimeMethod, message.id, message.result)
    return { type: 'response', id: message.id, result: message.result }
  },
}

export function runtimeProtocolConnectionFailure(
  kind: ProcessConnectionFailureKind,
  context: ProcessConnectionFailureContext,
): Error {
  switch (kind) {
    case 'closed':
      return new Error('Runtime connection is closed.')
    case 'spawn_failed':
      return context.cause ?? new Error('Runtime process could not be started.')
    case 'launch_input_failed':
      return context.cause ?? new Error('Runtime launch input could not be written.')
    case 'write_failed':
      return context.cause ?? new Error('Runtime request could not be written.')
    case 'timeout':
      return new Error(
        `Runtime request timed out${context.method ? ` for ${context.method}` : ''}.`,
      )
    case 'malformed_stdout':
      return new Error('Runtime wrote malformed JSON to stdout.')
    case 'oversized_stdout':
      return new Error('Runtime wrote an oversized stdout line.')
    case 'stdout_closed':
      return new Error('Runtime stdout closed.')
    case 'exited':
      return new Error(
        `Runtime exited unexpectedly (code=${String(context.code)}, signal=${String(context.signal)}).`,
      )
  }
}

function protocolResultError(value: unknown, method: string | undefined): string | undefined {
  if (!method || !isRecord(value) || typeof value.id !== 'string' || !('result' in value)) {
    return undefined
  }
  try {
    assertProtocolResult(method as RuntimeMethod, value.id, value.result)
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : 'Method result validation failed.'
  }
}

function isEventNotification(message: ProtocolMessage): message is EventNotification {
  return 'method' in message && message.method === 'event'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
