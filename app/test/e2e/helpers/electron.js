'use strict';

const path = require('node:path');
const { _electron: electron } = require('@playwright/test');
const { APP_ROOT } = require('./paths.js');

// The artifacts index is the cache the gate must not share. This helper spread
// process.env and nothing more, so every gate run rebuilt and rewrote the SAME
// ~/.cache/harbor artifacts index that harbor-server is writing for Pat's
// phone: a 77-second cold corpus scan on both sides of one file, which is why
// every gate run took the phone offline.
//
// HARBOR_CONTEXT_DIR is deliberately NOT isolated here. The statusline tee is
// read-only from Harbor's side, so it is not the collision, and spec 7's whole
// meaning is that the signal guard refuses WHILE READING THE REAL STORE: point
// it at a scratch dir and the spec stops testing what it says it tests (it
// failed with "cannot identify the owning process", which is the guard never
// being reached). A spec that wants an isolated tee passes its own.
const os = require('node:os');
const fs = require('node:fs');

function scratchCaches() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-e2e-caches-'));
  return {
    HARBOR_ARTIFACTS_CACHE: path.join(root, 'artifacts-index.json'),
    HARBOR_ARTIFACT_THUMBS_DIR: path.join(root, 'thumbs'),
  };
}

async function launchHarbor(extraEnv = {}) {
  const env = {
    ...process.env,
    ...scratchCaches(),
    HARBOR_E2E: '1',
    HARBOR_E2E_FAKE_LAUNCH: '1',
    // Harness sends pair real session ids with scratch bash panes, so the
    // transcript can never confirm them; the live drive (real Claude) keeps
    // delivery confirmation on.
    HARBOR_SKIP_DELIVERY_CONFIRM: '1',
    ELECTRON_DISABLE_GPU: '1',
    ...extraEnv,
  };

  const executablePath = require('electron');
  const attempt = async () => {
    const electronApp = await electron.launch({
      executablePath,
      args: [APP_ROOT],
      env,
      cwd: APP_ROOT,
      timeout: 120000,
    });
    try {
      const page = await electronApp.firstWindow({ timeout: 120000 });
      await page.waitForSelector('.rail', { timeout: 30000 });
      await page.waitForFunction(() => {
        const stats = window.__harborSidebarStats;
        return stats && stats.indexerSessionCount > 0;
      }, null, { timeout: 30000 });
      return { electronApp, page };
    } catch (error) {
      await electronApp.close({ force: true }).catch(() => {});
      throw error;
    }
  };

  try {
    return await attempt();
  } catch (error) {
    // Electron under Xvfb has a rare instant-quit at startup ("Target page,
    // context or browser has been closed" before the first window). One retry
    // absorbs it; a real boot regression still fails both attempts.
    console.log(`[launch-retry] first attempt failed: ${error.message}`);
    return attempt();
  }
}

// Teardown must never hang the harness: the quit IPC and electronApp.close
// can both wedge (live-caught 2026-07-20: every verify-all run on one tree
// hung here for hours). Race each step against a deadline, then guarantee
// death with a direct SIGKILL on the Electron process.
async function closeHarbor(electronApp, page) {
  const bounded = (promise, ms) => Promise.race([
    Promise.resolve(promise).catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, ms)),
  ]);
  await bounded(page.evaluate(async () => {
    if (window.harbor?.e2e?.quit) {
      await window.harbor.e2e.quit();
    }
  }), 4000);
  await bounded(electronApp.close({ force: true }), 8000);
  try { electronApp.process()?.kill('SIGKILL'); } catch { /* already gone */ }
}

async function readSubtitle(page) {
  return page.locator('.sidebar-subtitle').innerText();
}

async function readSidebarStats(page) {
  return page.evaluate(() => ({
    indexerSessionCount: window.__harborSidebarStats?.indexerSessionCount ?? null,
    sessionRows: document.querySelectorAll('.sr').length,
  }));
}

async function readMetrics(page) {
  return page.evaluate(() => window.harbor.e2e.getMetrics());
}

async function screenshot(page, name) {
  const target = path.join(APP_ROOT, 'verify', 'e2e', name);
  await page.screenshot({ path: target, fullPage: true });
  return target;
}

module.exports = {
  launchHarbor,
  closeHarbor,
  readSubtitle,
  readSidebarStats,
  readMetrics,
  screenshot,
};
