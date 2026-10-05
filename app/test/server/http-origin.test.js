'use strict';

// CROSS-ORIGIN EMBEDDING OF THE HTTP ASSET ROUTES (closed before publish,
// 2026-09-19).
//
// transport/ws.js checks Origin on the `/ws` upgrade (see ws-origin.test.js,
// the model for this file), but `/artifacts`, `/icons/*`, and the static PWA
// route had NO check at all before this fix, even though `docs/SECURITY-MOBILE.md`
// claimed a browser was refused for remote-safe reads. That claim was only
// ever true for `/ws`. Any web page open in a browser on the same machine or
// tailnet could `<script src>`, `<img>`, or `<iframe>` an indexed artifact by
// path: probing existence, and for a `.js` artifact, running agent-produced
// code IN THE ATTACKER'S OWN ORIGIN.
//
// The proof is two-sided per this repo's standard: a refusal-only test would
// pass just as well if the whole HTTP path were dead. Each guarded route is
// exercised against a REAL http.createServer produced by a REAL composeServer,
// not a mocked request handler:
//   1. a cross-site Sec-Fetch-Site is refused (403), same-site too;
//   2. a disallowed Origin (no Sec-Fetch-Site at all, the older-browser case)
//      is refused;
//   3. the server's own origin (Sec-Fetch-Site: same-origin, or a matching
//      Origin header) is allowed, and so is a request carrying NEITHER header
//      (curl, a native client, the installed PWA's own same-origin fetch);
//   4. every response (refused or served) carries Cross-Origin-Resource-Policy
//      and X-Content-Type-Options;
//   5. `/health` and `/whoami` stay reachable cross-origin, because they were
//      deliberately left out of the guard (no per-user content, and `/whoami`
//      exists specifically to be asked before any auth exists).

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { composeServer } = require('../../src/server/compose.js');
const { crossOriginRequestAllowed } = require('../../src/server/http/request-guard.js');

async function harness(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harbor-http-origin-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const artifactFile = path.join(dir, 'report.html');
  await fs.writeFile(artifactFile, '<html>real artifact</html>');
  const iconFile = path.join(dir, 'icon.png');
  await fs.writeFile(iconFile, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const webDist = path.join(dir, 'web-dist');
  await fs.mkdir(webDist, { recursive: true });
  await fs.writeFile(path.join(webDist, 'index.html'), '<html>pwa shell</html>');

  const composed = await composeServer({
    userDataDir: dir,
    webDist,
    env: { ...process.env, HARBOR_NO_DAEMON_START: '1', HARBOR_TAILNET_LOGINS: 'none', HARBOR_SESSIOND_DIR: path.join(dir, 'sessiond') },
    selfOriginHosts: [],
    sidebar: { emitter: new EventEmitter(), async start() {}, close() {}, getState: () => ({ model: ['real-state'] }) },
    artifacts: { async list() { return { ok: true, artifacts: [] }; }, isServable: (candidate) => candidate === artifactFile },
    icons: {
      async list() { return { dir, icons: {} }; },
      watch() {},
      async filePathFor(file) { return file === 'icon.png' ? iconFile : null; },
      mimeFor() { return 'image/png'; },
    },
    tasks: { read: async () => ({}), mutate: async () => ({}), subscribe() {}, close() {} },
  });
  const address = await composed.listen({ host: '127.0.0.1', port: 0 });
  t.after(() => composed.close());
  return { address, port: address.port, artifactFile };
}

function get(port, target, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: target, headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString() }));
    }).on('error', reject);
  });
}

// -----------------------------------------------------------------------
// Pure-function unit coverage, the same shape as ws-origin.test.js's
// coverage of originAllowed/isSelfOrigin.
// -----------------------------------------------------------------------

test('crossOriginRequestAllowed refuses cross-site and same-site Sec-Fetch-Site regardless of Origin', () => {
  const ctx = { boundHost: '127.0.0.1', boundPort: 8787, selfOriginHosts: [] };
  const req = (site, origin) => ({ headers: { 'sec-fetch-site': site, ...(origin ? { origin } : {}) } });
  assert.equal(crossOriginRequestAllowed(req('cross-site'), ctx), false);
  assert.equal(crossOriginRequestAllowed(req('cross-site', 'http://127.0.0.1:8787'), ctx), false);
  assert.equal(crossOriginRequestAllowed(req('same-site'), ctx), false);
  assert.equal(crossOriginRequestAllowed(req('same-origin'), ctx), true);
  assert.equal(crossOriginRequestAllowed(req('none'), ctx), true);
});

test('crossOriginRequestAllowed falls back to the Origin allowlist when Sec-Fetch-Site is absent', () => {
  const ctx = { boundHost: '127.0.0.1', boundPort: 8787, selfOriginHosts: [] };
  assert.equal(crossOriginRequestAllowed({ headers: {} }, ctx), true, 'no headers at all: curl, native clients');
  assert.equal(crossOriginRequestAllowed({ headers: { origin: 'http://127.0.0.1:8787' } }, ctx), true);
  assert.equal(crossOriginRequestAllowed({ headers: { origin: 'https://evil.example' } }, ctx), false);
});

// -----------------------------------------------------------------------
// Real HTTP server, real composeServer.
// -----------------------------------------------------------------------

test('a cross-site Sec-Fetch-Site is refused on the artifact, icon, and static routes', async (t) => {
  const { port, artifactFile } = await harness(t);
  const headers = { 'sec-fetch-site': 'cross-site' };
  const artifact = await get(port, `/artifacts?path=${encodeURIComponent(artifactFile)}`, headers);
  assert.equal(artifact.status, 403, 'a real, indexed artifact must still refuse a cross-site fetch');
  assert.equal((await get(port, '/icons/icon.png', headers)).status, 403);
  assert.equal((await get(port, '/', headers)).status, 403);
});

test('same-site Sec-Fetch-Site (never same-origin by definition) is refused', async (t) => {
  const { port } = await harness(t);
  const result = await get(port, '/icons/icon.png', { 'sec-fetch-site': 'same-site' });
  assert.equal(result.status, 403);
});

test('a disallowed Origin with no Sec-Fetch-Site header (the older-browser case) is refused', async (t) => {
  const { port } = await harness(t);
  const result = await get(port, '/icons/icon.png', { origin: 'https://evil.example' });
  assert.equal(result.status, 403);
});

test('the server\'s own origin is allowed and actually serves the icon and static routes', async (t) => {
  const { port } = await harness(t);
  const selfOrigin = { origin: `http://127.0.0.1:${port}` };

  const icon = await get(port, '/icons/icon.png', selfOrigin);
  assert.equal(icon.status, 200);
  assert.equal(icon.headers['cross-origin-resource-policy'], 'same-origin');
  assert.equal(icon.headers['x-content-type-options'], 'nosniff');

  const staticPage = await get(port, '/', selfOrigin);
  assert.equal(staticPage.status, 200);
  assert.equal(staticPage.headers['cross-origin-resource-policy'], 'same-origin');
  assert.equal(staticPage.headers['x-content-type-options'], 'nosniff');
});

test('a request with NEITHER Sec-Fetch-Site NOR Origin is allowed (curl, native clients, some installed PWA shells)', async (t) => {
  const { port } = await harness(t);
  const icon = await get(port, '/icons/icon.png');
  assert.equal(icon.status, 200);
  assert.equal(icon.headers['cross-origin-resource-policy'], 'same-origin');
  assert.equal(icon.headers['x-content-type-options'], 'nosniff');
});

test('Sec-Fetch-Site: same-origin is allowed even with no Origin header (a real same-origin <img> load)', async (t) => {
  const { port } = await harness(t);
  const icon = await get(port, '/icons/icon.png', { 'sec-fetch-site': 'same-origin' });
  assert.equal(icon.status, 200);
});

test('the artifact route serves a real indexed artifact to the server\'s own origin, with CORP set', async (t) => {
  const { port, artifactFile } = await harness(t);
  const target = `/artifacts?path=${encodeURIComponent(artifactFile)}`;

  const legit = await get(port, target, { origin: `http://127.0.0.1:${port}` });
  assert.equal(legit.status, 200, `the server's own origin must still read the real artifact, got ${legit.status}`);
  assert.equal(legit.body, '<html>real artifact</html>');
  assert.equal(legit.headers['cross-origin-resource-policy'], 'same-origin');
  assert.equal(legit.headers['x-content-type-options'], 'nosniff');
});

test('/health and /whoami stay reachable cross-origin: they carry no per-user content and are deliberately exempt', async (t) => {
  const { port } = await harness(t);
  const cross = { 'sec-fetch-site': 'cross-site' };
  assert.equal((await get(port, '/health', cross)).status, 200);
  assert.equal((await get(port, '/whoami', cross)).status, 200);
});
