import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import {
  promptForSecret,
  readSecretLine,
  SecureInputError,
  type SecureTtyInput,
} from '../apps/cli/src/securePrompt.js'

test('bounded stdin accepts one line without writing the secret', async () => {
  const input = new PassThrough()
  input.end('fixture-secret\r\n')

  assert.equal(await readSecretLine(input), 'fixture-secret')
})

test('bounded stdin rejects empty, multiline, and oversized values', async () => {
  for (const value of ['\n', 'first\nsecond\n', `${'x'.repeat(8_193)}\n`]) {
    const input = new PassThrough()
    input.end(value)
    await assert.rejects(() => readSecretLine(input), SecureInputError)
  }
})

test('TTY prompt disables echo and restores raw mode after success', async () => {
  const input = ttyInput()
  const output = ttyOutput()
  const signals = new EventEmitter()
  const modes: boolean[] = []
  input.setRawMode = (mode) => {
    input.isRaw = mode
    modes.push(mode)
  }

  const result = promptForSecret({ input, output, signals })
  input.write('fixture-secret\r')

  assert.equal(await result, 'fixture-secret')
  assert.deepEqual(modes, [true, false])
  assert.equal(output.captured(), 'API key: \n')
  assert.doesNotMatch(output.captured(), /fixture-secret/)
})

test('TTY prompt restores raw mode and reports cancellation on Ctrl+C', async () => {
  const input = ttyInput()
  const output = ttyOutput()
  const signals = new EventEmitter()
  const modes: boolean[] = []
  input.setRawMode = (mode) => {
    input.isRaw = mode
    modes.push(mode)
  }

  const result = promptForSecret({ input, output, signals })
  input.write('\x03')

  await assert.rejects(result, (error: unknown) => {
    assert.equal((error as SecureInputError).code, 'CLI_CANCELLED')
    return true
  })
  assert.deepEqual(modes, [true, false])
  assert.doesNotMatch(output.captured(), /fixture-secret/)
})

function ttyInput(): SecureTtyInput & PassThrough {
  const input = new PassThrough() as SecureTtyInput & PassThrough
  input.isTTY = true
  input.isRaw = false
  input.setRawMode = () => undefined
  return input
}

function ttyOutput(): PassThrough & { isTTY: boolean; captured(): string } {
  const output = new PassThrough() as PassThrough & {
    isTTY: boolean
    captured(): string
  }
  const chunks: Buffer[] = []
  output.isTTY = true
  output.on('data', (chunk: Buffer) => chunks.push(chunk))
  output.captured = () => Buffer.concat(chunks).toString('utf8')
  return output
}
