'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { test, expect } = require('@playwright/test');
const {
  launchHarbor,
  closeHarbor,
  readSidebarStats,
  readMetrics,
  screenshot,
} = require('./helpers/electron.js');
const { indexerCounts } = require('./helpers/indexer.js');
const { startHarness, teardownHarness } = require('./helpers/terminal-harness.js');
const { sessionProcessAlive } = require('./helpers/session-liveness.js');
const { APP_ROOT } = require('./helpers/paths.js');
const { createNotifier } = require('../../src/main/notify.js');
const { createDelegateProvider } = require('../../src/main/providers/delegate.js');
const { HerdrClient } = require('../../src/main/herdr/client.js');

// The composer is a contenteditable since 2026-07-26 (WYSIWYG in, markdown out),
// so it has no form value and no disabled property. These read the same facts
// the old textarea assertions did, from where they now live.
async function composerText(page) {
  return page.evaluate(() => {
    const el = document.querySelector('.ubar-input');
    if (!el) return null;
    // Chromium parks a filler <br> in an emptied editor and innerText renders
    // it as a newline; that is bookkeeping, not something anyone typed.
    return el.innerText.replace(/\n+$/, '');
  });
}

// The markdown the send path would actually deliver. Read from the persisted
// draft rather than the DOM on purpose: what matters about a WYSIWYG composer
// is the string that reaches the agent, not the markup it happens to build to
// show it.
async function composerDraft(page) {
  return page.evaluate(() => {
    let store = {};
    try { store = JSON.parse(localStorage.getItem('harbor-drafts') || '{}'); } catch { return null; }
    let selected = null;
    try { selected = JSON.parse(localStorage.getItem('harbor-slate-stage') || '{}').selectedId; } catch { /* fall back below */ }
    if (selected && store[selected]) return store[selected].text;
    const entries = Object.values(store);
    // An emptied draft is deleted from the store, so "no entry" means "empty".
    if (!entries.length) return '';
    return entries.sort((a, b) => (b.at || 0) - (a.at || 0))[0].text;
  });
}

// Select-all + delete empties the TEXT but leaves the block you were in, so a
// cleared bulleted list still puts the next keystroke inside a bullet. That is
// ordinary editor behaviour (and a real send clears the editor outright), so
// the reset here drops out of any list the way a user would: by clicking the
// lit list button again.
async function clearComposer(page, input) {
  await input.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Delete');
  // A list outlives its text and clear-formatting does not remove one, so
  // toggle out of it the way a user would. Inline marks need no unwinding:
  // emptying the editor clears the pending typing style by itself (see
  // "clearing the composer clears its formatting" below).
  for (const selector of ['.compose-format-btn.fmt-bullets', '.compose-format-btn.fmt-numbers']) {
    const button = page.locator(selector);
    if (await button.count() && await button.evaluate((el) => el.classList.contains('on'))) {
      await button.click();
      await page.waitForTimeout(60);
    }
  }
  // A heading/quote/pre wrapper also outlives its text; clear formatting drops
  // the block back to a plain paragraph.
  await page.locator('.compose-format-btn.fmt-clear').click();
  await expect.poll(async () => composerDraft(page)).toBe('');
}

// Select a character range inside the composer's first text node, which is how
// a user drags across a word before hitting a format button.
async function selectRange(page, start, end) {
  await page.evaluate(({ from, to }) => {
    const el = document.querySelector('.ubar-input');
    const node = document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode();
    const range = document.createRange();
    range.setStart(node, from);
    range.setEnd(node, to);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }, { from: start, to: end });
}

async function composerEnabled(page) {
  return page.evaluate(() => {
    const el = document.querySelector('.ubar-input');
    return Boolean(el) && el.getAttribute('aria-disabled') !== 'true';
  });
}

// Slash tokens are painted with the CSS Custom Highlight API, which colours
// ranges without putting anything in the DOM. The painted text is therefore
// only readable through the highlight registry.
async function highlightedSlashTokens(page) {
  return page.evaluate(() => {
    const read = (name) => Array.from(window.CSS?.highlights?.get(name) || [])
      .map((range) => range.toString());
    return { ok: read('harbor-slash-ok'), bad: read('harbor-slash-bad') };
  });
}

// Read a pane the way the app does. Harbor grows a driven pane so Claude's
// dialogs fit in it (2026-07-27), and a pty resize empties herdr's `recent`
// buffer: a full-screen TUI then redraws over the screen without pushing a
// single line into scrollback, so `recent` can be 0 bytes while the dialog is
// plainly on the screen. A verification that read only `recent` would fail for
// the opposite of the reason it looks like.
async function paneScreen(client, paneId, lines = 30) {
  for (const source of ['recent', 'visible']) {
    try {
      const res = await client.readPane(paneId, { source, lines, strip_ansi: true });
      const text = res?.read?.text || '';
      if (text.trim()) return text;
    } catch { /* try the other source */ }
  }
  return '';
}

const INDEX_TOLERANCE = 8;
const SEARCH_QUERY = 'harbor';
const IMAGE_SESSION_ID = 'afa9ccb7-a5de-4803-8de7-c9b5a7436654';
const TINY_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// Pick dead, non-worker sessions among the rail rows the virtual list has
// actually rendered (a row must be in the DOM to be clicked like Pat would).
// Recency alone is not death: a session idle in an outside terminal keeps a
// live process while its transcript sits quiet past the 15-minute filter, and
// its window flips to watch-only when the process-alive probe lands. The tee
// pid check runs node-side, so the DOM pass gathers a larger pool first.
async function renderedDeadSessions(page, limit = 1) {
  // The pool must be corpus-robust: under the default recency filter, a day
  // when every recent session is live (or codex/cursor, which share the rail
  // since 2026-07-24) starves it, live-caught 2026-07-24, when this spec
  // failed on the UNCHANGED tree. Select from ALL history like a user would,
  // and expand the "older" rows so old claude candidates actually render.
  await page.locator('[data-filter="all"]').click().catch(() => {});
  await page.waitForTimeout(300);
  for (let i = 0; i < 3; i += 1) {
    const older = page.locator('.sidebar-older-button').first();
    if (!(await older.count())) break;
    await older.click().catch(() => {});
    await page.waitForTimeout(200);
  }
  const pool = await page.evaluate(async (max) => {
    const state = await window.harbor.sidebar.getState();
    const byId = new Map();
    for (const proj of state.model.projects || []) {
      for (const s of proj.sessions || []) byId.set(s.id, s);
    }
    const picked = [];
    for (const el of document.querySelectorAll('.sr')) {
      const session = byId.get(el.dataset.sessionId);
      if (!session || session.isWindowsEra || session.isChildTask || session.isLive) continue;
      if (String(session.id).startsWith('live:')) continue;
      // Codex/cursor rows are read-only when dead (no provider resume); this
      // suite drives claude flows, so keep the candidate pool claude-only.
      if (session.provider && session.provider !== 'claude') continue;
      // Skip anything active in the last 15 minutes: a session running in a
      // terminal OUTSIDE Harbor is correctly read-only (no Resume chip), and
      // this suite runs while such sessions exist in the real corpus.
      if (session.lastActiveMs && Date.now() - session.lastActiveMs < 15 * 60 * 1000) continue;
      picked.push({ id: session.id, home: session.home, title: session.title, cwd: session.cwd });
      if (picked.length >= max) break;
    }
    return picked;
  }, limit * 4);
  // TWO liveness questions, because the first one cannot see every case.
  //
  // `sessionProcessAlive` reads the statusline context tee, which is exact when
  // there IS a tee and silent when there is not: a session running in an outside
  // terminal whose tee was never written, or was written under a relocated cache
  // dir, sails straight through. The rail does not flag it live either, because
  // the rail only knows about panes. The ownership ladder then finds its process
  // on the /proc scan and correctly refuses to call the owner gone, and the spec
  // fails for the most confusing reason available, which is that the product was
  // right. Live-caught 2026-08-07 with two of the author's own sessions open in
  // this project.
  //
  // So the second question is the one the product itself asks, through the
  // production scan: is a live process holding this id right now. This repo
  // already refuses to let a suite depend on what the user did five minutes ago;
  // the same rule has to cover what they are doing right now.
  const teeDead = pool.filter((session) => !sessionProcessAlive(session.id));
  const held = new Set();
  for (const session of teeDead) {
    const answer = await page.evaluate(
      (id) => window.harbor.e2e.sessionOwnerPid({ sessionId: id }),
      session.id,
    );
    // A scan that FAILED is not a scan that said "nobody owns this": treating
    // the two alike fails open and hands the spec back the exact candidate the
    // filter exists to remove.
    if (!answer?.ok || answer.pid) held.add(session.id);
  }
  return teeDead.filter((session) => !held.has(session.id)).slice(0, limit);
}

// Open a real historical session into a stage window. Some dead sessions in the
// corpus are THIN (a launch that never completed a turn: no conversation
// content, so no model header and a non-drivable command bar); instant-launch
// flows and outside sessions leave such rows at the top of the recency-sorted
// rail. Probe candidates and open the first with real conversation content, so
// tests that need a drivable, populated window are not handed an empty one.
// `skip` lets a caller rotate past a candidate it has rejected for a reason this
// helper cannot see, without re-opening the same window forever.
async function openFirstSession(page, skip = new Set()) {
  const all = await renderedDeadSessions(page, 12);
  expect(all.length).toBeGreaterThan(0);
  const cands = all.filter((meta) => !skip.has(meta.id));
  expect(cands.length, 'the rail ran out of usable candidates').toBeGreaterThan(0);
  for (const meta of cands) {
    await page.evaluate((id) => window.__harborOpenSession(id), meta.id);
    await page.waitForSelector(`.win2[data-session-id="${meta.id}"]`, { timeout: 15000 }).catch(() => {});
    const rich = await page.locator(
      `.win2[data-session-id="${meta.id}"] .conv-assistant, .win2[data-session-id="${meta.id}"] .conv-user`,
    ).count();
    if (rich > 0) {
      // The watch-only flip lands asynchronously (the process-alive probe
      // runs on transcript read); settle, then only hand a test a bar it can
      // actually drive. A flipped candidate rotates instead of failing later.
      await page.waitForTimeout(900);
      if (await composerEnabled(page)) return meta;
    }
    await page.locator(`.win2[data-session-id="${meta.id}"] .tile-close`).click().catch(() => {});
    await page.waitForTimeout(120);
  }
  // Fall back to the first candidate rather than throwing on a degenerate corpus.
  const [first] = cands;
  await page.evaluate((id) => window.__harborOpenSession(id), first.id);
  await page.waitForSelector(`.win2[data-session-id="${first.id}"]`, { timeout: 15000 });
  return first;
}

test.describe('Harbor Slate E2E', () => {
  // Every app boot in this suite targets ONE shared isolated harness daemon.
  // The real user daemon must never see e2e traffic (it wedged under it once:
  // 2026-07-18, orphaned-listener hang after heavy connect/close churn).
  let sharedHarness = null;
  // This suite drives the app against an isolated real HERDR daemon, so it
  // names that backend instead of inheriting the default, which is sessiond
  // now. Without this every spec connects to a session daemon that knows
  // nothing about the harness and times out three minutes at a time.
  const launch = (extraEnv = {}) => launchHarbor({
    HARBOR_SESSION_BACKEND: 'herdr',
    HERDR_SOCKET_PATH: sharedHarness.socketPath,
    ...extraEnv,
  });

  test.beforeAll(async () => {
    sharedHarness = await startHarness({ stress: false });
  });

  test.afterAll(() => {
    try { sharedHarness?.child.kill('SIGTERM'); } catch { /* already gone */ }
    teardownHarness();
  });

  test('worker close failure is visible and offers exact force close', async () => {
    const { electronApp, page } = await launch();
    try {
      await page.evaluate(() => {
        window.__setSidebarModelForTest({ projects: [{ sessions: [{
          id: 'worker-test-session', paneId: 'scratch-pane', isLive: true,
          isChildTask: true, childTitle: 'Scratch worker', title: 'BATCH TITLE: Scratch worker',
        }] }] });
      });
      await page.locator('.workers-chip').click();
      const close = page.getByLabel('Close Scratch worker');
      await close.click();
      await page.waitForTimeout(350);
      await close.click();
      // The pane does not exist, so the REAL main-process close path must
      // surface an honest failure in the menu and offer the force fallback.
      // (window.harbor is contextBridge-frozen; it cannot be stubbed here.)
      const alert = page.getByRole('alert');
      await expect(alert).toContainText(/not found|failed|unavailable/i);
      const force = page.getByRole('button', { name: 'Force close' });
      await expect(force).toBeVisible();
      await force.click();
      // Only the force path enters signalPane, and only signalPane produces a
      // process-info reason; seeing it proves force:true crossed the IPC.
      await expect(alert).toContainText(/process info failed/i, { timeout: 15000 });
      await screenshot(page, 'worker-close-error.png');
    } finally {
      await closeHarbor(electronApp, page);
    }
  });

  test('typing into an outside-terminal session adopts it on Enter, with no takeover chip', async () => {
    const { electronApp, page } = await launch();
    try {
      const sessionId = 'outside-adopt-test-session';
      await page.evaluate((id) => {
        window.__setSidebarModelForTest({ projects: [{ label: 'harbor', sessions: [{
          id, title: 'Outside terminal session', home: 'plan3', cwd: '/tmp/outside-adopt',
        }] }] });
        window.__setTranscriptForTest(id, {
          blocks: [{ key: 'b1', kind: 'assistant', text: 'running in an outside terminal' }],
          header: { working: false, processAlive: true, lastWriteMs: Date.now() },
        });
        window.__harborOpenSession(id);
      }, sessionId);
      await page.waitForSelector(`.win2[data-session-id="${sessionId}"]`, { timeout: 10000 });

      // There is no Take over concept (Pat vetoed it 2026-07-20): the composer
      // stays enabled for a session living in an outside terminal, and the
      // placeholder says what Enter will do.
      await expect(page.locator('.takeover-chip')).toHaveCount(0);
      const input = page.locator('.ubar-input');
      await expect.poll(async () => composerEnabled(page)).toBe(true);
      await expect(input).toHaveAttribute('data-placeholder', /ends its outside terminal and continues here/);

      // Enter must route the send through the REAL adopt IPC. No context tee
      // exists for the fabricated session, so the main process answers with
      // the honest refusal; seeing it proves the send crossed the IPC instead
      // of being silently dropped or dead-ending in a disabled bar.
      await input.fill('hello from harbor');
      await input.press('Enter');
      await expect(page.locator('.ubar-status.err')).toContainText(
        /cannot identify the owning process/, { timeout: 15000 },
      );
      await screenshot(page, 'outside-adopt-on-send.png');
    } finally {
      await closeHarbor(electronApp, page);
    }
  });

  test('a crashed outside session (dead beacon, working tail) offers resume, not takeover', async () => {
    const { electronApp, page } = await launch();
    try {
      const sessionId = 'crashed-owner-test-session';
      await page.evaluate((id) => {
        window.__setSidebarModelForTest({ projects: [{ label: 'harbor', sessions: [{
          id, title: 'Crashed outside session', home: 'personal', cwd: '/tmp/crashed-owner',
        }] }] });
        // The OOM-kill shape (live-caught 2026-07-24): the transcript tail
        // froze in a working state, but the beacon pid is verifiably dead.
        // The composer must offer the resume path, never a takeover of a
        // process that no longer exists.
        window.__setTranscriptForTest(id, {
          blocks: [{ key: 'b1', kind: 'assistant', text: 'killed mid-turn' }],
          header: { working: true, processAlive: false, lastWriteMs: Date.now() },
        });
        window.__harborOpenSession(id);
      }, sessionId);
      await page.waitForSelector(`.win2[data-session-id="${sessionId}"]`, { timeout: 10000 });

      const input = page.locator('.ubar-input');
      await expect.poll(async () => composerEnabled(page)).toBe(true);
      await expect(input).toHaveAttribute('data-placeholder', /Enter resumes it first/);
      await screenshot(page, 'crashed-owner-resume-composer.png');
    } finally {
      await closeHarbor(electronApp, page);
    }
  });

  // Pat, 2026-07-25: "the resume functionality doesn't even work". A resume
  // that refused was swallowed whole (.catch(() => {}) plus an ignored result),
  // so a failed resume and a successful one looked identical on screen: a
  // flicker, then nothing. The button must always say what happened.
  test('a resume that cannot finish says so in the command bar instead of failing silently', async () => {
    const { electronApp, page } = await launch({ HARBOR_FRESH_PANE_TIMEOUT_MS: '100' });
    try {
      const sessionId = 'resume-visibility-test-session';
      await page.evaluate((id) => {
        window.__setSidebarModelForTest({ projects: [{ label: 'harbor', sessions: [{
          id, title: 'Dead session', home: 'team', cwd: '/tmp/resume-visibility',
        }] }] });
        // Dead: exact processAlive false, the OOM/kill shape.
        window.__setTranscriptForTest(id, {
          blocks: [{ key: 'b1', kind: 'assistant', text: 'died mid turn' }],
          header: { working: false, processAlive: false, lastWriteMs: Date.now() - 600000 },
        });
        window.__harborOpenSession(id);
      }, sessionId);
      await page.waitForSelector(`.win2[data-session-id="${sessionId}"]`, { timeout: 10000 });

      const resume = page.locator('.resume-chip');
      await expect(resume).toBeVisible();
      await resume.click();

      // The launch is e2e-faked, so claude-sessions "succeeds" and no pane ever
      // appears: the honest failure has to reach the user.
      await expect(page.locator('.ubar-status.err')).toContainText(
        /resumed, but the new pane never appeared/, { timeout: 20000 },
      );
      await screenshot(page, 'resume-failure-visible.png');
    } finally {
      await closeHarbor(electronApp, page);
    }
  });

  // Pat, 2026-07-25: "in longer messages the slash command doesnt get
  // 'recognized' with the different text". The old parser anchored on position
  // 0 of the draft, so his append-/quality-at-the-end pattern never recolored,
  // and the recolor mirror never followed a wheel scroll (its sync listener
  // could not install after mount). Recognition must now work over the whole
  // draft, and the mirror must track the textarea's scroll.
  test('a slash command after text in a long draft is recognized and painted', async () => {
    const { electronApp, page } = await launch();
    try {
      const sessionId = 'slash-long-draft-test-session';
      await page.evaluate((id) => {
        window.__setSidebarModelForTest({ projects: [{ label: 'harbor', sessions: [{
          id, title: 'Slash long draft', home: 'team', cwd: '/tmp/slash-long-draft',
        }] }] });
        window.__setTranscriptForTest(id, {
          blocks: [{ key: 'b1', kind: 'assistant', text: 'ready' }],
          header: { working: false, processAlive: false, lastWriteMs: Date.now() - 600000 },
        });
        window.__harborOpenSession(id);
      }, sessionId);
      await page.waitForSelector(`.win2[data-session-id="${sessionId}"]`, { timeout: 10000 });
      const input = page.locator('.ubar-input');
      await expect.poll(async () => composerEnabled(page)).toBe(true);

      // Capabilities feed the known-command list; /compact is a built-in that
      // exists for every session, so recognition never depends on the corpus.
      const body = 'please take the whole backlog and work item by item with care, '.repeat(4).trim();
      await input.click();
      await input.fill(body);
      await input.type(' /comp', { delay: 15 });
      // Typing mid-command at the end of the draft pops prefix suggestions.
      await expect(page.locator('.slash-ac')).toBeVisible({ timeout: 10000 });
      await expect(page.locator('.slash-ac-name').first()).toHaveText('/compact');
      await input.press('Tab');
      await expect.poll(async () => composerText(page)).toBe(`${body} /compact `);
      // The committed command is recolored and the input stack reports valid.
      // The colour lives in a CSS highlight range now, not in a mirrored DOM
      // copy of the text, so it is read from the highlight registry. The
      // VALID/UNKNOWN pill that used to be asserted here is gone (2026-07-27,
      // Pat's call), so the surviving signals are what get checked: the token
      // colour and the inset line on the input stack.
      await expect.poll(async () => (await highlightedSlashTokens(page)).ok).toEqual(['/compact']);
      await expect(page.locator('.ubar-input-stack')).toHaveClass(/slash-valid/);
      await expect(page.locator('.slash-hint')).toHaveCount(0, { timeout: 1000 });
      await screenshot(page, 'slash-trailing-recognized.png');

      // A draft holding only a path must show NO slash chrome: a path is not a
      // failed command, so nothing may recolor red or pop suggestions.
      await input.fill('look at /home/you/dev/harbor/docs/BACKLOG.md please');
      await expect(page.locator('.ubar-input-stack')).not.toHaveClass(/slash-valid|slash-invalid/);
      await expect.poll(async () => await highlightedSlashTokens(page)).toEqual({ ok: [], bad: [] });

      // An unknown LEADING token is the one case that reddens, and it must
      // still land on exactly the token's own characters.
      await input.fill('/definitelynotacommand do the thing');
      await expect.poll(async () => (await highlightedSlashTokens(page)).bad)
        .toEqual(['/definitelynotacommand']);

      // A long draft scrolls inside the field rather than growing without
      // bound. There is no mirror left to keep in register: highlight ranges
      // move with the text they are attached to, which is the whole reason the
      // mirror could be deleted.
      await input.fill(`/compact ${'explain everything that should happen next in detail. '.repeat(30)}`);
      const scroll = await page.evaluate(() => {
        const el = document.querySelector('.ubar-input');
        return { scrollable: el.scrollHeight > el.clientHeight, capped: el.clientHeight <= window.innerHeight * 0.4 };
      });
      expect(scroll.scrollable).toBe(true);
      expect(scroll.capped).toBe(true);
      await expect.poll(async () => (await highlightedSlashTokens(page)).ok).toEqual(['/compact']);
    } finally {
      await closeHarbor(electronApp, page);
    }
  });

  // Backlog item 2 (Pat, 2026-07-25): "no way to drag and drop files/images in
  // here cleanly ... I somehow lost a window". There was no drop handling at
  // all, so Chromium's default navigated the window at the dropped file, taking
  // the whole app with it. The guard matters more than the feature, so this
  // asserts BOTH: the app never navigates, and the image lands in the selected
  // session's composer as an attachment.
  test('a file dropped anywhere in Harbor attaches to the composer and never navigates the window', async () => {
    const { electronApp, page } = await launch();
    try {
      const sessionId = 'drop-target-test-session';
      await page.evaluate((id) => {
        window.__setSidebarModelForTest({ projects: [{ label: 'harbor', sessions: [{
          id, title: 'Drop target', home: 'team', cwd: '/tmp/drop-target',
        }] }] });
        window.__setTranscriptForTest(id, {
          blocks: [{ key: 'b1', kind: 'assistant', text: 'ready for files' }],
          header: { working: false, lastWriteMs: Date.now() },
        });
        window.__harborOpenSession(id);
      }, sessionId);
      await page.waitForSelector(`.win2[data-session-id="${sessionId}"]`, { timeout: 10000 });
      const startUrl = await page.url();

      // Drag over the STAGE, far from the composer: the whole window is the
      // landing zone, and the composer only has to light up as the target.
      const dragOverStage = async () => page.locator('.app-shell').first().dispatchEvent('dragover', {
        dataTransfer: await page.evaluateHandle(() => {
          const dt = new DataTransfer();
          dt.items.add(new File([new Uint8Array([1, 2, 3])], 'shot.png', { type: 'image/png' }));
          return dt;
        }),
      });
      await dragOverStage();
      await expect(page.locator('.drop-zone')).toBeVisible();
      await expect(page.locator('.drop-zone-text')).toHaveText(/Drop to attach to Drop target/);
      await screenshot(page, 'drop-zone-overlay.png');

      // A real PNG so the save path writes a real file, dropped on the rail to
      // prove the landing zone is not just the composer.
      const dataTransfer = await page.evaluateHandle((b64) => {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const dt = new DataTransfer();
        dt.items.add(new File([bytes], 'dropped.png', { type: 'image/png' }));
        return dt;
      }, TINY_PNG_B64);
      await page.locator('.rail').first().dispatchEvent('drop', { dataTransfer });

      // The image lands in the composer as a pending attachment, exactly like a
      // pasted screenshot.
      await expect(page.locator('.compose-attachments .compose-attachment, .compose-attachments img'))
        .toHaveCount(1, { timeout: 15000 });
      await expect(page.locator('.drop-toast')).toContainText(/1 image attached/);
      await screenshot(page, 'drop-attached.png');

      // The guard: still the app, still every window, no navigation.
      expect(await page.url()).toBe(startUrl);
      await expect(page.locator('.rail')).toBeVisible();
      await expect(page.locator(`.win2[data-session-id="${sessionId}"]`)).toHaveCount(1);
      // And the attachment is in THAT session's persisted draft, not a global.
      const draftPaths = await page.evaluate((id) => {
        const store = JSON.parse(localStorage.getItem('harbor-drafts') || '{}');
        return (store[id]?.paths) || [];
      }, sessionId);
      expect(draftPaths.length).toBe(1);
      expect(draftPaths[0]).toMatch(/\.png$/);

      // A dropped NON-image is delivered as its absolute path, and a File has
      // carried no `path` since Electron 32, so the whole text path depends on
      // webUtils resolving a real OS file. A synthetic File cannot prove that:
      // hand the preload a File the OS actually produced (via a real input) and
      // require the true path back.
      const realFile = path.join(require('node:os').tmpdir(), `harbor-drop-path-${process.pid}.md`);
      require('node:fs').writeFileSync(realFile, '# dropped\n');
      try {
        await page.evaluate(() => {
          const input = document.createElement('input');
          input.type = 'file';
          input.id = 'e2e-path-probe';
          document.body.appendChild(input);
        });
        await page.setInputFiles('#e2e-path-probe', realFile);
        const resolved = await page.evaluate(() => {
          const file = document.querySelector('#e2e-path-probe').files[0];
          return window.harbor.files.pathFor(file);
        });
        expect(resolved).toBe(realFile);
      } finally {
        require('node:fs').rmSync(realFile, { force: true });
        await page.evaluate(() => document.querySelector('#e2e-path-probe')?.remove());
      }
    } finally {
      await closeHarbor(electronApp, page);
    }
  });

  // The signal guard, driven exactly as the accident happened (live-caught
  // 2026-07-25): a Harbor on an ISOLATED profile that is still reading the REAL
  // statusline context store must not signal the owner pid it finds there.
  // Session 31899b4f died that way, SIGTERMed by its own config-modal drive,
  // which had stubbed session.send but not session.takeover.
  //
  // Two-sided on purpose: a refusal assertion alone could pass because the
  // drive never reached the signal at all, so the second half opts in with
  // HARBOR_ALLOW_REAL_SIGNALS=1 and requires the SAME Enter to kill the SAME
  // kind of stand-in. Both halves only ever touch a `sleep` this test spawned.
  test('an isolated Harbor refuses to signal a real owner, and the opt-in proves the kill was reachable', async () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const { spawn } = require('node:child_process');
    const sessionId = 'harbor-signal-guard-proof';
    const teePath = path.join(os.homedir(), '.cache/harbor/context', `${sessionId}.json`);

    // A stand-in owner that satisfies takeover's cmdline guard (argv[0] has to
    // read as claude) and dies on SIGTERM the way the real CLI does.
    const spawnStandin = () => {
      const child = spawn('bash', ['-c', 'exec -a claude-signal-guard-standin sleep 600'], {
        stdio: 'ignore', detached: true,
      });
      child.unref();
      return child.pid;
    };
    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const writeTee = (pid) => fs.writeFileSync(teePath, JSON.stringify({
      session_id: sessionId,
      model_id: 'claude-opus-5',
      used_percentage: 5,
      ts: new Date().toISOString(),
      pid,
    }));
    const enterOnOutsideSession = async (page) => {
      await page.evaluate((id) => {
        window.__setSidebarModelForTest({ projects: [{ label: 'harbor', sessions: [{
          id, title: 'Signal guard stand-in', home: 'personal', cwd: '/tmp/signal-guard-proof',
        }] }] });
        window.__setTranscriptForTest(id, {
          blocks: [{ key: 'b1', kind: 'assistant', text: 'owned by an outside process' }],
          header: { working: false, processAlive: true, lastWriteMs: Date.now() },
        });
        window.__harborOpenSession(id);
      }, sessionId);
      await page.waitForSelector(`.win2[data-session-id="${sessionId}"]`, { timeout: 10000 });
      const input = page.locator('.ubar-input');
      await expect.poll(async () => composerEnabled(page)).toBe(true);
      await input.fill('adopt this session');
      await input.press('Enter');
    };

    const standins = [];
    try {
      // Half 1: the drive shape that caused the incident. Nothing may die.
      const barredPid = spawnStandin();
      standins.push(barredPid);
      writeTee(barredPid);
      const barred = await launch();
      try {
        await enterOnOutsideSession(barred.page);
        await expect(barred.page.locator('.ubar-status.err')).toContainText(
          /refusing to signal a real process/, { timeout: 15000 },
        );
        await screenshot(barred.page, 'isolated-profile-refuses-signal.png');
        // Give a failing guard time to land its SIGTERM before we call it safe.
        await barred.page.waitForTimeout(3000);
        expect(alive(barredPid)).toBe(true);
      } finally {
        await closeHarbor(barred.electronApp, barred.page);
      }

      // Half 2: same click, same shape, opted in. It MUST kill, or half 1
      // proved nothing.
      const optInPid = spawnStandin();
      standins.push(optInPid);
      writeTee(optInPid);
      const optedIn = await launch({ HARBOR_ALLOW_REAL_SIGNALS: '1' });
      try {
        // Non-vacuity: the stand-in has to be alive at the moment of the click,
        // or "it died" would prove nothing about who killed it.
        expect(alive(optInPid)).toBe(true);
        await enterOnOutsideSession(optedIn.page);
        await expect.poll(() => alive(optInPid), { timeout: 20000, intervals: [250] }).toBe(false);
      } finally {
        await closeHarbor(optedIn.electronApp, optedIn.page);
      }
    } finally {
      for (const pid of standins) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
      try { fs.unlinkSync(teePath); } catch { /* never written */ }
    }
  });

  test('a session with workflow runs shows the strip, and the inspector opens with agent rows', async () => {
    // Discover a real corpus session holding a workflow completion record
    // (the suite is corpus-dependent by design); skip honestly when the
    // machine has none.
    const fs = require('node:fs');
    const os = require('node:os');
    const projectsRoot = path.join(os.homedir(), '.claude', 'projects');
    const candidates = [];
    for (const proj of fs.readdirSync(projectsRoot)) {
      const dir = path.join(projectsRoot, proj);
      let entries = [];
      try { entries = fs.readdirSync(dir); } catch { continue; }
      for (const entry of entries) {
        try {
          const wfDir = path.join(dir, entry, 'workflows');
          if (!fs.readdirSync(wfDir).some((f) => /^wf_[a-z0-9-]+\.json$/.test(f))) continue;
          if (!fs.existsSync(path.join(dir, `${entry}.jsonl`))) continue;
          candidates.push(entry);
        } catch { /* not a session dir with records */ }
      }
    }
    test.skip(!candidates.length, 'no corpus session with workflow completion records');

    const { electronApp, page } = await launch();
    try {
      // Root cause of the 2026-08-02 failure: this spec drove whichever corpus
      // session `readdirSync` happened to yield first, and that was
      // 6bd43326, whose transcript opens with `BATCH TITLE:`. That makes it an
      // orchestration CHILD task, and SessionTile deliberately omits workflow
      // UI from children, so the strip could never render. It passed for months
      // because hash order put a different candidate first; tonight's sessions
      // shifted it. So eligibility is now explicit rather than positional.
      const survey = await page.evaluate(async (ids) => {
        const state = await window.harbor.sidebar.getState();
        const byId = new Map(state.model.projects
          .flatMap((project) => project.sessions || [])
          .map((session) => [session.id, session]));
        const eligible = [];
        let target = null;
        for (const id of ids) {
          const session = byId.get(id);
          if (!session || session.isChildTask) continue;
          eligible.push(id);
          const result = await window.harbor.session.workflowRuns({ sessionId: id });
          if (!target && (result?.runs || []).some((run) => run.agents?.length)) target = id;
        }
        return { target, eligibleCount: eligible.length };
      }, candidates);
      // Skip ONLY when the corpus genuinely offers nothing this window could
      // ever show. If eligible sessions exist and NONE of them resolve agent
      // rows, that is the provider regression this spec exists to catch, so it
      // must fail loudly rather than skip itself into silence.
      test.skip(!survey.eligibleCount, 'no non-child corpus session with workflow completion records');
      expect(survey.target, `${survey.eligibleCount} eligible corpus sessions but none resolved workflow agent rows`).toBeTruthy();
      const target = survey.target;
      await page.evaluate((id) => window.__harborOpenSession(id), target);
      await page.waitForSelector(`.win2[data-session-id="${target}"]`, { timeout: 10000 });
      const strip = page.locator('.wf-strip');
      await expect(strip).toBeVisible({ timeout: 15000 });
      await strip.click();
      await expect(page.locator('.wf-inspector')).toBeVisible();
      expect(await page.locator('.wf-agent').count()).toBeGreaterThan(0);
      await screenshot(page, 'workflow-strip-inspector.png');
    } finally {
      await closeHarbor(electronApp, page);
    }
  });

  test('1) app boots: rail, stage, command bar, live pill all present', async () => {
    const counts = indexerCounts();
    const { electronApp, page } = await launch();
    try {
      const stats = await readSidebarStats(page);
      expect(stats.indexerSessionCount).toBeGreaterThan(0);
      expect(Math.abs(stats.indexerSessionCount - counts.emitAll)).toBeLessThanOrEqual(INDEX_TOLERANCE);

      await expect(page.locator('.rail')).toBeVisible();
      await expect(page.locator('.stage-empty')).toBeVisible();
      await expect(page.locator('.ubar')).toBeVisible();
      await expect(page.locator('.ubar .send')).toBeDisabled();
      await expect(page.locator('.live-pill')).toBeVisible();
      expect(await page.locator('.titlebar .ring').count()).toBe(0);

      // The app renders STYLED, not as raw HTML: batch-10 (2026-07-28)
      // dropped `import './styles.css'` from index.jsx, the bundle shipped
      // without the Slate sheet, and every DOM-presence assertion above
      // stayed green while the app was unusable. Computed style is the only
      // check a CSS-less build cannot pass.
      const styleProbe = await page.evaluate(() => ({
        bodyBg: getComputedStyle(document.body).backgroundColor,
        railWidth: getComputedStyle(document.querySelector('.rail')).width,
      }));
      expect(styleProbe.bodyBg).toBe('rgb(11, 12, 15)');
      expect(styleProbe.railWidth).not.toBe('auto');

      await screenshot(page, '01-boot-slate.png');
    } finally {
      await closeHarbor(electronApp, page);
    }
  });

  test('2) search narrows the rail; Ctrl+K focuses it; filters apply', async () => {
    const { electronApp, page } = await launch();
    try {
      await page.keyboard.press('Control+k');
      const focused = await page.evaluate(() => document.activeElement?.classList?.contains('rail-find'));
      expect(focused).toBe(true);

      await page.locator('.rail-find').fill(SEARCH_QUERY);
      await page.waitForTimeout(600);
      const searchRows = await page.locator('.sr').count();
      expect(searchRows).toBeGreaterThan(0);
      const labels = await page.$$eval('.pg-label', (els) => els.map((el) => el.textContent.trim()));
      expect(labels.some((l) => l.includes('harbor'))).toBe(true);
      await screenshot(page, '02-rail-search.png');

      await page.locator('.rail-find').fill('');
      await page.waitForTimeout(400);
      // 'All' in Project grouping keeps projects collapsed (few session rows);
      // a time filter now auto-expands the matching projects AND the rail-head
      // count shows the narrowed fraction. Assert the count narrows below the
      // indexer total, and every visible row is a real session (not a raw
      // row-count compare, which the deliberate auto-expand makes apples-to-
      // oranges between the collapsed all-view and the expanded today-view).
      const total = await page.evaluate(() => window.__harborSidebarStats?.indexerSessionCount || 0);
      await page.locator('[data-filter="today"]').click();
      await page.waitForTimeout(600);
      const countText = await page.locator('.rail-count').innerText();
      const shown = Number(countText.split('/')[0].trim());
      expect(Number.isFinite(shown)).toBe(true);
      expect(shown).toBeLessThan(total);
      await screenshot(page, '03-rail-filter-today.png');
    } finally {
      await closeHarbor(electronApp, page);
    }
  });

  test('3b) conversation renders inline images from transcript blocks', async () => {
    const { electronApp, page } = await launch();
    try {
      // Inject into a SYNTHETIC session id: a real session's transcript keeps
      // streaming and a later replace clobbers the injected fixture (an
      // image-bearing candidate makes that a real jpeg beating the tiny PNG,
      // live-caught 2026-07-24 once the candidate pool widened to All).
      const syntheticId = 'e2e-image-fixture-session';
      await page.evaluate((id) => window.__harborOpenSession(id), syntheticId);
      await page.waitForSelector(`.win2[data-session-id="${syntheticId}"]`, { timeout: 10000 });

      const dataUri = `data:image/png;base64,${TINY_PNG_B64}`;
      await page.evaluate(({ sessionId, dataUri: uri }) => {
        window.__setTranscriptForTest(sessionId, {
          blocks: [{
            key: 'b-img',
            kind: 'user',
            text: 'screenshot attached',
            images: [{ mediaType: 'image/png', dataUri: uri }],
          }],
          header: { working: false },
        });
      }, { sessionId: syntheticId, dataUri });

      const img = page.locator(`.win2[data-session-id="${syntheticId}"] .conv-img`);
      await expect(img).toBeVisible({ timeout: 5000 });
      await expect(img).toHaveAttribute('src', dataUri);
    } finally {
      await closeHarbor(electronApp, page);
    }
  });

  test('3c) real image-bearing transcript shows inline images', async () => {
    const { electronApp, page } = await launch();
    try {
      // Open by id, not by a title search + row click: the image session is a
      // large, live-growing transcript and its rail title/position is not a
      // stable handle. Its early images still render because the parser retains
      // image-bearing blocks when trimming a long transcript.
      await page.evaluate((id) => window.__harborOpenSession(id), IMAGE_SESSION_ID);
      await page.waitForSelector(`.win2[data-session-id="${IMAGE_SESSION_ID}"]`, { timeout: 10000 });
      await page.waitForFunction(
        (id) => document.querySelector(`.win2[data-session-id="${id}"] .conv-img`) != null,
        IMAGE_SESSION_ID,
        { timeout: 30000 },
      );
      const src = await page.locator(`.win2[data-session-id="${IMAGE_SESSION_ID}"] .conv-img`).first()
        .getAttribute('src');
      expect(src).toMatch(/^data:image\/(png|jpeg);base64,/);
      await screenshot(page, '04b-conversation-inline-image.png');
    } finally {
      await closeHarbor(electronApp, page);
    }
  });

  test('3) rail click opens a conversation window wired to the real transcript', async () => {
    const { electronApp, page } = await launch();
    try {
      await page.locator('.rail-find').fill(SEARCH_QUERY);
      await page.waitForTimeout(600);
      const meta = await openFirstSession(page);

      // Conversation renders real parsed blocks (this is Pat's actual corpus).
      await page.waitForFunction(
        (id) => document.querySelector(`.win2[data-session-id="${id}"]`)
          ?.querySelectorAll('.conv-user, .conv-assistant, .conv-act').length > 0,
        meta.id,
        { timeout: 15000 },
      );

      // The single open window is selected, full-stage, and targeted.
      await expect(page.locator('.win2.sel')).toHaveCount(1);
      await expect(page.locator('.grid4[data-grid-cols="1"][data-grid-rows="1"]')).toBeVisible();
      const target = await page.locator('.ubar-status .ustat-title').innerText();
      expect(target.length).toBeGreaterThan(0);
      // Dead session: the bar offers resume, input stays enabled.
      await expect.poll(async () => composerEnabled(page)).toBe(true);
      await expect(page.locator('.resume-chip')).toBeVisible();

      await screenshot(page, '04-conversation-window.png');
    } finally {
      await closeHarbor(electronApp, page);
    }
  });

  test('4) two windows: selection raises, Ctrl+1/2 switches, command bar retargets', async () => {
    const { electronApp, page } = await launch();
    try {
      await page.locator('.rail-find').fill(SEARCH_QUERY);
      await page.waitForTimeout(600);
      // Open two distinct sessions through their real rail rows (opening the
      // first clears the search, so re-search before the second).
      const picked = await renderedDeadSessions(page, 2);
      expect(picked.length).toBe(2);
      const opened = picked.map((s) => s.id);
      await page.locator(`.sr[data-session-id="${opened[0]}"]`).click();
      await page.waitForSelector(`.win2[data-session-id="${opened[0]}"]`, { timeout: 10000 });
      await page.locator('.rail-find').fill(SEARCH_QUERY);
      await page.waitForTimeout(600);
      await page.locator(`.sr[data-session-id="${opened[1]}"]`).click();
      await page.waitForSelector(`.win2[data-session-id="${opened[1]}"]`, { timeout: 10000 });

      await expect(page.locator('.grid4[data-grid-cols="2"][data-grid-rows="1"]')).toBeVisible();
      // Second opened is selected; first is recessed.
      await expect(page.locator(`.win2[data-session-id="${opened[1]}"]`)).toHaveClass(/sel/);
      await expect(page.locator(`.win2[data-session-id="${opened[0]}"]`)).toHaveClass(/rest/);

      // Keycaps label the actual binding.
      const keycaps = await page.$$eval('.win2 .kc', (els) => els.map((el) => el.textContent.trim()));
      expect(keycaps).toEqual(['^1', '^2']);

      // Ctrl+1 selects window one and retargets the bar.
      await page.keyboard.press('Control+1');
      await expect(page.locator(`.win2[data-session-id="${opened[0]}"]`)).toHaveClass(/sel/);
      const targetTitle = await page.locator('.ubar-status .ustat-title').innerText();
      const win1Title = await page.locator(`.win2[data-session-id="${opened[0]}"] .ti`).innerText();
      expect(targetTitle).toBe(win1Title);

      // Clicking the recessed window selects it. Click the IDENTITY block,
      // not the header's center: the center can be occupied by a live chip
      // (data-dependent; the orch pill sits there for sessions with
      // orchestration runs, and clicking it legitimately opens the Orch view,
      // which unmounts every stage window).
      await page.locator(`.win2[data-session-id="${opened[1]}"] .wh .who`).click();
      await expect(page.locator(`.win2[data-session-id="${opened[1]}"]`)).toHaveClass(/sel/);

      // Close both; the stage empties.
      for (const id of opened) {
        await page.locator(`.win2[data-session-id="${id}"] .tile-close`).click();
      }
      await expect(page.locator('.stage-empty')).toBeVisible();

      await screenshot(page, '05-two-windows.png');
    } finally {
      await closeHarbor(electronApp, page);
    }
  });

  // THE DEATH RATTLE IS NOT A HEARTBEAT (live-caught 2026-08-03).
  //
  // bin/claude-sessions refuses a resume whose transcript was written in the
  // last 90 seconds, reading a hot transcript as a live writer. But a claude
  // WRITES ITS TRANSCRIPT ON THE WAY OUT, so a fleet killed together (that day:
  // a herdr daemon restart at 20:14:13.665Z that took every pane with it) is
  // un-resumable for 90 seconds precisely BECAUSE it just died. Two of Pat's
  // sessions refused four times over four minutes with his typed messages
  // stranded in their composers. Harbor proves ownership from the process
  // instead (statusline tee pid, /proc, id scan) and passes --live-ok on proof.
  //
  // This spec seeds its OWN tee store (the sanctioned escape named in
  // helpers/electron.js) so the answer is decided by the fixture rather than by
  // whatever the real machine happens to hold, and drives BOTH branches through
  // the Resume chip in the running app. Two-sided ON PURPOSE: the proven branch
  // alone would pass just as well if --live-ok were emitted unconditionally,
  // which would delete the double-writer protection outright.
  const resumeArgvWithTee = async (seedTee) => {
    const contextDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-e2e-tee-'));
    const { electronApp, page } = await launch({
      HARBOR_FRESH_PANE_TIMEOUT_MS: '1500',
      HARBOR_CONTEXT_DIR: contextDir,
    });
    try {
      await page.locator('.rail-find').fill(SEARCH_QUERY);
      await page.waitForTimeout(600);
      const meta = await openFirstSession(page);
      seedTee(contextDir, meta);

      await page.locator('.resume-chip').click();
      await page.waitForTimeout(800);
      const calls = await page.evaluate(() => window.harbor.e2e.getLaunchCalls());
      const resumeCall = calls.find((call) => Array.isArray(call.argv) && call.argv[0] === '--resume-id');
      expect(resumeCall).toBeTruthy();
      expect(String(resumeCall.command)).toMatch(/claude-sessions$/);
      return { meta, argv: resumeCall.argv, page, electronApp, contextDir };
    } catch (error) {
      await closeHarbor(electronApp, page);
      fs.rmSync(contextDir, { recursive: true, force: true });
      throw error;
    }
  };

  test('5) resume path (fake exec): Resume chip fires claude-sessions with the right argv', async () => {
    // No tee at all: ownership is UNPROVEN, so the transcript-mtime guard in
    // bin/claude-sessions must be left standing exactly as it was before.
    const unproven = await resumeArgvWithTee(() => {});
    try {
      expect(unproven.argv).toEqual([
        '--resume-id',
        unproven.meta.id,
        '--home',
        // resolveResumeHome keeps personal/team/plan3 verbatim (Third is the
        // third pool), so the resume argv carries the session's own home.
        unproven.meta.home,
      ]);
      await screenshot(unproven.page, '06-resume-argv.png');
    } finally {
      await closeHarbor(unproven.electronApp, unproven.page);
      fs.rmSync(unproven.contextDir, { recursive: true, force: true });
    }
  });

  test('5b) a session whose owner is PROVABLY dead resumes at once, not in 90 seconds', async () => {
    const proven = await resumeArgvWithTee((contextDir, meta) => {
      // The fleet-death shape: the tee still names the pid that died with the
      // daemon's cgroup. A spawned-and-reaped pid is dead by construction, so
      // this is the same thing /proc told Harbor that afternoon.
      const dead = require('node:child_process').spawnSync('/bin/true');
      fs.writeFileSync(
        path.join(contextDir, `${meta.id}.json`),
        JSON.stringify({ session_id: meta.id, pid: dead.pid, used_percentage: 40 }),
      );
    });
    try {
      expect(proven.argv).toEqual([
        '--resume-id',
        proven.meta.id,
        '--home',
        proven.meta.home,
        '--live-ok',
      ]);
    } finally {
      await closeHarbor(proven.electronApp, proven.page);
      fs.rmSync(proven.contextDir, { recursive: true, force: true });
    }
  });

  test("21) a window's + starts a sibling session in that window's own project and plan, with no picker and no popover", async () => {
    const { electronApp, page } = await launch({ HARBOR_FRESH_PANE_TIMEOUT_MS: '100' });
    try {
      // Two windows, and the + is clicked on the one that is NOT selected: a
      // launch that read the SELECTION instead of the clicked window would
      // otherwise pass by coincidence, since openNewSession falls back to the
      // selected session's cwd when it is handed neither folder nor id.
      // Straight from the sidebar model rather than from rendered rail rows:
      // the assertion needs a cwd and a home per candidate, and which rows are
      // rendered depends on filters and the "older" disclosure.
      const pair = await page.evaluate(async () => {
        const state = await window.harbor.sidebar.getState();
        const out = [];
        for (const proj of state.model.projects || []) {
          for (const s of proj.sessions || []) {
            if (s.isWindowsEra || s.isChildTask || s.isLive || !s.cwd) continue;
            if (String(s.id).startsWith('live:')) continue;
            if (s.provider && s.provider !== 'claude') continue;
            if (s.lastActiveMs && Date.now() - s.lastActiveMs < 15 * 60 * 1000) continue;
            out.push({ id: s.id, cwd: s.cwd, home: s.home, project: s.project });
            break; // one per project, so the two windows are in different projects
          }
          if (out.length === 2) break;
        }
        return out;
      });
      expect(pair.length, 'need two dead claude sessions in different projects').toBe(2);
      for (const meta of pair) {
        await page.evaluate((id) => window.__harborOpenSession(id), meta.id);
        await page.waitForSelector(`.win2[data-session-id="${meta.id}"]`, { timeout: 15000 });
      }
      await page.locator(`.win2[data-session-id="${pair[0].id}"] .wh .who`).click();
      await expect(page.locator(`.win2[data-session-id="${pair[0].id}"]`)).toHaveClass(/sel/);

      const target = pair[1];
      const before = (await page.evaluate(() => window.harbor.e2e.getLaunchCalls()))
        .filter((call) => String(call.command).endsWith('/bin/ai')).length;
      await page.locator(`.win2[data-session-id="${target.id}"] .tile-new`).click();

      // No folder picker and no config popover: the whole point of the button
      // is that it is one click from a window already on screen.
      await expect(page.getByRole('dialog', { name: 'Session configuration' })).toHaveCount(0);
      await expect.poll(
        async () => (await page.evaluate(() => window.harbor.e2e.getLaunchCalls()))
          .filter((call) => String(call.command).endsWith('/bin/ai')).length,
        { timeout: 15_000 },
      ).toBe(before + 1);

      const launch2 = (await page.evaluate(() => window.harbor.e2e.getLaunchCalls()))
        .filter((call) => String(call.command).endsWith('/bin/ai')).pop();
      // The clicked window's project...
      expect(launch2.options.cwd).toBe(target.cwd);
      // ...its own plan, as the configHome bin/ai applies as CLAUDE_CONFIG_DIR.
      // new-session:options deliberately strips configHome from the profiles it
      // hands the renderer, so the mapping is spelled out here the same way the
      // P/T/S spec below does; both are pinned against bin/ in
      // test/bin/ai-launch-argv.test.js.
      const os = require('node:os');
      // Config homes are DISCOVERED per machine (config/homes.js), not a fixed
      // three-name list, so the expected path is derived the same way
      // conventionalConfigHome() derives it in bin/harbor-bin.cjs: `personal`
      // is the bare `~/.claude`, and any other id is `~/.claude-<id>`.
      const expectedConfigHome = path.join(
        os.homedir(),
        target.home === 'personal' ? '.claude' : `.claude-${target.home}`,
      );
      expect(launch2.argv.slice(0, 2)).toEqual(['--home', expectedConfigHome]);
      // ...and the SAVED defaults for everything else. Without these,
      // buildNewArgv falls back to model null / effort 'default', which is not
      // what a one-click launch is supposed to mean.
      expect(launch2.argv).toContain('--model');
      expect(launch2.argv[launch2.argv.indexOf('--model') + 1]).toBe('opus');
      expect(launch2.argv).toContain('--effort');
      expect(launch2.argv[launch2.argv.indexOf('--effort') + 1]).toBe('xhigh');

      // Every window carries one, alongside the close button it must never be
      // confused with, and the + is on the far side of the group from it.
      const order = await page.$$eval('.win2:not(.slot) .wh-ctl', (els) => els.map((el) => (
        Array.from(el.querySelectorAll('button')).map((b) => (b.className.match(/tile-new|tile-close|tile-focus|tty/) || ['?'])[0])
      )));
      for (const controls of order) {
        expect(controls[0]).toBe('tile-new');
        expect(controls[controls.length - 1]).toBe('tile-close');
      }

      await screenshot(page, 'tile-new-sibling.png');
    } finally {
      await closeHarbor(electronApp, page);
    }
  });

  test('project P/T/S launch fixed defaults immediately and provider config preserves live Claude sessions', async () => {
    const { electronApp, page } = await launch({ HARBOR_FRESH_PANE_TIMEOUT_MS: '100' });
    try {
      // The rail renders the REAL indexer model (the app-level test pin only
      // feeds the stage), so drive a real project row: the harbor repo's own
      // project always exists on this machine. The actions are display:none
      // until the row is hovered, so hover first; launches are e2e-faked.
      const wrap = page.locator('.sidebar-project-wrap', {
        has: page.locator('.pg-label', { hasText: /^harbor$/ }),
      }).first();
      const launchProjectPlan = async (title) => {
        await wrap.hover();
        await wrap.getByTitle(title).click();
      };

      // THE PLANS COME FROM THE APP, NOT FROM THIS MACHINE'S HOME DIRECTORY
      // (2026-08-06). This spec used to hardcode Personal/Team/<third> in that
      // order, which was only ever true of one developer's account list. Profiles
      // are DISCOVERED now (config/homes.js) from whatever `.claude*` homes exist,
      // sorted with the primary first and the rest alphabetical, so both the
      // LABELS and the ORDER are properties of the machine. Hardcoding either
      // asserts the author's setup and fails for everybody else, which is exactly
      // how it failed here.
      const plans = await page.evaluate(async () => {
        const options = await window.harbor.session.newOptions();
        return (options?.profiles || []).map((p) => ({ id: p.id, label: p.label }));
      });
      expect(plans.length, 'the rail must offer at least one plan to launch').toBeGreaterThan(0);

      // Titles carry the profile LABELS ('Personal', not 'personal') since
      // the profile-driven rail, and the suffix is the launch FOLDER as a
      // full absolute path (house rule) plus, when known, the account email;
      // match the stable prefix, not the whole tooltip.
      for (const [index, plan] of plans.entries()) {
        const title = new RegExp(`^New ${plan.label} session`);
        const expectedCount = index + 1;
        await launchProjectPlan(title);
        await expect(page.getByRole('dialog', { name: 'Session configuration' })).toHaveCount(0);
        await expect.poll(async () => (await page.evaluate(() => window.harbor.e2e.getLaunchCalls()))
          .filter((call) => String(call.command).endsWith('/bin/ai')).length, { timeout: 10_000 }).toBe(expectedCount);
        await page.waitForTimeout(3100);
      }
      const projectLaunches = (await page.evaluate(() => window.harbor.e2e.getLaunchCalls()))
        .filter((call) => String(call.command).endsWith('/bin/ai'));
      // The launcher emits the configHome as `--home <path>` (what the Node
      // bin/ actually parses; it applies it as CLAUDE_CONFIG_DIR), the same
      // for every id including personal: the legacy per-account flags
      // flags are gone (2026-08-07). Pinned against bin/ in
      // test/bin/ai-launch-argv.test.js; change both together.
      const os = require('node:os');
      // Every claude launch also carries a caller-minted `--session-id <uuid>`
      // so Harbor knows the session id BEFORE the session exists and never has
      // to discover which session a pane holds. The id is random per launch, so
      // the stable prefix is compared exactly and the id is checked by shape.
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      const splitMintedId = (argv) => {
        const at = argv.indexOf('--session-id');
        if (at < 0) return { prefix: argv, sessionId: null };
        return { prefix: argv.slice(0, at), sessionId: argv[at + 1] };
      };
      const split = projectLaunches.map((call) => splitMintedId(call.argv));
      // The rule, not one machine's answer: each plan button launches on ITS OWN
      // config home and carries the saved defaults, pinned in
      // test/actions/launch.test.js and test/bin/ai-launch-argv.test.js.
      const homeForId = (id) => path.join(os.homedir(), id === 'personal' ? '.claude' : `.claude-${id}`);
      expect(split.map((entry) => entry.prefix)).toEqual(plans.map((plan) => [
        '--home', homeForId(plan.id),
        '--model', 'opus', '--effort', 'xhigh',
      ]));
      for (const { sessionId } of split) expect(sessionId).toMatch(UUID_RE);
      // Distinctness is the assertion that matters: minting one id and reusing
      // it would point two sessions at a single transcript, and an exact-argv
      // check could never see that.
      expect(new Set(split.map((entry) => entry.sessionId)).size).toBe(split.length);

      await page.locator('.rail-find').fill(SEARCH_QUERY);
      await page.waitForTimeout(500);
      const meta = await openFirstSession(page);
      const paneInfo = await page.evaluate(async () => {
        const state = await window.harbor.terminal.getState();
        const layout = Object.values(state.layouts || {})[0];
        const paneId = layout?.panes?.[0]?.pane_id;
        const tab = (state.tabs || []).find((item) => item.tab_id === layout?.tab_id);
        return { paneId, workspaceId: tab?.workspace_id || null };
      });
      await page.evaluate(({ sessionId, ...pane }) => window.harbor.e2e.setLink({ sessionId, ...pane }), { sessionId: meta.id, ...paneInfo });
      await expect(page.locator('.resume-chip')).toHaveCount(0);
      await page.locator(`.win2[data-session-id="${meta.id}"] .model-chip`).click();
      await expect(page.getByRole('dialog', { name: 'Session configuration' })).toBeVisible();
      await expect(page.getByRole('group', { name: 'Account' })).toHaveCount(0);
      await screenshot(page, 'config-modal-claude.png');
      await page.locator('.new-session-providers button', { hasText: 'Codex' }).click();
      // The model control is Harbor's OWN portaled dropdown, not a native
      // <select>: this modal sits on a backdrop-filter layer, which traps a
      // native option popup so every model but the current one was unreachable.
      // Drive it the way a human does (click, then click a row).
      // The codex default is codex's OWN default rather than a named model id:
      // Harbor cannot enumerate codex models, so shipping a specific id as the
      // default is a guess about somebody else's account.
      await expect(page.locator('.new-session-popover .model-select-val')).toHaveText('Codex default');
      await expect(page.getByRole('slider', { name: 'Effort' })).toHaveAttribute('aria-valuetext', 'medium');
      await expect(page.getByRole('group', { name: 'Account' })).toHaveCount(0);
      await screenshot(page, 'config-modal-codex.png');
      await page.locator('.new-session-providers button', { hasText: 'Cursor' }).click();
      await screenshot(page, 'config-modal-cursor.png');
      await page.locator('.new-session-providers button', { hasText: 'Codex' }).click();
      await expect(page.getByRole('slider', { name: 'Effort' })).toHaveAttribute('aria-valuetext', 'medium');
      await page.getByLabel('Set as default for new sessions').check();
      await page.getByRole('button', { name: /Start Codex session/ }).click();

      await expect.poll(async () => {
        const polled = await page.evaluate(() => window.harbor.e2e.getLaunchCalls());
        return polled.filter((call) => String(call.command).endsWith('/bin/ai')).length;
      }, { timeout: 10_000 }).toBe(plans.length + 1);
      const calls = await page.evaluate(() => window.harbor.e2e.getLaunchCalls());
      const launches = calls.filter((call) => String(call.command).endsWith('/bin/ai'));
      const homeFor = (id) => path.join(require('node:os').homedir(),
        id === 'personal' ? '.claude' : `.claude-${id}`);
      const allSplit = launches.map((call) => splitMintedId(call.argv));
      expect(allSplit.map((entry) => entry.prefix)).toEqual([
        ...plans.map((plan) => [
          '--home', homeFor(plan.id),
          '--model', 'opus', '--effort', 'xhigh',
        ]),
        // The Codex launch comes from the live session's config, so it carries
        // that session's own account as --home (buildNewArgv emits it for
        // every id, personal included), not a hardcoded default.
        // '--model default' means "the provider's own default", so no model
        // flag is composed at all.
        ['--home', homeFor(meta.home),
          '--provider', 'codex', '--effort', 'medium'],
      ]);
      // The claude-only rule, driven through the real app rather than asserted
      // in a unit: all three claude launches carry a distinct minted uuid, and
      // the codex launch carries NONE, because codex has no way to accept an id
      // at launch and must keep discovering its own.
      const claudeIds = allSplit.slice(0, plans.length).map((entry) => entry.sessionId);
      for (const sessionId of claudeIds) expect(sessionId).toMatch(UUID_RE);
      expect(new Set(claudeIds).size).toBe(plans.length);
      expect(allSplit[plans.length].sessionId).toBeNull();
      expect(await page.evaluate(() => JSON.parse(localStorage.getItem('harbor-new-session-default')))).toEqual({
        // NewSessionConfig seeds the account from the session's own home
        // (index.jsx sets request.account = session.home), stored verbatim.
        account: meta.home,
        provider: 'codex', model: 'default', effort: 'medium',
        // The version stamp marks this as a DELIBERATE save, so the one-time
        // re-seed to opus + xhigh (2026-07-27) leaves it alone from here on.
        v: 2,
      });

      // Same-provider Apply on a live Claude session must switch in place, NOT
      // relaunch: opening the chip, changing model, Apply => zero new bin/ai.
      // (That the /model command reaches the pty is proven by the live send
      // test above and verified on the real app; the harness cannot cleanly
      // drive a slash command into a non-visible fabricated pane.)
      const launchesBefore = await page.evaluate(() => window.harbor.e2e.getLaunchCalls());
      const aiBefore = launchesBefore.filter((call) => String(call.command).endsWith('/bin/ai')).length;
      await page.locator(`.win2[data-session-id="${meta.id}"] .model-chip`).click();
      await page.locator('.new-session-popover .model-select').click();
      await page.locator('.model-select-list').waitFor({ timeout: 10000 });
      await page.locator('.model-select-row', { hasText: /haiku/i }).first().click();
      await expect(page.locator('.new-session-popover .model-select-val')).toHaveText(/haiku/i);
      await expect(page.getByRole('button', { name: 'Apply' })).toBeVisible();
      await page.getByRole('button', { name: 'Apply' }).click();
      await page.waitForTimeout(1500);
      const launchesAfter = await page.evaluate(() => window.harbor.e2e.getLaunchCalls());
      const aiAfter = launchesAfter.filter((call) => String(call.command).endsWith('/bin/ai')).length;
      expect(aiAfter).toBe(aiBefore);
    } finally {
      await closeHarbor(electronApp, page);
    }
  });

  // The freeze log must catch a block in EITHER process and say which: a
  // blocked MAIN process queues auto-repeat keydowns exactly like a blocked
  // renderer (input dispatch rides through it), and the old capture could not
  // see it at all. Driven with real induced blocks through the real pipeline.
  test('induced renderer and main-process blocks land in the freeze log, labeled by layer', async () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const perfDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-perf-e2e-'));
    const { electronApp, page } = await launch({ HARBOR_PERF_LOG_DIR: perfDir });
    try {
      const logFile = path.join(perfDir, 'renderer-stalls.jsonl');
      const readEntries = () => (fs.existsSync(logFile)
        ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
        : []);

      // Typing context first, so the capture proves the keystroke counters.
      await page.locator('body').click();
      await page.keyboard.type('xxxxx', { delay: 30 });
      await page.evaluate(() => {
        const end = performance.now() + 700;
        while (performance.now() < end) { /* induced renderer block */ }
      });
      await page.waitForTimeout(1500);
      const rendererEntry = readEntries().find((e) => e.kind === 'blocked-main-thread');
      expect(rendererEntry).toBeTruthy();
      expect(rendererEntry.ms).toBeGreaterThan(400);
      expect(typeof rendererEntry.context.keys5s).toBe('number');
      expect(rendererEntry.context.keys5s).toBeGreaterThanOrEqual(3);

      // Same drive against the MAIN process.
      await electronApp.evaluate(() => {
        const end = Date.now() + 700;
        while (Date.now() < end) { /* induced main-process block */ }
      });
      await page.waitForTimeout(1500);
      const mainEntry = readEntries().find((e) => e.kind === 'blocked-main-process');
      expect(mainEntry).toBeTruthy();
      expect(mainEntry.ms).toBeGreaterThan(400);
    } finally {
      await closeHarbor(electronApp, page);
      fs.rmSync(perfDir, { recursive: true, force: true });
    }
  });

  // Pat, 2026-07-25: "whenever i click on a harbor window i want it to auto
  // 'start' the text box", plus arrow-key window navigation, moved to
  // Alt+arrows the same day so the auto-focused composer keeps Ctrl+arrow
  // word-jump. Clicking a window arms the composer, and Alt+arrows move the
  // selection spatially across the grid, landing ready to type.
  test('clicking a window arms the composer, and Alt+arrows move between windows', async () => {
    const { electronApp, page } = await launch();
    try {
      await page.evaluate(() => {
        window.__setSidebarModelForTest({ projects: [{ label: 'harbor', sessions: [
          { id: 'nav-a', title: 'Window A', home: 'team', cwd: '/tmp/nav-a' },
          { id: 'nav-b', title: 'Window B', home: 'team', cwd: '/tmp/nav-b' },
        ] }] });
        for (const id of ['nav-a', 'nav-b']) {
          window.__setTranscriptForTest(id, {
            blocks: [{ key: 'b1', kind: 'assistant', text: 'ready' }],
            header: { working: false, processAlive: false, lastWriteMs: Date.now() - 600000 },
          });
          window.__harborOpenSession(id);
        }
      });
      await page.waitForSelector('.win2[data-session-id="nav-b"]', { timeout: 10000 });

      // Clicking window A's BODY (not its composer) selects it AND focuses
      // the command bar, ready to type.
      await page.locator('.win2[data-session-id="nav-a"] .conv').click();
      await expect(page.locator('.win2[data-session-id="nav-a"]')).toHaveClass(/sel/);
      await page.waitForFunction(() => document.activeElement?.classList?.contains('ubar-input'), null, { timeout: 5000 });

      // Alt+ArrowRight moves to window B (slot 1), composer still armed,
      // even though focus was IN the textarea when the key was pressed.
      await page.keyboard.press('Alt+ArrowRight');
      await expect(page.locator('.win2[data-session-id="nav-b"]')).toHaveClass(/sel/);
      await page.waitForFunction(() => document.activeElement?.classList?.contains('ubar-input'), null, { timeout: 5000 });

      // And back left to A.
      await page.keyboard.press('Alt+ArrowLeft');
      await expect(page.locator('.win2[data-session-id="nav-a"]')).toHaveClass(/sel/);

      // Ctrl+arrows stay with the text field: with a draft in the composer,
      // Ctrl+ArrowLeft must word-jump the caret, never switch windows.
      await page.locator('.ubar-input').fill('two words');
      await page.keyboard.press('Control+ArrowLeft');
      await expect(page.locator('.win2[data-session-id="nav-a"]')).toHaveClass(/sel/);
      // A contenteditable has no selectionStart; the caret lives on the
      // document selection instead.
      const caret = await page.evaluate(() => document.getSelection()?.anchorOffset ?? null);
      expect(caret).toBe(4);
    } finally {
      await closeHarbor(electronApp, page);
    }
  });

  // Backlog item 1 (Pat, 2026-07-25): "an output viewing page in here ...
  // toggle between agent view, the orchestration view, and an artifact
  // viewer". Three top-level views switch from the title bar; Artifacts shows
  // agent-produced files grouped by project, HTML rendered live in a frame
  // that can never navigate the app.
  test('the Artifacts view lists agent-produced files and renders HTML without navigating the app', async () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-artifacts-e2e-'));
    const projectsRoot = path.join(tmp, 'projects');
    const projectDir = path.join(projectsRoot, '-tmp-artifact-demo');
    fs.mkdirSync(projectDir, { recursive: true });
    const outDir = path.join(tmp, 'demo-out');
    fs.mkdirSync(outDir, { recursive: true });
    const htmlPath = path.join(outDir, 'report.html');
    fs.writeFileSync(htmlPath, '<!doctype html><html><body><h1 id="mark">HARBOR ARTIFACT RENDER OK</h1></body></html>');
    const pngPath = path.join(outDir, 'chart.png');
    fs.writeFileSync(pngPath, Buffer.from(TINY_PNG_B64, 'base64'));
    const pdfPath = path.join(outDir, 'brief.pdf');
    fs.writeFileSync(pdfPath, [
      '%PDF-1.4',
      '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
      '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
      '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj',
      'trailer<</Root 1 0 R>>',
      '%%EOF',
    ].join('\n'));
    const stamp = new Date().toISOString();
    fs.writeFileSync(path.join(projectDir, 'artifact-demo-session.jsonl'), [
      JSON.stringify({ type: 'user', timestamp: stamp, cwd: '/tmp/artifact-demo', message: { role: 'user', content: 'build the demo report' } }),
      JSON.stringify({ type: 'assistant', timestamp: stamp, message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: htmlPath, content: 'x' } }] } }),
      JSON.stringify({ type: 'assistant', timestamp: stamp, message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: `python3 plot.py -o ${pngPath} && cp report.pdf ${pdfPath}` } }] } }),
    ].join('\n'));

    const { electronApp, page } = await launch({
      HARBOR_ARTIFACTS_ROOTS: projectsRoot,
      HARBOR_ARTIFACT_THUMBS_DIR: path.join(tmp, 'thumbs'),
    });
    try {
      const startUrl = await page.url();
      // Four top-level views since Tasks landed (2026-07-30), and the old
      // "Artifacts" tab is labelled "Files".
      await expect(page.locator('.view-switch-btn')).toHaveCount(4);

      await page.locator('.view-switch-btn', { hasText: 'Files' }).click();
      await expect(page.locator('.artifacts-view')).toBeVisible();
      await expect(page.locator('.artifacts-group-label')).toHaveText('artifact-demo', { timeout: 15000 });
      await expect(page.locator('.artifact-card')).toHaveCount(3);

      // Every card previews (Pat, 2026-07-25: "a preview of everything"):
      // the image renders itself, and the HTML and PDF cards get GENERATED
      // thumbnails (offscreen capture, poppler). All must be real bytes
      // through the allowlisted scheme; naturalWidth proves each was served.
      for (const kind of ['image', 'html', 'pdf']) {
        await page.waitForFunction((k) => {
          const img = document.querySelector(`.artifact-card.kind-${k} .artifact-thumb img`);
          return img && img.complete && img.naturalWidth > 0;
        }, kind, { timeout: 30000 });
      }

      // Open the HTML artifact: it renders live in the sandboxed frame.
      await page.locator('.artifact-card.kind-html').click();
      await expect(page.locator('.artifact-viewer .artifact-frame')).toBeVisible();
      let frame = null;
      const frameDeadline = Date.now() + 10000;
      while (Date.now() < frameDeadline && !frame) {
        frame = page.frames().find((f) => f.url().startsWith('harbor-artifact:')) || null;
        if (!frame) await page.waitForTimeout(200);
      }
      expect(frame).toBeTruthy();
      await expect(frame.locator('#mark')).toHaveText('HARBOR ARTIFACT RENDER OK', { timeout: 10000 });
      await screenshot(page, 'artifacts-view-html-open.png');

      // The app shell never navigated and every surface is still alive.
      expect(await page.url()).toBe(startUrl);
      await expect(page.locator('.rail')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.locator('.artifact-viewer')).toHaveCount(0);

      // PDFs render IN Harbor (Pat, 2026-07-25: "not something i have to open
      // externally"): the viewer mounts the in-app PDF frame, and the scheme
      // serves the bytes with range support (what the PDF viewer and <video>
      // seek with), proven by fetching through the page itself.
      await page.locator('.artifact-card.kind-pdf').click();
      await expect(page.locator('.artifact-viewer .artifact-frame.pdf')).toBeVisible();
      const served = await page.evaluate(async (src) => {
        const full = await fetch(src);
        const range = await fetch(src, { headers: { Range: 'bytes=0-3' } });
        return {
          fullStatus: full.status,
          type: full.headers.get('content-type'),
          rangeStatus: range.status,
          rangeBody: await range.text(),
        };
      }, await page.locator('.artifact-frame.pdf').getAttribute('src'));
      expect(served.fullStatus).toBe(200);
      expect(served.type).toBe('application/pdf');
      expect(served.rangeStatus).toBe(206);
      expect(served.rangeBody).toBe('%PDF');
      await screenshot(page, 'artifacts-view-pdf-open.png');
      await page.keyboard.press('Escape');
      await page.locator('.view-switch-btn', { hasText: 'Orch' }).click();
      await expect(page.locator('.orch-picker')).toBeVisible();
      await screenshot(page, 'orch-picker-view.png');
      await page.locator('.view-switch-btn', { hasText: 'Agents' }).click();
      await expect(page.locator('.stagewrap')).toBeVisible();
    } finally {
      await closeHarbor(electronApp, page);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ─── Tasks view (2026-07-30) ──────────────────────────────────────────────
  // Every run points HARBOR_TASKS_FILE at a throwaway file, which is also half
  // the proof: the env override has to outrank the composed config, or an
  // isolated Harbor would be editing Pat's real task list.
  const tasksNav = (page, label) => page.locator('.tasks-nav-btn')
    .filter({ has: page.locator('.tasks-nav-label', { hasText: new RegExp(`^${label}$`) }) });
  const taskRow = (page, title) => page.locator('.task-row')
    .filter({ has: page.locator('.task-title', { hasText: new RegExp(`^${title}$`) }) });

  test('17) tasks: a typed line becomes a task, three levels of sub-task, and it survives a reload', async () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-tasks-e2e-'));
    const tasksFile = path.join(tmp, 'tasks.json');
    const { electronApp, page } = await launch({ HARBOR_TASKS_FILE: tasksFile });
    try {
      await expect(page.locator('.view-switch-btn')).toHaveCount(4);
      await page.locator('.view-switch-btn', { hasText: 'Tasks' }).click();
      await expect(page.locator('.tasks-view')).toBeVisible();
      // A first run has nothing, and says so rather than showing an empty box.
      await expect(page.locator('.tasks-empty-title')).toBeVisible();

      // The add box has focus on arrival: the whole point is writing something
      // down before it is forgotten.
      await expect(page.locator('.tasks-add-input')).toBeFocused();
      await page.locator('.tasks-add-input').fill('Renew the storage lease');
      await page.keyboard.press('Enter');
      await expect(taskRow(page, 'Renew the storage lease')).toHaveCount(1);
      // Typed into My Day, it IS in My Day: the smart view means what it says.
      // Inside My Day the row does not repeat it; the list view is where it
      // shows, as metadata beside the due date.
      await expect(taskRow(page, 'Renew the storage lease').locator('.task-sub-bit.myday')).toHaveCount(0);
      await expect(page.locator('.tasks-add-input')).toHaveValue('', 'the box clears for the next one');

      // The list view is the tree. Add the sub-tasks there.
      await tasksNav(page, 'Tasks').click();
      const parent = taskRow(page, 'Renew the storage lease');
      await expect(parent).toHaveCount(1);
      await expect(parent.locator('.task-sub-bit.myday')).toHaveText('☀ My Day');
      await parent.locator('.task-addsub').click();
      await page.locator('.tasks-subadd-input').fill('Pull last year’s schedule');
      await page.keyboard.press('Enter');
      await expect(taskRow(page, 'Pull last year’s schedule')).toHaveAttribute('data-depth', '1');

      await taskRow(page, 'Pull last year’s schedule').locator('.task-addsub').click();
      await page.locator('.tasks-subadd-input').fill('Ask Jordan for the vendor list');
      await page.keyboard.press('Enter');
      const level3 = taskRow(page, 'Ask Jordan for the vendor list');
      await expect(level3).toHaveAttribute('data-depth', '2');

      // Three levels is the floor, and the UI enforces it structurally: a
      // level-3 row has no "add a sub-task" button at all, where a level-2 row
      // does. Two-sided on purpose; an absent button proves nothing on its own.
      await expect(taskRow(page, 'Pull last year’s schedule').locator('.task-addsub')).toHaveCount(1);
      await expect(level3.locator('.task-addsub')).toHaveCount(0);
      await level3.locator('.task-main').click();
      await expect(page.locator('.task-editor-hint')).toContainText('as deep as sub-tasks go');
      await page.keyboard.press('Escape');
      await expect(page.locator('.task-editor')).toHaveCount(0);

      await screenshot(page, 'tasks-view-tree.png');

      // Ticking the parent finishes the branch and moves it to Completed.
      await parent.locator('.task-check').click();
      await expect(page.locator('.tasks-done-toggle')).toContainText('Completed (3)');
      await expect(page.locator('.tasks-rows .task-row.done')).toHaveCount(3);

      // And unticking puts the branch back, all three of them.
      await taskRow(page, 'Renew the storage lease').locator('.task-check').click();
      await expect(page.locator('.tasks-donesec')).toHaveCount(0);
      await expect(page.locator('.task-row.done')).toHaveCount(0);

      // Everything above is on DISK, not in React state: the file the main
      // process was told to use holds it, in the shape a human could edit.
      const written = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
      expect(written.tasks.map((t) => t.title)).toEqual([
        'Renew the storage lease', 'Pull last year’s schedule', 'Ask Jordan for the vendor list',
      ]);
      expect(written.tasks.map((t) => t.done)).toEqual([false, false, false]);

      // A reload rebuilds the whole view from that file.
      await page.evaluate(() => window.location.reload());
      await page.waitForSelector('.rail', { timeout: 20000 });
      await expect(page.locator('.tasks-view')).toBeVisible({ timeout: 20000 });
      await expect(page.locator('.task-row')).toHaveCount(3);
      await expect(taskRow(page, 'Ask Jordan for the vendor list')).toHaveAttribute('data-depth', '2');

      // A star pins its task to the TOP of the list (Pat, 2026-08-02), and the
      // proof has to be the rendered order, not the flag on disk: the whole ask
      // is where the row sits. Two-sided, because a row that was already first
      // would pass either way.
      await page.locator('.tasks-add-input').fill('Call the vendor back');
      await page.keyboard.press('Enter');
      const titles = () => page.locator('.tasks-rows .task-row .task-title');
      await expect(titles()).toHaveText([
        'Renew the storage lease', 'Pull last year’s schedule',
        'Ask Jordan for the vendor list', 'Call the vendor back',
      ]);
      await taskRow(page, 'Call the vendor back').locator('.task-star').click();
      await expect(titles()).toHaveText([
        'Call the vendor back', 'Renew the storage lease',
        'Pull last year’s schedule', 'Ask Jordan for the vendor list',
      ]);
      // A starred SUB-task rises among its own siblings and never leaves its
      // parent: pinning to the top of the list would tear the tree apart.
      await taskRow(page, 'Ask Jordan for the vendor list').locator('.task-star').click();
      await expect(titles()).toHaveText([
        'Call the vendor back', 'Renew the storage lease',
        'Pull last year’s schedule', 'Ask Jordan for the vendor list',
      ]);
      await expect(taskRow(page, 'Ask Jordan for the vendor list')).toHaveAttribute('data-depth', '2');
      // And unstarring drops it back where its own order always said it was.
      await taskRow(page, 'Call the vendor back').locator('.task-star').click();
      await expect(titles()).toHaveText([
        'Renew the storage lease', 'Pull last year’s schedule',
        'Ask Jordan for the vendor list', 'Call the vendor back',
      ]);
    } finally {
      await closeHarbor(electronApp, page);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('18) tasks: the editor writes every field, the smart views answer, and the tab badge counts', async () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-tasks-e2e-'));
    const tasksFile = path.join(tmp, 'tasks.json');
    const { electronApp, page } = await launch({ HARBOR_TASKS_FILE: tasksFile });
    try {
      await page.locator('.view-switch-btn', { hasText: 'Tasks' }).click();
      await expect(page.locator('.tasks-view')).toBeVisible();

      // A second list, and a task in it.
      await page.locator('.tasks-newlist-btn').click();
      await page.locator('.tasks-newlist-input').fill('example-org');
      await page.keyboard.press('Enter');
      await expect(tasksNav(page, 'example-org')).toHaveCount(1);
      await expect(page.locator('.tasks-title')).toHaveText('example-org', { timeout: 5000 });

      await page.locator('.tasks-add-input').fill('Q3 renewal review');
      await page.keyboard.press('Enter');
      const row = taskRow(page, 'Q3 renewal review');
      await expect(row).toHaveCount(1);

      // Open the editor and fill in everything the task has.
      await row.locator('.task-main').click();
      await expect(page.locator('.task-editor-panel')).toBeVisible();
      const today = await page.evaluate(() => {
        // The same 6am day roll the app uses, so "Due today" is the app's today.
        const d = new Date();
        if (d.getHours() < 6) d.setDate(d.getDate() - 1);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      });
      await page.locator('.task-editor-chip', { hasText: 'Today' }).click();
      await expect(page.locator('.task-editor-due')).toHaveText('Due today');
      await page.locator('.task-editor-toggle').click(); // Add to My Day
      await expect(page.locator('.task-editor-toggle')).toHaveText(/In My Day/);
      await page.locator('.task-star').last().click(); // the star in the editor head
      await page.locator('.task-editor-tag-input').fill('work');
      await page.keyboard.press('Enter');
      await expect(page.locator('.task-editor-tag')).toContainText('work');
      await page.locator('.task-editor-notes').fill('Jordan has the vendor list; do not send before Thursday.');
      // Sub-tasks are addable from the editor too.
      await page.locator('.task-editor-subadd-input').fill('Confirm the effective date');
      await page.keyboard.press('Enter');
      await expect(page.locator('.task-editor-sub-title')).toHaveText('Confirm the effective date');
      // Created / modified metadata is real, not a placeholder.
      await expect(page.locator('.task-editor-meta')).toContainText('Created');
      await screenshot(page, 'tasks-editor.png');

      await page.locator('.task-editor-close').click();
      await expect(page.locator('.task-editor')).toHaveCount(0);

      // Everything reached disk, including the notes, which settle on a timer
      // and must not be lost by closing the editor a beat later.
      await expect.poll(async () => {
        const doc = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
        const task = doc.tasks.find((t) => t.title === 'Q3 renewal review');
        return task && {
          due: task.dueDate, starred: task.starred, myDay: task.myDayDate,
          tags: task.tags, notes: task.notes.slice(0, 5),
        };
      }, { timeout: 8000 }).toEqual({
        due: today, starred: true, myDay: today, tags: ['work'], notes: 'Jorda',
      });

      // The smart views each answer for the same task, which is the whole
      // reason they exist.
      for (const view of ['My Day', 'Important', 'Planned']) {
        await tasksNav(page, view).click();
        await expect(taskRow(page, 'Q3 renewal review')).toHaveCount(1);
      }
      // In a smart view the row carries its list and its due state.
      await expect(taskRow(page, 'Q3 renewal review').locator('.task-sub')).toContainText('example-org');
      await expect(taskRow(page, 'Q3 renewal review').locator('.task-sub-bit.due-today')).toHaveCount(1);

      // The tag filter narrows to it, and clearing the filter restores the rest.
      await tasksNav(page, 'All tasks').click();
      await expect(page.locator('.task-row')).toHaveCount(2);
      await page.locator('.tasks-tag-btn', { hasText: 'work' }).click();
      await expect(page.locator('.task-row')).toHaveCount(1);
      await page.locator('.tasks-tag-btn', { hasText: 'work' }).click();
      await expect(page.locator('.task-row')).toHaveCount(2);

      // The Tasks tab itself says something is due, so it is visible from the
      // Agents view without going looking.
      await expect(page.locator('.view-switch-badge')).toHaveText('1');
      await page.locator('.view-switch-btn', { hasText: 'Agents' }).click();
      await expect(page.locator('.stagewrap')).toBeVisible();
      await expect(page.locator('.view-switch-badge')).toHaveText('1');
      await screenshot(page, 'tasks-badge-from-agents.png');

      // Deleting takes the sub-task with it, and only on the second click.
      await page.locator('.view-switch-btn', { hasText: 'Tasks' }).click();
      await taskRow(page, 'Q3 renewal review').locator('.task-main').click();
      await page.locator('.task-editor-delete').click();
      await expect(page.locator('.task-editor-delete')).toHaveText(/Delete this and 1 sub-task/);
      await expect(page.locator('.task-editor-panel')).toBeVisible('one click is not consent');
      await page.waitForTimeout(400); // past the double-click dead zone
      await page.locator('.task-editor-delete').click();
      await expect(page.locator('.task-editor')).toHaveCount(0);
      await expect(taskRow(page, 'Q3 renewal review')).toHaveCount(0);
      await expect(page.locator('.view-switch-badge')).toHaveCount(0, 'nothing due, no badge');

      const after = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
      expect(after.tasks.some((t) => t.title === 'Confirm the effective date')).toBe(false);
    } finally {
      await closeHarbor(electronApp, page);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('19) tasks: a Claude session editing through bin/harbor-tasks lands in the open app', async () => {
    // Pat's ask (2026-07-30): his agents work with the list on request, from any
    // project and any config home. That only holds if an edit made OUTSIDE
    // Harbor reaches the open window without a reload, so this drives the real
    // CLI as a separate process against the same file the app is showing.
    const fs = require('node:fs');
    const os = require('node:os');
    const { spawnSync } = require('node:child_process');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-tasks-cli-e2e-'));
    const tasksFile = path.join(tmp, 'tasks.json');
    const CLI = path.join(APP_ROOT, '..', 'bin', 'harbor-tasks');
    const cli = (...args) => {
      const result = spawnSync(process.execPath, [CLI, ...args], {
        encoding: 'utf8',
        env: { ...process.env, HARBOR_TASKS_FILE: tasksFile },
      });
      expect(result.status, `harbor-tasks ${args.join(' ')}: ${result.stderr}`).toBe(0);
      return result.stdout;
    };

    const { electronApp, page } = await launch({ HARBOR_TASKS_FILE: tasksFile });
    try {
      await page.locator('.view-switch-btn', { hasText: 'Tasks' }).click();
      await expect(page.locator('.tasks-view')).toBeVisible();

      // Sit on All tasks first: the view opens on My Day, and a task the agent
      // did not put in My Day is correctly absent there, which would prove
      // nothing about whether the window is watching the file.
      await tasksNav(page, 'All tasks').click();
      await expect(page.locator('.task-row')).toHaveCount(0);

      // The agent writes while the window is open, and the window follows with
      // no reload and no click.
      cli('add', 'Send Morgan the renewal schedule', '--due', 'today', '--star', '--tag', 'work');
      await expect(taskRow(page, 'Send Morgan the renewal schedule')).toHaveCount(1, { timeout: 10000 });
      await tasksNav(page, 'Important').click();
      await expect(taskRow(page, 'Send Morgan the renewal schedule')).toHaveCount(1);
      await expect(page.locator('.view-switch-badge')).toHaveText('1');

      cli('add', 'Pull last year’s numbers', '--parent', 'Send Morgan');
      await tasksNav(page, 'Tasks').click();
      await expect(taskRow(page, 'Pull last year’s numbers')).toHaveAttribute('data-depth', '1', { timeout: 10000 });

      cli('done', 'Send Morgan');
      await expect(page.locator('.tasks-done-toggle')).toContainText('Completed (2)', { timeout: 10000 });
      await expect(page.locator('.view-switch-badge')).toHaveCount(0, 'and the badge clears with it');
      await screenshot(page, 'tasks-cli-edit-live.png');

      // And it works the other way: the app's own change is what the CLI reads.
      await page.locator('.tasks-add-input').fill('Typed in Harbor');
      await page.keyboard.press('Enter');
      await expect(taskRow(page, 'Typed in Harbor')).toHaveCount(1);
      await expect.poll(() => {
        const doc = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
        return doc.tasks.map((t) => t.title).includes('Typed in Harbor');
      }, { timeout: 8000 }).toBe(true);
      expect(cli('list', '--json')).toContain('Typed in Harbor');
    } finally {
      await closeHarbor(electronApp, page);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('20) a FRESH session\'s model switches in its own pane, and never spawns a second session', async () => {
    // Live-caught 2026-08-02: Pat started a session in Notes/Wiki, opened
    // its config, changed the model, and got a SECOND window and a second
    // session in the same project. The config popover treated a provisional
    // `pane:<id>` window as "no session yet" and launched one. It is a running
    // claude in a real pane, so the switch is typed into that pane.
    //
    // Driven against a REAL pty, because the failure was invisible to any
    // assertion about the popover alone: the old code also "worked", it just
    // worked by launching.
    const harness = sharedHarness;
    const { electronApp, page } = await launch();
    const verifyClient = new HerdrClient({ socketPath: harness.socketPath, requestTimeoutMs: 2000 });
    try {
      const before = await verifyClient.snapshot();
      const beforeIds = new Set((before.snapshot?.layouts || [])
        .flatMap((l) => (l.panes || []).map((p) => p.pane_id)));
      await verifyClient.splitPane(harness.paneIds[0], { direction: 'down', ratio: 0.5, focus: false });
      const after = await verifyClient.snapshot();
      const panesAfter = (after.snapshot?.layouts || []).flatMap((l) => l.panes || []);
      const simPaneId = panesAfter.map((p) => p.pane_id).find((id) => !beforeIds.has(id));
      expect(simPaneId).toBeTruthy();
      // Same primer as spec 6: the dead-shell guard refuses a bare shell tail,
      // and cat keeps the typed bytes on screen where they can be read back.
      let primed = false;
      for (let attempt = 0; attempt < 3 && !primed; attempt += 1) {
        await verifyClient.sendText(simPaneId, "clear; printf '────────\\n❯ \\n'; exec cat > /dev/null").catch(() => {});
        await verifyClient.sendKeys(simPaneId, ['enter']).catch(() => {});
        const primeDeadline = Date.now() + 7000;
        while (Date.now() < primeDeadline && !primed) {
          try {
            if ((await paneScreen(verifyClient, simPaneId, 10)).includes('❯')) primed = true;
          } catch { /* transient daemon latency; keep polling */ }
          if (!primed) await page.waitForTimeout(400);
        }
      }
      expect(primed).toBeTruthy();

      // Exactly what launchNewSession emits the moment the fresh pane appears,
      // before Claude has written any transcript at all.
      const provisionalId = `pane:${simPaneId}`;
      await page.evaluate(async ({ sessionId, paneId }) => {
        await window.harbor.e2e.emitLaunched({
          sessionId,
          paneId,
          cwd: '/home/you/dev/harbor',
          provider: 'claude',
          model: 'opus',
          effort: 'xhigh',
          provisional: true,
        });
        await window.harbor.e2e.setLink({ sessionId, paneId, workspaceId: null });
      }, { sessionId: provisionalId, paneId: simPaneId });

      const win = page.locator(`.win2[data-session-id="${provisionalId}"]`);
      await expect(win).toHaveCount(1);
      // Pat, same day: "i cant even see what model im in for these new
      // sessions". With no transcript the chip has nothing to read, so it reads
      // the launch: the registry's own label, not the raw alias.
      await expect(win.locator('.model-chip')).toContainText('Opus 5');
      await expect(win.locator('.model-chip .eff')).toHaveText('xhigh');

      await win.locator('.model-chip').click();
      await expect(page.locator('.new-session-popover')).toBeVisible();
      // The button is the tell: Apply changes this session, Start launches one.
      await expect(page.locator('.new-session-start')).toHaveText('Apply');
      await page.locator('.model-select').click();
      await page.locator('.model-select-row', { hasText: 'Sonnet' }).first().click();
      await page.locator('.new-session-start').click();
      await expect(page.locator('.new-session-popover')).toHaveCount(0);

      // The switch reached the REAL pty of the session that was already open.
      let seen = false;
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline && !seen) {
        try {
          seen = (await paneScreen(verifyClient, simPaneId, 30)).includes('/model sonnet');
        } catch { /* keep polling */ }
        if (!seen) await page.waitForTimeout(400);
      }
      expect(seen).toBe(true);

      // And nothing was launched: one window, still the same session.
      await expect(page.locator('.win2')).toHaveCount(1);
      await expect(win).toHaveCount(1);
      // A new session is a `bin/ai` shell-out, and the fake-launch recorder
      // sees every one of them. Zero, or the popover launched behind the fix.
      const launched = await page.evaluate(() => window.harbor.e2e.getLaunchCalls());
      expect(launched.filter((call) => String(call.command).endsWith('/bin/ai'))).toHaveLength(0);
      await screenshot(page, 'fresh-session-model-switch.png');
    } finally {
      await closeHarbor(electronApp, page);
    }
  });

  test('6) live command-bar send delivers real bytes into an isolated herdr pane', async () => {
    const harness = sharedHarness;
    const { electronApp, page } = await launch();
    const verifyClient = new HerdrClient({ socketPath: harness.socketPath, requestTimeoutMs: 2000 });
    try {
      // Pair a real historical session with a real harness pane (the seam the
      // launch flows fill in production). The dead-shell guard (live-caught
      // 2026-07-22: a CLI crash left bash, and a send EXECUTED in it) refuses
      // to type into a shell-prompt tail, so the stand-in pane must satisfy
      // the new contract: a fresh split pane primed with a composer frame and
      // parked in cat, where the typed bytes still echo into the real pty.
      const before = await verifyClient.snapshot();
      const beforeIds = new Set((before.snapshot?.layouts || [])
        .flatMap((l) => (l.panes || []).map((p) => p.pane_id)));
      await verifyClient.splitPane(harness.paneIds[0], { direction: 'down', ratio: 0.5, focus: false });
      const after = await verifyClient.snapshot();
      const panesAfter = (after.snapshot?.layouts || []).flatMap((l) => l.panes || []);
      const simPaneId = panesAfter.map((p) => p.pane_id).find((id) => !beforeIds.has(id));
      expect(simPaneId).toBeTruthy();
      // Prime with retry: a primer sent while the split pane's shell is still
      // coming up can vanish; re-sending is harmless once cat owns stdin (the
      // echoed literal still paints a ❯, which is all the guard needs).
      let primed = false;
      for (let attempt = 0; attempt < 3 && !primed; attempt += 1) {
        await verifyClient.sendText(simPaneId, "clear; printf '────────\\n❯ \\n'; exec cat > /dev/null").catch(() => {});
        await verifyClient.sendKeys(simPaneId, ['enter']).catch(() => {});
        const primeDeadline = Date.now() + 7000;
        while (Date.now() < primeDeadline && !primed) {
          try {
            const res = { read: { text: await paneScreen(verifyClient, simPaneId, 10) } };
            if ((res?.read?.text || '').includes('❯')) primed = true;
          } catch { /* transient daemon latency; keep polling */ }
          if (!primed) await page.waitForTimeout(400);
        }
      }
      expect(primed).toBeTruthy();
      const paneInfo = { paneId: simPaneId, workspaceId: null };

      await page.locator('.rail-find').fill(SEARCH_QUERY);
      await page.waitForTimeout(600);
      const meta = await openFirstSession(page);
      await page.evaluate(async ({ sessionId, paneId, workspaceId }) => {
        await window.harbor.e2e.setLink({ sessionId, paneId, workspaceId });
      }, { sessionId: meta.id, ...paneInfo });

      // The window now reads live; the bar is armed.
      await expect(page.locator(`.win2[data-session-id="${meta.id}"] .lv, .win2[data-session-id="${meta.id}"] .selflag`).first()).toBeVisible();
      await expect(page.locator('.resume-chip')).toHaveCount(0);

      const marker = `harbor_slate_${Date.now()}`;
      const composer = page.locator('.ubar-input');
      await composer.click();
      await composer.fill(marker);
      // Send it BOLD. The composer shows real bold, but a pty cannot receive
      // rich text: what has to arrive on the wire is the markdown `**marker**`.
      // Asserting the plain marker would pass even if formatting were dropped
      // silently on the way out.
      await page.keyboard.press('Control+A');
      await page.keyboard.press('Control+b');
      await page.locator('.ubar .send').click();

      // The bytes must land in the REAL pty (typed text + submit).
      let seen = false;
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline && !seen) {
        try {
          const text = await paneScreen(verifyClient, paneInfo.paneId, 30);
          seen = text.replace(/\s+/g, '').includes(`**${marker}**`);
        } catch { /* keep polling */ }
        if (!seen) await new Promise((r) => setTimeout(r, 400));
      }
      expect(seen).toBe(true);

      // The input cleared on success.
      await expect.poll(async () => composerText(page)).toBe('');

      // TTY escape hatch: flip the window to the raw terminal and back.
      await page.locator(`.win2[data-session-id="${meta.id}"] .ico.tty`).click();
      await page.waitForSelector(`.win2[data-session-id="${meta.id}"] .terminal-pane`, { timeout: 10000 });
      await page.waitForFunction(
        (id) => {
          const rows = document.querySelector(`.win2[data-session-id="${id}"] .xterm-rows`);
          return rows && (rows.textContent || '').trim().length > 0;
        },
        meta.id,
        { timeout: 10000 },
      );
      await screenshot(page, '07-tty-toggle.png');
      await page.locator(`.win2[data-session-id="${meta.id}"] .ico.tty`).click();
      await page.waitForSelector(`.win2[data-session-id="${meta.id}"] .conv`, { timeout: 10000 });

      await screenshot(page, '08-live-send.png');
    } finally {
      await closeHarbor(electronApp, page);
      // The shared harness stays up for the rest of the suite; afterAll owns it.
    }
  });

  test('6b) a hook/permission dialog renders the in-window question card and answers through the pty', async () => {
    // The real shape live-caught 2026-07-20: a PreToolUse hook confirmation
    // whose footer is "Esc to cancel · Tab to amend · ctrl+e to explain". The
    // first Q/A build only knew the "Enter to select" footer, so this screen
    // refused the command-bar send AND rendered no card: a dead end.
    const harness = sharedHarness;
    const { electronApp, page } = await launch();
    const verifyClient = new HerdrClient({ socketPath: harness.socketPath, requestTimeoutMs: 2000 });
    let simPaneId = null;
    try {
      // A fresh split pane (no demo tick loop) running the dialog simulator.
      const before = await verifyClient.snapshot();
      const beforeIds = new Set((before.snapshot?.layouts || [])
        .flatMap((l) => (l.panes || []).map((p) => p.pane_id)));
      await verifyClient.splitPane(harness.paneIds[0], { direction: 'down', ratio: 0.5, focus: false });
      const after = await verifyClient.snapshot();
      const panesAfter = (after.snapshot?.layouts || []).flatMap((l) => l.panes || []);
      simPaneId = panesAfter.map((p) => p.pane_id).find((id) => !beforeIds.has(id));
      expect(simPaneId).toBeTruthy();

      const simPath = path.join(APP_ROOT, 'scripts/e2e-ask-dialog-sim.js');
      await verifyClient.sendText(simPaneId, `node ${simPath}`);
      await verifyClient.sendKeys(simPaneId, ['enter']);
      await expect.poll(async () => {
        try {
          return paneScreen(verifyClient, simPaneId, 30);
        } catch { return ''; }
      }, { timeout: 10000 }).toContain('Do you want to proceed?');

      await page.locator('.rail-find').fill(SEARCH_QUERY);
      await page.waitForTimeout(600);
      const meta = await openFirstSession(page);
      await page.evaluate(async ({ sessionId, paneId }) => {
        await window.harbor.e2e.setLink({ sessionId, paneId, workspaceId: null });
      }, { sessionId: meta.id, paneId: simPaneId });

      // The question card appears inside the window, decidable in place. The
      // picked session can carry a 30MB+ transcript whose initial parse janks
      // the renderer for seconds on a loaded box, starving the 700ms card
      // poll; give the card the time the jank costs.
      const card = page.locator(`.win2[data-session-id="${meta.id}"] .tile-ask`);
      await expect(card).toBeVisible({ timeout: 25000 });
      await expect(card.locator('.tile-ask-q')).toContainText('Do you want to proceed?');
      const rows = card.locator('button.tile-ask-row');
      await expect(rows).toHaveCount(2);
      await screenshot(page, '06b-ask-card.png');

      // Answer "No": the pointer starts on Yes, so this proves arrow
      // navigation plus Enter through the real pty, not just a blind Enter.
      await rows.nth(1).click();
      await expect.poll(async () => {
        try {
          return paneScreen(verifyClient, simPaneId, 30);
        } catch { return ''; }
      }, { timeout: 10000 }).toContain('PICKED:2');

      // With the dialog gone the card clears on the next poll.
      await expect(card).toHaveCount(0, { timeout: 6000 });
    } finally {
      await closeHarbor(electronApp, page);
      if (simPaneId) await verifyClient.closePane(simPaneId).catch(() => {});
    }
  });

  test('6c) a viewport-clipped menu still renders an answerable card and lands on the option number', async () => {
    // The real shape live-caught 2026-07-21 (pane wC:pC): an AskUserQuestion
    // menu whose long option descriptions overflow the pty viewport, clipping
    // the question, option 1, and the "❯" pointer off the top. The visible
    // run starts at "2.", which the numbered-prose guard rejected wholesale:
    // amber "needs your answer" cue, no card, a dead end. The card must
    // render the visible tail honestly and answer by option NUMBER.
    const harness = sharedHarness;
    const { electronApp, page } = await launch();
    const verifyClient = new HerdrClient({ socketPath: harness.socketPath, requestTimeoutMs: 2000 });
    let simPaneId = null;
    try {
      const before = await verifyClient.snapshot();
      const beforeIds = new Set((before.snapshot?.layouts || [])
        .flatMap((l) => (l.panes || []).map((p) => p.pane_id)));
      await verifyClient.splitPane(harness.paneIds[0], { direction: 'down', ratio: 0.5, focus: false });
      const after = await verifyClient.snapshot();
      const panesAfter = (after.snapshot?.layouts || []).flatMap((l) => l.panes || []);
      simPaneId = panesAfter.map((p) => p.pane_id).find((id) => !beforeIds.has(id));
      expect(simPaneId).toBeTruthy();

      const simPath = path.join(APP_ROOT, 'scripts/e2e-ask-dialog-sim.js');
      await verifyClient.sendText(simPaneId, `node ${simPath} clipped`);
      await verifyClient.sendKeys(simPaneId, ['enter']);
      await expect.poll(async () => {
        try {
          return paneScreen(verifyClient, simPaneId, 30);
        } catch { return ''; }
      }, { timeout: 10000 }).toContain('Hand-build it now');

      await page.locator('.rail-find').fill(SEARCH_QUERY);
      await page.waitForTimeout(600);
      const meta = await openFirstSession(page);
      await page.evaluate(async ({ sessionId, paneId }) => {
        await window.harbor.e2e.setLink({ sessionId, paneId, workspaceId: null });
      }, { sessionId: meta.id, paneId: simPaneId });

      const card = page.locator(`.win2[data-session-id="${meta.id}"] .tile-ask`);
      await expect(card).toBeVisible({ timeout: 25000 });
      // No transcript question to merge here, so the card shows what the pane
      // shows and invents nothing: no question line, real option numbers
      // (2, 3, 5 select; 4 is the text option), and NOT the sentence Pat
      // banned on 2026-07-27. This scene is the permanent stand-in for a
      // dialog Harbor could not un-clip; the pane-growing fix removes the
      // cause, this proves the residual case is still answerable.
      await expect(card.locator('.tile-ask-q')).toHaveCount(0);
      await expect(card).not.toContainText('scrolled out of the terminal view');
      const rows = card.locator('button.tile-ask-row');
      await expect(rows).toHaveCount(3);
      await expect(rows.nth(0).locator('.tile-ask-num')).toHaveText('2');
      await expect(card.locator('.tile-ask-row.text')).toHaveCount(1);
      await screenshot(page, '06c-ask-card-clipped.png');

      // Answer "Re-run it in the tool" (option 3). The pointer starts hidden
      // on the clipped option 1, so this proves the reveal-nudge, the
      // number-keyed walk, and Enter-only-after-verify through a real pty.
      await rows.nth(1).click();
      await expect.poll(async () => {
        try {
          return paneScreen(verifyClient, simPaneId, 30);
        } catch { return ''; }
      }, { timeout: 10000 }).toContain('PICKED:3');

      await expect(card).toHaveCount(0, { timeout: 6000 });
    } finally {
      await closeHarbor(electronApp, page);
      if (simPaneId) await verifyClient.closePane(simPaneId).catch(() => {});
    }
  });

  test('6d) an UNRECOGNIZED dialog shape still yields an answerable in-window panel', async () => {
    // The no-dead-end guard (Pat mandate 2026-07-21): six dialog shapes were
    // each fixed only after a live hit. This drives a shape Harbor has NEVER
    // seen (lettered options, unknown footer): no parse is possible, so the
    // window must show the fallback panel: raw screen tail plus direct keys.
    // If this test can answer it, no future CLI dialog shape can dead-end the
    // workflow.
    const fs = require('node:fs');
    const os = require('node:os');
    const harness = sharedHarness;
    const captureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-e2e-unrec-'));
    const { electronApp, page } = await launch({ HARBOR_UNRECOGNIZED_DIR: captureDir });
    const verifyClient = new HerdrClient({ socketPath: harness.socketPath, requestTimeoutMs: 2000 });
    let simPaneId = null;
    // The harness pane is narrow enough to hard-wrap ANY phrase mid-word
    // (gate-caught: "migration rit/ual?"), so matching strips the wraps.
    const paneText = async () => (await paneScreen(verifyClient, simPaneId, 30)).replace(/\n/g, '');
    try {
      const before = await verifyClient.snapshot();
      const beforeIds = new Set((before.snapshot?.layouts || [])
        .flatMap((l) => (l.panes || []).map((p) => p.pane_id)));
      await verifyClient.splitPane(harness.paneIds[0], { direction: 'down', ratio: 0.5, focus: false });
      const after = await verifyClient.snapshot();
      const panesAfter = (after.snapshot?.layouts || []).flatMap((l) => l.panes || []);
      simPaneId = panesAfter.map((p) => p.pane_id).find((id) => !beforeIds.has(id));
      expect(simPaneId).toBeTruthy();

      const simPath = path.join(APP_ROOT, 'scripts/e2e-ask-dialog-sim.js');
      await verifyClient.sendText(simPaneId, `node ${simPath} mystery`);
      await verifyClient.sendKeys(simPaneId, ['enter']);
      await expect.poll(paneText, { timeout: 10000 }).toContain('migration ritual');

      await page.locator('.rail-find').fill(SEARCH_QUERY);
      await page.waitForTimeout(600);
      const meta = await openFirstSession(page);
      await page.evaluate(async ({ sessionId, paneId }) => {
        await window.harbor.e2e.setLink({ sessionId, paneId, workspaceId: null });
      }, { sessionId: meta.id, paneId: simPaneId });

      const card = page.locator(`.win2[data-session-id="${meta.id}"] .tile-ask`);
      await expect(card).toBeVisible({ timeout: 25000 });
      // Wrap-safe token: " cursor:1" always fits on one pane line.
      await expect(card.locator('.tile-ask-screen')).toContainText('cursor:1');
      await screenshot(page, '06d-ask-fallback.png');

      // A key button drives the real pty and the panel re-reads the screen.
      await card.locator('.tile-ask-key', { hasText: '↓' }).click();
      await expect(card.locator('.tile-ask-screen')).toContainText('cursor:2', { timeout: 8000 });

      // Raw text answers the dialog; no Enter is implied.
      await card.locator('.tile-ask-input').fill('b');
      await card.locator('.tile-ask-send').click();
      await expect.poll(paneText, { timeout: 10000 }).toContain('PICKED:b');

      // Dialog gone: the panel clears, and the unknown screen self-captured
      // as a fixture for the next labeled-card fix.
      await expect(card).toHaveCount(0, { timeout: 6000 });
      expect(fs.readdirSync(captureDir).length).toBeGreaterThan(0);
    } finally {
      await closeHarbor(electronApp, page);
      if (simPaneId) await verifyClient.closePane(simPaneId).catch(() => {});
    }
  });

  test('6e) a BATCHED AskUserQuestion renders its tab strip, labels and descriptions, and answers every question', async () => {
    // The shape Pat screenshotted 2026-07-26: several questions behind one tab
    // strip, wrapped option labels, a "(Recommended)" marker, a description per
    // option. The card rendered it as two mangled one-line choices under a
    // run-on question built from the transcript prose above the dialog plus the
    // tab strip itself. Everything asserted here is something that screen got
    // wrong, driven through the real pty.
    const harness = sharedHarness;
    const { electronApp, page } = await launch();
    const verifyClient = new HerdrClient({ socketPath: harness.socketPath, requestTimeoutMs: 2000 });
    let simPaneId = null;
    const paneText = async () => (await paneScreen(verifyClient, simPaneId, 40)).replace(/\n/g, '');
    try {
      const before = await verifyClient.snapshot();
      const beforeIds = new Set((before.snapshot?.layouts || [])
        .flatMap((l) => (l.panes || []).map((p) => p.pane_id)));
      await verifyClient.splitPane(harness.paneIds[0], { direction: 'down', ratio: 0.5, focus: false });
      const after = await verifyClient.snapshot();
      const panesAfter = (after.snapshot?.layouts || []).flatMap((l) => l.panes || []);
      simPaneId = panesAfter.map((p) => p.pane_id).find((id) => !beforeIds.has(id));
      expect(simPaneId).toBeTruthy();

      const simPath = path.join(APP_ROOT, 'scripts/e2e-ask-dialog-sim.js');
      await verifyClient.sendText(simPaneId, `node ${simPath} batch`);
      await verifyClient.sendKeys(simPaneId, ['enter']);
      await expect.poll(paneText, { timeout: 10000 }).toContain('Tab to switch questions');

      await page.locator('.rail-find').fill(SEARCH_QUERY);
      await page.waitForTimeout(600);
      const meta = await openFirstSession(page);
      await page.evaluate(async ({ sessionId, paneId }) => {
        await window.harbor.e2e.setLink({ sessionId, paneId, workspaceId: null });
      }, { sessionId: meta.id, paneId: simPaneId });

      const card = page.locator(`.win2[data-session-id="${meta.id}"] .tile-ask`);
      await expect(card).toBeVisible({ timeout: 25000 });

      // The question is the dialog's own, not the transcript prose above it
      // and not the tab strip.
      await expect(card.locator('.tile-ask-q'))
        .toHaveText('How should the custom range appear in the filter?');

      // Labels survive the pane's mid-word hard wrap, and the description the
      // old card threw away is on screen.
      const rows = card.locator('button.tile-ask-row');
      await expect(rows).toHaveCount(2);
      await expect(rows.nth(0).locator('.tile-ask-label'))
        .toContainText('Custom segment + inline pickers');
      await expect(rows.nth(0).locator('.tile-ask-desc'))
        .toHaveText('Adds a Custom chip beside the presets, with Start and End pickers.');
      await expect(rows.nth(0).locator('.tile-ask-rec')).toBeVisible();
      await expect(rows.nth(1).locator('.tile-ask-label'))
        .toContainText('Always-visible Start / End boxes');

      // The batch is visible as a batch: three questions plus the Submit tab.
      await expect(card.locator('.tile-ask-count')).toHaveText('3 questions');
      await expect(card.locator('.tile-ask-tab')).toHaveCount(4);
      await expect(card.locator('.tile-ask-tab.submit')).toHaveText(/Submit/);
      await screenshot(page, '06e-ask-card-batch.png');

      // Tab moves to the next question in the batch, through the real pty.
      await card.locator('.tile-ask-key', { hasText: 'Next question' }).click();
      await expect(card.locator('.tile-ask-q'))
        .toHaveText('Which totals should a custom range show?', { timeout: 10000 });

      // Answering that one marks it done in the strip and moves the dialog on.
      await card.locator('button.tile-ask-row').nth(1).click();
      await expect(card.locator('.tile-ask-count')).toHaveText('1 of 3 answered', { timeout: 10000 });
      await expect(card.locator('.tile-ask-tab.done')).toHaveText(/Chart/);

      // Answer the remaining two: the batch only submits once all three are in.
      await expect(card.locator('.tile-ask-q'))
        .toHaveText('How should the custom range appear in the filter?');
      await card.locator('button.tile-ask-row').nth(0).click();
      await expect(card.locator('.tile-ask-q'))
        .toHaveText('What should the period title say?', { timeout: 10000 });
      await card.locator('button.tile-ask-row').nth(1).click();

      await expect.poll(paneText, { timeout: 10000 }).toContain('PICKED:1,2,2');
      await expect(card).toHaveCount(0, { timeout: 6000 });
    } finally {
      await closeHarbor(electronApp, page);
      if (simPaneId) await verifyClient.closePane(simPaneId).catch(() => {});
    }
  });

  // Live-caught 2026-07-27, Pat: "not even showing the actual question, fix."
  // A dialog whose options carry long descriptions overflows the pty viewport,
  // and the pane buffer holds only the visible screen, so the question and the
  // first options are gone for good as far as the SCREEN is concerned. Claude's
  // own AskUserQuestion tool call recorded all of it in the transcript, so the
  // card reads the text from there and keeps the pane for the live interaction.
  // Here the transcript side is supplied through an e2e seam; the parse, the
  // merge, the card and the answer are all the real thing against a real pty.
  test('6f) a clipped dialog shows the real question and the options scrolled off, from the transcript', async () => {
    const harness = sharedHarness;
    const { electronApp, page } = await launch();
    const verifyClient = new HerdrClient({ socketPath: harness.socketPath, requestTimeoutMs: 2000 });
    let simPaneId = null;
    try {
      const before = await verifyClient.snapshot();
      const beforeIds = new Set((before.snapshot?.layouts || [])
        .flatMap((l) => (l.panes || []).map((p) => p.pane_id)));
      await verifyClient.splitPane(harness.paneIds[0], { direction: 'down', ratio: 0.5, focus: false });
      const after = await verifyClient.snapshot();
      simPaneId = (after.snapshot?.layouts || []).flatMap((l) => l.panes || [])
        .map((p) => p.pane_id).find((id) => !beforeIds.has(id));
      expect(simPaneId).toBeTruthy();

      const simPath = path.join(APP_ROOT, 'scripts/e2e-ask-dialog-sim.js');
      await verifyClient.sendText(simPaneId, `node ${simPath} clipped`);
      await verifyClient.sendKeys(simPaneId, ['enter']);
      const paneText = async () => {
        try {
          return paneScreen(verifyClient, simPaneId, 30);
        } catch { return ''; }
      };
      await expect.poll(paneText, { timeout: 10000 }).toContain('Hand-build it now');

      await page.locator('.rail-find').fill(SEARCH_QUERY);
      await page.waitForTimeout(600);
      const meta = await openFirstSession(page);

      // A REAL transcript on disk, in Claude's own format, read by the real
      // reader. The seam substitutes only WHICH FILE, never the question: this
      // spec exists because the previous one handed the card a ready-made
      // payload, so the READ was never gated, and the read is what failed Pat
      // in the field (his window was thirteen minutes behind the question the
      // card was showing).
      const askDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-e2e-ask-'));
      const askFile = path.join(askDir, `${meta.id}.jsonl`);
      const askLine = (id) => JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id,
            name: 'AskUserQuestion',
            input: {
              questions: [{
                question: 'How should I get you the census she needs?',
                header: 'Census route',
                multiSelect: false,
                options: [
                  { label: 'Use her own run (Recommended)', description: 'She reruns it in the tool and gets validated output.' },
                  { label: 'Hand-build it now', description: 'I build the census by hand from her files.' },
                  { label: 'Re-run it in the tool', description: 'I trigger a fresh run on her files.' },
                ],
              }],
            },
          }],
        },
      });
      fs.writeFileSync(askFile, `${askLine('toolu_e2e_ask')}\n`);

      await page.evaluate(async ({ sessionId, paneId, transcriptPath }) => {
        await window.harbor.e2e.setLink({ sessionId, paneId, workspaceId: null });
        await window.harbor.e2e.setAskTranscript({ sessionId, transcriptPath });
      }, { sessionId: meta.id, paneId: simPaneId, transcriptPath: askFile });

      const card = page.locator(`.win2[data-session-id="${meta.id}"] .tile-ask`);
      await expect(card).toBeVisible({ timeout: 25000 });

      // The whole point: the question is SHOWN, not apologized for.
      await expect(card.locator('.tile-ask-q'))
        .toHaveText('How should I get you the census she needs?', { timeout: 12000 });
      // The sentence Pat banned. It is gone from the source; this keeps it gone.
      await expect(card).not.toContainText('scrolled out of the terminal view');
      await expect(card.locator('.tile-ask-clip')).toHaveCount(0);

      // Option 1 scrolled off the pty viewport, so it is listed from the
      // transcript, and it is a real button: choosing it walks the highlight up
      // and confirms the row before pressing Enter.
      const off = card.locator('button.tile-ask-row.off');
      await expect(off).toHaveCount(1);
      await expect(off.locator('.tile-ask-num')).toHaveText('1');
      await expect(off.locator('.tile-ask-label')).toContainText('Use her own run');
      await expect(off.locator('.tile-ask-rec')).toBeVisible();
      await expect(off).toBeEnabled();

      // Descriptions the two-column scrape never carried now come through.
      const rows = card.locator('button.tile-ask-row');
      await expect(rows.nth(1).locator('.tile-ask-desc'))
        .toHaveText('I build the census by hand from her files.');
      await screenshot(page, '06f-ask-card-question-from-transcript.png');

      // Answering still goes through the real pty by option NUMBER.
      await rows.nth(2).click();
      await expect.poll(paneText, { timeout: 10000 }).toContain('PICKED:3');
    } finally {
      await closeHarbor(electronApp, page);
      if (simPaneId) await verifyClient.closePane(simPaneId).catch(() => {});
    }
  });

  // The regression guard for the actual 2026-07-27 failure. The question used
  // to come from a value the transcript TAIL left behind as it streamed, so it
  // was only ever as current as the last read that landed, and a card could sit
  // there describing a question the file had already moved past. Reading the
  // file cannot go stale, and the only way to gate that property is to CHANGE
  // THE FILE under a live card and require the card to follow within one poll.
  test('6i) the question card follows the transcript file, and cannot go stale', async () => {
    const harness = sharedHarness;
    const { electronApp, page } = await launch();
    const verifyClient = new HerdrClient({ socketPath: harness.socketPath, requestTimeoutMs: 2000 });
    let simPaneId = null;
    try {
      const before = await verifyClient.snapshot();
      const beforeIds = new Set((before.snapshot?.layouts || [])
        .flatMap((l) => (l.panes || []).map((p) => p.pane_id)));
      await verifyClient.splitPane(harness.paneIds[0], { direction: 'down', ratio: 0.5, focus: false });
      const after = await verifyClient.snapshot();
      simPaneId = (after.snapshot?.layouts || []).flatMap((l) => l.panes || [])
        .map((p) => p.pane_id).find((id) => !beforeIds.has(id));
      expect(simPaneId).toBeTruthy();

      const simPath = path.join(APP_ROOT, 'scripts/e2e-ask-dialog-sim.js');
      await verifyClient.sendText(simPaneId, `node ${simPath} clipped`);
      await verifyClient.sendKeys(simPaneId, ['enter']);
      const paneText = async () => {
        try {
          return paneScreen(verifyClient, simPaneId, 30);
        } catch { return ''; }
      };
      await expect.poll(paneText, { timeout: 10000 }).toContain('Hand-build it now');

      await page.locator('.rail-find').fill(SEARCH_QUERY);
      await page.waitForTimeout(600);
      const meta = await openFirstSession(page);

      const askDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-e2e-ask-fresh-'));
      const askFile = path.join(askDir, `${meta.id}.jsonl`);
      const ask = (question) => JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: `toolu_${question.length}`,
            name: 'AskUserQuestion',
            input: {
              questions: [{
                question,
                header: 'Census route',
                options: [
                  { label: 'Use her own run', description: 'd1' },
                  { label: 'Hand-build it now', description: 'd2' },
                  { label: 'Re-run it in the tool', description: 'd3' },
                ],
              }],
            },
          }],
        },
      });
      fs.writeFileSync(askFile, `${ask('First question, already answered?')}\n`);
      await page.evaluate(async ({ sessionId, paneId, transcriptPath }) => {
        await window.harbor.e2e.setLink({ sessionId, paneId, workspaceId: null });
        await window.harbor.e2e.setAskTranscript({ sessionId, transcriptPath });
      }, { sessionId: meta.id, paneId: simPaneId, transcriptPath: askFile });

      const card = page.locator(`.win2[data-session-id="${meta.id}"] .tile-ask`);
      await expect(card.locator('.tile-ask-q'))
        .toHaveText('First question, already answered?', { timeout: 25000 });

      // Claude answers that one and asks another, exactly as a session does.
      // The card has to move with the file: this is the assertion a cache
      // cannot pass.
      fs.appendFileSync(askFile, `${JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_33', content: 'ok' }] },
      })}\n`);
      fs.appendFileSync(askFile, `${ask('Second question, the live one?')}\n`);
      await expect(card.locator('.tile-ask-q'))
        .toHaveText('Second question, the live one?', { timeout: 12000 });

      // And when the live question is answered, the card stops claiming one.
      fs.appendFileSync(askFile, `${JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_30', content: 'ok' }] },
      })}\n`);
      await expect(card.locator('.tile-ask-q')).toHaveCount(0, { timeout: 12000 });
    } finally {
      await closeHarbor(electronApp, page);
      if (simPaneId) await verifyClient.closePane(simPaneId).catch(() => {});
    }
  });

  // A multi-select question got NO card until 2026-07-27 and fell through to the
  // raw-screen fallback panel, which is the shape Pat called unusable. It ticks
  // and submits in the window now, and every step is verified against the
  // checkbox each row draws rather than assumed from the keystroke.
  test('6g) a multi-select question is ticked and submitted from its own window', async () => {
    const harness = sharedHarness;
    const { electronApp, page } = await launch();
    const verifyClient = new HerdrClient({ socketPath: harness.socketPath, requestTimeoutMs: 2000 });
    let simPaneId = null;
    try {
      const before = await verifyClient.snapshot();
      const beforeIds = new Set((before.snapshot?.layouts || [])
        .flatMap((l) => (l.panes || []).map((p) => p.pane_id)));
      await verifyClient.splitPane(harness.paneIds[0], { direction: 'down', ratio: 0.5, focus: false });
      const after = await verifyClient.snapshot();
      simPaneId = (after.snapshot?.layouts || []).flatMap((l) => l.panes || [])
        .map((p) => p.pane_id).find((id) => !beforeIds.has(id));
      expect(simPaneId).toBeTruthy();

      const simPath = path.join(APP_ROOT, 'scripts/e2e-ask-dialog-sim.js');
      await verifyClient.sendText(simPaneId, `node ${simPath} multi`);
      await verifyClient.sendKeys(simPaneId, ['enter']);
      const paneText = async () => {
        try {
          return paneScreen(verifyClient, simPaneId, 30);
        } catch { return ''; }
      };
      await expect.poll(paneText, { timeout: 10000 }).toContain('Crash reports');

      await page.locator('.rail-find').fill(SEARCH_QUERY);
      await page.waitForTimeout(600);
      const meta = await openFirstSession(page);
      await page.evaluate(async ({ sessionId, paneId }) => {
        await window.harbor.e2e.setLink({ sessionId, paneId, workspaceId: null });
      }, { sessionId: meta.id, paneId: simPaneId });

      const card = page.locator(`.win2[data-session-id="${meta.id}"] .tile-ask`);
      await expect(card).toBeVisible({ timeout: 25000 });
      await expect(card.locator('.tile-ask-q')).toHaveText('Which features do you want to enable?');

      // A click TICKS. It must not submit: a half-made answer sent on the first
      // click is the reason this shape used to get no card at all.
      const rows = card.locator('button.tile-ask-row');
      await expect(rows).toHaveCount(4);
      await rows.nth(0).click();
      await expect(rows.nth(0)).toHaveClass(/ on/, { timeout: 10000 });
      await expect.poll(paneText, { timeout: 8000 }).toContain('1. [x] Fast boot');
      await expect(card).toBeVisible();
      expect(await paneText()).not.toContain('PICKED');

      await rows.nth(2).click();
      await expect(rows.nth(2)).toHaveClass(/ on/, { timeout: 10000 });
      await screenshot(page, '06g-ask-card-multiselect.png');

      // Submitting is its own deliberate act, and it carries BOTH ticks.
      await card.locator('.tile-ask-key.primary').click();
      await expect.poll(paneText, { timeout: 10000 }).toContain('PICKED:1,3');
    } finally {
      await closeHarbor(electronApp, page);
      if (simPaneId) await verifyClient.closePane(simPaneId).catch(() => {});
    }
  });

  // Live-caught 2026-07-27: Pat started typing into a brand-new session and a
  // few seconds later the composer emptied itself. A new session opens as a
  // provisional pane:<id> window he can type into at once, and its id UPGRADES
  // to the real session id the moment the transcript materializes. The draft
  // stayed keyed to the dead id, so the composer read the new one, found
  // nothing, and rebuilt itself blank. He blamed the "/effort xhigh" auto-send,
  // which was only the thing that TRIGGERED the upgrade that early; his first
  // real message would have done the same.
  test('6h) a draft survives the session id upgrading under its window', async () => {
    const { electronApp, page } = await launch();
    try {
      await page.locator('.rail-find').fill(SEARCH_QUERY);
      await page.waitForTimeout(600);
      const meta = await openFirstSession(page);

      // Stand in for the provisional window a fresh launch opens.
      const paneKey = 'pane:%e2e-draft';
      await page.evaluate(async ({ paneId }) => {
        await window.harbor.e2e.setLink({ sessionId: paneId, paneId: '%e2e-draft', workspaceId: null });
        await window.harbor.e2e.emitLaunched({
          sessionId: paneId, paneId: '%e2e-draft', cwd: '/tmp', account: 'personal',
          provider: 'claude', model: 'opus', effort: 'xhigh', provisional: true,
        });
      }, { paneId: paneKey });
      const provisional = page.locator(`.win2[data-session-id="${paneKey}"]`);
      await expect(provisional).toBeVisible({ timeout: 15000 });

      // Type the message Pat would be halfway through.
      const typed = 'the thing i was in the middle of writing';
      await provisional.click();
      await page.locator('.ubar-input').fill(typed);
      await expect.poll(async () => composerText(page)).toBe(typed);

      // The transcript materializes: same window, new id.
      await page.evaluate(async ({ from, to }) => {
        await window.harbor.e2e.emitLaunched({
          sessionId: to, paneId: '%e2e-draft', cwd: '/tmp', account: 'personal',
          provider: 'claude', model: 'opus', effort: 'xhigh', replacesKey: from,
        });
      }, { from: paneKey, to: meta.id });

      // The window took the new id, and the text came with it. Exactly ONE
      // window holds it: this spec upgrades onto the id of a session it already
      // opened from the rail, which is the real shape of Pat reopening a
      // session while its launch is still provisional, and two windows claiming
      // one session is a broken state (two transcripts of one file, two
      // composers, two drafts).
      await expect(page.locator(`.win2[data-session-id="${meta.id}"]`)).toHaveCount(1, { timeout: 15000 });
      await expect(page.locator(`.win2[data-session-id="${meta.id}"]`)).toBeVisible({ timeout: 15000 });
      await expect(page.locator(`.win2[data-session-id="${paneKey}"]`)).toHaveCount(0);
      await expect.poll(async () => composerText(page), { timeout: 10000 }).toBe(typed);
    } finally {
      await closeHarbor(electronApp, page);
    }
  });

  // Live voice mode, wiring only. The suite deliberately does NOT open a real
  // voice call: it would cost money, need the network and make the gate depend
  // on a third party, so voice is disabled in a harness the same way the usage
  // fetch is (HARBOR_NO_VOICE, defaulted on under HARBOR_E2E). What is proven
  // here is that the control exists, that a refusal is surfaced rather than
  // swallowed, and that the tool surface handed to the model is the safe one.
  // The real conversation is verified by scripts/live-drive-voice.js, which has
  // been run against the live model.
  test('13) live voice mode has a control, and a refusal to start says so out loud', async () => {
    const { electronApp, page } = await launch();
    try {
      const button = page.locator('.compose-live-voice');
      await expect(button).toHaveCount(1);
      await expect(button).toHaveClass(/idle/);
      // It must not be mistakable for the dictation mic beside it.
      await expect(page.locator('.compose-mic')).toHaveCount(1);

      await button.click();
      // Disabled in a harness, so this is the refusal path, and it has to be
      // visible: a voice feature that fails silently is indistinguishable from
      // one that is listening.
      await expect(page.locator('.live-voice-bar')).toBeVisible({ timeout: 15000 });
      await expect(page.locator('.live-voice-bar')).toHaveClass(/error/);
      await expect(page.locator('.live-voice-bar')).toContainText('disabled');
      await expect(button).toHaveClass(/error/);
      await screenshot(page, '13-live-voice-refusal.png');

      // The tool surface the model would be given is the audited one, with no
      // way to close a window, kill a process or answer a permission prompt.
      const tools = await page.evaluate(() => window.__harborVoice?.toolNames
        || (window.__harborVoiceTools || null));
      if (tools) {
        expect(tools).toEqual([
          'harbor_list_sessions', 'harbor_read_session', 'harbor_send_to_session',
          'harbor_interrupt_session', 'harbor_select_session',
        ]);
      }
    } finally {
      await closeHarbor(electronApp, page);
    }
  });

  // The composer shows real bold and real bullets, but a terminal cannot
  // receive either: what has to be right is the MARKDOWN it serializes to. So
  // this drives the toolbar and the shortcuts the way Pat would and reads the
  // draft the send path would actually use, not the DOM it happens to build.
  test('12) the format toolbar and its shortcuts produce the markdown that gets sent', async () => {
    const { electronApp, page } = await launch();
    try {
      await page.locator('.rail-find').fill(SEARCH_QUERY);
      await page.waitForTimeout(600);
      const meta = await openFirstSession(page);
      console.log('format test picked session', meta.id);

      const input = page.locator('.ubar-input');
      await expect.poll(async () => composerEnabled(page)).toBe(true);

      // The toolbar is a toggle beside the mic (Pat, 2026-07-26: "just like MS
      // Teams"), closed until asked for.
      await expect(page.locator('.compose-format-bar')).toHaveCount(0);
      await page.locator('.compose-format-toggle').click();
      await expect(page.locator('.compose-format-bar')).toBeVisible();

      // Toolbar bold: type, select, click B.
      await input.click();
      await input.type('make the send path bold');
      await page.keyboard.press('Control+A');
      await page.locator('.compose-format-btn.fmt-bold').click();
      await expect.poll(async () => composerDraft(page)).toBe('**make the send path bold**');
      // Real bold on screen, not asterisks: the whole point of WYSIWYG.
      await expect(input.locator('b, strong')).toHaveCount(1);
      await expect.poll(async () => composerText(page)).toBe('make the send path bold');

      // Keyboard bold, on the key that used to hide the rail.
      await page.keyboard.press('Control+A');
      await page.keyboard.press('Control+b');
      await expect.poll(async () => composerDraft(page)).toBe('make the send path bold');
      // ...and the rail did NOT toggle, because Ctrl+B is the composer's now.
      await expect(page.locator('.rail')).toBeVisible();

      // Press-type-press with NOTHING selected, which is how formatting is
      // actually used mid-sentence. This runs on Chromium's pending typing
      // style, which is discarded by any touch of the selection: restoring the
      // caret around inline marks silently dropped the formatting here while
      // every select-then-format case above still passed (live-caught
      // 2026-07-26 by reading the markdown, not the screen).
      await clearComposer(page, input);
      await input.type('Refactor the ');
      await page.keyboard.press('Control+b');
      await input.type('send path');
      await page.keyboard.press('Control+b');
      await input.type(' and the ');
      await page.keyboard.press('Control+i');
      await input.type('resume');
      await page.keyboard.press('Control+i');
      await input.type(' fallback');
      await expect.poll(async () => composerDraft(page))
        .toBe('Refactor the **send path** and the *resume* fallback');

      // Bulleted list through the toolbar, continued with Shift+Enter.
      await clearComposer(page, input);
      await input.type('first item');
      await page.locator('.compose-format-btn.fmt-bullets').click();
      await input.press('Shift+Enter');
      await input.type('second item');
      await expect.poll(async () => composerDraft(page)).toBe('- first item\n- second item');
      await expect(input.locator('ul li')).toHaveCount(2);

      // Numbered list renumbers rather than repeating "1.".
      await clearComposer(page, input);
      await input.type('alpha');
      await page.keyboard.press('Control+Shift+Digit7');
      await input.press('Shift+Enter');
      await input.type('beta');
      await expect.poll(async () => composerDraft(page)).toBe('1. alpha\n2. beta');

      // Underline has no markdown form at all, so it must arrive as the inline
      // HTML the model can still read.
      await clearComposer(page, input);
      await input.type('underlined');
      await page.keyboard.press('Control+A');
      await page.keyboard.press('Control+u');
      await expect.poll(async () => composerDraft(page)).toBe('<u>underlined</u>');

      // Marks nest in a fixed order regardless of the order they were applied,
      // so the same set of marks always produces the same markdown.
      await page.keyboard.press('Control+A');
      await page.keyboard.press('Control+Shift+X');
      await expect.poll(async () => composerDraft(page)).toBe('<u>~~underlined~~</u>');

      // Clearing the composer clears its formatting. Chromium keeps a pending
      // typing style after the text is gone, so emptying an underlined draft
      // and typing again silently produced underlined text in a box that
      // looked blank (live-caught 2026-07-26). The toolbar must go dark too.
      await input.click();
      await page.keyboard.press('Control+A');
      await page.keyboard.press('Delete');
      await expect(page.locator('.compose-format-btn.on')).toHaveCount(0);
      await input.type('plain again');
      await expect.poll(async () => composerDraft(page)).toBe('plain again');

      // The remaining toolbar buttons, each asserted on the markdown it puts on
      // the wire. Driven because "the button exists" is not the claim; "the
      // agent receives the right characters" is.
      await clearComposer(page, input);
      await input.type('Section title');
      await page.locator('.compose-format-btn.fmt-heading').click();
      await expect.poll(async () => composerDraft(page)).toBe('## Section title');

      await clearComposer(page, input);
      await input.type('quoted line');
      await page.locator('.compose-format-btn.fmt-quote').click();
      await expect.poll(async () => composerDraft(page)).toBe('> quoted line');

      await clearComposer(page, input);
      await input.type('npm test');
      await page.locator('.compose-format-btn.fmt-codeblock').click();
      await expect.poll(async () => composerDraft(page)).toBe('```\nnpm test\n```');

      // Inline code is the one mark with no execCommand behind it, so it is
      // hand-rolled and worth driving over a partial selection.
      await clearComposer(page, input);
      await input.type('run runSend now');
      await selectRange(page, 4, 11);
      await page.locator('.compose-format-btn.fmt-code').click();
      await expect.poll(async () => composerDraft(page)).toBe('run `runSend` now');

      await clearComposer(page, input);
      await input.type('see the docs');
      await selectRange(page, 4, 12);
      await page.locator('.compose-format-btn.fmt-link').click();
      await page.locator('.compose-link-field input').fill('https://example.com');
      await page.locator('.compose-link-field button').click();
      await expect.poll(async () => composerDraft(page)).toBe('see [the docs](https://example.com)');

      await clearComposer(page, input);
      await input.type('bolded');
      await page.keyboard.press('Control+A');
      await page.keyboard.press('Control+b');
      await expect.poll(async () => composerDraft(page)).toBe('**bolded**');
      await page.keyboard.press('Control+A');
      await page.locator('.compose-format-btn.fmt-clear').click();
      await expect.poll(async () => composerDraft(page)).toBe('bolded');

      // Pasting from a styled source must not drag that source's markup into a
      // message bound for a terminal: the text/plain flavour wins outright.
      await clearComposer(page, input);
      await page.evaluate(() => {
        const el = document.querySelector('.ubar-input');
        el.focus();
        const transfer = new DataTransfer();
        transfer.setData('text/plain', 'pasted plain');
        transfer.setData('text/html', '<b style="color:red">pasted styled</b>');
        el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
      });
      await expect.poll(async () => composerDraft(page)).toBe('pasted plain');
      await expect(input.locator('b, strong')).toHaveCount(0);

      await clearComposer(page, input);
      await input.type('Refactor the ');
      await page.keyboard.press('Control+b');
      await input.type('send path');
      await page.keyboard.press('Control+b');
      await input.type(' so it:');
      await screenshot(page, 'compose-format-toolbar.png');

      // Enter still submits rather than making a new bullet: send muscle
      // memory outranks list ergonomics.
      await clearComposer(page, input);
      await input.type('one');
      await page.locator('.compose-format-btn.fmt-bullets').click();
      await input.press('Enter');
      await expect(input.locator('li')).toHaveCount(1, 'Enter submitted, it did not add a bullet');

      // The toggle survives a reload, the way Teams remembers it.
      expect(await page.evaluate(() => window.localStorage.getItem('harbor-compose-format'))).toBe('1');
    } finally {
      await closeHarbor(electronApp, page);
    }
  });

  // Live-caught 2026-07-26, and it cost Pat ninety minutes: every gate run
  // popped a GNOME file chooser on his real desktop. Electron does not draw
  // showOpenDialog itself, it calls org.freedesktop.portal.FileChooser over the
  // SESSION BUS, and `env -u DISPLAY xvfb-run` isolates X11 and nothing else,
  // so the picker walked out of the harness and then BLOCKED the main process
  // waiting for an answer nobody on the test side could give.
  //
  // Proven two-sided on purpose. A refusal alone would also pass if the click
  // never reached the picker at all, so the same button is driven with a
  // harness-supplied answer to show it genuinely gets there.
  test('12c) an isolated Harbor refuses a native file picker, and the same click proves the picker was reachable', async () => {
    const PICKED = '/tmp/harbor-e2e-fake-picked';

    // ── refusal side: no answer supplied, so the real picker would be needed ──
    {
      const { electronApp, page } = await launch();
      try {
        const refusal = await page.evaluate(async () => {
          try {
            await window.harbor.session.pickFolder();
            return { threw: false, message: '' };
          } catch (error) {
            return { threw: true, message: String(error?.message || error) };
          }
        });
        expect(refusal.threw).toBe(true);
        expect(refusal.message).toMatch(/refusing to open a native file dialog/);
        // The reason must name the mechanism, or the next person "fixes" this
        // by scrubbing DISPLAY again and watches it escape anyway.
        expect(refusal.message).toMatch(/SESSION BUS/);
        expect(refusal.message).toMatch(/HARBOR_ALLOW_REAL_DIALOGS=1/);

        // Driven as a user: the rail-head +P walks a folder picker first, so it
        // must dead-end here rather than opening anything.
        await page.locator('.sidebar-global-new.personal').click();
        await page.waitForTimeout(1200);
        await expect(page.getByRole('dialog', { name: 'Session configuration' })).toHaveCount(0);
      } finally {
        await closeHarbor(electronApp, page);
      }
    }

    // ── reachability side: the SAME click, with the answer supplied ──
    {
      const { electronApp, page } = await launch({ HARBOR_E2E_FAKE_DIALOG: PICKED });
      try {
        expect(await page.evaluate(() => window.harbor.session.pickFolder())).toBe(PICKED);
        await page.locator('.sidebar-global-new.personal').click();
        // The config popover only opens once a folder came back, so seeing it
        // proves the click really does run the picker: the refusal above was
        // the guard doing its job, not the drive missing the path.
        await expect(page.getByRole('dialog', { name: 'Session configuration' })).toBeVisible({ timeout: 10000 });
      } finally {
        await closeHarbor(electronApp, page);
      }
    }
  });

  // Right-click correction, driven end to end. The dictionary is a one-time
  // download, so suggestions cannot be guaranteed inside a hermetic run; what
  // IS guaranteed is that the menu path works, which is asserted by pushing a
  // real model through the real IPC and clicking the real row.
  test('12b) right-clicking a misspelling offers corrections that rewrite the draft', async () => {
    // The only spec that wants a real dictionary. It is off for every other
    // launch so the suite does not fetch a .bdic ~34 times per run.
    const { electronApp, page } = await launch({ HARBOR_E2E_SPELLCHECK: '1' });
    try {
      await page.locator('.rail-find').fill(SEARCH_QUERY);
      await page.waitForTimeout(600);
      await openFirstSession(page);

      let status = await page.evaluate(() => window.harbor.contextMenu.spellStatus());
      expect(status.enabled).toBe(true);
      expect(status.languages).toContain('en-US');

      // The .bdic is fetched once per profile and E2E uses a throwaway one, so
      // wait for it rather than racing it.
      for (let i = 0; i < 40 && !status.dictionary.downloaded; i += 1) {
        await page.waitForTimeout(500);
        status = await page.evaluate(() => window.harbor.contextMenu.spellStatus());
      }

      const input = page.locator('.ubar-input');
      await input.click();
      await input.type('teh quick brown fox');

      // Chromium only reports a misspelling through the context-menu event, so
      // a real right-click is the only honest driver for the menu itself. The
      // marker lands asynchronously after the spellchecker sweeps, so the
      // OBSERVATION is retried; the outcome is not.
      let suggestions = [];
      for (let attempt = 0; attempt < 6 && !suggestions.length; attempt += 1) {
        await page.waitForTimeout(700);
        await input.click({ button: 'right', position: { x: 14, y: 22 } });
        await page.locator('.ctxmenu').waitFor({ state: 'visible', timeout: 8000 });
        suggestions = await page.locator('.ctxmenu-suggestion').allInnerTexts();
        if (!suggestions.length) {
          await page.keyboard.press('Escape');
          await expect(page.locator('.ctxmenu')).toHaveCount(0);
        }
      }

      if (!suggestions.length) {
        // No dictionary on this machine: say so rather than passing quietly.
        console.log('[spellcheck] no dictionary available; suggestion rows skipped');
        expect(status.dictionary.downloaded).toBe(false);
      } else {
        expect(suggestions).toContain('the');
        await page.locator('.ctxmenu-suggestion', { hasText: /^the$/ }).first().click();
        await expect.poll(async () => composerText(page)).toBe('the quick brown fox');
      }
      await expect(page.locator('.ctxmenu')).toHaveCount(0);
    } finally {
      await closeHarbor(electronApp, page);
    }
  });

  test('command bar pastes an image as an attachment chip and grows for a multiline send', async () => {
    const pastePath = '/tmp/harbor-e2e-pasted-image.png';
    const { electronApp, page } = await launch({ HARBOR_E2E_CLIPBOARD_PATH: pastePath });
    try {
      await page.locator('.rail-find').fill(SEARCH_QUERY);
      await page.waitForTimeout(600);
      const meta = await openFirstSession(page);
      console.log('paste test picked session', meta.id);

      const input = page.locator('.ubar-input');
      // A contenteditable since 2026-07-26, so the composer can show real bold
      // and real bullets while still sending markdown.
      await expect(input).toHaveJSProperty('tagName', 'DIV');
      await expect(input).toHaveAttribute('contenteditable', 'true');
      // A watch-only (outside-live) candidate disables the bar and paste is a
      // designed no-op; fail HERE with the real reason, not at the chip wait.
      await expect.poll(async () => composerEnabled(page)).toBe(true);
      await input.evaluate((element) => {
        const transfer = new DataTransfer();
        transfer.items.add(new File([Uint8Array.from([1, 2, 3])], 'shot.png', { type: 'image/png' }));
        element.dispatchEvent(new ClipboardEvent('paste', {
          bubbles: true,
          cancelable: true,
          clipboardData: transfer,
        }));
      });
      // A pasted image becomes a thumbnail ATTACHMENT chip, NOT path text.
      await page.waitForSelector('.compose-attachments .image-chip', { timeout: 5000 });
      await expect.poll(async () => composerText(page)).toBe('');
      expect(await page.locator('.image-chip button').count()).toBe(1);
      // Remove clears it.
      await page.locator('.image-chip button').first().click();
      expect(await page.locator('.image-chip').count()).toBe(0);

      await input.fill('first line');
      const oneRowHeight = await input.evaluate((element) => element.getBoundingClientRect().height);
      await input.press('Shift+Enter');
      await input.type('second line');
      await expect.poll(async () => composerText(page)).toBe('first line\nsecond line');
      // A contenteditable grows on its own now (the JS auto-grow is gone), so
      // this proves the CSS actually lets it, not that an effect fired.
      await expect.poll(async () => input.evaluate((el) => el.getBoundingClientRect().height))
        .toBeGreaterThan(oneRowHeight);
      await screenshot(page, 'command-bar-multiline.png');

      // Enter (no Shift) is bound to submit and must NOT insert a newline.
      // (That a successful send clears the input is covered by the live-send
      // test; this opened session has no drivable pane, so it cannot send.)
      await input.press('Enter');
      await expect.poll(async () => composerText(page)).toBe('first line\nsecond line');
    } finally {
      await closeHarbor(electronApp, page);
    }
  });

  test('7) orchestration panel renders real queue read-only and mutex refusal path', async () => {
    const { electronApp, page } = await launch({
      CLAUDE_DELEGATE_DRY_RUN: '1',
    });
    try {
      await page.evaluate(async () => {
        const state = await window.harbor.sidebar.getState();
        const project = (state.model.projects || []).find((p) => p.label === 'harbor');
        if (!project) throw new Error('harbor project missing');
        window.__openOrchForTest(project);
      });

      await page.waitForSelector('.orch-panel', { timeout: 15000 });
      await page.waitForTimeout(1500);

      const orchData = await page.evaluate(async () => {
        const state = await window.harbor.sidebar.getState();
        const project = (state.model.projects || []).find((p) => p.label === 'harbor');
        const sessionId = project?.sessions?.find((s) => !s.isWindowsEra)?.id;
        return window.harbor.orchestration.getData({
          projectLabel: 'harbor',
          sessionId,
        });
      });

      const delegate = createDelegateProvider();
      const realQueue = await delegate.getQueue(orchData.projectRoot || '/home/you/dev/harbor');
      const uiBatchCount = await page.locator('.orch-batch-card').count();
      const expectedBatches = (realQueue?.batches || []).length;
      if (expectedBatches > 0) {
        expect(uiBatchCount).toBe(expectedBatches);
      } else {
        expect(await page.locator('.orch-empty').count()).toBeGreaterThan(0);
      }

      await screenshot(page, '09-orch-panel.png');

      await page.evaluate(() => {
        window.__forceOrchMutex('An orchestrate-execution session is already open in this workspace.');
      });
      await page.waitForTimeout(400);
      await expect(page.locator('.orch-mutex-reason')).toContainText('orchestrate-execution');
      await expect(page.locator('.orch-execute-btn')).toBeDisabled();

      await screenshot(page, '10-orch-mutex-refusal.png');
    } finally {
      await closeHarbor(electronApp, page);
    }
  });

  test('22) the Orch picker hides the throwaway lane worktrees the rail already hides', async () => {
    const { electronApp, page } = await launch();
    try {
      await page.locator('.view-switch-btn', { hasText: 'Orch' }).click();
      await page.waitForSelector('.orch-picker', { timeout: 15000 });
      const labels = await page.$$eval('.orch-picker-label', (els) => els.map((el) => el.textContent.trim()));
      expect(labels.length).toBeGreaterThan(0);

      // claude-delegate creates one worktree per orchestration batch under
      // /tmp; the rail has filtered them for months and this picker never
      // learned, so choosing a project to orchestrate meant reading past 25
      // rows of litter from previous orchestrations to find 8 real projects.
      const litter = labels.filter((l) => /claude-delegate-lanes|^tmp[-/]/i.test(l));
      expect(litter, `lane worktrees in the picker: ${JSON.stringify(litter.slice(0, 8))}`).toEqual([]);

      // Two-sided: the real projects this machine definitely has must survive
      // the filter, or an over-broad rule would pass by emptying the list.
      expect(labels).toContain('harbor');
    } finally {
      await closeHarbor(electronApp, page);
    }
  });

  test('8) help overlay opens on F1 and closes on Escape', async () => {
    const { electronApp, page } = await launch();
    try {
      await page.keyboard.press('F1');
      await expect(page.locator('.help-panel')).toBeVisible();
      await screenshot(page, '11-help-overlay.png');
      await page.keyboard.press('Escape');
      await expect(page.locator('.help-panel')).toHaveCount(0);
    } finally {
      await closeHarbor(electronApp, page);
    }
  });

  test('9) notifications module unit-level check', async () => {
    const calls = [];
    const notifier = createNotifier({
      getFocusedPaneId: () => 'focused-pane',
      isWindowFocused: () => true,
      notify: (title, body) => calls.push([title, body]),
    });

    notifier.onAgentStatusChanged({
      event: 'pane.agent_status_changed',
      data: { pane_id: 'other-pane', agent_status: 'working', title: 'E2E session' },
    });
    notifier.onAgentStatusChanged({
      event: 'pane.agent_status_changed',
      data: { pane_id: 'other-pane', agent_status: 'idle', title: 'E2E session' },
    });
    notifier._flushNow();

    expect(calls.length).toBe(1);
    expect(calls[0].join(' ')).toMatch(/E2E session/);

    notifier.onAgentStatusChanged({
      event: 'pane.agent_status_changed',
      data: { pane_id: 'focused-pane', agent_status: 'working' },
    });
    notifier.onAgentStatusChanged({
      event: 'pane.agent_status_changed',
      data: { pane_id: 'focused-pane', agent_status: 'idle' },
    });
    notifier._flushNow();
    expect(calls.length).toBe(1);

    notifier.destroy();
  });

  test('perf) cold start and RSS with four conversation windows on real transcripts', async () => {
    const { electronApp, page } = await launch();
    try {
      const ids = await page.evaluate(async () => {
        const state = await window.harbor.sidebar.getState();
        const sessions = [];
        for (const proj of state.model.projects || []) {
          for (const s of proj.sessions || []) {
            if (!s.isWindowsEra && !s.isChildTask && !String(s.id).startsWith('live:')) sessions.push(s.id);
            if (sessions.length >= 4) break;
          }
          if (sessions.length >= 4) break;
        }
        return sessions;
      });
      expect(ids.length).toBe(4);
      for (const id of ids) {
        await page.evaluate((sessionId) => window.__harborOpenSession(sessionId), id);
      }
      await page.waitForFunction(() => document.querySelectorAll('.win2:not(.slot)').length === 4, null, { timeout: 20000 });
      await page.waitForTimeout(4000);

      const metrics = await readMetrics(page);
      expect(metrics.coldStartInteractiveMs).toBeGreaterThan(0);
      expect(metrics.coldStartInteractiveMs).toBeLessThan(60000);
      expect(metrics.rssMb).toBeGreaterThan(50);

      const lag = await page.evaluate(() => window.__harborLagReport?.() || null);
      const perfPath = path.join(APP_ROOT, 'verify', 'e2e', 'perf-snapshot.json');
      require('node:fs').writeFileSync(perfPath, JSON.stringify({
        coldStartInteractiveMs: metrics.coldStartInteractiveMs,
        rssMbWith4ConversationWindows: metrics.rssMb,
        rendererLag: lag,
        capturedAt: new Date().toISOString(),
      }, null, 2));
      if (lag) expect(lag.p95Ms).toBeLessThan(120);

      await screenshot(page, '12-perf-4windows.png');
    } finally {
      await closeHarbor(electronApp, page);
    }
  });

  test('10) adaptive grid: 6-window 3x2 and 9-window 3x3 layouts', async () => {
    const { electronApp, page } = await launch();
    try {
      const ids = await page.evaluate(async () => {
        const state = await window.harbor.sidebar.getState();
        const sessions = [];
        for (const proj of state.model.projects || []) {
          for (const s of proj.sessions || []) {
            if (!s.isWindowsEra && !s.isChildTask && !s.isLive && !String(s.id).startsWith('live:')) {
              if (s.lastActiveMs && Date.now() - s.lastActiveMs < 15 * 60 * 1000) continue;
              sessions.push(s.id);
            }
            if (sessions.length >= 9) break;
          }
          if (sessions.length >= 9) break;
        }
        return sessions;
      });
      expect(ids.length).toBeGreaterThanOrEqual(6);

      for (const id of ids.slice(0, 6)) {
        await page.evaluate((sessionId) => window.__harborOpenSession(sessionId), id);
      }
      await page.waitForFunction(() => document.querySelectorAll('.win2:not(.slot)').length === 6, null, { timeout: 20000 });
      await expect(page.locator('.grid4[data-grid-cols="3"][data-grid-rows="2"]')).toBeVisible();
      await screenshot(page, '13-grid-6windows.png');

      for (const id of ids.slice(6, 9)) {
        await page.evaluate((sessionId) => window.__harborOpenSession(sessionId), id);
      }
      await page.waitForFunction(() => document.querySelectorAll('.win2:not(.slot)').length === 9, null, { timeout: 20000 });
      await expect(page.locator('.grid4[data-grid-cols="3"][data-grid-rows="3"]')).toBeVisible();

      // Equal geometry: every tile in the grid shares the same cell size.
      const sizes = await page.$$eval('.win2:not(.slot)', (els) => els.map((el) => {
        const r = el.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height) };
      }));
      const first = sizes[0];
      for (const s of sizes) {
        expect(Math.abs(s.w - first.w)).toBeLessThanOrEqual(2);
        expect(Math.abs(s.h - first.h)).toBeLessThanOrEqual(2);
      }

      await screenshot(page, '14-grid-9windows.png');
    } finally {
      await closeHarbor(electronApp, page);
    }
  });

  test('11) drag placement: bottom-left window drops into the empty bottom-right cell (the Pat case)', async () => {
    const { electronApp, page } = await launch();
    try {
      const ids = await page.evaluate(async () => {
        const state = await window.harbor.sidebar.getState();
        const sessions = [];
        for (const proj of state.model.projects || []) {
          for (const s of proj.sessions || []) {
            if (!s.isWindowsEra && !s.isChildTask && !s.isLive && !String(s.id).startsWith('live:')) {
              if (s.lastActiveMs && Date.now() - s.lastActiveMs < 15 * 60 * 1000) continue;
              sessions.push(s.id);
            }
            if (sessions.length >= 3) break;
          }
          if (sessions.length >= 3) break;
        }
        return sessions;
      });
      expect(ids.length).toBe(3);
      for (const id of ids) {
        await page.evaluate((sessionId) => window.__harborOpenSession(sessionId), id);
      }
      await page.waitForFunction(() => document.querySelectorAll('.win2:not(.slot)').length === 3, null, { timeout: 15000 });

      // Three windows own cells 0,1,2 of a 2x2 grid; cell 3 is a hole.
      const mover = ids[2];
      const src = await page.locator(`.win2[data-session-id="${mover}"] .wh`).boundingBox();
      const hole = await page.locator('.win2.slot').first().boundingBox();
      expect(src && hole).toBeTruthy();

      // Human-speed drag of the bottom-left window into the bottom-right hole.
      await page.mouse.move(src.x + src.width / 2, src.y + 12);
      await page.mouse.down({ button: 'right' });
      const steps = 30;
      for (let i = 1; i <= steps; i += 1) {
        await page.mouse.move(
          src.x + src.width / 2 + ((hole.x + hole.width / 2) - (src.x + src.width / 2)) * (i / steps),
          src.y + 12 + ((hole.y + hole.height / 2) - (src.y + 12)) * (i / steps),
        );
        await page.waitForTimeout(15);
        if (i === 15) {
          // Mid-drag the lifted tile must be VISIBLE (it once dragged with
          // visibility:hidden, which read as nothing happening at all).
          const vis = await page.evaluate((id) => {
            const el = document.querySelector(`.win2[data-session-id="${id}"]`);
            return el ? getComputedStyle(el).visibility : 'missing';
          }, mover);
          expect(vis).toBe('visible');
        }
        if (i === 27) {
          // Deep inside the target cell the drop hint must be showing.
          await expect(page.locator('.drop-hint')).toBeVisible({ timeout: 2000 });
        }
      }
      await page.mouse.up({ button: 'right' });
      await page.waitForTimeout(300);

      // The window now OWNS cell 3; its old cell is a hole.
      await expect(page.locator(`.win2[data-session-id="${mover}"]`)).toHaveAttribute('data-slot', '3');

      // Swap case: drag it back onto the window in cell 0; the two swap.
      const occupant0 = ids[0];
      const a = await page.locator(`.win2[data-session-id="${mover}"] .wh`).boundingBox();
      const b = await page.locator(`.win2[data-session-id="${occupant0}"]`).boundingBox();
      await page.mouse.move(a.x + a.width / 2, a.y + 12);
      await page.mouse.down({ button: 'right' });
      for (let i = 1; i <= steps; i += 1) {
        await page.mouse.move(
          a.x + a.width / 2 + ((b.x + b.width / 2) - (a.x + a.width / 2)) * (i / steps),
          a.y + 12 + ((b.y + 12) - (a.y + 12)) * (i / steps),
        );
        await page.waitForTimeout(15);
      }
      await page.mouse.up({ button: 'right' });
      await page.waitForTimeout(300);
      await expect(page.locator(`.win2[data-session-id="${mover}"]`)).toHaveAttribute('data-slot', '0');
      await expect(page.locator(`.win2[data-session-id="${occupant0}"]`)).toHaveAttribute('data-slot', '3');

      // Placement survives reload.
      await page.evaluate(() => window.location.reload());
      await page.waitForSelector('.rail', { timeout: 20000 });
      await page.waitForFunction(() => document.querySelectorAll('.win2:not(.slot)').length === 3, null, { timeout: 20000 });
      await expect(page.locator(`.win2[data-session-id="${mover}"]`)).toHaveAttribute('data-slot', '0');
      await screenshot(page, '15-drag-placement-persist.png');
    } finally {
      await closeHarbor(electronApp, page);
    }
  });

  test('perf) frame lag with nine conversation windows', async () => {
    const { electronApp, page } = await launch();
    try {
      const ids = await page.evaluate(async () => {
        const state = await window.harbor.sidebar.getState();
        const sessions = [];
        for (const proj of state.model.projects || []) {
          for (const s of proj.sessions || []) {
            if (!s.isWindowsEra && !s.isChildTask && !String(s.id).startsWith('live:')) sessions.push(s.id);
            if (sessions.length >= 9) break;
          }
          if (sessions.length >= 9) break;
        }
        return sessions;
      });
      expect(ids.length).toBe(9);
      for (const id of ids) {
        await page.evaluate((sessionId) => window.__harborOpenSession(sessionId), id);
      }
      await page.waitForFunction(() => document.querySelectorAll('.win2:not(.slot)').length === 9, null, { timeout: 20000 });
      await page.waitForTimeout(4000);

      const lag = await page.evaluate(() => window.__harborLagReport?.() || null);
      expect(lag).toBeTruthy();
      expect(lag.p95Ms).toBeLessThan(120);

      await screenshot(page, '16-perf-9windows.png');
    } finally {
      await closeHarbor(electronApp, page);
    }
  });
});
