#!/usr/bin/env node
'use strict';

// Isolated win32 phone-viewport drive for item 4 (harbor-server first-class).
//
// Starts harbor-server on loopback against a fully relocated store, drives the
// built PWA with headless Chromium at an iPhone viewport (390x844), and writes
// screenshots under orch-inputs/i4-evidence/. Never touches the real daemon,
// never binds beyond loopback, never opens a visible window.
//
//   cd app && npm run build:web && npm run drive:mobile-win
//
// Requires app/node_modules (junction the real checkout's if this is a worktree).

const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const fssync = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { WebSocket } = require('ws');
const { chromium } = require('@playwright/test');
const { composeServer } = require('../src/server/compose.js');
const { realTmpDir } = require('../test/support/real-tmpdir.js');
const { execPath: guiNodeExecPath } = require('../test/support/gui-node.js');

const APP_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(APP_ROOT, '..');
const EVIDENCE = path.join(REPO_ROOT, 'orch-inputs', 'i4-evidence');
const VIEWPORT = { width: 390, height: 844 };
const SESSION_ID = '11111111-1111-4111-8111-111111111111';

function wsCall(url, method, payload, { token } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(token ? `${url}?token=${token}` : url);
    ws.once('error', reject);
    ws.once('open', () => ws.send(JSON.stringify({ id: 1, method, payload })));
    ws.once('message', (bytes) => {
      const message = JSON.parse(bytes.toString());
      ws.close();
      resolve(message);
    });
  });
}

async function buildWebIfNeeded() {
  const index = path.join(APP_ROOT, 'dist-web', 'index.html');
  if (fssync.existsSync(index)) return;
  console.log('building phone client (dist-web missing)...');
  const res = spawnSync('npm', ['run', 'build:web'], {
    cwd: APP_ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (res.status !== 0) throw new Error('npm run build:web failed');
}

async function makeFixture() {
  const root = await fs.mkdtemp(path.join(realTmpDir(), 'harbor-i4-drive-'));
  const userDataDir = path.join(root, 'user-data');
  const contextDir = path.join(root, 'context');
  const sessiondDir = path.join(root, 'sessiond');
  const projectFolder = path.join(root, 'project');
  await Promise.all([
    fs.mkdir(userDataDir, { recursive: true }),
    fs.mkdir(contextDir, { recursive: true }),
    fs.mkdir(sessiondDir, { recursive: true }),
    fs.mkdir(projectFolder, { recursive: true }),
  ]);

  const sidebarEmitter = new EventEmitter();
  const transcriptEmitter = new EventEmitter();
  const state = {
    model: {
      projects: [{
        label: 'i4-isolated-project',
        hasLive: true,
        sessions: [{
          id: SESSION_ID,
          title: 'Isolated i4 session',
          cwd: projectFolder,
          provider: 'claude',
          paneId: 'pane-i4',
          workspaceId: 'workspace-i4',
          isLive: true,
          agentStatus: 'idle',
          lastActiveMs: Date.now(),
        }],
      }],
    },
  };
  const sent = [];
  const composed = await composeServer({
    userDataDir,
    env: {
      ...process.env,
      HARBOR_NO_DAEMON_START: '1',
      HARBOR_NO_USAGE_FETCH: '1',
      HARBOR_NO_MODEL_DISCOVERY: '1',
      HARBOR_NO_TITLER: '1',
      HARBOR_NO_VOICE: '1',
      HARBOR_CONTEXT_DIR: contextDir,
      HARBOR_SESSIOND_DIR: sessiondDir,
      HARBOR_SESSIOND_SOCKET: path.join(sessiondDir, 'sessiond.sock'),
      HARBOR_ARTIFACTS_ROOTS: path.join(root, 'artifacts'),
      HARBOR_ARTIFACTS_CACHE: path.join(root, 'artifact-cache.json'),
      HARBOR_TASKS_FILE: path.join(root, 'tasks.json'),
      HARBOR_PROJECT_ICONS_DIR: path.join(root, 'icons'),
      HARBOR_E2E_FAKE_LAUNCH: '1',
      HARBOR_TAILNET_LOGINS: 'none',
      HARBOR_WEB_DIST: path.join(APP_ROOT, 'dist-web'),
    },
    skipDaemonStart: true,
    sidebar: {
      emitter: sidebarEmitter,
      async start() {},
      close() {},
      getState: () => state,
      getSessionMeta: async () => ({ cwd: projectFolder }),
      getSessionPreview: async () => null,
      focusLivePane: async () => ({ ok: true }),
    },
    transcript: {
      emitter: transcriptEmitter,
      async open(sessionId) {
        setTimeout(() => transcriptEmitter.emit('update', {
          sessionId,
          replace: [
            { key: `${sessionId}-user`, kind: 'user', text: 'Probe the isolated phone plane.' },
            { key: `${sessionId}-assistant`, kind: 'assistant', text: 'Standing by on the relocated store.' },
          ],
          header: { blocked: false, working: false },
        }), 20);
        return { ok: true };
      },
      close() {},
      closeAll() {},
    },
    sessionSend: {
      emitter: new EventEmitter(),
      async send(payload) {
        sent.push(payload);
        return { ok: true };
      },
      getQueueState: () => ({ count: 0, items: [] }),
      cancelQueued: () => ({ ok: true }),
      async getMenu() { return null; },
      async answerMenu() { return { ok: true }; },
    },
    terminalBridge: {
      emitter: new EventEmitter(),
      async start() {},
      close() {},
      async sendInput() { return { ok: true }; },
    },
    tasks: {
      read: async () => ({ lists: [], tasks: [], version: 1 }),
      mutate: async (op) => ({ ok: true, op }),
      subscribe() {},
      close() {},
    },
    logger: console,
  });
  const address = await composed.listen({ host: '127.0.0.1', port: 0 });
  return {
    root,
    composed,
    address,
    sent,
    projectFolder,
    wsUrl: `ws://127.0.0.1:${address.port}/ws`,
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      await composed.close();
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

async function assertAuthGates(fx) {
  const unauth = await wsCall(fx.wsUrl, 'session:send', { sessionId: SESSION_ID, text: 'nope' });
  if (!/authentication required/.test(unauth.error || '')) {
    throw new Error(`expected unauthenticated session:send refusal, got ${JSON.stringify(unauth)}`);
  }
  const localOnly = await wsCall(fx.wsUrl, 'e2e:quit', {}, { token: fx.composed.token });
  if (!/local-only/.test(localOnly.error || '')) {
    throw new Error(`expected token-bearing e2e:quit local-only refusal, got ${JSON.stringify(localOnly)}`);
  }
  const foreign = await new Promise((resolve) => {
    const ws = new WebSocket(fx.wsUrl, { headers: { origin: 'https://evil.example' } });
    ws.once('open', () => resolve({ opened: true }));
    ws.once('error', () => resolve({ opened: false }));
    ws.once('unexpected-response', () => resolve({ opened: false }));
  });
  if (foreign.opened) throw new Error('foreign Origin must be refused before open');
}

async function main() {
  console.log(`gui-node execPath=${guiNodeExecPath}`);
  await buildWebIfNeeded();
  await fs.mkdir(EVIDENCE, { recursive: true });
  const fx = await makeFixture();
  let browser;
  try {
    await assertAuthGates(fx);
    console.log('auth gates: unauth mutation refused, e2e:* local-only, foreign Origin destroyed');

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: VIEWPORT });
    const page = await context.newPage();

    // 1. Connect screen (no token preloaded).
    await page.goto(fx.baseUrl, { waitUntil: 'domcontentloaded' });
    await page.locator('.connect-screen').waitFor({ timeout: 15000 });
    await page.screenshot({ path: path.join(EVIDENCE, '01-connect-screen.png'), fullPage: true });
    console.log('shot: 01-connect-screen.png');

    // 2. One-tap token link (the mint:server-link shape).
    const link = `${fx.baseUrl}/#token=${fx.composed.token}&url=${encodeURIComponent(fx.baseUrl)}`;
    await page.goto(link, { waitUntil: 'domcontentloaded' });
    // A same-URL hash-only goto does not reload the SPA, and the client
    // ingests the #token fragment only at load: reload to make the one-tap
    // link do what a phone's cold open does.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('.app-shell[data-connection="online"]').waitFor({ timeout: 20000 });
    await page.screenshot({ path: path.join(EVIDENCE, '02-rail-online.png'), fullPage: true });
    console.log('shot: 02-rail-online.png');

    // 3. Open the isolated session (rail / switcher -> transcript).
    const switcher = page.getByRole('button', { name: 'Switch session' });
    if (await switcher.count()) {
      await switcher.click();
      // The header title and the switcher row both carry the exact text;
      // strict mode refuses two matches, so target the switcher row class.
      await page.locator('.session-title', { hasText: 'Isolated i4 session' }).first().click();
    } else {
      // Fresh connect may already land on the only live session; open via row.
      const row = page.getByText('Isolated i4 session', { exact: true });
      if (await row.count()) await row.first().click();
    }
    await page.getByText('Standing by on the relocated store.').waitFor({ timeout: 15000 });
    await page.screenshot({ path: path.join(EVIDENCE, '03-transcript.png'), fullPage: true });
    console.log('shot: 03-transcript.png');

    // 4. One send into the isolated session.
    const field = page.locator('.composer-field textarea, textarea, [contenteditable="true"]').first();
    await field.click();
    await field.fill('i4 isolated send probe');
    await page.keyboard.press('Enter');
    const deadline = Date.now() + 10000;
    while (fx.sent.length === 0 && Date.now() < deadline) {
      await page.waitForTimeout(100);
    }
    if (fx.sent.length === 0) {
      // Some composers use a send button rather than Enter alone.
      const sendBtn = page.getByRole('button', { name: /send/i });
      if (await sendBtn.count()) await sendBtn.first().click();
      while (fx.sent.length === 0 && Date.now() < deadline + 5000) {
        await page.waitForTimeout(100);
      }
    }
    if (fx.sent.length === 0) {
      throw new Error('session:send never reached the stubbed sessionSend boundary');
    }
    await page.screenshot({ path: path.join(EVIDENCE, '04-after-send.png'), fullPage: true });
    console.log('shot: 04-after-send.png');
    console.log(`send payload: ${JSON.stringify(fx.sent[0])}`);

    await fs.writeFile(
      path.join(EVIDENCE, 'README.md'),
      [
        '# i4 evidence: harbor-server win32 phone drive',
        '',
        `- viewport: ${VIEWPORT.width}x${VIEWPORT.height}`,
        `- bind: ${fx.baseUrl} (loopback only)`,
        `- store: relocated under ${fx.root}`,
        `- gui-node execPath: ${guiNodeExecPath}`,
        `- auth: unauthenticated mutation refused; e2e:* local-only with token; foreign Origin destroyed`,
        `- send count: ${fx.sent.length}`,
        '',
        '## Screenshots',
        '',
        '- `01-connect-screen.png` — token login form',
        '- `02-rail-online.png` — online after `#token=` link',
        '- `03-transcript.png` — isolated session transcript',
        '- `04-after-send.png` — after one send into the isolated session',
        '',
        'Real-machine bring-up (token mint on default profile, tailscale serve,',
        'iPhone PWA install) was NOT performed here; that is the orchestrator step.',
        '',
      ].join('\n'),
    );
    console.log(`evidence written to ${EVIDENCE}`);
  } finally {
    await browser?.close().catch(() => {});
    await fx.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
