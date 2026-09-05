'use strict';

/**
 * MY check of batch-3: upload:image over the REAL authenticated WebSocket
 * transport, not just the function under unit test. Spins an isolated
 * harbor-server on an ephemeral port so the live one (and Pat's phone) is
 * untouched.
 *
 * Proves: an authenticated upload returns a contained host path that
 * session:send's `images` array can take, the four refusals refuse over the
 * wire with honest messages, and an UNAUTHENTICATED upload is rejected
 * (upload:image is MUTATING, so the capability map must gate it).
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { WebSocket } = require('ws');
const { composeServer } = require('../src/server/compose.js');
const { createAppShim } = require('../src/server/app-shim.js');

const OUT = path.join(__dirname, '..', 'verify', 'my-upload-check');

function call(url, method, payload, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(token ? `${url}?token=${token}` : url);
    const timer = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 10000);
    ws.once('error', (e) => { clearTimeout(timer); resolve({ transportError: e.message }); });
    ws.once('open', () => ws.send(JSON.stringify({ id: 1, method, payload })));
    ws.once('message', (bytes) => {
      clearTimeout(timer);
      const msg = JSON.parse(bytes.toString());
      ws.close();
      resolve(msg);
    });
    ws.once('close', (code) => { clearTimeout(timer); resolve({ closed: code }); });
  });
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-upload-check-'));
  const app = createAppShim({ userDataDir: dir });
  const noop = { emitter: new EventEmitter(), async start() {}, close() {}, closeAll() {} };

  const composed = await composeServer({
    userDataDir: dir,
    webDist: path.join(__dirname, '..', 'dist-web'),
    env: {
      ...process.env,
      HARBOR_NO_DAEMON_START: '1',
      HARBOR_NO_USAGE_FETCH: '1',
      HARBOR_TAILNET_LOGINS: 'none',
      HARBOR_CONTEXT_DIR: path.join(dir, 'context'),
      HARBOR_ARTIFACTS_ROOTS: path.join(dir, 'artifacts'),
      HARBOR_ARTIFACTS_CACHE: path.join(dir, 'artifacts.json'),
      HARBOR_TASKS_FILE: path.join(dir, 'tasks.json'),
    },
    app,
    sidebar: { ...noop, getState: () => ({ model: { projects: [] } }), getSessionMeta: async () => null, getSessionPreview: async () => null, focusLivePane: async () => ({}) },
    tasks: { ...noop, read: async () => ({ doc: null }), mutate: async () => ({ ok: true }) },
    artifacts: { async list() { return { ok: true, artifacts: [] }; }, isServable() { return false; } },
    icons: { async list() { return { dir, icons: {} }; }, watch() {}, async filePathFor() { return null; }, mimeFor() { return 'image/png'; } },
    terminalBridge: noop,
    transcript: { ...noop, open: async () => ({ ok: true }), close() {} },
    sessionSend: { ...noop, getMenu: async () => null, answerMenu: async () => ({ ok: true }) },
    usage: { getUsage: async () => ({}) },
    accountsProvider: {},
    capabilities: { get: async () => ({}) },
    workflowRuns: { runsForSession: async () => [] },
    artifactThumbs: { thumbFor: async () => null },
    launchActions: {},
    sendClient: { snapshot: async () => ({ snapshot: {} }) },
    links: { all: () => ({}), emitter: new EventEmitter() },
    history: { sessionMeta: () => null },
  });

  const addr = await composed.listen({ host: '127.0.0.1', port: 0 });
  const url = `ws://127.0.0.1:${addr.port}/ws`;
  const token = composed.token;
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');

  const results = {};
  results.authorized = await call(url, 'upload:image', { name: 'shot.png', mediaType: 'image/png', bytesBase64: png }, token);
  results.unauthenticated = await call(url, 'upload:image', { name: 'shot.png', mediaType: 'image/png', bytesBase64: png }, null);
  results.traversal = await call(url, 'upload:image', { name: '../escape.png', mediaType: 'image/png', bytesBase64: png }, token);
  results.absolute = await call(url, 'upload:image', { name: '/etc/escape.png', mediaType: 'image/png', bytesBase64: png }, token);
  results.wrongType = await call(url, 'upload:image', { name: 'p.svg', mediaType: 'image/svg+xml', bytesBase64: png }, token);
  results.oversize = await call(url, 'upload:image', { name: 'big.png', mediaType: 'image/png', bytesBase64: 'A'.repeat(40 * 1024 * 1024) }, token);

  // The two most dangerous methods batch-3 added: takeover SIGNALS a process
  // and resume LAUNCHES one. Both must refuse an unauthenticated caller.
  const sid = '11111111-1111-4111-8111-111111111111';
  results.takeoverUnauth = await call(url, 'session:takeover', { sessionId: sid }, null);
  results.resumeUnauth = await call(url, 'resume-session', { id: sid }, null);
  results.voiceTokenUnauth = await call(url, 'voice:token', {}, null);
  results.whisperUnauth = await call(url, 'whisper:transcribe', {}, null);

  const okPath = results.authorized?.result?.path || results.authorized?.result;
  const checks = {
    authorizedUploadReturnedPath: typeof okPath === 'string' && okPath.length > 0,
    pathIsContainedInUserData: typeof okPath === 'string' && path.resolve(okPath).startsWith(path.resolve(dir) + path.sep),
    pathExistsOnDisk: typeof okPath === 'string' && fs.existsSync(okPath),
    unauthenticatedRefused: Boolean(results.unauthenticated?.error || results.unauthenticated?.closed || results.unauthenticated?.transportError),
    traversalRefused: Boolean(results.traversal?.error),
    absoluteRefused: Boolean(results.absolute?.error),
    wrongTypeRefused: Boolean(results.wrongType?.error),
    oversizeRefused: Boolean(results.oversize?.error),
    nothingEscaped: !fs.existsSync('/tmp/escape.png') && !fs.existsSync(path.join(dir, '..', 'escape.png')),
    takeoverRefusedUnauthenticated: /authentication required/i.test(results.takeoverUnauth?.error || ''),
    resumeRefusedUnauthenticated: /authentication required/i.test(results.resumeUnauth?.error || ''),
    voiceTokenRefusedUnauthenticated: /authentication required/i.test(results.voiceTokenUnauth?.error || ''),
    whisperRefusedUnauthenticated: /authentication required/i.test(results.whisperUnauth?.error || ''),
  };
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ checks, results, uploadedTo: okPath }, null, 2));

  console.log(JSON.stringify(checks, null, 2));
  console.log('\nuploaded to:', okPath);
  for (const [k, v] of Object.entries(results)) {
    const e = v?.error?.message || v?.error || (v?.closed ? `closed ${v.closed}` : v?.transportError) || 'ok';
    console.log(`  ${k.padEnd(20)} ${String(e).slice(0, 110)}`);
  }

  await composed.close();
  fs.rmSync(dir, { recursive: true, force: true });

  const failed = Object.entries(checks).filter(([, v]) => !v);
  if (failed.length) { console.error(`\nFAIL: ${failed.map(([k]) => k).join(', ')}`); process.exit(1); }
  console.log('\nPASS (my own round trip over the real transport)');
}

main().catch((e) => { console.error(e); process.exit(1); });
