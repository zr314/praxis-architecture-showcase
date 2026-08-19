import assert from 'node:assert/strict'
import test from 'node:test'
import { isPortableRelativeEvaluationPath } from '../apps/runtime/src/evaluation/portablePath.js'

test('accepts only portable unambiguous relative evaluation paths', () => {
  for (const path of ['notes/input.txt', 'allowed.txt', 'unicode/数据.txt']) {
    assert.equal(isPortableRelativeEvaluationPath(path), true, path)
  }

  for (const path of [
    '',
    '/absolute.txt',
    '../escape.txt',
    'nested/../escape.txt',
    'nested\\ambiguous.txt',
    'C:/drive.txt',
    'carrier.txt:secret',
    'CON',
    'con.txt',
    'dir/NUL.log',
    'COM1.json',
    'lpt9',
    'bad<name.txt',
    'bad>name.txt',
    'bad"name.txt',
    'bad|name.txt',
    'bad?name.txt',
    'bad*name.txt',
    'bad\u0001name.txt',
    'trailing.',
    'trailing ',
    'nested//empty.txt',
    './dot.txt',
    'nested/./dot.txt',
  ]) {
    assert.equal(isPortableRelativeEvaluationPath(path), false, path)
  }
})
