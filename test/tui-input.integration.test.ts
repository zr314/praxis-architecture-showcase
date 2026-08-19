import assert from 'node:assert/strict'
import test from 'node:test'
import { navigatePicker, type CatalogPickerState } from '../apps/cli/src/ui/catalogPickerModel.js'
import {
  moveSessionSelection,
  selectedSession,
  updateSessionQuery,
  type SessionPickerState,
} from '../apps/cli/src/ui/SessionPicker.js'
import { TerminalEditorModel } from '../apps/cli/src/ui/terminalEditor.js'
import { editorViewport } from '../apps/cli/src/ui/tuiModel.js'

test('terminal input matrix preserves Unicode, paste, deletion, history draft, and completion', () => {
  const editor = new TerminalEditorModel(['/session'])
  editor.insert('\u001b[200~中文 😀\r\nsecond\u001b[201~')
  assert.equal(editor.value, '中文 😀\nsecond')
  editor.moveToLineStart()
  editor.deleteForward()
  assert.equal(editor.value, '中文 😀\necond')
  editor.moveUp()
  editor.moveToLineEnd()
  editor.backspace()
  assert.equal(editor.value, '中文 \necond')
  editor.moveToLineEnd()
  editor.insert(' restored')
  assert.equal(editor.submit(), '中文  restored\necond')

  editor.insert('draft')
  assert.equal(editor.previousHistory(), '中文  restored\necond')
  assert.equal(editor.nextHistory(), 'draft')
  editor.replace('/sess')
  assert.equal(editor.complete(), '/session ')
})

test('bounded editor viewport keeps the logical cursor visible across resize', () => {
  const value = Array.from({ length: 12 }, (_, index) => `第${index}行 😀 content`).join('\n')
  const cursorIndex = value.indexOf('第8行') + 2
  for (const columns of [18, 32, 74]) {
    const viewport = editorViewport(value, cursorIndex, columns, 4)
    assert.ok(viewport.hiddenAbove > 0)
    assert.ok(viewport.cursorIndex >= 0)
    assert.ok(viewport.cursorIndex <= viewport.value.length)
    assert.equal(viewport.value.slice(viewport.cursorIndex).startsWith('行'), true)
  }
})

test('catalog and session pickers share bounded page and edge navigation', () => {
  const catalog = catalogState()
  assert.equal(navigatePicker(catalog, 'pageDown', 3).selected, 3)
  assert.equal(navigatePicker(catalog, 'end').selected, 5)
  assert.equal(navigatePicker({ ...catalog, selected: 5 }, 'pageDown', 3).selected, 5)
  assert.equal(navigatePicker({ ...catalog, selected: 5 }, 'home').selected, 0)

  const sessions = sessionState()
  assert.equal(moveSessionSelection(sessions, 'pageDown', 3).selected, 3)
  assert.equal(moveSessionSelection(sessions, 'end').selected, 5)
  assert.equal(moveSessionSelection({ ...sessions, selected: 5 }, 'pageDown', 3).selected, 5)
  const searched = updateSessionQuery(sessions, 'Task 4') as Extract<
    SessionPickerState,
    { status: 'ready' }
  >
  assert.equal(selectedSession(searched)?.name, 'Task 4')
})

function catalogState(): Extract<CatalogPickerState, { status: 'ready' }> {
  return {
    status: 'ready',
    view: 'providers',
    intent: 'select',
    query: '',
    currentProvider: 'mock',
    currentModel: 'mock-v1',
    providers: Array.from({ length: 6 }, (_, index) => ({
      id: `provider-${index}`,
      status: 'authenticated' as const,
      health: 'healthy',
      modelCount: 1,
    })),
    models: [],
    selected: 0,
  }
}

function sessionState(): Extract<SessionPickerState, { status: 'ready' }> {
  return {
    status: 'ready',
    query: '',
    currentSessionId: 'session-0',
    sessions: Array.from({ length: 6 }, (_, index) => ({
      sessionId: `session-${index}`,
      state: 'closed' as const,
      cwd: `D:\\workspace-${index}`,
      provider: 'mock',
      model: 'mock-v1',
      name: `Task ${index}`,
      updatedAt: new Date(index * 1000).toISOString(),
    })),
    selected: 0,
  }
}
