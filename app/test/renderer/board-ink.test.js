'use strict';

// The Board draws on a dark canvas in Excalidraw's LIGHT theme (its dark theme inverts the
// finished canvas with a filter and flips every colour), so stored ink that would not read
// on the canvas is SHOWN in a readable ink while the file keeps what it stored.
// Everything under test is pure (board-ink.cjs).

const assert = require('node:assert/strict');
const test = require('node:test');
const ink = require('../../src/renderer/whiteboard/board-ink.cjs');
const model = require('../../src/shared/board-model.cjs');

const {
  CANVAS_DARK, CANVAS_WHITE_PICKED, INK_LIGHT, INK_DARK,
  canvasForDisplay, canvasForStorage, readableInk, contrastRatio, applyBoardInk, fixBoundTextInk, restoreStoredInk, displayScene,
} = ink;

const el = (over = {}) => ({
  id: 'e', type: 'rectangle', x: 0, y: 0, width: 100, height: 60, isDeleted: false, opacity: 100,
  strokeColor: '#1e1e1e', backgroundColor: 'transparent', fillStyle: 'solid', boundElements: [], ...over,
});

// ---- The canvas ---------------------------------------------------------------------

test('a board stored with the old white default, or none, shows the dark canvas', () => {
  for (const stored of [undefined, null, '', '#ffffff', '#FFFFFF', '#fff', 'white', 'transparent']) {
    assert.equal(canvasForDisplay(stored), CANVAS_DARK, `${JSON.stringify(stored)} is the retired default`);
  }
});

test('a background the user chose on purpose stays', () => {
  assert.equal(canvasForDisplay('#f8f9fa'), '#f8f9fa');
  assert.equal(canvasForDisplay('#0b2a3d'), '#0b2a3d');
  assert.equal(canvasForStorage('#f8f9fa'), '#f8f9fa');
  assert.equal(canvasForStorage(CANVAS_DARK), CANVAS_DARK);
});

test('a white picked on purpose is stored one level off white so it survives a reload', () => {
  const stored = canvasForStorage('#ffffff');
  assert.equal(stored, CANVAS_WHITE_PICKED);
  assert.equal(canvasForDisplay(stored), CANVAS_WHITE_PICKED, 'it is not mistaken for the retired default');
});

// ---- Readable ink -------------------------------------------------------------------

test('near-black and grey ink become the light ink on the dark canvas', () => {
  for (const color of ['#1e1e1e', '#1a1a1a', '#212529', '#343a40', '#495057', '#000000']) {
    assert.equal(readableInk(color, CANVAS_DARK, 3), INK_LIGHT, color);
  }
});

test('ink that already reads on the canvas is left exactly as it is', () => {
  for (const color of ['#e03131', '#2f9e44', '#1971c2', '#f08c00', '#ffffff', '#868e96', INK_LIGHT]) {
    assert.equal(readableInk(color, CANVAS_DARK, 3), color, color);
  }
});

test('a dark coloured ink keeps its hue and gets light enough to read', () => {
  const shown = readableInk('#1e3a8a', CANVAS_DARK, 4.5);
  assert.notEqual(shown, '#1e3a8a');
  assert.ok(contrastRatio(shown, CANVAS_DARK) >= 4.5, `${shown} reads`);
  const [r, , b] = ink.parseHex(shown);
  assert.ok(b > r, 'still a blue');
});

test('on a light canvas the same rule runs the other way', () => {
  assert.equal(readableInk(INK_LIGHT, '#f8f9fa', 3), INK_DARK);
  assert.equal(readableInk('#1e1e1e', '#f8f9fa', 3), '#1e1e1e');
});

// ---- Applying it to a board ---------------------------------------------------------

test('standalone text and connectors that would not read are shown light', () => {
  const ledger = new Map();
  const { elements, changed } = applyBoardInk([
    el({ id: 't', type: 'text', strokeColor: '#1e1e1e' }),
    el({ id: 'a', type: 'arrow', strokeColor: '#495057' }),
    el({ id: 'r', type: 'rectangle', strokeColor: '#1e1e1e' }),
  ], CANVAS_DARK, ledger);
  assert.equal(changed, true);
  assert.deepEqual(elements.map((e) => e.strokeColor), [INK_LIGHT, INK_LIGHT, INK_LIGHT]);
  assert.deepEqual([...ledger.keys()].sort(), ['a', 'r', 't']);
  assert.equal(ledger.get('t').stored, '#1e1e1e');
});

test('a sticky keeps its fill and its dark text', () => {
  const sticky = [
    el({ id: 'face', backgroundColor: '#ffe86d', strokeColor: 'transparent', boundElements: [{ type: 'text', id: 'lbl' }] }),
    el({ id: 'lbl', type: 'text', containerId: 'face', strokeColor: '#1a1a1a' }),
  ];
  const ledger = new Map();
  const out = applyBoardInk(sticky, CANVAS_DARK, ledger);
  assert.equal(out.changed, false);
  assert.equal(out.elements, sticky, 'nothing was copied');
  assert.equal(ledger.size, 0);
});

test('a label bound to a shape with no fill sits on the canvas, so it is shown light', () => {
  const out = applyBoardInk([
    el({ id: 'box', backgroundColor: 'transparent', strokeColor: '#ced4da', boundElements: [{ type: 'text', id: 'lbl' }] }),
    el({ id: 'lbl', type: 'text', containerId: 'box', strokeColor: '#1e1e1e' }),
  ], CANVAS_DARK, new Map());
  assert.equal(out.elements[1].strokeColor, INK_LIGHT);
});

test('text laid over a filled shape or a pasted image sits on that, not on the canvas', () => {
  const column = el({ id: 'col', x: 0, y: 0, width: 220, height: 460, backgroundColor: '#e7f5ff', strokeColor: '#74c0fc' });
  const title = el({ id: 'title', type: 'text', x: 16, y: 16, width: 80, height: 24, strokeColor: '#212529' });
  const outside = el({ id: 'out', type: 'text', x: 300, y: 16, width: 80, height: 24, strokeColor: '#212529' });
  const shot = el({ id: 'img', type: 'image', x: 600, y: 0, width: 300, height: 200, strokeColor: 'transparent' });
  const pen = el({ id: 'pen', type: 'freedraw', x: 620, y: 20, width: 100, height: 60, strokeColor: '#1e1e1e' });
  const out = applyBoardInk([column, title, outside, shot, pen], CANVAS_DARK, new Map());
  const by = Object.fromEntries(out.elements.map((e) => [e.id, e.strokeColor]));
  assert.equal(by.title, '#212529', 'dark text on a pastel column stays dark');
  assert.equal(by.out, INK_LIGHT, 'the same text off the column is on the canvas');
  assert.equal(by.pen, '#1e1e1e', 'a pen stroke on a screenshot is left as drawn');
  assert.equal(by.col, '#74c0fc');
});

test('a shape with its own opaque fill keeps its stored border', () => {
  const cell = el({ id: 'c', backgroundColor: '#ffffff', strokeColor: '#ced4da' });
  const filled = el({ id: 'f', backgroundColor: '#a5d8ff', strokeColor: '#1e1e1e' });
  const out = applyBoardInk([cell, filled], CANVAS_DARK, new Map());
  assert.equal(out.changed, false);
});

test('saving puts every stored colour back, byte for byte', () => {
  const original = [
    el({ id: 't', type: 'text', strokeColor: '#1e1e1e' }),
    el({ id: 'a', type: 'arrow', strokeColor: '#495057' }),
    el({ id: 'g', type: 'line', strokeColor: '#e03131' }),
  ];
  const ledger = new Map();
  const shown = applyBoardInk(original, CANVAS_DARK, ledger).elements;
  assert.notEqual(shown[0].strokeColor, '#1e1e1e');
  const stored = restoreStoredInk(shown, ledger);
  assert.deepEqual(stored.map((e) => e.strokeColor), original.map((e) => e.strokeColor));
  assert.deepEqual(stored.map((e) => e.id), original.map((e) => e.id));
});

test('a colour the user picks after loading is never reverted at save', () => {
  const ledger = new Map();
  const shown = applyBoardInk([el({ id: 't', type: 'text', strokeColor: '#1e1e1e' })], CANVAS_DARK, ledger).elements;
  const recoloured = [{ ...shown[0], strokeColor: '#e03131' }];
  const stored = restoreStoredInk(recoloured, ledger);
  assert.equal(stored[0].strokeColor, '#e03131');
});

test('applying twice changes nothing the second time', () => {
  const ledger = new Map();
  const first = applyBoardInk([el({ id: 't', type: 'text', strokeColor: '#1e1e1e' })], CANVAS_DARK, ledger).elements;
  const second = applyBoardInk(first, CANVAS_DARK, ledger);
  assert.equal(second.changed, false);
  assert.equal(second.elements, first);
});

test('deleted elements and unreadable colour strings are ignored', () => {
  const list = [
    el({ id: 'd', type: 'text', isDeleted: true, strokeColor: '#1e1e1e' }),
    el({ id: 'n', type: 'text', strokeColor: 'transparent' }),
    el({ id: 'r', type: 'text', strokeColor: 'rgb(30,30,30)' }),
  ];
  assert.equal(applyBoardInk(list, CANVAS_DARK, new Map()).changed, false);
});

test('picking a light canvas re-adapts: light ink goes dark, stored ink is untouched', () => {
  const ledger = new Map();
  const original = [
    el({ id: 'old', type: 'text', strokeColor: '#1e1e1e' }),
    el({ id: 'new', type: 'text', strokeColor: INK_LIGHT }),
  ];
  const onDark = applyBoardInk(original, CANVAS_DARK, ledger).elements;
  assert.deepEqual(onDark.map((e) => e.strokeColor), [INK_LIGHT, INK_LIGHT]);
  const bumps = [];
  const onLight = applyBoardInk(onDark, '#f8f9fa', ledger, (e, patch) => { bumps.push(e.id); return { ...e, ...patch, version: 2 }; });
  assert.deepEqual(onLight.elements.map((e) => e.strokeColor), ['#1e1e1e', INK_DARK]);
  assert.deepEqual(bumps.sort(), ['new', 'old'], 'each changed element is handed to the version bump');
  assert.deepEqual(restoreStoredInk(onLight.elements, ledger).map((e) => e.strokeColor), ['#1e1e1e', INK_LIGHT]);
});

test('displayScene gives an export the canvas and the readable ink without touching the stored scene', () => {
  const stored = {
    elements: [el({ id: 't', type: 'text', strokeColor: '#1e1e1e' })],
    appState: { viewBackgroundColor: '#ffffff', gridSize: 20 },
  };
  const shown = displayScene(stored);
  assert.equal(shown.appState.viewBackgroundColor, CANVAS_DARK);
  assert.equal(shown.appState.gridSize, 20);
  assert.equal(shown.elements[0].strokeColor, INK_LIGHT);
  assert.equal(stored.elements[0].strokeColor, '#1e1e1e');
  assert.equal(stored.appState.viewBackgroundColor, '#ffffff');
});

// ---- Text typed into a note --------------------------------------------------------

test('text typed into a light sticky in the default ink is made readable, once', () => {
  const list = [
    el({ id: 'face', backgroundColor: '#ffe86d', strokeColor: 'transparent' }),
    el({ id: 'lbl', type: 'text', containerId: 'face', strokeColor: INK_LIGHT }),
  ];
  const fixed = fixBoundTextInk(list);
  assert.equal(fixed.changed, true);
  assert.ok(contrastRatio(fixed.elements[1].strokeColor, '#ffe86d') >= 4.5, fixed.elements[1].strokeColor);
  assert.equal(fixBoundTextInk(fixed.elements).changed, false, 'idempotent');
});

test('light text on a dark note, a chosen colour, and text on the canvas are left alone', () => {
  const dark = [
    el({ id: 'face', backgroundColor: '#151515', strokeColor: 'transparent' }),
    el({ id: 'lbl', type: 'text', containerId: 'face', strokeColor: INK_LIGHT }),
  ];
  assert.equal(fixBoundTextInk(dark).changed, false);
  const chosen = [
    el({ id: 'face', backgroundColor: '#ffe86d', strokeColor: 'transparent' }),
    el({ id: 'lbl', type: 'text', containerId: 'face', strokeColor: '#e03131' }),
  ];
  assert.equal(fixBoundTextInk(chosen).changed, false, 'a colour that is not the default is the user\'s');
  assert.equal(fixBoundTextInk([el({ id: 'free', type: 'text', strokeColor: INK_LIGHT })]).changed, false);
});

// ---- What the CLI writes ------------------------------------------------------------

test('text placed through the model defaults to the light ink', () => {
  assert.equal(model.textNote({ text: 'hello' }).strokeColor, INK_LIGHT);
});

test('a connector placed through the model defaults to the light ink', () => {
  const a = model.shape({ shape: 'rectangle', x: 0, y: 0 })[0];
  const b = model.shape({ shape: 'rectangle', x: 400, y: 0 })[0];
  assert.equal(model.connector({ source: a, target: b }).strokeColor, INK_LIGHT);
});

test('a bare shape and its label default light, and a label on a light fill stays dark', () => {
  const [plain, plainLabel] = model.shape({ shape: 'rectangle', text: 'plain' });
  assert.equal(plain.strokeColor, INK_LIGHT);
  assert.equal(plainLabel.strokeColor, INK_LIGHT);
  const [pastel, pastelLabel] = model.shape({ shape: 'rectangle', text: 'pastel', backgroundColor: '#a5d8ff' });
  assert.equal(pastel.strokeColor, INK_DARK);
  assert.equal(pastelLabel.strokeColor, INK_DARK);
});
