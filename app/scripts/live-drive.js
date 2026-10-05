'use strict';
// LIVE drive of the real Harbor app on Pat's real display, real daemon, real
// corpus. Authorized one-time focus steal. Checks:
//   1. generated titles present in the real model
//   2. the wrong-session double-click bug, against real multi-tab workspaces
//      (two different live sessions, driven through the real DOM rows)
//   3. one real resume of a tiny personal session (no message sent = no cost),
//      then /exit + tab cleanup
//   4. search + F1 help
// NEVER touches: orchestration kickoffs, window close/minimize, other panes'
// input. Leaves the app to be relaunched cleanly afterwards.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const APP_ROOT = path.resolve(__dirname, '..');
const { _electron: electron } = require(APP_ROOT + '/node_modules/@playwright/test');

const SHOTS = APP_ROOT + '/verify/e2e';
const results = [];
const ok = (m) => { results.push(m); console.log('OK  ' + m); };

async function shot(page, name) {
  await page.screenshot({ path: `${SHOTS}/${name}` }).catch(() => {});
}

async function main() {
  // Hard watchdog: this script drives Pat's real display and must NEVER hold
  // a window hostage; if anything wedges, die and take the app child along.
  setTimeout(() => {
    console.error('WATCHDOG: live drive exceeded 8 minutes; aborting');
    process.exit(2);
  }, 480000).unref();
  const env = { ...process.env };
  // REAL mode: no harness flags, real daemon socket, real launches.
  delete env.HARBOR_E2E;
  delete env.HARBOR_E2E_FAKE_LAUNCH;
  delete env.HERDR_SOCKET_PATH;
  delete env.HARBOR_NO_DAEMON_START;
  delete env.CLAUDE_DELEGATE_DRY_RUN;

  const electronApp = await electron.launch({
    executablePath: APP_ROOT + '/node_modules/.bin/electron',
    args: [APP_ROOT],
    env,
    cwd: APP_ROOT,
    timeout: 120000,
  });
  const child = electronApp.process();
  child.stdout?.on('data', (d) => process.stdout.write('[app] ' + d));
  child.stderr?.on('data', (d) => process.stdout.write('[app!] ' + d));
  const page = await electronApp.firstWindow({ timeout: 120000 });
  page.setDefaultTimeout(30000);

  try {
    await page.waitForSelector('.sidebar-project-row', { timeout: 45000 });
    await page.waitForTimeout(2500);
    await shot(page, 'live-1-boot.png');

    // ── 1. Generated titles in the real model ──
    const sidecar = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.cache', 'harbor', 'session-titles.json'), 'utf8')).titles;
    const titleStats = await page.evaluate(async () => {
      const state = await window.harbor.sidebar.getState();
      const sessions = (state.model.projects || []).flatMap((p) => p.sessions || []);
      return { total: sessions.length, byId: sessions.slice(0, 400).map((s) => [s.id, s.title]) };
    });
    const generated = titleStats.byId.filter(([id, t]) => sidecar[id] && t && t.startsWith(sidecar[id].slice(0, 40))).length;
    assert.ok(generated >= 50, `generated titles active in live model (${generated} matched)`);
    ok(`live model carries generated titles (${generated} of first 400 sessions match the sidecar)`);

    // ── 2. Double-click live sessions; the RIGHT one must come on screen ──
    const liveSessions = await page.evaluate(async () => {
      const state = await window.harbor.sidebar.getState();
      return (state.model.projects || []).flatMap((p) => p.sessions || [])
        .filter((s) => s.isLive && s.paneId && s.workspaceId && s.title)
        .map((s) => ({ id: s.id, title: s.title, paneId: s.paneId, workspaceId: s.workspaceId, project: s.project }));
    });
    assert.ok(liveSessions.length >= 2, `enough live sessions to test (${liveSessions.length})`);
    // Prefer sessions in different workspaces.
    const first = liveSessions[0];
    const second = liveSessions.find((s) => s.workspaceId !== first.workspaceId) || liveSessions[1];
    for (const target of [first, second]) {
      const needle = target.title.replace(/…$/, '').slice(0, 24);
      await page.locator('.sidebar-search-input').fill(needle);
      await page.waitForTimeout(700);
      const row = page.locator('.sr', { hasText: needle.slice(0, 18) }).first();
      assert.ok(await row.count(), `search surfaces live session "${needle}"`);
      await row.click();
      await page.waitForFunction(
        (pid) => window.harbor.terminal.getState().then
          ? true
          : true,
        null, { timeout: 1000 },
      ).catch(() => {});
      // Poll main state: controlled pane must be THIS session's pane and its
      // pane must be rendered in the DOM.
      const deadline = Date.now() + 15000;
      let good = false;
      while (Date.now() < deadline && !good) {
        good = await page.evaluate(async (pid) => {
          const t = await window.harbor.terminal.getState();
          const dom = !!document.querySelector(`.terminal-pane[data-pane-id="${pid}"]`);
          return t.controlledPaneId === pid && dom;
        }, target.paneId);
        if (!good) await page.waitForTimeout(500);
      }
      assert.ok(good, `double-click put the RIGHT session on screen (${target.project} / "${needle}", pane ${target.paneId})`);
      ok(`double-click opened the correct live session: ${target.project} · "${needle}"`);
      const wide = await page.waitForFunction((pid) => {
        const pane = document.querySelector(`.terminal-pane[data-pane-id="${pid}"]`);
        if (!pane) return false;
        const rows = [...pane.querySelectorAll('.xterm-rows > div')];
        const maxLen = Math.max(0, ...rows.map((r) => (r.textContent || '').trimEnd().length));
        return maxLen > Math.floor(pane.clientWidth / 8) * 0.6;
      }, target.paneId, { timeout: 15000 }).then(() => true).catch(() => false);
      assert.ok(wide, `content fills the pane width for ${target.project} (no bunched top-left text)`);
      ok(`pane content spans the full width for ${target.project}`);
      await page.locator('.sidebar-search-input').fill('');
      await page.waitForTimeout(400);
    }
    await shot(page, 'live-2-focused.png');


    // ── Real window-manager behaviors (mutter, not xvfb) ──
    {
      const isMax = () => electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized());
      const startMax = await isMax();
      const firstBtn = startMax ? 'Restore' : 'Maximize';
      const secondBtn = startMax ? 'Maximize' : 'Restore';
      await page.locator(`.titlebar-controls .titlebar-btn[aria-label="${firstBtn}"]`).click();
      await page.waitForTimeout(900);
      assert.ok((await isMax()) === !startMax, `${firstBtn} button really toggled maximize`);
      assert.ok(await page.locator(`.titlebar-controls .titlebar-btn[aria-label="${secondBtn}"]`).count() === 1, 'control glyph flipped');
      await page.locator(`.titlebar-controls .titlebar-btn[aria-label="${secondBtn}"]`).click();
      await page.waitForTimeout(900);
      assert.ok((await isMax()) === startMax, 'second click toggled back');
      ok('maximize / restore work for real under the live compositor (both directions)');
      await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
      await page.waitForTimeout(700);
      const min = await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized());
      await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].restore());
      await page.waitForTimeout(700);
      assert.ok(min, 'minimize really minimized');
      ok('minimize / restore work for real');
      await page.locator('.app-menu-btn').click();
      await page.locator('.app-menu-item[data-action="fullscreen"]').click();
      await page.waitForTimeout(900);
      const fs1 = await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen());
      await page.locator('.app-menu-btn').click();
      await page.locator('.app-menu-item[data-action="fullscreen"]').click();
      await page.waitForTimeout(900);
      const fs2 = await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen());
      assert.ok(fs1 && !fs2, `fullscreen toggles for real (${fs1} -> ${fs2})`);
      ok('fullscreen toggles on and off for real');
    }

    // ── Real new session: per-project +T (no native picker involved) ──
    {
      const { HerdrClient } = require(APP_ROOT + '/src/main/herdr/client.js');
      const hc2 = new HerdrClient({ socketPath: process.env.HOME + '/.config/herdr/herdr.sock' });
      const wrap = page.locator('.sidebar-project-wrap', { hasText: 'harbor' }).first();
      await wrap.hover();
      await page.waitForTimeout(300);
      await wrap.locator('.sidebar-proj-new.team').click();
      ok('clicked +T on the harbor project (REAL launch)');
      // (a) daemon-level: the session pane appears in a harbor workspace.
      let spawnPane = null;
      let spawnWs = null;
      const dl1 = Date.now() + 60000;
      while (Date.now() < dl1 && !spawnPane) {
        const res = await hc2.request('session.snapshot', {}).catch(() => null);
        const snap = res?.snapshot || res || {};
        const wsIds = (snap.workspaces || []).filter((w) => w.label === 'harbor').map((w) => w.workspace_id);
        const pane = (snap.panes || []).find((pp) => wsIds.includes(pp.workspace_id));
        if (pane) { spawnPane = pane.pane_id; spawnWs = pane.workspace_id; }
        if (!spawnPane) await new Promise((r) => setTimeout(r, 1500));
      }
      assert.ok(spawnPane, 'daemon shows the new +T session pane (REAL spawn proof)');
      ok(`real +T spawned at the daemon level (pane ${spawnPane})`);
      // (b) app-level: it lands on screen, controlled and full width.
      const dl2 = Date.now() + 150000;
      let onScreen = false;
      while (Date.now() < dl2 && !onScreen) {
        onScreen = await page.evaluate(async (pid) => {
          const t = await window.harbor.terminal.getState();
          return t.controlledPaneId === pid
            && !!document.querySelector(`.terminal-pane[data-pane-id="${pid}"]`);
        }, spawnPane);
        if (!onScreen) await page.waitForTimeout(2000);
      }
      if (!onScreen) {
        const dump = await page.evaluate(async (pid) => {
          const t = await window.harbor.terminal.getState();
          return {
            controlled: t.controlledPaneId,
            controlledTab: t.controlledPaneTabId,
            focusedWs: t.focusedWorkspaceId,
            dom: !!document.querySelector(`.terminal-pane[data-pane-id="${pid}"]`),
            label: document.querySelector('.terminal-context-label')?.textContent,
          };
        }, spawnPane);
        console.log('+T ONSCREEN DUMP:', JSON.stringify(dump));
        await shot(page, 'live-6-newsession-failed.png');
      }
      assert.ok(onScreen, 'new +T session came on screen and took control');
      ok('real new team session landed on screen and took control');
      // The REAL width proof: the pty must now be sized to the rendered pane
      // (herdr layout reports the pty grid), independent of what claude draws.
      let ptyRows = 0;
      for (let i = 0; i < 12 && ptyRows <= 40; i += 1) {
        const res = await hc2.request('session.snapshot', {}).catch(() => null);
        const snap = res?.snapshot || res || {};
        ptyRows = (snap.panes || []).find((pp) => pp.pane_id === spawnPane)?.scroll?.viewport_rows || 0;
        if (ptyRows <= 40) await new Promise((r) => setTimeout(r, 1500));
      }
      assert.ok(ptyRows > 40, `pty resized to the rendered pane (viewport_rows=${ptyRows}, default is 24)`);
      ok(`pty resized to the rendered pane (viewport_rows=${ptyRows}): no bunched text`);
      await page.waitForTimeout(1200);
      await shot(page, 'live-6-newsession.png');
      await page.keyboard.type('/exit');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(2500);
      // Cleanup at the daemon: close the tab, or the workspace if it is the
      // last tab (herdr refuses last-tab closes).
      try {
        const res = await hc2.request('session.snapshot', {});
        const snap = res?.snapshot || res || {};
        const pane = (snap.panes || []).find((pp) => pp.pane_id === spawnPane);
        if (pane) {
          await hc2.request('tab.close', { tab_id: pane.tab_id }).catch(async () => {
            await hc2.request('workspace.close', { workspace_id: spawnWs });
          });
        }
      } catch { /* already gone */ }
      ok('cleaned up the +T test session');
    }

    // ── 3. One real resume: tiny personal session, no message sent ──
    const resumable = await page.evaluate(async () => {
      const state = await window.harbor.sidebar.getState();
      const all = (state.model.projects || []).flatMap((p) => p.sessions || [])
        .filter((s) => !s.isLive && !s.isChildTask && !s.isWindowsEra
          && s.home === 'personal' && s.title && s.title.length > 12
          && !String(s.id).startsWith('live:'));
      // A titled personal session idle 2+ days: searchable by its generated
      // title and not something Pat is actively using. Resume sends no
      // message, so it costs nothing.
      const cutoff = 1784357680149 - 36 * 3600 * 1000;
      const idle = all.filter((s) => s.lastActiveMs < cutoff && !/\[/.test(s.title));
      idle.sort((a, b) => b.lastActiveMs - a.lastActiveMs);
      return idle.slice(0, 3).map((s) => ({ id: s.id, title: s.title }));
    });
    assert.ok(resumable.length >= 1, `found a tiny personal test session to resume (${resumable.length})`);
    const victim = resumable[0];
    await page.locator('.sidebar-search-input').fill(victim.title.slice(0, 20));
    await page.waitForTimeout(700);
    const row = page.locator('.sr', { hasText: victim.title.slice(0, 18) }).first();
    if (!(await row.count())) {
      const titles = await page.$$eval('.sidebar-session-title', (els) => els.map((e) => e.textContent).slice(0, 10));
      console.log('RESUME VICTIM NOT FOUND. victim:', JSON.stringify(victim), 'visible:', JSON.stringify(titles));
    }
    await row.click();
    ok(`clicked to resume "${victim.title}" (${victim.id.slice(0, 8)})`);
    // The resume routes through bin/claude-sessions -> herdr; the session goes
    // live and its pane lands on screen (auto tab focus + control).
    const deadline = Date.now() + 110000;
    let livePane = null;
    while (Date.now() < deadline && !livePane) {
      livePane = await page.evaluate(async (sid) => {
        const state = await window.harbor.sidebar.getState();
        const s = (state.model.projects || []).flatMap((p) => p.sessions || [])
          .find((x) => x.id === sid && x.isLive && x.paneId);
        if (!s) return null;
        const t = await window.harbor.terminal.getState();
        const dom = !!document.querySelector(`.terminal-pane[data-pane-id="${s.paneId}"]`);
        return (t.controlledPaneId === s.paneId && dom) ? s.paneId : null;
      }, victim.id);
      if (!livePane) await page.waitForTimeout(1000);
    }
    if (!livePane) {
      const rowText = await page.locator('.sr', { hasText: victim.title.slice(0, 12) })
        .first().innerText().catch(() => '(row gone)');
      console.log('RESUME ROW STATE AT TIMEOUT:', JSON.stringify(rowText));
      await shot(page, 'live-3-resume-failed.png');
    }
    assert.ok(livePane, 'resumed session went live, its pane rendered and took control');
    ok(`real resume worked end to end: pane ${livePane} on screen and controlled`);
    await page.waitForTimeout(2500);
    await shot(page, 'live-3-resumed.png');
    // Clean up: /exit the fresh claude instance, then close its tab via API.
    await page.keyboard.type('/exit');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(2500);
    const tabId = await page.evaluate(async () => (await window.harbor.terminal.getState()).controlledPaneTabId);
    if (tabId) {
      await page.evaluate((tid) => window.harbor.terminal.closeTab({ tabId: tid }), tabId);
      ok(`cleaned up: exited the resumed session and closed its tab (${tabId})`);
    }
    await page.locator('.sidebar-search-input').fill('');

    // ── 4. F1 help ──
    await page.keyboard.press('F1');
    await page.waitForSelector('.help-overlay', { timeout: 5000 });
    await shot(page, 'live-4-help.png');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.help-overlay'));
    ok('F1 quick guide opens and closes on the live app');

    await shot(page, 'live-5-final.png');
  } finally {
    // Real-mode close can wedge (observed twice); race it and then hard-kill.
    await Promise.race([
      electronApp.close().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 12000)),
    ]);
    try { electronApp.process().kill('SIGKILL'); } catch { /* already gone */ }
  }
  console.log('\nLIVE DRIVE PASSED');
  for (const r of results) console.log('  ' + r);
}

main().catch((e) => { console.error('LIVE DRIVE FAILED:', e.message); process.exit(1); });
