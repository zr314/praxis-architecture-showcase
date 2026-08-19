import assert from 'node:assert/strict'
import test from 'node:test'
import { clipboardCommands, osc52Sequence } from '../apps/cli/src/ui/clipboard.js'

test('clipboard commands are explicit and shell-free on every supported platform', () => {
  assert.deepEqual(clipboardCommands('win32'), [{ command: 'clip.exe', args: [] }])
  assert.deepEqual(clipboardCommands('darwin'), [{ command: 'pbcopy', args: [] }])
  assert.deepEqual(clipboardCommands('linux'), [
    { command: 'wl-copy', args: [] },
    { command: 'xclip', args: ['-selection', 'clipboard'] },
  ])
})

test('OSC 52 fallback base64-encodes UTF-8 text', () => {
  const text = 'Praxis 中文'
  assert.equal(
    osc52Sequence(text),
    `\u001b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\u0007`,
  )
})
