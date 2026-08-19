import assert from 'node:assert/strict'
import test from 'node:test'
import { prepareTextEdit } from '../apps/runtime/src/tools/textEdit.js'

test('multiline LF input edits CRLF source and preserves CRLF', () => {
  const result = prepareTextEdit('before\r\nmiddle\r\nafter\r\n', 'before\nmiddle', 'first\nsecond')

  assert.deepEqual(result, {
    ok: true,
    content: 'first\r\nsecond\r\nafter\r\n',
    matchMode: 'line-ending-normalized',
    lineEnding: 'crlf',
  })
})

test('an exact LF edit remains exact and keeps LF', () => {
  const result = prepareTextEdit('before\nmiddle\nafter\n', 'before\nmiddle', 'first\nsecond')

  assert.deepEqual(result, {
    ok: true,
    content: 'first\nsecond\nafter\n',
    matchMode: 'exact',
    lineEnding: 'lf',
  })
})

test('mixed untouched regions retain their original line endings', () => {
  const result = prepareTextEdit('keep\r\nold\nvalue\r\nkeep\n', 'old\r\nvalue', 'new\nvalue')

  assert.deepEqual(result, {
    ok: true,
    content: 'keep\r\nnew\nvalue\r\nkeep\n',
    matchMode: 'line-ending-normalized',
    lineEnding: 'lf',
  })
})

test('logically duplicated CRLF and LF text is ambiguous', () => {
  assert.deepEqual(prepareTextEdit('same\r\ntext\nsame\ntext\n', 'same\ntext', 'replacement'), {
    ok: false,
    reason: 'ambiguous',
  })
})

test('bare carriage returns remain literal', () => {
  assert.deepEqual(prepareTextEdit('a\rb', 'a\nb', 'changed'), {
    ok: false,
    reason: 'not_found',
  })
})

test('CRLF input can exactly match CRLF source', () => {
  const result = prepareTextEdit('a\r\nb\r\n', 'a\r\nb', 'x\ny')
  assert.deepEqual(result, {
    ok: true,
    content: 'x\r\ny\r\n',
    matchMode: 'exact',
    lineEnding: 'crlf',
  })
})

test('a missing single-line occurrence remains not found', () => {
  assert.deepEqual(prepareTextEdit('alpha\n', 'beta', 'gamma'), {
    ok: false,
    reason: 'not_found',
  })
})

test('overlapping exact multiline occurrences are ambiguous', () => {
  assert.deepEqual(prepareTextEdit('a\na\na', 'a\na', 'replacement'), {
    ok: false,
    reason: 'ambiguous',
  })
})

test('overlapping CRLF-normalized multiline occurrences are ambiguous', () => {
  assert.deepEqual(prepareTextEdit('a\r\na\r\na', 'a\na', 'replacement'), {
    ok: false,
    reason: 'ambiguous',
  })
})

test('overlapping mixed-ending multiline occurrences are ambiguous', () => {
  assert.deepEqual(prepareTextEdit('a\r\na\na', 'a\r\na', 'replacement'), {
    ok: false,
    reason: 'ambiguous',
  })
})
