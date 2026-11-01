'use strict';

// The header's copy-id button claims success only for a copy that landed
// (web/src/shell/copy-text.js, 2026-10-31). Both paths run here against a fake
// navigator and document; the drive scripts/drive-phone-qol-win.js runs the real
// ones in Chromium, and iOS Safari itself is a physical-device check.

const test = require('node:test');
const assert = require('node:assert/strict');

function fakeDocument({ execResult = true, execThrows = false } = {}) {
  const log = { appended: [], removed: 0, commands: [], selected: null, focusedOwn: 0 };
  const previous = { focused: 0, focus() { this.focused += 1; } };
  const doc = {
    activeElement: previous,
    body: { appendChild(node) { log.appended.push(node); } },
    createElement(tag) {
      assert.equal(tag, 'textarea');
      const node = {
        style: {}, attrs: {}, value: '',
        setAttribute(name, value) { this.attrs[name] = value; },
        focus() { log.focusedOwn += 1; },
        select() { this.selectedAll = true; },
        setSelectionRange(start, end) { log.selected = [start, end]; },
        remove() { log.removed += 1; },
      };
      return node;
    },
    execCommand(command) {
      log.commands.push({ command, value: log.appended.at(-1)?.value });
      if (execThrows) throw new Error('blocked');
      return execResult;
    },
  };
  return { doc, log, previous };
}

test('the async clipboard is used first, from the tap, and a resolved write is a landed copy', async () => {
  const { copyText } = await import('../../web/src/shell/copy-text.js');
  const written = [];
  const nav = { clipboard: { writeText: async (text) => { written.push(text); } } };
  const { doc, log } = fakeDocument();
  assert.equal(await copyText('abc-123', { navigator: nav, document: doc }), true);
  assert.deepEqual(written, ['abc-123']);
  assert.equal(log.appended.length, 0, 'no textarea is made when the async write landed');
});

test('no async clipboard (an http address): the hidden textarea is selected and copied, then removed', async () => {
  const { copyText } = await import('../../web/src/shell/copy-text.js');
  const { doc, log, previous } = fakeDocument();
  assert.equal(await copyText('abc-123', { navigator: {}, document: doc }), true);
  assert.deepEqual(log.commands, [{ command: 'copy', value: 'abc-123' }]);
  assert.deepEqual(log.selected, [0, 7], 'iOS needs an explicit selection range');
  assert.equal(log.appended[0].attrs.readonly, '', 'readonly, so no keyboard opens');
  assert.equal(log.appended[0].style.fontSize, '16px', 'no iOS zoom');
  assert.equal(log.removed, 1);
  assert.equal(previous.focused, 1, 'focus goes back to where it was');
});

test('a refused async write falls back to the selection copy', async () => {
  const { copyText } = await import('../../web/src/shell/copy-text.js');
  const nav = { clipboard: { writeText: () => Promise.reject(new Error('NotAllowedError')) } };
  const { doc, log } = fakeDocument();
  assert.equal(await copyText('abc-123', { navigator: nav, document: doc }), true);
  assert.equal(log.commands.length, 1);
});

test('when neither path lands, it says so: false, never a claimed success', async () => {
  const { copyText } = await import('../../web/src/shell/copy-text.js');
  const refuse = { clipboard: { writeText: () => Promise.reject(new Error('NotAllowedError')) } };
  assert.equal(await copyText('abc', { navigator: refuse, document: fakeDocument({ execResult: false }).doc }), false);
  assert.equal(await copyText('abc', { navigator: refuse, document: fakeDocument({ execThrows: true }).doc }), false);
  assert.equal(await copyText('abc', { navigator: {}, document: { body: null } }), false);
  assert.equal(await copyText('abc', { navigator: {}, document: {} }), false);
  const stillClean = fakeDocument({ execThrows: true });
  await copyText('abc', { navigator: {}, document: stillClean.doc });
  assert.equal(stillClean.log.removed, 1, 'the textarea is removed even when the copy throws');
});

test('nothing is copied for an empty id', async () => {
  const { copyText } = await import('../../web/src/shell/copy-text.js');
  const written = [];
  const nav = { clipboard: { writeText: async (text) => { written.push(text); } } };
  assert.equal(await copyText('', { navigator: nav, document: fakeDocument().doc }), false);
  assert.equal(await copyText(null, { navigator: nav, document: fakeDocument().doc }), false);
  assert.deepEqual(written, []);
});

test('the button calls the copy first thing in the tap handler and shows the check only for a landed copy', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '../../web/src/shell/SessionActions.jsx'), 'utf8');
  // Nothing awaited before it: iOS Safari only allows the clipboard write inside the gesture.
  assert.match(source, /const copy = async \(\) => \{\s*if \(!ready\) return;\s*const landed = await copyText\(String\(sessionId\)\);/);
  assert.match(source, /setState\(landed \? 'copied' : 'failed'\)/);
  assert.match(source, /disabled=\{!ready\}/);
});
