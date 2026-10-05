'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  applyOp, cleanColor, emptyDoc, normalizeDoc,
} = require('../../src/shared/tasks-model.cjs');
const {
  LIST_SWATCHES, hexToHsl, hslToHex, resolveListColor,
} = require('../../src/renderer/tasks/list-color.cjs');

const NOW = 1_700_000_000_000;
let seq = 0;
const ids = (prefix) => `${prefix}-${++seq}`;

test('LIST-COLOR-1: cleanColor normalizes every spelling of a colour to one', () => {
  assert.equal(cleanColor('#4EC9B6'), '#4ec9b6');
  assert.equal(cleanColor('4ec9b6'), '#4ec9b6');
  assert.equal(cleanColor('#abc'), '#aabbcc');
  assert.equal(cleanColor('  #4ec9b6  '), '#4ec9b6');
});

test('LIST-COLOR-2: cleanColor is TOTAL, because the tasks file is hand-editable', () => {
  // Every one of these is an ordinary input for a file a human can edit.
  for (const bad of ['#nope', 'red', '', '#12345', '#1234567', null, undefined, 42, {}, [], NaN]) {
    assert.equal(cleanColor(bad), null, `${JSON.stringify(bad)} must be null, never a throw`);
  }
});

test('LIST-COLOR-3: list.add stores a chosen colour', () => {
  const created = applyOp(emptyDoc(NOW), { type: 'list.add', name: 'Work', color: '#E0B45C' },
    { now: NOW, idFactory: ids });
  assert.equal(created.ok, true);
  const list = created.doc.lists.find((l) => l.id === created.listId);
  assert.equal(list.color, '#e0b45c');
});

test('LIST-COLOR-4: a list created without a colour stores null, not a guess', () => {
  const created = applyOp(emptyDoc(NOW), { type: 'list.add', name: 'Plain' },
    { now: NOW, idFactory: ids });
  const list = created.doc.lists.find((l) => l.id === created.listId);
  assert.equal(list.color, null);
});

test('LIST-COLOR-5: a bad hex must not cost the user the list they were creating', () => {
  const created = applyOp(emptyDoc(NOW), { type: 'list.add', name: 'Keep me', color: '#nope' },
    { now: NOW, idFactory: ids });
  assert.equal(created.ok, true, 'the list is the primary intent on create');
  assert.equal(created.doc.lists.find((l) => l.id === created.listId).color, null);
});

test('LIST-COLOR-6: list.color sets, clears, and REFUSES a bad hex out loud', () => {
  const base = applyOp(emptyDoc(NOW), { type: 'list.add', name: 'Example Org' },
    { now: NOW, idFactory: ids });
  const id = base.listId;

  const set = applyOp(base.doc, { type: 'list.color', listId: id, color: '#8b9bff' }, { now: NOW });
  assert.equal(set.doc.lists.find((l) => l.id === id).color, '#8b9bff');

  const cleared = applyOp(set.doc, { type: 'list.color', listId: id, color: null }, { now: NOW });
  assert.equal(cleared.doc.lists.find((l) => l.id === id).color, null,
    'clearing returns the list to the name-hash fallback');

  // On an explicit recolour the colour IS the whole intent, so silently doing
  // nothing would be a lie. This is deliberately unlike list.add above.
  const bad = applyOp(set.doc, { type: 'list.color', listId: id, color: 'octarine' }, { now: NOW });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /not a colour/);
});

test('LIST-COLOR-7: list.rename must not clear a colour, list.color must not need a name', () => {
  const base = applyOp(emptyDoc(NOW), { type: 'list.add', name: 'Before', color: '#d884c8' },
    { now: NOW, idFactory: ids });
  const id = base.listId;
  const renamed = applyOp(base.doc, { type: 'list.rename', listId: id, name: 'After' }, { now: NOW });
  const list = renamed.doc.lists.find((l) => l.id === id);
  assert.equal(list.name, 'After');
  assert.equal(list.color, '#d884c8', 'renaming a list must not repaint it');
});

test('LIST-COLOR-8: normalizeDoc repairs a garbage colour instead of failing the load', () => {
  const doc = normalizeDoc({
    version: 1,
    lists: [
      { id: 'l1', name: 'Good', color: '#ABC' },
      { id: 'l2', name: 'Bad', color: 'not-a-colour' },
      { id: 'l3', name: 'Missing' },
    ],
    tasks: [],
  }, { now: NOW, idFactory: ids });
  assert.equal(doc.lists.find((l) => l.id === 'l1').color, '#aabbcc');
  assert.equal(doc.lists.find((l) => l.id === 'l2').color, null);
  assert.equal(doc.lists.find((l) => l.id === 'l3').color, null);
});

test('LIST-COLOR-9: resolveListColor prefers the stored colour, else the legacy hash', () => {
  const hash = (name) => `HASH(${name})`;
  assert.equal(resolveListColor({ name: 'Work', color: '#4ec9b6' }, hash), '#4ec9b6');
  // The fallback is what keeps every pre-existing list looking identical.
  assert.equal(resolveListColor({ name: 'Work', color: null }, hash), 'HASH(Work)');
  assert.equal(resolveListColor({ name: 'Work' }, hash), 'HASH(Work)');
  assert.equal(resolveListColor({ name: 'Work', color: 'bogus' }, hash), 'HASH(Work)');
});

test('LIST-COLOR-10: hex/hsl round trip is stable enough to drive a hue slider', () => {
  for (const swatch of LIST_SWATCHES) {
    const hsl = hexToHsl(swatch);
    assert.ok(hsl, `${swatch} must parse`);
    assert.ok(hsl.h >= 0 && hsl.h < 360, `${swatch} hue in range`);
  }
  assert.equal(hexToHsl('nope'), null);
  assert.match(hslToHex(170, 60, 68), /^#[0-9a-f]{6}$/);
  // Round trip: hue in -> hex -> hue out, within rounding.
  for (const h of [0, 45, 120, 200, 300, 359]) {
    const back = hexToHsl(hslToHex(h, 60, 68));
    assert.ok(Math.abs(back.h - h) <= 2 || Math.abs(back.h - h) >= 358, `hue ${h} round trips (got ${back.h})`);
  }
});

test('LIST-COLOR-11: every shipped swatch is a value the model accepts', () => {
  for (const swatch of LIST_SWATCHES) {
    assert.equal(cleanColor(swatch), swatch.toLowerCase(),
      'a swatch the picker offers must never be one applyOp would reject');
  }
});
