'use strict';

// Stage slide drive (2026-10-07): a real right-button drag on the stage, in a hidden
// Harbor on the repo's capture host (hidden, unfocusable, offscreen windows;
// isolated HOME/config/store under app/verify/harbor-*; demo corpus only).
// Five windows in a 3x2 grid, one empty cell:
//   1. drag the window in cell 1 into the empty cell 5: the windows after it
//      slide back, it lands in cell 4, cell 5 stays empty, no hole in the middle;
//   2. drag the last window (cell 4) into cell 5: it moves there (bottom-right);
//   3. drag the first window onto the window in cell 2: it takes cell 2 and the
//      two windows between slide back one place each (never a swap).
// Usage (from app/): node scripts/drive-stage-slide-win.js   (fails at the old
// swap-or-move rule on step 1, exactly the gap Pat reported). HARBOR_DRIVE_APP
// points it at another checkout; screenshots go to HARBOR_DRIVE_OUT.
const fs = require('node:fs');
const path = require('node:path');
const APP = process.env.HARBOR_DRIVE_APP || path.resolve(__dirname, '..');
const { captureEnv, hiddenMain, closeApp, assertHidden, reportIsolation } = require(`${APP}/scripts/lib/capture-runtime.cjs`);
const { prepareRoot, buildCorpus, buildConfig } = require(`${APP}/scripts/lib/demo-corpus.cjs`);
const { _electron: electron } = require(`${APP}/node_modules/@playwright/test`);
const OUT = process.env.HARBOR_DRIVE_OUT || path.join(require('node:os').tmpdir(), 'harbor-drive-stage-slide');

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const root = prepareRoot(path.join(APP, 'verify', 'harbor-stage-slide'));
  const isolated = captureEnv(root);
  const userData = path.join(root, 'userData');
  const cacheDir = path.join(root, 'cache');
  fs.mkdirSync(userData, { recursive: true }); fs.mkdirSync(cacheDir, { recursive: true });
  const corpus = buildCorpus(root);
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify(buildConfig(root, { projectsDir: corpus.projectsDir, home: corpus.home, cacheDir, userData }), null, 2));
  const ids = corpus.sessions.slice(0, 5).map((s) => String(s.id || s.sessionId));
  const facts = { ids };
  const problems = [];
  let app;
  try {
    app = await electron.launch({ executablePath: require(`${APP}/node_modules/electron`), args: [hiddenMain, `--user-data-dir=${userData}`], cwd: APP, timeout: 120000, env: { ...isolated, HARBOR_SHOT_ROOT: root } });
    const page = await app.firstWindow({ timeout: 60000 });
    page.setDefaultTimeout(30000);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1500, 900));
    await assertHidden(app);
    await page.waitForSelector('.rail', { timeout: 60000 });
    await page.evaluate((tiles) => { localStorage.setItem('harbor-slate-stage', JSON.stringify({ tiles, selectedId: tiles[0].sessionId })); localStorage.setItem('harbor-view', 'agents'); location.reload(); }, ids.map((sessionId, slot) => ({ sessionId, slot })));
    await page.waitForFunction((n) => document.querySelectorAll('.win2[data-session-id]').length === n, ids.length, { timeout: 60000 });
    await page.waitForTimeout(1500);
    const layout = () => page.evaluate(() => {
      const grid = document.querySelector('.grid4');
      return { cols: Number(grid.dataset.gridCols), rows: Number(grid.dataset.gridRows),
        stored: JSON.parse(localStorage.getItem('harbor-slate-stage')).tiles.map((t) => [t.sessionId, t.slot]) };
    });
    const slotOf = (l) => Object.fromEntries(l.stored);
    const cellCenter = (l, cell) => page.evaluate(({ cols, rows, cell }) => {
      const grid = document.querySelector('.grid4').getBoundingClientRect();
      const col = cell % cols; const row = Math.floor(cell / cols);
      return { x: grid.left + (col + 0.5) * grid.width / cols, y: grid.top + (row + 0.5) * grid.height / rows };
    }, { cols: l.cols, rows: l.rows, cell });
    const drag = async (sessionId, toCell, l) => {
      const from = await page.locator(`.win2[data-session-id="${sessionId}"] .ti`).first().boundingBox();
      const to = await cellCenter(l, toCell);
      await page.mouse.move(from.x + 20, from.y + from.height / 2);
      await page.mouse.down({ button: 'right' });
      for (let i = 1; i <= 12; i += 1) { await page.mouse.move(from.x + 20 + (to.x - from.x - 20) * i / 12, from.y + from.height / 2 + (to.y - from.y - from.height / 2) * i / 12); await page.waitForTimeout(30); }
      await page.waitForTimeout(150);
      await page.mouse.up({ button: 'right' });
      await page.waitForTimeout(800);
    };
    let l = await layout();
    facts.before = l;
    await page.screenshot({ path: path.join(OUT, '1-before.png') });
    if (l.cols * l.rows !== 6) problems.push(`expected a 3x2 grid, got ${l.cols}x${l.rows}`);

    await drag(ids[1], 5, l);
    l = await layout();
    facts.afterSlide = l;
    await page.screenshot({ path: path.join(OUT, '2-after-drag-second-to-empty-cell.png') });
    const s1 = slotOf(l);
    const want1 = { [ids[0]]: 0, [ids[2]]: 1, [ids[3]]: 2, [ids[4]]: 3, [ids[1]]: 4 };
    if (JSON.stringify(Object.keys(want1).map((k) => s1[k])) !== JSON.stringify(Object.values(want1))) problems.push(`slide: got ${JSON.stringify(s1)}`);
    facts.holesAfterSlide = await page.evaluate(() => document.querySelectorAll('.grid4 > .new-session-slot, .grid4 .ns-slot').length);

    await drag(ids[1], 5, l);
    l = await layout();
    facts.afterCorner = l;
    await page.screenshot({ path: path.join(OUT, '3-after-last-window-to-corner.png') });
    const s2 = slotOf(l);
    if (s2[ids[1]] !== 5 || s2[ids[4]] !== 3) problems.push(`corner: got ${JSON.stringify(s2)}`);

    await drag(ids[0], 2, l);
    l = await layout();
    facts.afterOnto = l;
    await page.screenshot({ path: path.join(OUT, '4-after-first-onto-third.png') });
    const s3 = slotOf(l);
    const want3 = { [ids[2]]: 0, [ids[3]]: 1, [ids[0]]: 2, [ids[4]]: 3, [ids[1]]: 5 };
    if (JSON.stringify(Object.keys(want3).map((k) => s3[k])) !== JSON.stringify(Object.values(want3))) problems.push(`onto a window: got ${JSON.stringify(s3)}`);
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
