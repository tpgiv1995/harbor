'use strict';

// AN EMPTY DAEMON ADDRESS IS REFUSED, NOT TREATED AS "THE USER'S DAEMON"
// (2026-11-01). A scratch harness read its relocated store's socket from a field
// `harbor-sessiond status` does not print, passed `socketPath: undefined`, and
// the client fell through to the real store: four scratch Codex sessions
// launched into Pat's own daemon. Naming the option means you have an address.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SessionClient } = require('../../src/daemon/client.js');

test('SessionClient refuses an explicitly empty socketPath', () => {
  for (const empty of [undefined, null, '']) {
    assert.throws(() => new SessionClient({ socketPath: empty }), /empty socketPath/);
  }
});

test('SessionClient with no socketPath option, or a real one, is unchanged', () => {
  assert.doesNotThrow(() => new SessionClient({}));
  assert.doesNotThrow(() => new SessionClient());
  const client = new SessionClient({ socketPath: 'C:\\somewhere\\sessiond.sock' });
  assert.equal(client.socketPath, 'C:\\somewhere\\sessiond.sock');
});
