'use strict';

const { test, expect } = require('@playwright/test');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { WebSocket } = require('ws');
const { composeServer } = require('../../src/server/compose.js');
const { createArtifactHandler } = require('../../src/server/http/artifacts.js');
const { createIconHandler } = require('../../src/server/http/icons.js');
const { createArtifactsProvider } = require('../../src/main/providers/artifacts.js');
const { createProjectIconProvider } = require('../../src/main/providers/project-icons.js');
const { METHOD_CHANNELS } = require('../../src/main/rpc/channels.js');
const { defaultUserDataDir } = require('../../src/shared/tasks-file.cjs');

const MUTATING_METHODS = METHOD_CHANNELS
  .filter(({ capability }) => capability === 'mutating')
  .map(({ method }) => method);

function wsCall(url, method, payload, { token, bearer } = {}) {
  return new Promise((resolve, reject) => {
    const headers = bearer ? { Authorization: `Bearer ${bearer}` } : undefined;
    const ws = new WebSocket(url, { headers });
    ws.once('error', reject);
    ws.once('open', () => ws.send(JSON.stringify({ id: 1, method, payload })));
    ws.once('message', (bytes) => {
      const message = JSON.parse(bytes.toString());
      ws.close();
      resolve(message);
    });
  });
}

async function httpGet(port, target) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: target }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        body: Buffer.concat(chunks),
      }));
    }).on('error', reject);
  });
}

async function isolatedFixture(options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'harbor-mobile-e2e-'));
  const userDataDir = path.join(root, 'user-data');
  const contextDir = path.join(root, 'context');
  const artifactsRoot = path.join(root, 'artifacts');
  const artifactsCache = path.join(root, 'artifact-cache.json');
  const tasksFile = path.join(root, 'tasks.json');
  const iconsDir = path.join(root, 'project-icons');
  await Promise.all([
    fs.mkdir(userDataDir, { recursive: true }),
    fs.mkdir(contextDir, { recursive: true }),
    fs.mkdir(artifactsRoot, { recursive: true }),
    fs.mkdir(iconsDir, { recursive: true }),
  ]);
  const env = {
    ...process.env,
    HARBOR_NO_DAEMON_START: '1',
    HARBOR_NO_USAGE_FETCH: '1',
    HARBOR_CONTEXT_DIR: contextDir,
    // The session store is isolated exactly like userData, context, artifacts,
    // tasks and icons above. It was the one thing this fixture did not think
    // of, so the moment the default backend became the one that owns a real
    // store, every spec here was refused by the isolation guard by name. That
    // is the guard working: isolating the parts you thought of is not
    // isolation.
    HARBOR_SESSIOND_DIR: path.join(root, 'sessiond'),
    HARBOR_ARTIFACTS_ROOTS: artifactsRoot,
    HARBOR_ARTIFACTS_CACHE: artifactsCache,
    HARBOR_TASKS_FILE: tasksFile,
    HARBOR_PROJECT_ICONS_DIR: iconsDir,
    HARBOR_E2E_FAKE_LAUNCH: options.fakeLaunch ? '1' : '0',
    HARBOR_ALLOW_REAL_SIGNALS: options.allowRealSignals ? '1' : '0',
    HARBOR_ALLOW_REAL_LAUNCH: options.allowRealLaunch ? '1' : '0',
    // Off unless a spec asks for it, so the token gate below keeps testing
    // tokens, and so no fixture shells out to the real `tailscale` to discover
    // who owns THIS machine.
    HARBOR_TAILNET_LOGINS: options.tailnetLogins ? options.tailnetLogins.join(',') : 'none',
  };
  delete env.HARBOR_USER_DATA_DIR;
  const sidebar = options.sidebar || {
    emitter: new EventEmitter(),
    async start() {},
    close() {},
    getState: () => ({ model: [] }),
    getSessionMeta: async () => null,
  };
  const composed = await composeServer({
    userDataDir,
    env,
    skipDaemonStart: true,
    sidebar,
    transcript: options.transcript,
    sessionSend: options.sessionSend,
    terminalBridge: options.terminalBridge,
    tasks: {
      read: async () => ({ lists: [], tasks: [], version: 1 }),
      mutate: async (op) => ({ ok: true, op }),
      subscribe() {},
      close() {},
    },
    queueLimit: options.queueLimit ?? 4,
    logger: options.logger ?? console,
    onFakeLaunch: options.onFakeLaunch,
  });
  const address = await composed.listen({ host: '127.0.0.1', port: 0 });
  const wsUrl = `ws://127.0.0.1:${address.port}/ws`;
  return {
    root,
    composed,
    env,
    userDataDir,
    artifactsRoot,
    iconsDir,
    address,
    wsUrl,
    close: async () => {
      await composed.close();
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

module.exports = { isolatedFixture };

test.describe('MOBILE-9 adversarial security gate', () => {
  test('attack 1: every mutating RPC requires a valid token', async () => {
    const fx = await isolatedFixture();
    try {
      const truncated = fx.composed.token.slice(0, 32);
      const wrong = 'f'.repeat(64);
      expect(wrong).not.toBe(fx.composed.token);
      for (const method of MUTATING_METHODS) {
        const unauth = await wsCall(fx.wsUrl, method, {});
        expect(unauth.error, `${method} without token`).toMatch(/authentication required/);
        const badBearer = await wsCall(fx.wsUrl, method, {}, { bearer: wrong });
        expect(badBearer.error, `${method} wrong token`).toMatch(/authentication required/);
        const short = await wsCall(`${fx.wsUrl}?token=${truncated}`, method, {});
        expect(short.error, `${method} truncated token`).toMatch(/authentication required/);
      }
      const authed = await wsCall(`${fx.wsUrl}?token=${fx.composed.token}`, 'tasks:mutate', { op: { type: 'noop' } });
      expect(authed.error || authed.result).toBeTruthy();
      if (authed.error) expect(authed.error).not.toMatch(/authentication required/);
    } finally {
      await fx.close();
    }
  });

  test('attack 2: session:takeover is impossible without authentication', async () => {
    const fx = await isolatedFixture();
    try {
      const payload = { sessionId: '11111111-1111-4111-8111-111111111111' };
      // The security property, unchanged and still the point of this spec.
      const unauth = await wsCall(fx.wsUrl, 'session:takeover', payload);
      expect(unauth.error).toMatch(/authentication required.*session:takeover/);

      // The second half used to assert takeover was "not available in the
      // headless composition". That was a statement about the server being
      // INCOMPLETE, not about it being safe, and it stopped being true when
      // the phone gained adopt-on-send. Asserting it now would mean the gate
      // fails whenever the server gains a capability, which trains you to
      // edit the security spec to make it pass. What must hold is narrower and
      // real: an authenticated caller REACHES the handler, and is then subject
      // to the ordinary takeover rules rather than being waved through.
      const authed = await wsCall(`${fx.wsUrl}?token=${fx.composed.token}`, 'session:takeover', payload);
      expect(authed.error || '').not.toMatch(/authentication required/);
      expect(authed.error || '').not.toMatch(/not available in the headless composition/);
      // This fixture's session id owns no live process, so a correct
      // implementation refuses it honestly rather than signalling something.
      if (authed.error) expect(authed.error).toMatch(/session|process|owner|pane|resume/i);
      // And the signal guard must be wired in this composition root at all;
      // attack 7 drives the kill path itself.
      expect(fx.composed.isolation.signalPolicy).toBeTruthy();
    } finally {
      await fx.close();
    }
  });

  test('attack 3: artifact route refuses traversal, symlinks, encoding, and fake siblings', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'harbor-mobile-artifacts-'));
    try {
      const indexedDir = path.join(root, 'project', 'out');
      const otherDir = path.join(root, 'project', 'other');
      const outside = path.join(path.dirname(root), `outside-secret-${path.basename(root)}.txt`);
      await fs.mkdir(indexedDir, { recursive: true });
      await fs.mkdir(otherDir, { recursive: true });
      const indexed = path.join(indexedDir, 'report.html');
      const realSibling = path.join(indexedDir, 'chart.png');
      const fakeSibling = path.join(otherDir, 'chart.png');
      const symlinkEscape = path.join(indexedDir, 'escape.txt');
      await fs.writeFile(indexed, '<html>ok</html>');
      await fs.writeFile(realSibling, 'png');
      await fs.writeFile(fakeSibling, 'wrong sibling');
      await fs.writeFile(outside, 'secret');
      await fs.symlink(outside, symlinkEscape);

      const sessionStart = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const transcriptDir = path.join(root, 'project');
      await fs.mkdir(transcriptDir, { recursive: true });
      const transcript = path.join(transcriptDir, 'session.jsonl');
      const line = JSON.stringify({
        type: 'assistant',
        cwd: '/tmp',
        timestamp: sessionStart,
        message: { content: [{ type: 'text', text: `written ${indexed} and ${realSibling}` }] },
      });
      await fs.writeFile(transcript, `${line}\n`);

      const provider = createArtifactsProvider({
        roots: [root],
        cacheFile: path.join(root, 'artifacts-index.json'),
      });
      await provider.list();
      const handler = createArtifactHandler({ provider });
      const server = http.createServer(handler);
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = server.address().port;

      const okIndexed = await httpGet(port, `/artifacts?path=${encodeURIComponent(indexed)}`);
      expect(okIndexed.status).toBe(200);

      const okSibling = await httpGet(port, `/artifacts?path=${encodeURIComponent(realSibling)}`);
      expect(okSibling.status).toBe(200);

      const traversal = await httpGet(port, `/artifacts?path=${encodeURIComponent(path.join(indexedDir, '..', '..', 'outside-secret.txt'))}`);
      expect(traversal.status).toBe(404);

      const encodedTraversal = await httpGet(port, `/artifacts?path=%2F${encodeURIComponent(path.join('project', 'out', '..', '..', 'outside-secret.txt')).replace(/%2F/g, '%252F')}`);
      expect(encodedTraversal.status).toBe(404);

      const fake = await httpGet(port, `/artifacts?path=${encodeURIComponent(fakeSibling)}`);
      expect(fake.status).toBe(404);

      const viaSymlink = await httpGet(port, `/artifacts?path=${encodeURIComponent(symlinkEscape)}`);
      expect(viaSymlink.status).toBe(404);

      await new Promise((resolve) => server.close(resolve));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test('attack 4: icons are served only for filenames the index found', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'harbor-mobile-icons-'));
    try {
      const iconsDir = path.join(root, 'icons');
      const outsideSecret = path.join(root, 'secret.png');
      await fs.mkdir(iconsDir, { recursive: true });
      await fs.writeFile(path.join(iconsDir, 'harbor.png'), 'PNG');
      await fs.writeFile(outsideSecret, 'SECRET');
      const provider = createProjectIconProvider({ env: { HARBOR_PROJECT_ICONS_DIR: iconsDir } });
      const handler = createIconHandler({ provider });
      const server = http.createServer(handler);
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = server.address().port;

      const ok = await httpGet(port, `/icons/${encodeURIComponent('harbor.png')}`);
      expect(ok.status).toBe(200);

      const notIndexed = await httpGet(port, `/icons/${encodeURIComponent('secret.png')}`);
      expect(notIndexed.status).toBe(404);

      const traversal = await httpGet(port, '/icons/..%2Fsecret.png');
      expect(traversal.status).toBe(404);

      await new Promise((resolve) => server.close(resolve));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test('attack 5: listener is not on 0.0.0.0 and Tailscale Funnel is not configured', async () => {
    const fx = await isolatedFixture();
    try {
      expect(fx.address.address).toBe('127.0.0.1');
      expect(fx.address.address).not.toBe('0.0.0.0');

      const ss = spawnSync('ss', ['-tlnp'], { encoding: 'utf8' });
      expect(ss.status).toBe(0);
      const listenLines = ss.stdout.split('\n').filter((line) => line.includes(`:${fx.address.port}`));
      expect(listenLines.length).toBeGreaterThan(0);
      for (const line of listenLines) {
        const local = line.trim().split(/\s+/)[3] || '';
        expect(local).toBe(`127.0.0.1:${fx.address.port}`);
        expect(local.startsWith('0.0.0.0:')).toBe(false);
      }

      const tailscale = spawnSync('tailscale', ['serve', 'status'], { encoding: 'utf8' });
      if (tailscale.status === 0) {
        expect(tailscale.stdout + tailscale.stderr).not.toMatch(/funnel/i);
      }
    } finally {
      await fx.close();
    }
  });

  test('attack 6: a slow websocket client drops terminal frames instead of growing unbounded', async () => {
    const warnings = [];
    const fx = await isolatedFixture({
      queueLimit: 3,
      logger: { warn: (msg) => warnings.push(String(msg)) },
    });
    try {
      const ws = new WebSocket(`${fx.wsUrl}?token=${fx.composed.token}`);
      await new Promise((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
      });
      for (let i = 0; i < 12; i += 1) {
        fx.composed.router.emit('terminal:frame', { paneId: 'pane-1', seq: i });
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
      ws.close();
      expect(warnings.some((line) => line.includes('dropped terminal frames'))).toBe(true);
    } finally {
      await fx.close();
    }
  });

  test('attack 7: isolated harbor-server refuses real signals and launches unless opted in', async () => {
    const defaultProfile = defaultUserDataDir({ env: process.env });
    const blockedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'harbor-mobile-isolation-blocked-'));
    const allowedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'harbor-mobile-isolation-allowed-'));
    try {
      const blockedUserData = path.join(blockedRoot, 'user-data');
      const allowedUserData = path.join(allowedRoot, 'user-data');
      await fs.mkdir(blockedUserData, { recursive: true });
      await fs.mkdir(allowedUserData, { recursive: true });

      const blockedEnv = {
        ...process.env,
        HARBOR_NO_DAEMON_START: '1',
        HARBOR_NO_USAGE_FETCH: '1',
        // Never let a test read this machine's real Tailscale identity.
        HARBOR_TAILNET_LOGINS: 'none',
        HARBOR_TASKS_FILE: path.join(blockedRoot, 'tasks.json'),
        // Isolated like every other store. This spec is about the LAUNCH and
        // SIGNAL policies; letting it trip the session-store policy instead
        // would make it throw before it asserted anything.
        HARBOR_SESSIOND_DIR: path.join(blockedRoot, 'sessiond'),
      };
      delete blockedEnv.HARBOR_CONTEXT_DIR;

      const blocked = await composeServer({
        userDataDir: blockedUserData,
        env: blockedEnv,
        skipDaemonStart: true,
        sidebar: { emitter: new EventEmitter(), async start() {}, close() {}, getState: () => ({ model: [] }) },
        tasks: { read: async () => ({}), mutate: async () => ({}), subscribe() {}, close() {} },
        artifacts: { async list() { return { ok: true, artifacts: [] }; }, isServable: () => false },
        icons: { async list() { return { icons: {} }; }, watch() {}, async filePathFor() { return null; }, mimeFor() { return null; } },
      });
      expect(blocked.userDataDir).not.toBe(defaultProfile);
      expect(blocked.isolation.launchPolicy.allowed).toBe(false);
      expect(blocked.isolation.signalPolicy.allowed).toBe(false);

      await expect(blocked.isolation.launchActions.resumeSession({
        id: '11111111-1111-4111-8111-111111111111',
        detectedHome: 'personal',
      })).rejects.toThrow(/refusing to launch a real session/);

      expect(() => blocked.isolation.guardedKill(4321, 'SIGTERM')).toThrow(/refusing to signal a real process/);
      blocked.isolation.guardedKill(4321, 0);
      expect(blocked.isolation.signalCalls).toEqual([[4321, 0]]);

      const fakeCalls = [];
      const allowed = await composeServer({
        userDataDir: allowedUserData,
        env: {
          ...process.env,
          HARBOR_NO_DAEMON_START: '1',
          HARBOR_NO_USAGE_FETCH: '1',
          // Never let a test read this machine's real Tailscale identity.
          HARBOR_TAILNET_LOGINS: 'none',
          HARBOR_E2E_FAKE_LAUNCH: '1',
          HARBOR_ALLOW_REAL_SIGNALS: '1',
          HARBOR_CONTEXT_DIR: path.join(allowedRoot, 'context'),
          HARBOR_TASKS_FILE: path.join(allowedRoot, 'tasks.json'),
          HARBOR_SESSIOND_DIR: path.join(allowedRoot, 'sessiond'),
        },
        skipDaemonStart: true,
        onFakeLaunch: (record) => fakeCalls.push(record),
        sidebar: { emitter: new EventEmitter(), async start() {}, close() {}, getState: () => ({ model: [] }) },
        tasks: { read: async () => ({}), mutate: async () => ({}), subscribe() {}, close() {} },
        artifacts: { async list() { return { ok: true, artifacts: [] }; }, isServable: () => false },
        icons: { async list() { return { icons: {} }; }, watch() {}, async filePathFor() { return null; }, mimeFor() { return null; } },
      });
      expect(allowed.isolation.launchPolicy.allowed).toBe(false);
      expect(allowed.isolation.signalPolicy.allowed).toBe(true);

      await allowed.isolation.launchActions.resumeSession({
        id: '22222222-2222-4222-8222-222222222222',
        detectedHome: 'personal',
      });
      expect(fakeCalls.length).toBe(1);
      try { allowed.isolation.guardedKill(9999, 'SIGTERM'); } catch (error) {
        if (error?.code !== 'ESRCH') throw error;
      }
      expect(allowed.isolation.signalCalls).toContainEqual([9999, 'SIGTERM']);

      await blocked.close();
      await allowed.close();
    } finally {
      await fs.rm(blockedRoot, { recursive: true, force: true });
      await fs.rm(allowedRoot, { recursive: true, force: true });
    }
  });
});
