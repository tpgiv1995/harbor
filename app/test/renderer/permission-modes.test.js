'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSessionSend } = require('../../src/main/session-send.js');
const { MODE_LABEL } = require('../../src/shared/permission-modes.cjs');

test('permission readback has human labels shared by desktop and phone', async () => {
  let screen = '';
  const send = createSessionSend({ readPane: async () => screen });
  for (const [footer, expected] of [
    ['❯', 'default · asks before edits'],
    ['plan mode on', 'plan mode · read-only'],
    ['accept edits on', 'accept edits'],
    ['bypass permissions on', 'bypass permissions'],
    ['auto mode on', 'auto mode · classifier reviews'],
  ]) {
    screen = `conversation\n❯\n${footer}`;
    const { mode } = await send.readPermissionMode('fixture-pane');
    assert.equal(MODE_LABEL[mode], expected, `label for the actual readback of ${footer}`);
  }
  screen = '';
  assert.deepEqual(await send.readPermissionMode('fixture-pane'), { mode: null });
  assert.equal(MODE_LABEL.null, undefined, 'unreadable is handled by the view, never named as a mode');
});
