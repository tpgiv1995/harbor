'use strict';

const { registerIpcHandler } = require('./rpc/ipc-transport.js');

const fs = require('node:fs');
const path = require('node:path');

// Right-click in Harbor draws a RENDERER menu, not a native one: the app is
// frameless Slate and a GTK popup inside it reads as a foreign object (the
// xterm pane already draws its own `.terminal-context-menu` for exactly this
// reason). Chromium still owns the spellchecker; only the presentation is ours.
//
// The suggestions can come from NOWHERE ELSE than the `context-menu` event.
// Electron exposes no "give me suggestions for this word" API, so the
// browser-side params are the single source of truth and the renderer is
// handed a finished model rather than asked to work anything out.
//
// A renderer that calls preventDefault() on the DOM contextmenu event (the
// xterm pane does) never triggers this event at all, so the terminal keeps its
// own menu with no suppression logic needed here.

const EDIT_ACTIONS = new Set(['cut', 'copy', 'paste', 'selectAll']);

// How many suggestions are worth showing. Chromium often returns a long tail
// of near-identical stems; past about six the menu is scrolling rather than
// helping.
const MAX_SUGGESTIONS = 6;

// Pure: context-menu params in, what the menu should show out. Deliberately
// free of Electron so the shape is unit-testable.
function buildMenuModel(params = {}) {
  const misspelledWord = String(params.misspelledWord || '');
  const suggestions = misspelledWord
    ? (params.dictionarySuggestions || []).map(String).slice(0, MAX_SUGGESTIONS)
    : [];
  const flags = params.editFlags || {};
  const editable = Boolean(params.isEditable);
  const hasSelection = Boolean(String(params.selectionText || '').length);
  return {
    x: Number.isFinite(params.x) ? params.x : 0,
    y: Number.isFinite(params.y) ? params.y : 0,
    editable,
    misspelledWord,
    suggestions,
    // A misspelling with NO suggestions still earns a menu: "add to dictionary"
    // is the entire point for names, jargon, and command fragments.
    canAddToDictionary: Boolean(misspelledWord),
    actions: {
      cut: editable && hasSelection && flags.canCut !== false,
      copy: hasSelection && flags.canCopy !== false,
      paste: editable && flags.canPaste !== false,
      selectAll: editable,
    },
  };
}

// Right-clicking empty chrome with nothing selected should do nothing at all
// rather than flash an empty panel.
function menuHasContent(model) {
  if (!model) return false;
  return Boolean(
    model.suggestions.length
    || model.canAddToDictionary
    || model.actions.cut
    || model.actions.copy
    || model.actions.paste
    || model.actions.selectAll,
  );
}

// Which dictionary files Chromium has actually landed on disk. Spellchecking on
// Linux needs a one-time .bdic fetch, so "spellchecker enabled" is NOT the same
// claim as "words are being checked"; this reports the difference honestly
// instead of letting a silent download failure look like a working feature.
function readDictionaryState({ userDataPath, fsImpl = fs } = {}) {
  const directory = path.join(String(userDataPath || ''), 'Dictionaries');
  try {
    const files = fsImpl.readdirSync(directory).filter((name) => name.endsWith('.bdic'));
    return { directory, files, downloaded: files.length > 0 };
  } catch {
    return { directory, files: [], downloaded: false };
  }
}

function createContextMenuHandlers({ getWebContents, getSession, userDataPath, fsImpl = fs }) {
  const contents = () => getWebContents?.() || null;
  return {
    'context-menu:replace-misspelling': (_event, { text } = {}) => {
      const target = contents();
      const word = String(text || '');
      if (!target || !word) return false;
      // Chromium's own replace keeps its misspelling markers consistent; a
      // renderer-side splice would leave the old marker painted under the new
      // word until the next full recheck.
      target.replaceMisspelling(word);
      return true;
    },
    'context-menu:add-to-dictionary': (_event, { word } = {}) => {
      const session = getSession?.();
      const value = String(word || '');
      if (!session || !value) return false;
      session.addWordToSpellCheckerDictionary(value);
      return true;
    },
    'context-menu:edit-action': (_event, { action } = {}) => {
      const target = contents();
      if (!target || !EDIT_ACTIONS.has(action)) return false;
      // Routed through WebContents rather than document.execCommand because
      // Chromium refuses execCommand('paste') in page context.
      target[action]();
      return true;
    },
    'context-menu:spell-status': () => {
      const session = getSession?.();
      return {
        enabled: Boolean(contents()?.session?.spellCheckerEnabled ?? session?.spellCheckerEnabled),
        languages: session?.getSpellCheckerLanguages?.() || [],
        dictionary: readDictionaryState({ userDataPath, fsImpl }),
      };
    },
  };
}

function registerContextMenuIpc(ipcMain, dependencies) {
  const handlers = createContextMenuHandlers(dependencies);
  for (const [channel, handler] of Object.entries(handlers)) {
    registerIpcHandler(dependencies?.router, ipcMain, channel, handler);
  }
  return handlers;
}

// Wire the browser-side event to a renderer push. Kept separate from the IPC
// handlers so a test can drive either half alone.
function attachContextMenu(webContents, { send } = {}) {
  const push = send || ((payload) => webContents.send('context-menu:show', payload));
  const listener = (_event, params) => {
    const model = buildMenuModel(params);
    if (!menuHasContent(model)) return;
    push(model);
  };
  webContents.on('context-menu', listener);
  return () => webContents.removeListener('context-menu', listener);
}

module.exports = {
  EDIT_ACTIONS,
  MAX_SUGGESTIONS,
  buildMenuModel,
  menuHasContent,
  readDictionaryState,
  createContextMenuHandlers,
  registerContextMenuIpc,
  attachContextMenu,
};
