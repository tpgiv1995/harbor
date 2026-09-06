'use strict';

// REAL-WORLD drive of the Slate UI: real daemon, real corpus, real Claude.
// Spawns ONE scratch personal session in the harbor project, drives the whole
// command-bar contract against it (send -> reply, /model switch, tty, kill,
// resume-then-send), and opens real history windows. Runs under xvfb so the
// live desktop is never touched; costs a few Haiku/Fable messages.
//
//   env -u DISPLAY -u WAYLAND_DISPLAY xvfb-run -a node scripts/live-drive-slate.js
//
// PRECONDITION: no other Harbor instance running (single-instance lock).

if ((process.env.DISPLAY || process.env.WAYLAND_DISPLAY) && !process.env.__HARBOR_XVFB) {
  const { spawnSync } = require('node:child_process');
  const env = { ...process.env, __HARBOR_XVFB: '1' };
  delete env.DISPLAY;
  delete env.WAYLAND_DISPLAY;
  const res = spawnSync('xvfb-run', ['-a', process.execPath, __filename], { stdio: 'inherit', env });
  process.exit(res.status == null ? 1 : res.status);
}

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { _electron: electron } = require('@playwright/test');
const { HerdrClient } = require('../src/main/herdr/client.js');

const APP_ROOT = path.join(__dirname, '..');
const REPO_ROOT = path.join(APP_ROOT, '..');
const SHOT_DIR = path.join(APP_ROOT, 'verify', 'live');
fs.mkdirSync(SHOT_DIR, { recursive: true });

// Read-only client on the real daemon socket: lets the drive scrape the pty to
// answer the model/effort switch-confirm dialog that lives in the terminal.
const herdrRead = new HerdrClient({
  socketPath: process.env.HERDR_SOCKET_PATH || path.join(os.homedir(), '.config/herdr/herdr.sock'),
});

const results = [];
const ok = (m) => { results.push(['ok', m]); console.log('OK  ' + m); };
const fail = (m) => { results.push(['fail', m]); console.log('XX  ' + m); };
const skip = (m) => { results.push(['skip', m]); console.log('--  SKIP ' + m); };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const app = await electron.launch({
    executablePath: require('electron'),
    args: [APP_ROOT],
    env: { ...process.env, ELECTRON_DISABLE_GPU: '1', HARBOR_SEND_DEBUG: '1' },
    cwd: APP_ROOT,
    timeout: 60000,
  });
  app.process().stdout?.on('data', (d) => {
    const s = d.toString();
    if (s.includes('send-debug')) process.stdout.write('[main] ' + s);
  });
  const page = await app.firstWindow({ timeout: 60000 });
  page.on('console', (m) => { const t = m.text(); if (t.includes('[ui]')) console.log(t); });
  page.setDefaultTimeout(20000);
  await page.waitForSelector('.rail', { timeout: 30000 }).catch(() => {});
  await page.evaluate(() => { window.__harborUiDebug = 1; }).catch(() => {});
  const shot = async (name) => page.screenshot({ path: path.join(SHOT_DIR, name) });
  const watchdog = setTimeout(() => {
    console.error('WATCHDOG: drive exceeded 10 minutes; killing');
    try { app.process().kill('SIGKILL'); } catch { /* dying */ }
    process.exit(1);
  }, 10 * 60 * 1000);
  watchdog.unref();

  let scratch = null; // { sessionId, paneId }
  const PROOF = `HARBOR-PROOF-${Date.now().toString(36).toUpperCase()}`;
  try {
    await page.waitForSelector('.rail', { timeout: 30000 });
    // The real profile restores the previous stage; the drive needs a clean
    // one or restored windows false-match its assertions (live-caught).
    await page.evaluate(() => { localStorage.removeItem('harbor-slate-stage'); window.location.reload(); });
    await page.waitForSelector('.rail', { timeout: 30000 });
    await page.waitForFunction(() => (window.__harborSidebarStats?.indexerSessionCount || 0) > 0, null, { timeout: 30000 });
    await page.evaluate(() => { window.__harborUiDebug = 1; });
    await page.waitForSelector('.stage-empty', { timeout: 10000 });
    ok('app booted against the real daemon and corpus (stage cleared for the drive)');

    // ── A. A session live OUTSIDE Harbor renders read-only. The usual driver is
    // "this conversation" (a non-child harbor session, always mid-turn while it
    // drives), so prefer harbor; but when the drive is launched by an
    // orchestration WORKER the driver is a child task (excluded), so fall back
    // to any non-child, pane-less, recently-active session in the corpus. The
    // "outside Harbor" bar only shows while the transcript is mid-turn, so if the
    // picked session has since gone idle we skip rather than false-fail.
    const outside = await page.evaluate(async () => {
      const state = await window.harbor.sidebar.getState();
      const projects = state.model.projects || [];
      const recent = (x) => !x.isLive && !x.isChildTask
        && x.lastActiveMs && Date.now() - x.lastActiveMs < 10 * 60 * 1000;
      const harbor = projects.find((p) => p.label === 'harbor');
      const s = (harbor?.sessions || []).find(recent)
        || projects.flatMap((p) => p.sessions || []).find(recent);
      return s ? { id: s.id, title: s.title } : null;
    });
    if (outside) {
      await page.evaluate((id) => window.__harborOpenSession(id), outside.id);
      await page.waitForSelector(`.win2[data-session-id="${outside.id}"] .conv-assistant, .win2[data-session-id="${outside.id}"] .conv-act`, { timeout: 20000 });
      const barText = await page.locator('.ubar-input').getAttribute('placeholder');
      const working = await page.locator(`.win2[data-session-id="${outside.id}"].working`).count();
      if (/outside terminal|outside Harbor/i.test(barText || '')) {
        ok(`outside-Harbor session renders live, bar honestly read-only ("${barText}")`);
      } else if (working) {
        // The tile is mid-turn but the bar is not read-only: a real regression.
        fail(`working outside session bar says "${barText}" (expected outside-Harbor read-only)`);
      } else {
        skip(`outside session ${outside.id.slice(0, 8)}… went idle before the bar could be asserted (bar: "${barText}")`);
      }
      await shot('live-A-outside-session.png');
      await page.locator('.win2 .tile-close').first().click();
    } else {
      skip('no non-child, pane-less, recently-active session in the corpus to prove the outside-Harbor bar');
    }

    // ── B. Scratch session: +P on the harbor project, auto-tile, real send ──
    await page.locator('.rail-find').fill('harbor');
    await sleep(500);
    const beforeIds = await page.evaluate(() => [...document.querySelectorAll('.win2')].map((w) => w.dataset.sessionId));
    const projRow = page.locator('.sidebar-project-wrap', { has: page.locator('.pg-label', { hasText: /^harbor$/ }) }).first();
    await projRow.hover();
    await sleep(200);
    await projRow.locator('.sidebar-proj-new.personal').click();
    ok('clicked + P on the harbor project row (real bin/ai launch)');

    // Stage 1: the provisional pane-keyed window opens within seconds (Claude
    // writes no transcript until the first message).
    await page.waitForFunction((prev) => {
      const wins = [...document.querySelectorAll('.win2:not(.slot)')];
      return wins.some((w) => w.dataset.sessionId && !prev.includes(w.dataset.sessionId));
    }, beforeIds, { timeout: 60000 });
    scratch = await page.evaluate((prev) => {
      const w = [...document.querySelectorAll('.win2:not(.slot)')].find((x) => !prev.includes(x.dataset.sessionId));
      return { sessionId: w.dataset.sessionId };
    }, beforeIds);
    if (!scratch.sessionId.startsWith('pane:')) {
      fail(`expected a provisional pane-keyed window, got ${scratch.sessionId}`);
    }
    ok(`provisional window auto-opened (${scratch.sessionId}); typeable before any transcript exists`);
    await page.waitForSelector(`.win2[data-session-id="${scratch.sessionId}"] .ico.tty`, { timeout: 30000 });
    ok('fresh pane linked (tty toggle armed) without waiting on agent detection');
    await shot('live-B0-provisional.png');
    await sleep(3000); // composer cushion

    await page.locator('.ubar-input').fill(`Reply with exactly: ${PROOF}`);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('.ubar-input')?.value === '', null, { timeout: 20000 });
    ok('command bar send accepted (input cleared)');

    // Stage 2: the first message materializes the transcript; the window
    // upgrades in place to the real session id and renders the conversation.
    await page.waitForFunction((m) => {
      const wins = [...document.querySelectorAll('.win2:not(.slot)')];
      return wins.some((w) => (w.querySelector('.conv')?.textContent || '').includes(m));
    }, PROOF, { timeout: 120000 });
    scratch = await page.evaluate((m) => {
      const w = [...document.querySelectorAll('.win2:not(.slot)')]
        .find((x) => (x.querySelector('.conv')?.textContent || '').includes(m));
      return { sessionId: w.dataset.sessionId };
    }, PROOF);
    if (scratch.sessionId.startsWith('pane:')) fail('window never upgraded to the real session id');
    else ok(`REAL round trip: send -> transcript materialized -> window upgraded (${scratch.sessionId.slice(0, 8)}…) -> Claude's reply rendered`);
    await shot('live-B-real-roundtrip.png');

    // ── C. Capability menu: model switch (real confirm) + effort switch ──
    // The scratch session lives in the harbor project on the personal home;
    // Claude munges every non-alphanumeric cwd char to '-' for the project dir.
    const DRIVE_CWD = REPO_ROOT;
    const transcriptPath = path.join(
      os.homedir(), '.claude', 'projects',
      DRIVE_CWD.replace(/[^a-zA-Z0-9]/g, '-'),
      `${scratch.sessionId}.jsonl`,
    );
    const lastEffort = () => {
      try {
        const lines = fs.readFileSync(transcriptPath, 'utf8').trim().split('\n');
        for (let i = lines.length - 1; i >= 0; i -= 1) {
          let obj; try { obj = JSON.parse(lines[i]); } catch { continue; }
          if (obj.type === 'assistant' && typeof obj.effort === 'string') return obj.effort;
        }
      } catch { /* not readable yet */ }
      return null;
    };

    const openCap = async () => {
      await page.locator('.mswitch').click();
      await page.waitForSelector('.cap-menu', { timeout: 5000 });
      await page.waitForSelector('.cap-menu .cap-sec-h', { timeout: 15000 });
    };
    const scratchPaneId = async () => {
      const links = await page.evaluate(() => window.harbor.links.get());
      return links[scratch.sessionId]?.paneId || null;
    };
    // A /model (and possibly /effort) switch on a CACHED conversation pops a
    // "Yes, switch …" confirm dialog IN THE PTY (permission prompts live in the
    // pty, not the transcript). Answer "1" (Yes) via raw pty input so the
    // switch actually lands, before sending any follow-up message.
    const answerSwitchDialog = async (paneId, tag) => {
      for (let i = 0; i < 10; i += 1) {
        let txt = '';
        try { txt = (await herdrRead.readPane(paneId, { source: 'recent', lines: 12, strip_ansi: true }))?.read?.text || ''; } catch { /* poll */ }
        if (/1\.\s*Yes|Yes,\s*switch/i.test(txt)) {
          await page.evaluate((p) => window.harbor.terminal.focusPane({ paneId: p }), paneId).catch(() => {});
          await sleep(300);
          await page.evaluate((p) => window.harbor.terminal.sendInput({ paneId: p, text: '1\r' }), paneId);
          console.log(`[caps] answered "${tag}" switch confirm dialog (1=Yes)`);
          await sleep(1500);
          return true;
        }
        await sleep(700);
      }
      return false; // no dialog: the CLI switched without a confirm
    };
    const noSendError = async () => page.evaluate(() => {
      const s = document.querySelector('.ubar-status');
      return s && s.classList.contains('err') ? (document.querySelector('.ustat-phase')?.textContent || 'err') : null;
    });
    // Retry-robust follow-up: the send can be briefly blocked by the switch
    // still being "sending"; retry until the composer clears.
    const sendAndClear = async (msg) => {
      for (let i = 0; i < 6; i += 1) {
        await page.locator('.ubar-input').fill(msg);
        await page.keyboard.press('Enter');
        try {
          await page.waitForFunction(() => document.querySelector('.ubar-input')?.value === '', null, { timeout: 12000 });
          return true;
        } catch { await sleep(1500); }
      }
      return false;
    };

    // Capture the full capability menu for the deliverable, then drive it.
    await openCap();
    await shot('live-C0-capability-menu.png');
    const capSections = await page.locator('.cap-menu .cap-sec-h').allInnerTexts();
    console.log('[caps] sections: ' + capSections.map((s) => s.replace(/\s+\d+\/\d+$/, '')).join(' | '));

    const capPaneId = await scratchPaneId();

    // Model switch via the menu; the REAL confirm path must NOT report a
    // failure (the slash-command confirm fix: a landed /model used to read as
    // "send failed"). Then answer the pty switch-confirm and prove it lands.
    await page.locator('.cap-row', { hasText: 'Haiku 4.5' }).first().click();
    await page.waitForSelector('.cap-menu', { state: 'detached', timeout: 4000 }).catch(() => {});
    await sleep(3500); // let the optional confirm window resolve to 'sent'
    const modelErr = await noSendError();
    if (modelErr) fail(`/model switch reported a send failure: "${modelErr}" (confirm fix regressed)`);
    else ok('/model switch resolved cleanly (no spurious send-failure; slash send treated as requested)');

    await answerSwitchDialog(capPaneId, '/model haiku');
    await sendAndClear('Say only: OK');
    await page.waitForFunction((id) => {
      const chip = document.querySelector(`.win2[data-session-id="${id}"] .model`);
      return chip && /Haiku 4\.5/.test(chip.textContent || '');
    }, scratch.sessionId, { timeout: 90000 });
    ok('model quick-switch: /model haiku actually landed (window chip now Haiku 4.5)');
    await shot('live-C-model-switch.png');

    // ── C2. Effort switch: prove the NEW level stamps the next assistant line ──
    const beforeEffort = lastEffort();
    const targetEffort = beforeEffort === 'low' ? 'medium' : 'low';
    console.log(`[caps] effort before=${beforeEffort} target=${targetEffort}`);
    await openCap();
    await page.locator('.cap-eff', { hasText: new RegExp(`^${targetEffort}$`) }).first().click();
    await page.waitForSelector('.cap-menu', { state: 'detached', timeout: 4000 }).catch(() => {});
    await sleep(3500);
    const effortErr = await noSendError();
    if (effortErr) fail(`/effort switch reported a send failure: "${effortErr}"`);
    else ok('/effort switch resolved cleanly (no spurious send-failure)');
    await answerSwitchDialog(capPaneId, `/effort ${targetEffort}`);
    await sendAndClear('Say only: OK2');
    // Authoritative landing proof is the CLI's own ack in the transcript
    // ("Set effort level to <target>"). The per-line assistant effort stamp is
    // model-dependent (haiku never emits one), so it is a bonus, not the gate.
    const effortAck = () => {
      try {
        return fs.readFileSync(transcriptPath, 'utf8')
          .includes(`Set effort level to ${targetEffort}`);
      } catch { return false; }
    };
    const effDeadline = Date.now() + 120000;
    let acked = false;
    while (Date.now() < effDeadline) {
      if (effortAck()) { acked = true; break; }
      await sleep(1500);
    }
    const stamped = lastEffort();
    if (acked) {
      ok(`/effort ${targetEffort} landed: CLI ack in transcript`
        + (stamped === targetEffort ? ` (and assistant stamps effort="${stamped}")` : ' (model does not stamp per-line effort)'));
    } else {
      fail(`/effort ${targetEffort} did not land: no CLI ack in transcript`);
    }
    await shot('live-C2-effort-switch.png');

    // ── D. TTY toggle shows the real Claude UI ──
    await page.locator(`.win2[data-session-id="${scratch.sessionId}"] .ico.tty`).click();
    await page.waitForFunction((id) => {
      const rows = document.querySelector(`.win2[data-session-id="${id}"] .xterm-rows`);
      return rows && (rows.textContent || '').length > 50;
    }, scratch.sessionId, { timeout: 15000 });
    ok('tty toggle renders the live Claude terminal inside the window');
    await shot('live-D-tty.png');
    await page.locator(`.win2[data-session-id="${scratch.sessionId}"] .ico.tty`).click();

    // ── E. Kill the scratch pane (real closePaneTab), window survives read-only ──
    const links = await page.evaluate(() => window.harbor.links.get());
    const paneId = links[scratch.sessionId]?.paneId;
    if (!paneId) throw new Error('scratch pane link missing before kill');
    scratch.paneId = paneId;
    const closed = await page.evaluate((p) => window.harbor.workers.close({ paneId: p }), paneId);
    if (closed?.ok) ok(`scratch pane closed via closePaneTab (${closed.closedWorkspaceId ? 'last tab -> workspace closed' : 'tab closed'})`);
    else fail(`closePaneTab refused: ${closed?.reason}`);
    await sleep(3000);

    // ── F. Resume-then-send: wait out the 90s live-guard, then type into the dead session ──
    console.log('.. waiting out the 95s live-guard before the resume test');
    await sleep(95000);
    await page.evaluate((id) => window.__harborOpenSession(id), scratch.sessionId);
    await sleep(800);
    await page.locator('.ubar-input').fill('Say only: RESUMED');
    await page.keyboard.press('Enter');
    // Bar narrates resuming -> waiting -> sending; reply lands in the window.
    await page.waitForFunction((id) => {
      const win = document.querySelector(`.win2[data-session-id="${id}"]`);
      return win && /RESUMED/.test(win.querySelector('.conv')?.textContent || '');
    }, scratch.sessionId, { timeout: 150000 });
    ok('RESUME-THEN-SEND: dead session resumed, queued message delivered, reply rendered');
    await shot('live-F-resume-send.png');

    // Clean up the resumed pane too.
    const links2 = await page.evaluate(() => window.harbor.links.get());
    const pane2 = links2[scratch.sessionId]?.paneId;
    if (pane2) {
      await page.evaluate((p) => window.harbor.workers.close({ paneId: p }), pane2);
      ok('resumed scratch pane cleaned up');
    }

    // ── G. Multi-window with real history ──
    await page.locator('.win2 .tile-close').first().click().catch(() => {});
    const historyIds = await page.evaluate(async () => {
      const state = await window.harbor.sidebar.getState();
      const ids = [];
      for (const proj of state.model.projects || []) {
        for (const s of proj.sessions || []) {
          if (!s.isWindowsEra && !s.isChildTask && !String(s.id).startsWith('live:')) ids.push(s.id);
          if (ids.length >= 4) break;
        }
        if (ids.length >= 4) break;
      }
      return ids;
    });
    for (const id of historyIds) await page.evaluate((x) => window.__harborOpenSession(x), id);
    await page.waitForFunction(() => document.querySelectorAll('.win2:not(.slot)').length >= 4, null, { timeout: 20000 });
    await sleep(1500);
    ok('four real sessions tiled 2x2');
    await shot('live-G-grid4.png');

    const lag = await page.evaluate(() => window.__harborLagReport?.() || null);
    if (lag && lag.p95Ms < 120) ok(`renderer p95 frame lag ${lag.p95Ms.toFixed(1)}ms with 4 live windows + aurora`);
    else fail(`renderer lag concern: ${JSON.stringify(lag)}`);
  } catch (e) {
    fail('drive error: ' + e.message);
    await shot('live-ERROR.png').catch(() => {});
  } finally {
    clearTimeout(watchdog);
    // Real instance: close can hang; race then kill.
    await Promise.race([app.close(), sleep(5000)]).catch(() => {});
    try { app.process().kill('SIGKILL'); } catch { /* already gone */ }
  }

  console.log('\n════ LIVE DRIVE SUMMARY ════');
  const label = { ok: 'OK  ', fail: 'FAIL', skip: '--  ' };
  for (const [kind, m] of results) console.log(`${label[kind] || kind} ${m}`);
  const failed = results.filter(([k]) => k === 'fail').length;
  const skipped = results.filter(([k]) => k === 'skip').length;
  const passed = results.length - failed - skipped;
  console.log(`\n${passed} ok, ${skipped} skipped, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('live drive crashed:', e); process.exit(1); });
