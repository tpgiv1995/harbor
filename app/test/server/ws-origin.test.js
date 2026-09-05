'use strict';

// CROSS-SITE WEBSOCKET HIJACKING (closed before publish, 2026-08-07).
//
// The browser `WebSocket` constructor ignores the same-origin policy: a page
// at `https://evil.example` can run `new WebSocket('ws://127.0.0.1:8787/ws')`
// and the browser connects, unauthenticated, using whatever network position
// it already has (loopback, or the tailnet if the phone browsing that page is
// on it). Nothing in `transport/ws.js` checked the `Origin` header before
// this fix, so any `remote-safe` method (`sidebar:get-state`, an unauthenticated
// full enumeration of every project/session/cwd; `transcript:open`, the full
// text of a conversation) was a free read for any web page the owner's phone
// or desktop browser happened to have open.
//
// The proof is deliberately two-sided, per this repo's own standard: a
// refusal-only test would pass just as well if the whole WebSocket path were
// dead. Three shapes are exercised against a REAL websocket handshake over a
// REAL composed server, not a mocked upgrade handler:
//   1. a foreign Origin is refused before the handshake completes;
//   2. the server's OWN origin (its actual bound host:port) is accepted and
//      can still call a remote-safe method;
//   3. a MISSING Origin header is accepted (the non-browser-client case:
//      curl, a native app, some installed PWA shells send none, and a real
//      browser handshake ALWAYS carries one, so refusing an absent header
//      would only ever break a legitimate non-browser client while stopping
//      nothing, since the attack this guards against requires a browser).
//
// A fourth case proves the MagicDNS wiring from compose.js: setup/mobile.md's
// recommended phone setup fronts a loopback bind with `tailscale serve`,
// which terminates HTTPS at the tailnet's MagicDNS name on a port this
// process is not itself bound to, so the allowlist has to accept that name
// on ANY port, not just the one it is actually listening on.

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { WebSocket } = require('ws');
const { composeServer } = require('../../src/server/compose.js');
const { parseOrigin, isSelfOrigin, originAllowed } = require('../../src/server/transport/ws.js');

function stubs(dir) {
  return {
    sidebar: { emitter: new EventEmitter(), async start() {}, close() {}, getState: () => ({ model: ['real-state'] }) },
    artifacts: { async list() { return { ok: true, artifacts: [] }; }, isServable() { return false; } },
    icons: { async list() { return { dir, icons: {} }; }, watch() {}, async filePathFor() { return null; }, mimeFor() { return null; } },
    tasks: { read: async () => ({}), mutate: async () => ({}), subscribe() {}, close() {} },
  };
}

// Connects and resolves once the handshake either opens or fails, rather than
// racing a bare `open`/`error` listener pair against each other.
function attempt(url, options = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, options);
    ws.once('open', () => resolve({ opened: true, ws }));
    ws.once('error', (error) => resolve({ opened: false, error }));
    ws.once('unexpected-response', () => resolve({ opened: false, error: new Error('unexpected-response') }));
  });
}

function call(ws, method, payload) {
  return new Promise((resolve, reject) => {
    ws.once('error', reject);
    ws.send(JSON.stringify({ id: 1, method, payload }));
    ws.once('message', (bytes) => resolve(JSON.parse(bytes)));
  });
}

// -----------------------------------------------------------------------
// Pure-function unit coverage: parseOrigin / isSelfOrigin / originAllowed
// -----------------------------------------------------------------------

test('parseOrigin accepts clean http/https origins and fills in default ports', () => {
  assert.deepEqual(parseOrigin('http://127.0.0.1:8787'), { hostname: '127.0.0.1', port: '8787' });
  assert.deepEqual(parseOrigin('https://example.ts.net'), { hostname: 'example.ts.net', port: '443' });
  assert.deepEqual(parseOrigin('http://example.com'), { hostname: 'example.com', port: '80' });
  // An IPv6 literal origin carries brackets; the URL parser strips them.
  assert.deepEqual(parseOrigin('http://[::1]:8787'), { hostname: '::1', port: '8787' });
  // Hostname comparison must not be case-sensitive.
  assert.equal(parseOrigin('https://EXAMPLE.ts.net').hostname, 'example.ts.net');
});

test('parseOrigin refuses anything that is not a bare scheme://host[:port] origin', () => {
  assert.equal(parseOrigin(null), null);
  assert.equal(parseOrigin(undefined), null);
  assert.equal(parseOrigin(''), null);
  assert.equal(parseOrigin('not a url'), null);
  // A scheme other than http/https (e.g. a malformed or exotic header) is
  // refused rather than partially matched.
  assert.equal(parseOrigin('file:///etc/passwd'), null);
  assert.equal(parseOrigin('null'), null);
});

test('isSelfOrigin matches loopback and the live bound host, only at the bound port', () => {
  const ctx = { boundHost: '100.72.5.9', boundPort: 8787, selfOriginHosts: [] };
  assert.equal(isSelfOrigin('http://127.0.0.1:8787', ctx), true);
  assert.equal(isSelfOrigin('http://localhost:8787', ctx), true);
  assert.equal(isSelfOrigin('http://[::1]:8787', ctx), true);
  // The server's own direct tailnet-IP bind.
  assert.equal(isSelfOrigin('http://100.72.5.9:8787', ctx), true);
  // Same host, WRONG port: not this server's origin.
  assert.equal(isSelfOrigin('http://127.0.0.1:9999', ctx), false);
  assert.equal(isSelfOrigin('http://100.72.5.9:9999', ctx), false);
  // A different host entirely, the actual attack shape.
  assert.equal(isSelfOrigin('https://evil.example', ctx), false);
  // Someone else's tailnet CGNAT address is not OUR bound host.
  assert.equal(isSelfOrigin('http://100.72.5.10:8787', ctx), false);
});

test('isSelfOrigin matches a selfOriginHosts entry (the MagicDNS name) on ANY port', () => {
  const ctx = { boundHost: '127.0.0.1', boundPort: 8787, selfOriginHosts: ['node.tailnet-name.ts.net'] };
  // tailscale serve fronts loopback with HTTPS on 443, a different port than
  // the one this process itself is bound to.
  assert.equal(isSelfOrigin('https://node.tailnet-name.ts.net', ctx), true);
  assert.equal(isSelfOrigin('https://node.tailnet-name.ts.net:8787', ctx), true);
  assert.equal(isSelfOrigin('http://node.tailnet-name.ts.net:1234', ctx), true);
  // A DIFFERENT tailnet node's MagicDNS name must not match.
  assert.equal(isSelfOrigin('https://someone-elses-node.ts.net', ctx), false);
});

test('originAllowed allows a missing Origin (the non-browser-client case) and nothing else foreign', () => {
  const ctx = { boundHost: '127.0.0.1', boundPort: 8787, selfOriginHosts: [] };
  assert.equal(originAllowed(undefined, ctx), true);
  assert.equal(originAllowed('', ctx), true);
  assert.equal(originAllowed('http://127.0.0.1:8787', ctx), true);
  assert.equal(originAllowed('https://evil.example', ctx), false);
});

// -----------------------------------------------------------------------
// Real handshake, real composed server.
// -----------------------------------------------------------------------

test('a real websocket handshake carrying a FOREIGN Origin is refused before it opens', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harbor-server-origin-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const composed = await composeServer({
    userDataDir: dir,
    env: { ...process.env, HARBOR_NO_DAEMON_START: '1', HARBOR_TAILNET_LOGINS: 'none', HARBOR_SESSIOND_DIR: path.join(dir, 'sessiond') },
    selfOriginHosts: [],
    ...stubs(dir),
  });
  const address = await composed.listen({ host: '127.0.0.1', port: 0 });
  t.after(() => composed.close());
  const url = `ws://127.0.0.1:${address.port}/ws`;

  const result = await attempt(url, { headers: { origin: 'https://evil.example' } });
  assert.equal(result.opened, false, 'a foreign Origin must never reach an open connection');
});

test('a real websocket handshake carrying the SERVER\'S OWN Origin opens and can call a remote-safe method', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harbor-server-origin-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const composed = await composeServer({
    userDataDir: dir,
    env: { ...process.env, HARBOR_NO_DAEMON_START: '1', HARBOR_TAILNET_LOGINS: 'none', HARBOR_SESSIOND_DIR: path.join(dir, 'sessiond') },
    selfOriginHosts: [],
    ...stubs(dir),
  });
  const address = await composed.listen({ host: '127.0.0.1', port: 0 });
  t.after(() => composed.close());
  const url = `ws://127.0.0.1:${address.port}/ws`;

  const result = await attempt(url, { headers: { origin: `http://127.0.0.1:${address.port}` } });
  assert.equal(result.opened, true, `the server's own origin must open a connection, got: ${result.error?.message}`);
  const response = await call(result.ws, 'sidebar:get-state');
  assert.deepEqual(response.result, { model: ['real-state'] });
  result.ws.close();
});

test('a real websocket handshake carrying NO Origin header opens and can call a remote-safe method', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harbor-server-origin-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const composed = await composeServer({
    userDataDir: dir,
    env: { ...process.env, HARBOR_NO_DAEMON_START: '1', HARBOR_TAILNET_LOGINS: 'none', HARBOR_SESSIOND_DIR: path.join(dir, 'sessiond') },
    selfOriginHosts: [],
    ...stubs(dir),
  });
  const address = await composed.listen({ host: '127.0.0.1', port: 0 });
  t.after(() => composed.close());
  const url = `ws://127.0.0.1:${address.port}/ws`;

  // No `origin` option: the `ws` client only sends an Origin header when one
  // is explicitly given, so this is exactly what curl or a native client
  // looks like on the wire.
  const result = await attempt(url);
  assert.equal(result.opened, true, `an absent Origin header must still connect, got: ${result.error?.message}`);
  const response = await call(result.ws, 'sidebar:get-state');
  assert.deepEqual(response.result, { model: ['real-state'] });
  result.ws.close();
});

test('a handshake carrying the discovered MagicDNS-style origin opens, on a port the server is not bound to', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harbor-server-origin-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const composed = await composeServer({
    userDataDir: dir,
    env: { ...process.env, HARBOR_NO_DAEMON_START: '1', HARBOR_TAILNET_LOGINS: 'none', HARBOR_SESSIOND_DIR: path.join(dir, 'sessiond') },
    // Stands in for compose.js's real `resolveSelfMagicDnsName` (which shells
    // out to `tailscale status --json`), the same way `allowedTailnetLogins`
    // stands in for `resolveAllowedLogins` in ws-integration.test.js.
    selfOriginHosts: ['pat-desktop.tailnet-name.ts.net'],
    ...stubs(dir),
  });
  const address = await composed.listen({ host: '127.0.0.1', port: 0 });
  t.after(() => composed.close());
  const url = `ws://127.0.0.1:${address.port}/ws`;

  // No port on the origin at all: this is what a browser sends for the
  // documented `tailscale serve --https=443` setup, https' default port.
  const result = await attempt(url, { headers: { origin: 'https://pat-desktop.tailnet-name.ts.net' } });
  assert.equal(result.opened, true, `the discovered MagicDNS origin must open, got: ${result.error?.message}`);
  const response = await call(result.ws, 'sidebar:get-state');
  assert.deepEqual(response.result, { model: ['real-state'] });
  result.ws.close();

  // Two-sided again: a DIFFERENT tailnet node's name, even though it also
  // ends in `.ts.net`, must still be refused.
  const stranger = await attempt(url, { headers: { origin: 'https://someone-elses-node.ts.net' } });
  assert.equal(stranger.opened, false, 'a foreign .ts.net origin must not be treated as this node');
});

// A server that boots before Tailscale is up used to pin an empty MagicDNS
// allowlist for the life of the process, so every phone browser Origin
// (https://<magicdns> via `tailscale serve`) was refused until a restart.
// Discovery is now a live getter; this proves the heal two-sided against a
// real handshake: first refuse while discovery returns null, then accept
// once it returns a name, without restarting the server.
test('MagicDNS origin heals after startup when discovery later returns a name', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harbor-server-origin-heal-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let discovered = null;
  const composed = await composeServer({
    userDataDir: dir,
    env: { ...process.env, HARBOR_NO_DAEMON_START: '1', HARBOR_TAILNET_LOGINS: 'none', HARBOR_SESSIOND_DIR: path.join(dir, 'sessiond') },
    resolveSelfMagicDnsName: async () => discovered,
    // Zero TTL so the second handshake re-asks immediately rather than
    // waiting on the empty-result floor.
    selfOriginHostsEmptyTtlMs: 0,
    selfOriginHostsTtlMs: 0,
    ...stubs(dir),
  });
  const address = await composed.listen({ host: '127.0.0.1', port: 0 });
  t.after(() => composed.close());
  const url = `ws://127.0.0.1:${address.port}/ws`;
  const magicOrigin = { headers: { origin: 'https://node-that-came-up-later.ts.net' } };

  const before = await attempt(url, magicOrigin);
  assert.equal(before.opened, false, 'MagicDNS Origin must refuse while discovery still returns null');

  discovered = 'node-that-came-up-later.ts.net';
  const after = await attempt(url, magicOrigin);
  assert.equal(after.opened, true, `MagicDNS Origin must open after discovery heals, got: ${after.error?.message}`);
  const response = await call(after.ws, 'sidebar:get-state');
  assert.deepEqual(response.result, { model: ['real-state'] });
  after.ws.close();
});
