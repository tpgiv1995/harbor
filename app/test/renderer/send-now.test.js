'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sendNowCount } = require('../../src/renderer/stage/send-now.cjs');

const live = { header: { working: true, queuedPending: 2 }, provider: 'claude', drivable: true, pending: false, queuedItem: null };

test('Send now offers the count of messages in Claude queue while a turn runs on a pane Harbor drives', () => {
  assert.equal(sendNowCount(live), 2);
  assert.equal(sendNowCount({ ...live, provider: undefined }), 2, 'a row with no provider is a Claude row');
});

test('Send now hides at idle, on read-only or externally driven panes, and for other CLIs', () => {
  assert.equal(sendNowCount({ ...live, header: { working: false, queuedPending: 2 } }), 0);
  assert.equal(sendNowCount({ ...live, drivable: false }), 0);
  assert.equal(sendNowCount({ ...live, provider: 'codex' }), 0);
  assert.equal(sendNowCount({ ...live, header: { working: true, queuedPending: 0 } }), 0);
  assert.equal(sendNowCount({ ...live, header: { working: true } }), 0);
  assert.equal(sendNowCount({}), 0);
});

test('Send now hides while Harbor own send is still typing or holds a queued item', () => {
  // The chord landing mid-type would mix a half draft into the composer.
  assert.equal(sendNowCount({ ...live, pending: true }), 0);
  assert.equal(sendNowCount({ ...live, queuedItem: { id: 'send-2', status: 'queued' } }), 0);
});
