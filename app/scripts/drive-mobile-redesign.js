#!/usr/bin/env node
'use strict';

// Isolated offscreen phone drive for the mobile redesign. The composed server
// binds only to loopback and every writable path lives under a throwaway root.

const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('@playwright/test');
const { composeServer } = require('../src/server/compose.js');
const { realTmpDir } = require('../test/support/real-tmpdir.js');
const { dayKey } = require('../src/shared/tasks-model.cjs');

const APP_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(APP_ROOT, '..');
const EVIDENCE = path.join(REPO_ROOT, 'orch-inputs', 'mobile-redesign-evidence');
const VIEWPORT = { width: 390, height: 844 };
const SESSION_ID = '22222222-2222-4222-8222-222222222222';

async function makeFixture() {
  console.log('fixture: creating relocated stores');
  const root = await fs.mkdtemp(path.join(realTmpDir(), 'harbor-mobile-redesign-'));
  const userDataDir = path.join(root, 'user-data');
  const contextDir = path.join(root, 'context');
  const sessiondDir = path.join(root, 'sessiond');
  const projectFolder = path.join(root, 'project');
  const tasksFile = path.join(root, 'tasks.json');
  const notesFile = path.join(root, 'notes.json');
  await Promise.all([
    fs.mkdir(userDataDir, { recursive: true }),
    fs.mkdir(contextDir, { recursive: true }),
    fs.mkdir(sessiondDir, { recursive: true }),
    fs.mkdir(projectFolder, { recursive: true }),
  ]);

  const now = Date.now();
  const today = dayKey(new Date(now));
  await fs.writeFile(tasksFile, JSON.stringify({
    version: 1,
    lists: [{ id: 'list-mobile', name: 'Launch prep', color: '#437ffe', createdAt: now - 10000, order: 0 }],
    tasks: [
      { id: 'task-qa', listId: 'list-mobile', title: 'Review mobile launch checklist', notes: 'Confirm all three tabs.', starred: true, myDayDate: today, dueDate: null, tags: ['mobile'], createdAt: now - 9000, updatedAt: now - 4000, order: 0 },
      { id: 'task-copy', listId: 'list-mobile', title: 'Polish release notes', notes: 'Keep the summary concise.', done: false, myDayDate: today, dueDate: null, tags: ['release'], createdAt: now - 8000, updatedAt: now - 3000, order: 1 },
    ],
  }, null, 2));
  await fs.writeFile(notesFile, JSON.stringify({
    version: 1,
    notes: [
      { id: 'note-launch', title: 'Launch thoughts', body: 'The phone experience should feel calm, direct, and complete.', tags: ['mobile'], pinned: true, createdAt: now - 7000, updatedAt: now - 2000 },
      { id: 'note-followup', title: 'Follow-up ideas', body: 'Collect feedback after the first real-world session.', tags: ['research'], pinned: false, createdAt: now - 6000, updatedAt: now - 1000 },
    ],
  }, null, 2));

  const transcriptEmitter = new EventEmitter();
  const state = { model: { projects: [{
    label: 'mobile-redesign',
    hasLive: true,
    sessions: [{
      id: SESSION_ID,
      title: 'Mobile redesign verification',
      cwd: projectFolder,
      provider: 'claude',
      paneId: 'pane-mobile-redesign',
      workspaceId: 'workspace-mobile-redesign',
      isLive: true,
      agentStatus: 'idle',
      lastActiveMs: now,
    }],
  }] } };

  console.log('fixture: composing isolated server');
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
      HARBOR_TASKS_FILE: tasksFile,
      HARBOR_NOTES_FILE: notesFile,
      HARBOR_PROJECT_ICONS_DIR: path.join(root, 'icons'),
      HARBOR_TAILNET_LOGINS: 'none',
      HARBOR_WEB_DIST: path.join(APP_ROOT, 'dist-web'),
    },
    skipDaemonStart: true,
    sidebar: {
      emitter: new EventEmitter(), async start() {}, close() {}, getState: () => state,
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
            { key: `${sessionId}-user`, kind: 'user', text: 'Verify the redesigned phone experience.' },
            { key: `${sessionId}-assistant`, kind: 'assistant', text: 'Chat is ready in the isolated mobile fixture.' },
          ],
          header: { blocked: false, working: false },
        }), 20);
        return { ok: true };
      },
      close() {}, closeAll() {},
    },
    sessionSend: {
      emitter: new EventEmitter(), async send() { return { ok: true }; },
      getQueueState: () => ({ count: 0, items: [] }), cancelQueued: () => ({ ok: true }),
      async getMenu() { return null; }, async answerMenu() { return { ok: true }; },
    },
    terminalBridge: {
      emitter: new EventEmitter(), async start() {}, close() {}, async sendInput() { return { ok: true }; },
    },
    logger: console,
  });
  console.log('fixture: listening on loopback');
  const address = await composed.listen({ host: '127.0.0.1', port: 0 });
  return {
    root,
    composed,
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      await composed.close();
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

async function main() {
  console.log('drive: starting');
  await fs.mkdir(EVIDENCE, { recursive: true });
  const fx = await makeFixture();
  let browser;
  try {
    console.log('drive: launching headless Chromium');
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: VIEWPORT, screen: VIEWPORT });
    const page = await context.newPage();
    const link = `${fx.baseUrl}/#token=${fx.composed.token}&url=${encodeURIComponent(fx.baseUrl)}`;
    console.log(`drive: opening ${fx.baseUrl}`);
    await page.goto(link, { waitUntil: 'domcontentloaded' });
    await page.locator('.app-shell[data-connection="online"]').waitFor({ timeout: 20000 });

    const sessionRow = page.getByText('Mobile redesign verification', { exact: true });
    if (await sessionRow.count()) await sessionRow.first().click();
    await page.getByText('Chat is ready in the isolated mobile fixture.').waitFor({ timeout: 15000 });
    const closeSessions = page.getByRole('button', { name: 'Close sessions' });
    if (await closeSessions.count()) await closeSessions.click();
    await page.screenshot({ path: path.join(EVIDENCE, '01-chat.png') });
    console.log('shot: 01-chat.png');

    await page.getByRole('button', { name: 'Tasks', exact: true }).click();
    await page.locator('.tasks-mobile').waitFor({ timeout: 15000 });
    console.log(`tasks screen: ${await page.locator('.tasks-mobile').innerText()}`);
    await page.screenshot({ path: path.join(EVIDENCE, '02-tasks.png') });
    await page.getByText('Review mobile launch checklist', { exact: true }).waitFor({ timeout: 15000 });
    await page.getByText('Polish release notes', { exact: true }).waitFor({ timeout: 15000 });
    await page.screenshot({ path: path.join(EVIDENCE, '02-tasks.png') });
    console.log('shot: 02-tasks.png');

    await page.getByRole('button', { name: 'Notes', exact: true }).click();
    await page.getByText('Launch thoughts', { exact: true }).waitFor({ timeout: 15000 });
    await page.getByText('Follow-up ideas', { exact: true }).waitFor({ timeout: 15000 });
    await page.screenshot({ path: path.join(EVIDENCE, '03-notes.png') });
    console.log('shot: 03-notes.png');

    await page.getByText('Launch thoughts', { exact: true }).click();
    await page.locator('.ne-screen').waitFor({ timeout: 15000 });
    await page.locator('.ne-body').waitFor({ timeout: 5000 });
    await page.waitForTimeout(450);
    await page.screenshot({ path: path.join(EVIDENCE, '04-note-editor.png') });
    console.log('shot: 04-note-editor.png');

    console.log(`viewport: ${VIEWPORT.width}x${VIEWPORT.height}`);
    console.log(`evidence: ${EVIDENCE}`);
  } finally {
    await browser?.close().catch(() => {});
    await fx.close();
  }
}

// Watchdog: a hung Playwright wait or an un-closed browser/server must never
// keep this process (and any codex parent tree) alive forever. Force-exit past a
// hard deadline; unref so it never itself keeps the loop open.
const WATCHDOG_MS = Number(process.env.DRIVE_WATCHDOG_MS || 120000);
setTimeout(() => {
  console.error(`drive-mobile-redesign: watchdog fired after ${WATCHDOG_MS}ms; forcing exit`);
  process.exit(1);
}, WATCHDOG_MS).unref();

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
