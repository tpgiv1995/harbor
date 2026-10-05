'use strict';

/**
 * MOBILE-PARITY-2 verification: settings sheet leaves websocket connected.
 * Run: node scripts/verify-settings-sheet.js
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { _electron: electron } = require('@playwright/test');
const { composeServer } = require('../src/server/compose.js');
const { createTaskStore } = require('../src/main/providers/tasks.js');
const { createAppShim } = require('../src/server/app-shim.js');

const APP_ROOT = path.join(__dirname, '..');
const REPO_ROOT = path.join(APP_ROOT, '..');
const OUT_DIR = path.join(APP_ROOT, 'verify', 'settings');
const VIEWPORT = { width: 430, height: 932 };

function sampleSidebarModel() {
  return {
    projects: [
      {
        label: 'harbor',
        hasLive: true,
        sessionCount: 1,
        lastActiveMs: Date.now(),
        sessions: [
          {
            id: 'sess-settings-proof',
            title: 'Settings sheet proof session',
            project: 'harbor',
            cwd: REPO_ROOT,
            provider: 'claude',
            lastActiveMs: Date.now(),
            isLive: true,
            agentStatus: 'idle',
            paneId: 'pane-settings-proof',
            workspaceId: 'workspace-settings-proof',
          },
        ],
      },
    ],
  };
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-settings-verify-'));
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
  const composed = await composeServer({
    userDataDir: dir,
    webDist: path.join(APP_ROOT, 'dist-web'),
    env: {
      ...process.env,
      HARBOR_NO_DAEMON_START: '1',
      HARBOR_TASKS_FILE: tasksFile,
    },
    sidebar,
    tasks,
    artifacts: {
      async list() { return { ok: true, artifacts: [] }; },
      isServable() { return false; },
    },
    icons: {
      async list() {
        return { dir, icons: { harbor: '/icons/harbor.png' } };
      },
      watch() {},
      async filePathFor() { return null; },
      mimeFor() { return 'image/png'; },
    },
    terminalBridge: { async start() {}, close() {} },
    transcript: {
      open: async (sessionId) => {
        const lines = [];
        for (let i = 1; i <= 12; i += 1) {
          lines.push({
            key: `u${i}`,
            kind: 'user',
            text: `Scroll proof line ${i}: settings must not disconnect the live session.`,
          });
          lines.push({
            key: `a${i}`,
            kind: 'assistant',
            text: `Acknowledged line ${i}. The websocket stays up while settings is open.`,
          });
        }
        const payload = {
          sessionId,
          replace: lines,
          header: { blocked: false, working: false },
        };
        // useTranscript subscribes AFTER the first open call; delay so the push
        // is not missed (same pattern as capture-mobile-web.js).
        setTimeout(() => transcriptEmitter.emit('update', payload), 200);
        return { ok: true };
      },
      close: () => {},
      closeAll() {},
      emitter: transcriptEmitter,
    },
    sessionSend: {
      emitter: new EventEmitter(),
      getMenu: async () => null,
      answerMenu: async () => ({ ok: true }),
      getQueueState: () => ({ count: 0, items: [] }),
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

  const electronMain = path.join(dir, 'verify-electron.js');
  fs.writeFileSync(electronMain, `'use strict';\nconst { app, BrowserWindow } = require('electron');\napp.whenReady().then(() => {\n  const win = new BrowserWindow({ width: ${VIEWPORT.width}, height: ${VIEWPORT.height}, useContentSize: true, show: true });\n  win.loadURL('about:blank');\n});\n`, 'utf8');
  const electronApp = await electron.launch({
    executablePath: require('electron'),
    args: ['--no-sandbox', '--disable-gpu', electronMain],
    env: {
      ...process.env,
      HARBOR_USER_DATA_DIR: dir,
    },
    cwd: APP_ROOT,
  });
  const page = await electronApp.firstWindow();
  await page.setViewportSize(VIEWPORT);
  page.on('pageerror', (err) => console.error('PAGE ERROR:', err));

  await page.addInitScript(({ serverUrl, token }) => {
    localStorage.setItem('harbor-web-server', serverUrl);
    localStorage.setItem('harbor-web-token', token);
    localStorage.setItem('harbor-web-open', JSON.stringify(['sess-settings-proof']));
    localStorage.setItem('harbor-web-active', 'sess-settings-proof');
    window.__harborConnectCount = 0;
    const NativeWS = window.WebSocket;
    window.WebSocket = class HarborCountWebSocket extends NativeWS {
      constructor(...args) {
        super(...args);
        window.__harborConnectCount += 1;
      }
    };
  }, { serverUrl: baseUrl, token: composed.token });

  await page.goto(`${baseUrl}/`);
  await page.waitForSelector('.app-shell', { timeout: 15000 });
  await page.waitForSelector('.app-shell[data-connection="online"]', { timeout: 30000 });
  try {
    await page.waitForFunction(() => {
      const title = document.querySelector('.hdr-title');
      const err = document.querySelector('.load-error');
      return title?.textContent?.includes('Settings sheet proof') && !err;
    }, null, { timeout: 30000 });
  } catch (error) {
    const debug = await page.evaluate(() => ({
      connection: document.querySelector('.app-shell')?.getAttribute('data-connection'),
      title: document.querySelector('.hdr-title')?.textContent,
      err: document.querySelector('.load-error')?.textContent,
      body: document.body.innerText.slice(0, 600),
    }));
    throw new Error(`${error.message}\n${JSON.stringify(debug)}`);
  }
  try {
    await page.waitForFunction(() => document.querySelectorAll('.conv-assistant').length > 0, null, { timeout: 25000 });
  } catch (error) {
    const snippet = await page.evaluate(() => document.body.innerText.slice(0, 800));
    throw new Error(`${error.message}\nbody: ${snippet}`);
  }

  const conv = page.locator('.conv');
  await conv.evaluate((el) => { el.scrollTop = 420; });
  const scrollBefore = await conv.evaluate((el) => el.scrollTop);

  const connectCountBefore = await page.evaluate(() => window.__harborConnectCount);
  const connectionBefore = await page.locator('.app-shell').getAttribute('data-connection');

  const capture = async (name) => {
    const target = path.join(OUT_DIR, name);
    await page.screenshot({ path: target, fullPage: true });
    console.log(`CAPTURE ${name}`);
    return target;
  };

  await capture('01-session-before-settings.png');

  await page.locator('.hdr-settings').click();
  await page.waitForSelector('.settings-panel', { timeout: 5000 });

  const connectCountOpen = await page.evaluate(() => window.__harborConnectCount);
  const connectionOpen = await page.locator('.app-shell').getAttribute('data-connection');
  const connectScreenVisible = await page.locator('.connect-screen').count();

  await capture('02-settings-sheet-open.png');

  await page.locator('.settings-close').click();
  await page.waitForSelector('.settings-panel', { state: 'hidden', timeout: 5000 });

  const scrollAfter = await conv.evaluate((el) => el.scrollTop);
  const connectCountAfter = await page.evaluate(() => window.__harborConnectCount);
  const connectionAfter = await page.locator('.app-shell').getAttribute('data-connection');

  await capture('03-session-after-settings.png');

  const results = {
    viewport: VIEWPORT,
    scrollBefore,
    scrollAfter,
    scrollPreserved: scrollBefore === scrollAfter,
    connectionBefore,
    connectionOpen,
    connectionAfter,
    connectCountBefore,
    connectCountOpen,
    connectCountAfter,
    connectScreenVisibleWhileSettingsOpen: connectScreenVisible > 0,
    tokenFormReachableBySingleTap: false,
    routesToConnectScreen: [
      'setupGate === setup (no server URL, or token required and not authenticated)',
      'forceSetup === true after SettingsSheet Reconnect confirm or Sign out',
    ],
    screenshots: [
      '01-session-before-settings.png',
      '02-settings-sheet-open.png',
      '03-session-after-settings.png',
    ],
  };

  fs.writeFileSync(path.join(OUT_DIR, 'results.json'), JSON.stringify(results, null, 2));

  const failures = [];
  if (connectionBefore !== 'online') failures.push(`connectionBefore=${connectionBefore}`);
  if (connectionOpen !== 'online') failures.push(`connectionOpen=${connectionOpen}`);
  if (connectionAfter !== 'online') failures.push(`connectionAfter=${connectionAfter}`);
  if (connectCountOpen !== connectCountBefore) failures.push(`connect count changed on open: ${connectCountBefore}->${connectCountOpen}`);
  if (connectCountAfter !== connectCountBefore) failures.push(`connect count changed after close: ${connectCountBefore}->${connectCountAfter}`);
  if (!results.scrollPreserved) failures.push(`scroll drift: ${scrollBefore}->${scrollAfter}`);
  if (connectScreenVisible > 0) failures.push('connect screen visible while settings open');

  console.log('RESULTS', JSON.stringify(results, null, 2));

  await electronApp.close();
  await composed.close();
  fs.rmSync(dir, { recursive: true, force: true });

  if (failures.length) {
    throw new Error(`verification failed: ${failures.join('; ')}`);
  }
  console.log('PASS: settings sheet verification');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
