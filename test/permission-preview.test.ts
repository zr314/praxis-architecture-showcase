import assert from 'node:assert/strict'
import test from 'node:test'
import {
  boundedPreviewText,
  materializePreviewTabs,
  permissionPreview,
} from '../apps/cli/src/ui/permissionPreview.js'

test('edit permission preview exposes bounded before and after text', () => {
  assert.deepEqual(
    permissionPreview({
      tool: 'edit',
      input: { oldText: 'before\r\nmiddle', newText: 'after\nmiddle' },
    }),
    { kind: 'edit', before: 'before\nmiddle', after: 'after\nmiddle' },
  )
})

test('write permission preview exposes bounded whole-file content and mode', () => {
  assert.deepEqual(
    permissionPreview({
      tool: 'write',
      input: { content: 'first\r\nsecond', createOnly: true },
    }),
    {
      kind: 'write',
      mode: 'CREATE ONLY',
      content: 'first\nsecond',
    },
  )

  assert.deepEqual(
    permissionPreview({
      tool: 'write',
      input: { content: '' },
    }),
    {
      kind: 'write',
      mode: 'CREATE OR REPLACE',
      content: '(empty)',
    },
  )
})

test('preview marks empty text and uses one ellipsis for either limit', () => {
  assert.equal(boundedPreviewText(''), '(empty)')
  assert.equal(boundedPreviewText('one\ntwo\nthree\nfour'), 'one\ntwo\nthree…')
  assert.equal(boundedPreviewText('x'.repeat(241)), `${'x'.repeat(240)}…`)
})

test('preview neutralizes terminal control characters but preserves tabs and LF', () => {
  assert.equal(boundedPreviewText('safe\u001b[31m\tline\nnext\u007f'), 'safe�[31m\tline\nnext�')
})

test('display materialization expands preview tabs to the fixed two-cell convention', () => {
  assert.equal(materializePreviewTabs('one\ttwo\n\tthree'), 'one  two\n  three')
})

test('unsupported and malformed requests have no preview', () => {
  assert.equal(permissionPreview({ tool: 'read', input: {} }), undefined)
  assert.equal(permissionPreview({ tool: 'edit', input: { oldText: 'only' } }), undefined)
  assert.equal(permissionPreview({ tool: 'write', input: {} }), undefined)
})
