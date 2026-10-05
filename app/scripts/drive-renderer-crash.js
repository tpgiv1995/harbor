#!/usr/bin/env node
'use strict';

// Prove the renderer-death recovery on a REAL Harbor.
//
// The policy in main/renderer-recovery.js has unit tests, but the 2026-08-10
// bug was never in a policy: it was that nothing was wired to notice, so only
// driving a real app proves anything.
//
// The crash is triggered from INSIDE the instance under test
// (`webContents.forcefullyCrashRenderer()`), never by matching process names.
// A first version of this script found renderers with a `ps | grep` on the app
// path and SIGKILLed them, which on this machine is indistinguishable from
// Pat's own running Harbor: the same binary, the same path. Never reach for a
// pid you did not create.
//
// Run under: env -u DISPLAY -u WAYLAND_DISPLAY xvfb-run -a node scripts/drive-renderer-crash.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launchHarbor, closeHarbor } = require('../test/e2e/helpers/electron.js');

// Every store this app would otherwise share with the real installation. The
// isolation guards in main/isolation.js name each one when they refuse, which
// is how this list was built: by being told, not by guessing.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-crash-drive-'));
const ISOLATED = {
  HARBOR_SESSIOND_DIR: path.join(scratch, 'sessiond'),
  HARBOR_CONTEXT_DIR: path.join(scratch, 'context'),
  HARBOR_NO_DAEMON_START: '1',
  HARBOR_NO_TITLER: '1',
  HARBOR_NO_USAGE_FETCH: '1',
  HARBOR_NO_MODEL_DISCOVERY: '1',
};
for (const dir of [ISOLATED.HARBOR_SESSIOND_DIR, ISOLATED.HARBOR_CONTEXT_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const { electronApp, page } = await launchHarbor(ISOLATED);
  const logs = [];
  electronApp.process().stderr?.on('data', (d) => logs.push(String(d)));
  electronApp.process().stdout?.on('data', (d) => logs.push(String(d)));

  check('the app booted with a live window', await page.isVisible('.rail'));

  // Crash it the way Chromium does, from inside this instance only.
  await electronApp.evaluate(({ BrowserWindow }) => {
    const [w] = BrowserWindow.getAllWindows();
    w.webContents.forcefullyCrashRenderer();
  });

  // The window must come BACK, on its own, with a renderer that renders.
  // Asked of the MAIN process: the Playwright page handle is detached by the
  // crash, so a failure there says nothing about the app.
  let recovered = null;
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    await sleep(500);
    recovered = await electronApp.evaluate(async ({ BrowserWindow }) => {
      const [w] = BrowserWindow.getAllWindows();
      if (!w || w.isDestroyed()) return { ok: false, why: 'no window' };
      const wc = w.webContents;
      if (wc.isCrashed() || wc.isDestroyed()) return { ok: false, why: 'renderer still down' };
      try {
        const hasRail = await wc.executeJavaScript("document.querySelector('.rail') !== null");
        return { ok: Boolean(hasRail), why: hasRail ? 'rail is drawn' : 'frame up, rail not drawn yet' };
      } catch (e) { return { ok: false, why: `frame not answering: ${e.message}` }; }
    }).catch((e) => ({ ok: false, why: `main not answering: ${e.message}` }));
    if (recovered?.ok) break;
  }
  check('the window came back on its own, and RE-RENDERED', Boolean(recovered?.ok), recovered?.why || '');

  await sleep(2000);
  const text = logs.join('');
  check('it announced the recovery', /renderer went away .*reloading the window/.test(text),
    (text.split('\n').find((l) => /renderer went away/.test(l)) || '(no line)').trim());
  const disposed = (text.match(/Render frame was disposed/g) || []).length;
  check('no "Render frame was disposed" storm', disposed === 0,
    `${disposed} occurrences (the incident logged 704 in 11 minutes)`);
  check('the app is still running, not a windowless process',
    electronApp.process().exitCode === null, `exitCode=${electronApp.process().exitCode}`);

  await closeHarbor(electronApp, page).catch(() => {});
  fs.rmSync(scratch, { recursive: true, force: true });
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
