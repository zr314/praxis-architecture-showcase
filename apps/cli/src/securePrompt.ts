import type { Readable, Writable } from 'node:stream'

export const MAX_SECRET_BYTES = 8_192

export class SecureInputError extends Error {
  constructor(
    message: string,
    readonly code: 'INVALID_PARAMS' | 'AUTH_REQUIRED' | 'CLI_CANCELLED' = 'INVALID_PARAMS',
  ) {
    super(message)
    this.name = 'SecureInputError'
  }
}

export async function readSecretLine(
  input: Readable = process.stdin,
  maximumBytes = MAX_SECRET_BYTES,
): Promise<string> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of input) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    bytes += buffer.byteLength
    if (bytes > maximumBytes + 2) {
      throw new SecureInputError(`Credential must be at most ${maximumBytes} bytes.`)
    }
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  const value = text.replace(/\r?\n$/, '')
  validateSecret(value, maximumBytes)
  return value
}

export type SecureTtyInput = Readable & {
  isTTY?: boolean
  isRaw?: boolean
  setRawMode?: (mode: boolean) => unknown
  resume(): unknown
  pause(): unknown
}

export type SecurePromptOptions = {
  input?: SecureTtyInput
  output?: Writable & { isTTY?: boolean }
  prompt?: string
  maximumBytes?: number
  signals?: {
    once(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown
    off(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown
  }
}

export async function promptForSecret(options: SecurePromptOptions = {}): Promise<string> {
  const input = options.input ?? process.stdin
  const output = options.output ?? process.stdout
  const maximumBytes = options.maximumBytes ?? MAX_SECRET_BYTES
  const signals = options.signals ?? process
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') {
    throw new SecureInputError(
      'Secure terminal input is unavailable; use --stdin or the provider environment variable.',
      'AUTH_REQUIRED',
    )
  }

  const wasRaw = input.isRaw === true
  const bytes: number[] = []
  output.write(options.prompt ?? 'API key: ')
  input.setRawMode(true)
  input.resume()

  try {
    return await new Promise<string>((resolve, reject) => {
      const cleanup = () => {
        input.off('data', onData)
        signals.off('SIGINT', onInterrupt)
        signals.off('SIGTERM', onInterrupt)
      }
      const finish = (action: () => void) => {
        cleanup()
        action()
      }
      const onInterrupt = () =>
        finish(() => reject(new SecureInputError('Credential entry cancelled.', 'CLI_CANCELLED')))
      const onData = (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        for (const byte of buffer) {
          if (byte === 0x03 || byte === 0x1b) {
            finish(() =>
              reject(new SecureInputError('Credential entry cancelled.', 'CLI_CANCELLED')),
            )
            return
          }
          if (byte === 0x0d || byte === 0x0a) {
            const value = Buffer.from(bytes).toString('utf8')
            try {
              validateSecret(value, maximumBytes)
              finish(() => resolve(value))
            } catch (error) {
              finish(() => reject(error))
            }
            return
          }
          if (byte === 0x08 || byte === 0x7f) {
            bytes.pop()
            continue
          }
          bytes.push(byte)
          if (bytes.length > maximumBytes) {
            finish(() =>
              reject(new SecureInputError(`Credential must be at most ${maximumBytes} bytes.`)),
            )
            return
          }
        }
      }
      input.on('data', onData)
      signals.once('SIGINT', onInterrupt)
      signals.once('SIGTERM', onInterrupt)
    })
  } finally {
    input.setRawMode(wasRaw)
    input.pause()
    output.write('\n')
  }
}

function validateSecret(value: string, maximumBytes: number): void {
  if (!value.trim()) throw new SecureInputError('Credential must not be empty.')
  if (/[\r\n]/.test(value)) {
    throw new SecureInputError('Credential must contain exactly one line.')
  }
  if (Buffer.byteLength(value) > maximumBytes) {
    throw new SecureInputError(`Credential must be at most ${maximumBytes} bytes.`)
  }
}
