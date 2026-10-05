'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { deriveServerUrl } = require('../../web/src/rpc/derive-server-url.cjs');

// The PWA is always served BY the harbor-server, so the origin that served the
// page IS the server to talk to. Before this fix, deriveServerUrl only named a
// .ts.net MagicDNS host and returned '' for loopback and for a direct tailnet
// IP. That empty value flowed through ingestSetupFragment/loadSettings into
// setupGate, which returns 'setup' (the Connect screen) whenever serverUrl is
// empty, BEFORE it ever looks at the token. So a valid one-tap token link
// (#token=...) dropped to a manual Connect screen anywhere the page was not
// served from a .ts.net name, including the "try it on this machine over
// loopback" flow the README recommends first.

test('loopback defaults to the serving origin, not empty', () => {
  assert.equal(
    deriveServerUrl({ protocol: 'http:', hostname: '127.0.0.1', origin: 'http://127.0.0.1:8787' }),
    'http://127.0.0.1:8787',
  );
  assert.equal(
    deriveServerUrl({ protocol: 'http:', hostname: 'localhost', origin: 'http://localhost:8787' }),
    'http://localhost:8787',
  );
});

test('a direct tailnet IP defaults to the serving origin', () => {
  assert.equal(
    deriveServerUrl({ protocol: 'http:', hostname: '100.72.5.9', origin: 'http://100.72.5.9:8787' }),
    'http://100.72.5.9:8787',
  );
});

test('a MagicDNS .ts.net name uses its own origin', () => {
  assert.equal(
    deriveServerUrl({ protocol: 'https:', hostname: 'box.tailnet.ts.net', origin: 'https://box.tailnet.ts.net' }),
    'https://box.tailnet.ts.net',
  );
});

test('a non-http(s) origin, or a missing one, yields empty rather than a junk URL', () => {
  assert.equal(deriveServerUrl({ protocol: 'file:', hostname: '', origin: 'null' }), '');
  assert.equal(deriveServerUrl(null), '');
  assert.equal(deriveServerUrl(undefined), '');
  assert.equal(deriveServerUrl({ protocol: 'http:', hostname: 'x' }), '');
});
