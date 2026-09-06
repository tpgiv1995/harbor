'use strict';

// The right-click menu model. Spelling suggestions are reachable ONLY through
// Chromium's context-menu params, so this pure core is where the params turn
// into something the renderer can draw, and where an empty right-click is
// refused before it can flash a blank panel.

const test = require('node:test');
const assert = require('node:assert');
const {
  buildMenuModel,
  menuHasContent,
  readDictionaryState,
  createContextMenuHandlers,
  attachContextMenu,
  MAX_SUGGESTIONS,
} = require('../../src/main/context-menu.js');

test('a misspelled word carries its suggestions and the add-to-dictionary offer', () => {
  const model = buildMenuModel({
    x: 120,
    y: 340,
    isEditable: true,
    misspelledWord: 'teh',
    dictionarySuggestions: ['the', 'tech', 'ten'],
    editFlags: { canPaste: true },
  });
  assert.equal(model.misspelledWord, 'teh');
  assert.deepEqual(model.suggestions, ['the', 'tech', 'ten']);
  assert.equal(model.canAddToDictionary, true);
  assert.equal(model.x, 120);
  assert.equal(model.y, 340);
});

test('a long suggestion tail is capped rather than turning the menu into a scroller', () => {
  const many = Array.from({ length: 20 }, (_, i) => `word${i}`);
  const model = buildMenuModel({ isEditable: true, misspelledWord: 'wrd', dictionarySuggestions: many });
  assert.equal(model.suggestions.length, MAX_SUGGESTIONS);
  assert.equal(model.suggestions[0], 'word0');
});

test('a correctly spelled word offers no suggestions and no dictionary entry', () => {
  const model = buildMenuModel({
    isEditable: true,
    misspelledWord: '',
    // Chromium can leave a stale suggestion array on the params; an empty
    // misspelledWord is the authority, not the array.
    dictionarySuggestions: ['leftover'],
    editFlags: { canPaste: true },
  });
  assert.deepEqual(model.suggestions, []);
  assert.equal(model.canAddToDictionary, false);
});

test('a misspelling Chromium has no guesses for still earns a menu', () => {
  // Names and jargon are the common case here: no suggestion is possible, but
  // "add to dictionary" is exactly what the user wants.
  const model = buildMenuModel({ isEditable: true, misspelledWord: 'example-org', dictionarySuggestions: [] });
  assert.deepEqual(model.suggestions, []);
  assert.equal(model.canAddToDictionary, true);
  assert.equal(menuHasContent(model), true);
});

test('cut and paste are offered only where they can actually work', () => {
  const readOnlySelection = buildMenuModel({ isEditable: false, selectionText: 'copy me' });
  assert.equal(readOnlySelection.actions.copy, true);
  assert.equal(readOnlySelection.actions.cut, false, 'cannot cut out of non-editable text');
  assert.equal(readOnlySelection.actions.paste, false);

  const editableEmpty = buildMenuModel({ isEditable: true, selectionText: '', editFlags: { canPaste: true } });
  assert.equal(editableEmpty.actions.copy, false, 'nothing selected, nothing to copy');
  assert.equal(editableEmpty.actions.paste, true);
  assert.equal(editableEmpty.actions.selectAll, true);
});

test('right-clicking inert chrome produces no menu at all', () => {
  const model = buildMenuModel({ isEditable: false, selectionText: '' });
  assert.equal(menuHasContent(model), false);
});

test('attachContextMenu pushes drawable menus and swallows empty ones', () => {
  const listeners = {};
  const webContents = {
    on: (name, fn) => { listeners[name] = fn; },
    removeListener: (name) => { delete listeners[name]; },
  };
  const pushed = [];
  const detach = attachContextMenu(webContents, { send: (payload) => pushed.push(payload) });

  listeners['context-menu'](null, { isEditable: false, selectionText: '' });
  assert.equal(pushed.length, 0, 'an empty right-click must not flash a panel');

  listeners['context-menu'](null, { isEditable: true, misspelledWord: 'teh', dictionarySuggestions: ['the'] });
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].misspelledWord, 'teh');

  detach();
  assert.equal(listeners['context-menu'], undefined);
});

test('replace routes through Chromium so its misspelling markers stay correct', () => {
  const calls = [];
  const handlers = createContextMenuHandlers({
    getWebContents: () => ({ replaceMisspelling: (text) => calls.push(text) }),
    getSession: () => null,
  });
  assert.equal(handlers['context-menu:replace-misspelling'](null, { text: 'the' }), true);
  assert.deepEqual(calls, ['the']);
  // An empty pick is a no-op rather than a blanking of the word.
  assert.equal(handlers['context-menu:replace-misspelling'](null, { text: '' }), false);
  assert.deepEqual(calls, ['the']);
});

test('edit actions are whitelisted, so a forged channel cannot call arbitrary WebContents methods', () => {
  const called = [];
  const target = {
    cut: () => called.push('cut'),
    copy: () => called.push('copy'),
    paste: () => called.push('paste'),
    selectAll: () => called.push('selectAll'),
    destroy: () => called.push('destroy'),
    loadURL: () => called.push('loadURL'),
  };
  const handlers = createContextMenuHandlers({ getWebContents: () => target, getSession: () => null });

  assert.equal(handlers['context-menu:edit-action'](null, { action: 'copy' }), true);
  assert.equal(handlers['context-menu:edit-action'](null, { action: 'destroy' }), false);
  assert.equal(handlers['context-menu:edit-action'](null, { action: 'loadURL' }), false);
  assert.deepEqual(called, ['copy'], 'only the whitelisted action ran');
});

test('spell status reports a missing dictionary instead of implying words are checked', () => {
  const withoutDictionary = readDictionaryState({
    userDataPath: '/nope',
    fsImpl: { readdirSync: () => { throw new Error('ENOENT'); } },
  });
  assert.equal(withoutDictionary.downloaded, false);
  assert.deepEqual(withoutDictionary.files, []);

  const withDictionary = readDictionaryState({
    userDataPath: '/home/you/.config/Harbor',
    fsImpl: { readdirSync: () => ['en-US-10-1.bdic', 'notes.txt'] },
  });
  assert.equal(withDictionary.downloaded, true);
  assert.deepEqual(withDictionary.files, ['en-US-10-1.bdic'], 'only .bdic files count as a dictionary');
});
