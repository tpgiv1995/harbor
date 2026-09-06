'use strict';

/**
 * MOBILE-PARITY-6 verification: session browser grouping, filter, collapse.
 * Run: node scripts/verify-browser.js
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { chromium } = require('@playwright/test');
const { composeServer } = require('../src/server/compose.js');

const APP_ROOT = path.join(__dirname, '..');
const REPO_ROOT = path.join(APP_ROOT, '..');
const OUT_DIR = path.join(APP_ROOT, 'verify', 'browser');
const REAL_SIDEBAR_FIXTURE = path.join(REPO_ROOT, '.harbor-mobile-fixtures', 'sidebar-get-state.json');
const VIEWPORT = { width: 430, height: 932 };

function readRealSidebarFixture() {
  if (!fs.existsSync(REAL_SIDEBAR_FIXTURE)) {
    throw new Error(`missing real sidebar fixture at ${REAL_SIDEBAR_FIXTURE}`);
  }
  const payload = JSON.parse(fs.readFileSync(REAL_SIDEBAR_FIXTURE, 'utf8'));
  if (!payload?.model?.projects?.length) {
    throw new Error('real sidebar fixture must include grouped projects');
  }
  return payload;
}

function measureBrowser(page) {
  return page.evaluate(() => {
    const browser = document.querySelector('.session-browser');
    const browserRect = browser?.getBoundingClientRect();
    const list = document.querySelector('.session-browser-list');
    const listStyle = list ? window.getComputedStyle(list) : null;
    const scrollWidth = list ? list.scrollWidth : 0;
    const clientWidth = list ? list.clientWidth : 0;
    const scrollbars = listStyle
      ? {
        scrollbarWidth: listStyle.scrollbarWidth,
        msOverflowStyle: listStyle.msOverflowStyle,
      }
      : null;
    const interactive = [...document.querySelectorAll(
      '.session-browser button, .session-browser input, .session-browser .session-row',
    )].map((el) => {
      const rect = el.getBoundingClientRect();
      return {
        tag: el.tagName.toLowerCase(),
        className: el.className.split(' ').slice(0, 3).join(' '),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    });
    const minInteractive = interactive.reduce(
      (acc, item) => ({
        width: Math.min(acc.width, item.width),
        height: Math.min(acc.height, item.height),
      }),
      { width: Infinity, height: Infinity },
    );
    const stickyHeader = document.querySelector('.session-browser-list .project-header');
    const stickyStyle = stickyHeader ? window.getComputedStyle(stickyHeader) : null;
    const answerBand = document.querySelector('.session-browser-pinned');
    const answerRect = answerBand?.getBoundingClientRect();
    const firstSticky = stickyHeader?.getBoundingClientRect();
    return {
      browser: browserRect
        ? {
          width: Math.round(browserRect.width),
          height: Math.round(browserRect.height),
        }
        : null,
      horizontalOverflow: scrollWidth > clientWidth + 1,
      scrollWidth,
      clientWidth,
      scrollbars,
      minInteractive: Number.isFinite(minInteractive.width) ? minInteractive : null,
      interactiveCount: interactive.length,
      stickyPosition: stickyStyle?.position || null,
      answerBandTop: answerRect ? Math.round(answerRect.top) : null,
      firstStickyTop: firstSticky ? Math.round(firstSticky.top) : null,
      projectHeaderCount: document.querySelectorAll('.session-browser-list .project-header').length,
      filterOpen: Boolean(document.querySelector('.browser-filter-panel')),
      collapsedCount: document.querySelectorAll('.project-header.collapsed').length,
    };
  });
}

async function openBrowser(page) {
  const browseBtn = page.locator('.hdr-session, .conv-pick');
  await browseBtn.first().click();
  await page.waitForSelector('.session-browser', { timeout: 15000 });
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const build = require('node:child_process').spawnSync('npm', ['run', 'build:web'], {
    cwd: APP_ROOT,
    encoding: 'utf8',
  });
  if (build.status !== 0) {
    throw new Error(build.stderr || build.stdout);
  }

  const payload = readRealSidebarFixture();
  const model = payload.model;
  const blocked = {
    ...(model.projects[0]?.sessions?.[0] || {}),
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    title: 'Needs answer proof session',
    agentStatus: 'blocked',
    isLive: true,
    lastActiveMs: Date.now(),
    isChildTask: false,
  };
  if (model.projects[0]) {
    model.projects[0].sessions = [blocked, ...(model.projects[0].sessions || [])];
  }

  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'harbor-browser-verify-'));
  const env = {
    ...process.env,
    HARBOR_NO_DAEMON_START: '1',
    HARBOR_NO_USAGE_FETCH: '1',
    HARBOR_TAILNET_LOGINS: 'none',
    HARBOR_CONTEXT_DIR: path.join(root, 'context'),
    HARBOR_ARTIFACTS_ROOTS: path.join(root, 'artifacts'),
    HARBOR_ARTIFACTS_CACHE: path.join(root, 'artifacts-index.json'),
    HARBOR_TASKS_FILE: path.join(root, 'tasks.json'),
  };
  await Promise.all([
    fs.promises.mkdir(env.HARBOR_CONTEXT_DIR, { recursive: true }),
    fs.promises.mkdir(env.HARBOR_ARTIFACTS_ROOTS, { recursive: true }),
  ]);

  const sidebar = {
    emitter: new EventEmitter(),
    async start() {},
    close() {},
    getState: () => ({ model }),
    getSessionMeta: async () => ({}),
  };

  const composed = await composeServer({
    userDataDir: path.join(root, 'user-data'),
    webDist: path.join(APP_ROOT, 'dist-web'),
    env,
    sidebar,
    artifacts: { async list() { return { ok: true, artifacts: [] }; }, isServable() { return false; } },
    icons: { async list() { return { icons: {} }; }, watch() {}, async filePathFor() { return null; }, mimeFor() { return null; } },
    tasks: { read: async () => ({}), mutate: async () => ({}), subscribe() {}, close() {} },
    terminalBridge: {
      emitter: new EventEmitter(), async start() {}, close() {}, sendInput: async () => ({ ok: true }),
    },
    sessionSend: {
      emitter: new EventEmitter(),
      send: async () => ({ ok: true }),
      getMenu: async () => null,
      answerMenu: async () => ({ ok: true }),
      getQueueState: () => ({ count: 0 }),
      cancelQueued: () => ({ ok: true }),
    },
  });

  const address = await composed.listen({ host: '127.0.0.1', port: 0 });
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const launchOpts = fs.existsSync('/usr/bin/google-chrome')
    ? { channel: 'chrome', timeout: 60000 }
    : { timeout: 60000 };
  const browser = await chromium.launch(launchOpts);
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();

  await page.addInitScript(({ serverUrl, token }) => {
    window.localStorage.setItem('harbor-web-server', serverUrl);
    window.localStorage.setItem('harbor-web-token', token);
    window.localStorage.removeItem('harbor-web-browser-collapse');
    window.localStorage.removeItem('harbor-web-browser-prefs');
  }, { serverUrl: baseUrl, token: composed.token });

  await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' });
  try {
    await page.waitForSelector('.app-shell[data-connection="online"]', { timeout: 30000 });
  } catch (error) {
    const debug = await page.evaluate(() => ({
      html: document.body?.innerText?.slice(0, 500),
      shell: document.querySelector('.app-shell')?.getAttribute('data-connection'),
      connect: Boolean(document.querySelector('.connect-screen')),
      splash: Boolean(document.querySelector('.splash')),
      browser: Boolean(document.querySelector('.session-browser')),
    }));
    throw new Error(`${error.message}\n${JSON.stringify(debug)}`);
  }
  await openBrowser(page);

  const shots = {};
  const metrics = {};

  shots.expanded = path.join(OUT_DIR, '01-groups-expanded.png');
  await page.screenshot({ path: shots.expanded, fullPage: false });
  metrics.expanded = await measureBrowser(page);

  await page.locator('.browser-filter-toggle').click();
  await page.waitForSelector('.browser-filter-panel');
  shots.filterOpen = path.join(OUT_DIR, '02-filter-control-open.png');
  await page.screenshot({ path: shots.filterOpen, fullPage: false });
  metrics.filterOpen = await measureBrowser(page);

  const firstProject = page.locator('.session-browser-list .project-header').first();
  const projectLabel = await firstProject.locator('.project-label').textContent();
  await firstProject.click();
  await page.waitForFunction(
    (label) => {
      const header = [...document.querySelectorAll('.project-header')].find(
        (el) => el.querySelector('.project-label')?.textContent === label,
      );
      return header?.classList.contains('collapsed');
    },
    projectLabel,
  );
  shots.collapsed = path.join(OUT_DIR, '03-group-collapsed.png');
  await page.screenshot({ path: shots.collapsed, fullPage: false });
  metrics.collapsed = await measureBrowser(page);

  await page.locator('.browser-filter-toggle').click();
  await page.waitForSelector('.browser-filter-panel', { state: 'hidden' });
  await page.evaluate(() => {
    const list = document.querySelector('.session-browser-list');
    if (list) list.scrollTop = 280;
  });
  await page.waitForTimeout(150);
  shots.sticky = path.join(OUT_DIR, '04-sticky-header-midscroll.png');
  await page.screenshot({ path: shots.sticky, fullPage: false });
  metrics.sticky = await measureBrowser(page);

  shots.answerBand = path.join(OUT_DIR, '05-needs-answer-band.png');
  await page.evaluate(() => {
    const list = document.querySelector('.session-browser-list');
    if (list) list.scrollTop = 0;
  });
  await page.screenshot({ path: shots.answerBand, fullPage: false });
  metrics.answerBand = await measureBrowser(page);

  const report = {
    viewport: VIEWPORT,
    fixture: REAL_SIDEBAR_FIXTURE,
    screenshots: shots,
    metrics,
    sortFilterOptions: [
      { mobile: 'Today', desktop: 'FilterChip Today (filter.kind === today)' },
      { mobile: '48h', desktop: 'FilterChip 48h (filter.kind === rolling, days === 2)' },
      { mobile: '7d', desktop: 'FilterChip 7d (filter.kind === rolling, days === 7)' },
      { mobile: '30d', desktop: 'FilterChip 30d (filter.kind === rolling, days === 30)' },
      { mobile: 'All', desktop: 'FilterChip All (filter.kind === all)' },
      { mobile: 'Project', desktop: 'rail-grouping-toggle Project (grouping === project)' },
      { mobile: 'Date', desktop: 'rail-grouping-toggle Date (grouping === date)' },
    ],
  };

  const reportPath = path.join(OUT_DIR, 'measured.json');
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  for (const [state, data] of Object.entries(metrics)) {
    assertMetrics(data, state);
  }

  await browser.close();
  await composed.close();
  await fs.promises.rm(root, { recursive: true, force: true });

  console.log(JSON.stringify(report, null, 2));
}

function assertMetrics(data, state) {
  if (!data.browser) throw new Error(`${state}: session browser missing`);
  if (data.browser.width !== VIEWPORT.width) {
    throw new Error(`${state}: browser width ${data.browser.width} !== ${VIEWPORT.width}`);
  }
  if (data.horizontalOverflow) {
    throw new Error(`${state}: horizontal overflow scrollWidth=${data.scrollWidth} clientWidth=${data.clientWidth}`);
  }
  if (data.scrollbars?.scrollbarWidth !== 'none') {
    throw new Error(`${state}: scrollbar-width is ${data.scrollbars?.scrollbarWidth}`);
  }
  if (!data.minInteractive || data.minInteractive.height < 44 || data.minInteractive.width < 44) {
    throw new Error(`${state}: interactive element below 44px: ${JSON.stringify(data.minInteractive)}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
