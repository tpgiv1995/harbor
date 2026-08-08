'use strict';

/**
 * MOBILE-6 verification: screenshots at 430x932 and live CLI task propagation.
 * Run: node scripts/capture-mobile-web.js
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { _electron: electron } = require('@playwright/test');
const { WebSocket } = require('ws');
const { composeServer } = require('../src/server/compose.js');
const { createTaskStore } = require('../src/main/providers/tasks.js');
const { createAppShim } = require('../src/server/app-shim.js');

const APP_ROOT = path.join(__dirname, '..');
const REPO_ROOT = path.join(APP_ROOT, '..');
const OUT_DIR = path.join(APP_ROOT, 'test', 'web', 'screenshots');
const CLI = path.join(REPO_ROOT, 'bin', 'harbor-tasks');
// A second, unrelated project (sibling of the repo checkout) purely to prove
// the sidebar groups sessions by project; any real second project would do.
const OTHER_PROJECT_CWD = path.join(path.dirname(REPO_ROOT), 'example-project');
const VIEWPORT = { width: 430, height: 932 };

function sampleSidebarModel() {
  return {
    projects: [
      {
        label: 'harbor',
        hasLive: true,
        sessionCount: 2,
        lastActiveMs: Date.now(),
        sessions: [
          {
            id: 'sess-harbor-live',
            title: 'Mobile session switcher',
            project: 'harbor',
            cwd: REPO_ROOT,
            provider: 'claude',
            lastActiveMs: Date.now(),
            isLive: true,
            agentStatus: 'working',
            paneId: 'pane-mobile-proof',
            workspaceId: 'workspace-mobile-proof',
          },
          {
            id: 'sess-harbor-old',
            title: 'Rail sheet polish',
            project: 'harbor',
            cwd: REPO_ROOT,
            provider: 'claude',
            lastActiveMs: Date.now() - 3600000,
            isLive: false,
            agentStatus: 'idle',
          },
        ],
      },
      {
        label: 'Team Tools',
        hasLive: false,
        sessionCount: 1,
        lastActiveMs: Date.now() - 7200000,
        sessions: [
          {
            id: 'sess-hr',
            title: 'Example Reporting',
            project: 'Team Tools',
            cwd: OTHER_PROJECT_CWD,
            provider: 'claude',
            lastActiveMs: Date.now() - 7200000,
            isLive: false,
            agentStatus: 'idle',
          },
        ],
      },
    ],
  };
}

function waitForPush(url, token, channel, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${url}?token=${token}`);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`timed out waiting for ${channel}`));
    }, timeoutMs);
    ws.on('message', (bytes) => {
      const message = JSON.parse(bytes);
      if (message.type === 'push' && message.channel === channel) {
        clearTimeout(timer);
        ws.close();
        resolve(message.args?.[0] || message.args);
      }
    });
    ws.on('error', reject);
  });
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-mobile-web-'));
  const tasksFile = path.join(dir, 'tasks.json');
  const contextDir = path.join(dir, 'context');
  const artifactsRoot = path.join(dir, 'artifacts');
  fs.mkdirSync(contextDir, { recursive: true });
  fs.mkdirSync(artifactsRoot, { recursive: true });
  const app = createAppShim({ userDataDir: dir });
  const tasks = createTaskStore({ app, env: { HARBOR_TASKS_FILE: tasksFile } });

  const sidebar = {
    emitter: new EventEmitter(),
    async start() {},
    close() {},
    getState: () => ({ model: sampleSidebarModel() }),
    getSessionMeta: () => null,
    getSessionPreview: () => null,
    focusLivePane: async () => ({}),
  };

  const transcriptEmitter = new EventEmitter();
  let showAnswer = false;
  const composed = await composeServer({
    userDataDir: dir,
    webDist: path.join(APP_ROOT, 'dist', 'web'),
    env: {
      ...process.env,
      HARBOR_NO_DAEMON_START: '1',
      HARBOR_TASKS_FILE: tasksFile,
      HARBOR_CONTEXT_DIR: contextDir,
      HARBOR_ARTIFACTS_ROOTS: artifactsRoot,
    },
    sidebar,
    tasks,
    artifacts: {
      async list() { return { ok: true, artifacts: [] }; },
      isServable() { return false; },
    },
    icons: {
      async list() {
        return {
          dir,
          icons: { harbor: '/icons/harbor.png' },
        };
      },
      watch() {},
      async filePathFor() { return null; },
      mimeFor() { return 'image/png'; },
    },
    terminalBridge: { async start() {}, close() {} },
    transcript: {
      open: async (sessionId) => {
        setTimeout(() => transcriptEmitter.emit('update', {
          sessionId,
          replace: [
            { key: 'u1', kind: 'user', text: 'Integrate the mobile navigation lane.' },
            { key: 'a1', kind: 'assistant', text: 'The shared shell now mounts one authoritative conversation.' },
            { key: 't1', kind: 'action', verb: 'Read', status: 'done', chip: 'main.jsx' },
          ],
          header: { blocked: true, working: false },
        }), 50);
        return { ok: true };
      },
      close: () => {},
      closeAll() {},
      emitter: transcriptEmitter,
    },
    sessionSend: {
      emitter: new EventEmitter(),
      getMenu: async () => showAnswer ? ({
        question: 'Which mobile shell should Harbor use?',
        options: [
          { index: 1, label: 'Unified navigation shell', description: 'Keeps one conversation and the complete answer-card contract.', recommended: true },
          { index: 2, label: 'Parallel conversation panes', description: 'Duplicates transcript ownership and can drift.' },
        ],
      }) : null,
      answerMenu: async () => ({ ok: true }),
    },
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

  const address = await composed.listen({ host: '127.0.0.1', port: 0 });
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const wsUrl = `ws://127.0.0.1:${address.port}/ws`;

  const electronMain = path.join(dir, 'capture-electron.js');
  fs.writeFileSync(electronMain, `'use strict';\nconst { app, BrowserWindow } = require('electron');\napp.whenReady().then(() => {\n  const win = new BrowserWindow({ width: ${VIEWPORT.width}, height: ${VIEWPORT.height}, useContentSize: true, show: true });\n  win.loadURL('about:blank');\n});\n`, 'utf8');
  const electronApp = await electron.launch({
    executablePath: require('electron'),
    args: ['--no-sandbox', '--disable-gpu', electronMain],
    env: {
      ...process.env,
      HARBOR_USER_DATA_DIR: dir,
      HARBOR_CONTEXT_DIR: contextDir,
      HARBOR_ARTIFACTS_ROOTS: artifactsRoot,
    },
    cwd: APP_ROOT,
  });
  const page = await electronApp.firstWindow();
  await page.setViewportSize(VIEWPORT);
  page.on('pageerror', (err) => console.error('PAGE ERROR:', err));
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.error('CONSOLE:', msg.text());
  });
  await page.addInitScript(({ serverUrl, token }) => {
    localStorage.setItem('harbor-web-server', serverUrl);
    localStorage.setItem('harbor-web-token', token);
    localStorage.setItem('harbor-web-open', JSON.stringify(['sess-harbor-live']));
    localStorage.setItem('harbor-web-active', 'sess-harbor-live');
  }, { serverUrl: baseUrl, token: composed.token });

  await page.goto(`${baseUrl}/`);
  await page.waitForSelector('.app-shell', { timeout: 15000 });
  await page.waitForFunction(() => (
    document.querySelector('.connection-banner')?.classList.contains('online')
  ), null, { timeout: 20000 });
  await page.waitForSelector('.conv-header-btn', { timeout: 15000 });
  await page.waitForSelector('.conv-assistant', { timeout: 15000 });

  const capture = async (name) => {
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    if (scrollWidth !== VIEWPORT.width) {
      throw new Error(`${name}: expected scrollWidth ${VIEWPORT.width}, got ${scrollWidth}`);
    }
    const target = path.join(OUT_DIR, name);
    await page.screenshot({ path: target, fullPage: true });
    console.log(`CAPTURE ${name}: scrollWidth=${scrollWidth}`);
  };

  await capture('conversation-430x932.png');

  showAnswer = true;
  await page.waitForSelector('.ask-card', { timeout: 3000 });
  await capture('answer-card-430x932.png');

  await page.locator('.conv-header-btn').click();
  await page.waitForSelector('.sheet-panel');
  await capture('session-sheet-430x932.png');

  await page.locator('.sheet-scrim').click();
  await page.locator('.nav-item', { hasText: 'Tasks' }).click();
  await page.waitForSelector('.tasks-mobile');
  await page.locator('.tasks-view-tab', { hasText: 'All' }).click();

  const pushPromise = waitForPush(wsUrl, composed.token, 'tasks:changed');
  const cliResult = spawnSync(process.execPath, [CLI, 'add', 'CLI live propagation proof'], {
    encoding: 'utf8',
    env: { ...process.env, HARBOR_TASKS_FILE: tasksFile },
  });
  if (cliResult.status !== 0) throw new Error(`harbor-tasks failed: ${cliResult.stderr}`);
  const pushed = await pushPromise;
  if (!pushed?.doc?.tasks?.some((task) => task.title === 'CLI live propagation proof')) {
    throw new Error('tasks:changed push did not carry the CLI-added task');
  }
  await page.waitForSelector('.mtask-row', { timeout: 10000 });
  await page.getByText('CLI live propagation proof', { exact: true }).waitFor({ timeout: 10000 });
  console.log('PASS: harbor-tasks CLI edit appeared in the mounted Tasks view without reload');
  await capture('tasks-view-430x932.png');

  await electronApp.close();
  await composed.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
