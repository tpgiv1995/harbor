'use strict';

// Link-freeze drive (2026-10-09, Pat: a window frozen on a 10:40 PM reply
// while the session's terminal showed three more answers). One click on a link
// in a conversation released EVERY open window's transcript reader, because
// Electron fires did-start-navigation before will-navigate refuses the link and
// the release read "a navigation started" as "the page is reloading". The page
// never reloaded, so nothing asked for the readers again and every window froze.
//
// Hidden Harbor on the repo's capture host (hidden, unfocusable, offscreen
// windows; isolated HOME/config/store under app/verify/harbor-*; demo corpus
// only; shell.openExternal stubbed and link opens RECORDED, never performed).
// One conversation window whose transcript ends on a reply with links, then:
//   1. a navigation the guard refuses (the page sets location.href to a web
//      address): the page must survive AND a reply written to the transcript
//      afterwards must appear in the window;
//   2. after a real reload, a real mouse click on a link in the conversation:
//      the page must survive, the link must be handed to the browser opener,
//      and a later reply must again appear in the window.
// Usage (from app/): node scripts/drive-link-freeze-win.js
// HARBOR_DRIVE_APP points it at another checkout (the pre-fix code fails both
// "later reply appears" checks); screenshots go to HARBOR_DRIVE_OUT.
const fs = require('node:fs');
const path = require('node:path');
const APP = process.env.HARBOR_DRIVE_APP || path.resolve(__dirname, '..');
const { captureEnv, hiddenMain, closeApp, assertHidden, reportIsolation } = require(`${APP}/scripts/lib/capture-runtime.cjs`);
const { prepareRoot, buildCorpus, buildConfig } = require(`${APP}/scripts/lib/demo-corpus.cjs`);
const { _electron: electron } = require(`${APP}/node_modules/@playwright/test`);
const OUT = process.env.HARBOR_DRIVE_OUT || path.join(require('node:os').tmpdir(), 'harbor-drive-link-freeze');
const LINK = 'https://example.com/harbor-link-drive';
const REPLY_WAIT_MS = 15000;

function assistantLine(session, text, at = new Date()) {
  return JSON.stringify({
    uuid: `drive-${at.getTime()}-${Math.random().toString(16).slice(2, 10)}`,
    sessionId: session.id,
    cwd: session.cwd,
    timestamp: at.toISOString(),
    type: 'assistant',
    message: { role: 'assistant', model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text }] },
  });
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const root = prepareRoot(path.join(APP, 'verify', 'harbor-link-freeze'));
  const isolated = captureEnv(root);
  const userData = path.join(root, 'userData');
  const cacheDir = path.join(root, 'cache');
  fs.mkdirSync(userData, { recursive: true }); fs.mkdirSync(cacheDir, { recursive: true });
  const corpus = buildCorpus(root);
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify(buildConfig(root, { projectsDir: corpus.projectsDir, home: corpus.home, cacheDir, userData }), null, 2));
  const session = corpus.sessions.find((s) => (s.provider || 'claude') === 'claude');
  const id = String(session.id);
  fs.appendFileSync(session.file, `${assistantLine(session, `The two counties each have a free records search.\n\nSources:\n\n- [Example portal](${LINK})\n- [Second source](https://example.org/second)`, new Date(Date.now() - 60000))}\n`);
  const facts = { session: id };
  const problems = [];
  let app;
  try {
    app = await electron.launch({ executablePath: require(`${APP}/node_modules/electron`), args: [hiddenMain, `--user-data-dir=${userData}`], cwd: APP, timeout: 120000, env: { ...isolated, HARBOR_SHOT_ROOT: root } });
    const page = await app.firstWindow({ timeout: 60000 });
    page.setDefaultTimeout(30000);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1400, 900));
    await assertHidden(app);
    await page.waitForSelector('.rail', { timeout: 60000 });
    await page.evaluate((sessionId) => {
      localStorage.setItem('harbor-slate-stage', JSON.stringify({ tiles: [{ sessionId, slot: 0 }], selectedId: sessionId }));
      localStorage.setItem('harbor-view', 'agents');
      location.reload();
    }, id);
    const tile = `.win2[data-session-id="${id}"]`;
    const link = `${tile} a[href="${LINK}"]`;
    await page.waitForSelector(link, { timeout: 60000 });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(OUT, '1-window-with-links.png') });
    facts.linkAttrs = await page.$eval(link, (a) => ({ target: a.getAttribute('target'), rel: a.getAttribute('rel'), title: a.getAttribute('title') }));

    // A reply written after the action must reach the window: the reader is alive.
    const replyAppears = async (label) => {
      const text = `Drive reply ${label} ${Date.now()}`;
      fs.appendFileSync(session.file, `${assistantLine(session, text)}\n`);
      try {
        await page.waitForFunction(({ sel, want }) => (document.querySelector(sel)?.textContent || '').includes(want), { sel: tile, want: text }, { timeout: REPLY_WAIT_MS });
        return true;
      } catch { return false; }
    };
    const pageSurvived = async () => page.evaluate(() => window.__driveMarker === 'alive').catch(() => false);

    // 1. A navigation the main-process guard refuses.
    await page.evaluate((url) => { window.__driveMarker = 'alive'; location.href = url; }, 'https://example.com/elsewhere');
    await page.waitForTimeout(1200);
    facts.refusedNavigation = { pageSurvived: await pageSurvived() };
    facts.refusedNavigation.laterReplyShown = await replyAppears('after a refused navigation');
    await page.screenshot({ path: path.join(OUT, '2-after-refused-navigation.png') });
    if (!facts.refusedNavigation.pageSurvived) problems.push('the refused navigation replaced the page');
    if (!facts.refusedNavigation.laterReplyShown) problems.push(`after a refused navigation the window never showed a new reply within ${REPLY_WAIT_MS / 1000}s (frozen)`);

    // A real reload in between, so step 2 starts from fresh readers whatever
    // step 1 did. A reload must also keep the window live.
    await page.reload();
    await page.waitForSelector(link, { timeout: 60000 });
    await page.waitForTimeout(1000);
    facts.afterReloadReplyShown = await replyAppears('after a reload');
    if (!facts.afterReloadReplyShown) problems.push('after a real reload the window never showed a new reply');

    // 2. A real mouse click on a link in the conversation.
    await page.evaluate(() => { window.__driveMarker = 'alive'; });
    const callsBefore = (await page.evaluate(() => window.harbor.e2e.getLaunchCalls())).length;
    // A raw mouse click: locator.click() waits for the navigation the old code
    // starts, and that navigation is refused, so it would never finish.
    await page.locator(link).scrollIntoViewIfNeeded();
    const box = await page.locator(link).boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(1200);
    const calls = await page.evaluate(() => window.harbor.e2e.getLaunchCalls());
    facts.linkClick = {
      pageSurvived: await pageSurvived(),
      opened: calls.slice(callsBefore).filter((c) => c.command === 'open-external').map((c) => c.argv[0]),
    };
    facts.linkClick.laterReplyShown = await replyAppears('after a link click');
    await page.screenshot({ path: path.join(OUT, '3-after-link-click.png') });
    if (!facts.linkClick.pageSurvived) problems.push('the link click replaced the page');
    if (JSON.stringify(facts.linkClick.opened) !== JSON.stringify([LINK])) problems.push(`the link was not handed to the browser opener exactly once: ${JSON.stringify(facts.linkClick.opened)}`);
    if (!facts.linkClick.laterReplyShown) problems.push(`after a link click the window never showed a new reply within ${REPLY_WAIT_MS / 1000}s (frozen)`);
  } catch (error) {
    problems.push(error.message);
  } finally {
    await closeApp(app).catch((e) => problems.push(`teardown: ${e.message}`));
    try { reportIsolation(root); } catch (e) { problems.push(e.message); }
  }
  fs.writeFileSync(path.join(OUT, 'facts.json'), JSON.stringify({ facts, problems }, null, 2));
  console.log(JSON.stringify(facts));
  console.log(problems.length ? `FAIL: ${problems.join('; ')}` : 'PASS');
  process.exit(problems.length ? 1 : 0);
})();
