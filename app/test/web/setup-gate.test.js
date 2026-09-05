'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setupGate } = require('../../web/src/rpc/setup-gate.cjs');

const TAILNET = 'https://node.example.ts.net';

test('the answer is held until the server has given one', () => {
  // Guessing either way here flashes a screen the user should never see.
  assert.equal(setupGate({ settings: { serverUrl: TAILNET, token: '' }, auth: null }), 'pending');
  assert.equal(setupGate({ settings: { serverUrl: TAILNET, token: '' } }), 'pending');
});

// The bug, stated as a spec. An installed PWA cold launch is exactly this
// input: a server URL derived from window.location, and an EMPTY token,
// because iOS gave the home-screen app its own storage container.
test('a cold launch with empty storage goes straight into the app when the tailnet authenticated it', () => {
  const gate = setupGate({
    settings: { serverUrl: TAILNET, token: '' },
    auth: { authenticated: true, tokenRequired: false, login: 'owner@example.com' },
  });
  assert.equal(gate, 'ready');
});

// Two-sided: the identical empty-token launch must STILL ask when the server
// says it needs a token, or this would just be "authentication removed".
test('the identical cold launch still asks for a token when the server is not satisfied', () => {
  const gate = setupGate({
    settings: { serverUrl: TAILNET, token: '' },
    auth: { authenticated: false, tokenRequired: true, login: null },
  });
  assert.equal(gate, 'setup');
});

test('a stored token still works, so a non-tailnet client is unaffected', () => {
  const gate = setupGate({
    settings: { serverUrl: 'https://elsewhere.example.com', token: 'a'.repeat(64) },
    auth: { authenticated: false, tokenRequired: true, login: null },
  });
  assert.equal(gate, 'ready');
});

test('no server URL is the genuine first run and still asks', () => {
  assert.equal(setupGate({ settings: { serverUrl: '', token: '' }, auth: { authenticated: true } }), 'setup');
  assert.equal(setupGate({ settings: {}, auth: { authenticated: true } }), 'setup');
});

test('a malformed call does not throw, because this runs on first paint', () => {
  assert.equal(setupGate(), 'pending');
  assert.equal(setupGate({}), 'pending');
});
