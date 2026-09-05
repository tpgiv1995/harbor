'use strict';

// Windows prod-drive for the rail's sort / project-filter / collapse-all
// controls (Pat, 2026-08-25). Same posture as drive-artifacts-win.js: an
// ISOLATED Harbor instance (tmp userData so every isolation guard engages, tmp
// caches, no daemon start), the REAL transcript corpus read-only, the window
// parked off the visible desktop without activating it, driven over CDP.
//
// It exists because the unit suite cannot see a control: it can prove the sort
// comparator and the collapse plan, and it still cannot tell you the chip
// overflowed the rail or that clicking it changed nothing. The Linux e2e
// harness runs on no machine, so this is the proof.
//
// Usage: node scripts/drive-rail-controls-win.js   (from app/)
// Writes screenshots and a verdict to %TEMP%\harbor-drive-rail\

const { spawn, execSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP_DIR = path.resolve(__dirname, '..');
const ELECTRON = path.join(APP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT = 9334;
const OUT = path.join(os.tmpdir(), 'harbor-drive-rail');

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function fetchJson(url) {
  const res = await fetch(url);
  return res.json();
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error(`page threw: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description || ''}`);
    }
    return r.result.value;
  }

  async shot(name) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(OUT, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    return file;
  }
}

async function waitFor(cdp, expression, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await cdp.eval(expression);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await sleep(250);
  }
}

// The rail is VIRTUALIZED: only the rows in the viewport exist in the DOM, so
// reading `.pg-label` gives a window, not the order. Scroll the list end to end
// and accumulate in first-seen order to get the real one. Callers collapse
// every project first, so the accumulated list is projects and nothing else.
const READ_ALL_PROJECTS = `(async () => {
  const list = document.querySelector('.sidebar-virtual-list');
  const seen = [];
  const sweep = () => {
    for (const item of document.querySelectorAll('.sidebar-virtual-item')) {
      const label = item.querySelector('.pg-label');
      if (!label) continue;
      const text = label.textContent.trim();
      if (!seen.includes(text)) seen.push(text);
    }
  };
  const settle = () => new Promise((r) => setTimeout(r, 140));
  list.scrollTop = 0;
  await settle();
  sweep();
  let guard = 0;
  while (list.scrollTop + list.clientHeight < list.scrollHeight - 1 && guard < 200) {
    list.scrollTop += Math.max(120, list.clientHeight * 0.75);
    guard += 1;
    await settle();
    sweep();
  }
  list.scrollTop = 0;
  await settle();
  return seen;
})()`;

// Click by visible text inside a container, the way a human picks a menu row.
const clickText = (selector, text) => `(() => {
  const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
    .find((n) => n.textContent.trim().startsWith(${JSON.stringify(text)}));
  if (!el) return false;
  el.click();
  return true;
})()`;

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-rail-drive-'));
  const userData = path.join(tmp, 'userData');
  fs.mkdirSync(userData, { recursive: true });

  const realConfig = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.harbor', 'config.json'), 'utf8'));
  const cacheDir = path.join(tmp, 'cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  realConfig.paths = {
    ...realConfig.paths,
    cacheDir,
    tasksFile: path.join(tmp, 'tasks.json'),
    projectIconsDir: path.join(tmp, 'project-icons'),
  };
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify(realConfig, null, 2));

  const env = {
    ...process.env,
    HARBOR_E2E: '1',
    HARBOR_E2E_USER_DATA: userData,
    HARBOR_NO_DAEMON_START: '1',
    HARBOR_SESSIOND_DIR: path.join(tmp, 'sessiond'),
    HARBOR_CONTEXT_DIR: path.join(tmp, 'context'),
    HARBOR_NO_ICON_GEN: '1',
    HARBOR_NO_USAGE_FETCH: '1',
    HARBOR_NO_TITLER: '1',
  };
  const child = spawn(ELECTRON, [APP_DIR, `--remote-debugging-port=${PORT}`, '--no-focus-steal'], {
    env, stdio: 'ignore', detached: false,
  });

  const results = [];
  const fail = [];
  const check = (ok, message) => { if (!ok) fail.push(message); };

  try {
    let target = null;
    for (let i = 0; i < 60 && !target; i += 1) {
      await sleep(500);
      try {
        const list = await fetchJson(`http://127.0.0.1:${PORT}/json/list`);
        target = list.find((t) => t.type === 'page' && !/devtools/.test(t.url));
      } catch { /* not listening yet */ }
    }
    if (!target) throw new Error('CDP target never appeared');
    const connect = (url) => new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.addEventListener('open', () => resolve(socket));
      socket.addEventListener('error', () => reject(new Error('ws failed')));
    });
    const cdp = new Cdp(await connect(target.webSocketDebuggerUrl));
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    // Park the window off the visible desktop WITHOUT activating it
    // (SWP_NOACTIVATE|SWP_NOZORDER). Never over the game, no exceptions.
    execSync(`powershell -NoProfile -Command "Add-Type -Name W -Namespace P -MemberDefinition '[DllImport(\\"user32.dll\\")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int cy, uint f);'; $p = Get-Process -Id ${child.pid} -ErrorAction SilentlyContinue; if ($p -and $p.MainWindowHandle -ne 0) { [P.W]::SetWindowPos($p.MainWindowHandle, [IntPtr]::Zero, -4200, 100, 2560, 1600, 0x0014) }"`, { stdio: 'ignore' });

    await waitFor(cdp, "document.querySelector('.rail-list-controls') ? true : false", 'the new rail controls row');
    // Widen the window to the geometry the rail is tuned for, then let the
    // corpus land: "All" so there are enough projects to sort and filter.
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 2560, height: 1600, deviceScaleFactor: 1, mobile: false,
    });
    await cdp.eval(clickText('.sidebar-filter-chip', 'All'));
    await waitFor(cdp, "document.querySelectorAll('.pg-label').length > 3", 'projects in the rail');
    await sleep(600);
    await cdp.shot('1-controls-row');

    // ── Layout: nothing overflows the rail, at the width it is tuned for ──
    const layout = await cdp.eval(`(() => {
      const row = document.querySelector('.rail-list-controls');
      const rail = document.querySelector('.rail');
      const box = row.getBoundingClientRect();
      const railBox = rail.getBoundingClientRect();
      const kids = [...row.children].map((el) => {
        const r = el.getBoundingClientRect();
        return { cls: el.className, left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width) };
      });
      return {
        railWidth: Math.round(railBox.width),
        rowWidth: Math.round(box.width),
        scrollWidth: row.scrollWidth,
        clientWidth: row.clientWidth,
        rowHeight: Math.round(box.height),
        insideRail: kids.every((k) => k.right <= Math.round(railBox.right) + 1),
        kids,
      };
    })()`);
    results.push(`layout: rail=${layout.railWidth}px row=${layout.rowWidth}px h=${layout.rowHeight}px `
      + `scroll=${layout.scrollWidth}/${layout.clientWidth} kids=${JSON.stringify(layout.kids)}`);
    check(layout.scrollWidth <= layout.clientWidth + 1, `controls row overflows: ${layout.scrollWidth} > ${layout.clientWidth}`);
    check(layout.insideRail, 'a control sits outside the rail box');
    check(layout.kids.length === 3, `expected 3 controls, saw ${layout.kids.length}`);
    check(layout.rowHeight <= 30, `controls row is ${layout.rowHeight}px tall, expected one line`);

    // ── 1. Collapse all / expand all ──────────────────────────────────────
    // Drive BOTH directions from whatever the boot state is, since Harbor
    // auto-collapses non-live projects and the first offer is usually expand.
    const bootTitle = await cdp.eval("document.querySelector('.rail-collapse-all').getAttribute('title')");
    const expanded = await cdp.eval(`(async () => {
      const button = document.querySelector('.rail-collapse-all');
      const wasExpand = /Expand all/.test(button.getAttribute('title') || '');
      if (!wasExpand) { button.click(); await new Promise((r) => setTimeout(r, 450)); }
      document.querySelector('.rail-collapse-all').click();
      await new Promise((r) => setTimeout(r, 600));
      return {
        sessions: document.querySelectorAll('.sr').length,
        carets: [...new Set([...document.querySelectorAll('.sidebar-caret')].map((c) => c.textContent.trim()))],
        title: document.querySelector('.rail-collapse-all').getAttribute('title'),
      };
    })()`);
    results.push(`boot title='${bootTitle}'`);
    results.push(`expand all -> ${expanded.sessions} session rows, carets=${JSON.stringify(expanded.carets)}, `
      + `button now '${expanded.title}'`);
    check(expanded.sessions > 0, 'expand all produced no session rows');
    check(expanded.carets.every((c) => c === '▾'), `a caret still points closed: ${JSON.stringify(expanded.carets)}`);
    check(/Collapse all/.test(expanded.title), `button did not flip to collapse: '${expanded.title}'`);
    await cdp.shot('2a-expanded-all');

    const collapsed = await cdp.eval(`(async () => {
      document.querySelector('.rail-collapse-all').click();
      await new Promise((r) => setTimeout(r, 600));
      return {
        sessions: document.querySelectorAll('.sr').length,
        projects: document.querySelectorAll('.pg-label').length,
        carets: [...new Set([...document.querySelectorAll('.sidebar-caret')].map((c) => c.textContent.trim()))],
        title: document.querySelector('.rail-collapse-all').getAttribute('title'),
      };
    })()`);
    results.push(`collapse all -> ${collapsed.sessions} session rows, ${collapsed.projects} projects still listed, `
      + `carets=${JSON.stringify(collapsed.carets)}, button now '${collapsed.title}'`);
    check(collapsed.sessions === 0, `collapse all left ${collapsed.sessions} session rows`);
    check(collapsed.projects > 3, 'collapse all hid the projects too');
    check(collapsed.carets.every((c) => c === '▸'), `a caret still points open: ${JSON.stringify(collapsed.carets)}`);
    check(/Expand all/.test(collapsed.title), `button did not flip back to expand: '${collapsed.title}'`);
    // A fully folded rail must not read as an empty one. Before the head count
    // was moved onto the matched set, one click on this button made it say
    // "0 / 1105".
    const foldedCount = await cdp.eval("document.querySelector('.rail-count').textContent.trim()");
    results.push(`head count with the whole rail folded: '${foldedCount}'`);
    check(!/^0\s*\//.test(foldedCount), `a fully collapsed rail reports '${foldedCount}', which reads as nothing matched`);
    await cdp.shot('2b-collapsed-all');

    // ── 2. Sort ───────────────────────────────────────────────────────────
    // Every order is read with the tree fully collapsed and the virtual list
    // swept end to end, so these are the REAL orders and not the DOM window.
    const byNewest = await cdp.eval(READ_ALL_PROJECTS);
    results.push(`corpus: ${byNewest.length} projects under the All chip`);
    check(byNewest.length > 10, `only ${byNewest.length} projects swept, expected the real corpus`);

    await cdp.eval("document.querySelector('.rail-list-controls .rail-opt-chip').click(); true");
    await sleep(250);
    const sortRows = await cdp.eval("[...document.querySelectorAll('.rail-sort-menu .rail-menu-item')].map((e) => e.textContent.trim())");
    results.push(`sort menu offers: ${JSON.stringify(sortRows)}`);
    check(sortRows.length === 4, `expected 4 sort rows, saw ${sortRows.length}`);
    await cdp.shot('3-sort-menu');

    await cdp.eval(clickText('.rail-sort-menu .rail-menu-item', 'Name'));
    await sleep(600);
    const byName = await cdp.eval(READ_ALL_PROJECTS);
    const sortChip = await cdp.eval("document.querySelector('.rail-list-controls .rail-opt-chip .rail-opt-value').textContent.trim()");
    // The rail draws homeLabel(label), so A-Z has to hold in the drawn column.
    const alphabetical = [...byName].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    const firstBreak = byName.findIndex((label, i) => label !== alphabetical[i]);
    results.push(`sort=Name chip='${sortChip}' n=${byName.length} first6=${JSON.stringify(byName.slice(0, 6))}`);
    check(sortChip === 'Name', `chip says '${sortChip}', expected 'Name'`);
    check(firstBreak === -1, `projects are not A-Z from index ${firstBreak}: `
      + `saw '${byName[firstBreak]}' where '${alphabetical[firstBreak]}' belongs`);
    check(JSON.stringify(byName) !== JSON.stringify(byNewest), 'Name produced the same order as Newest');
    await cdp.shot('4-sorted-name');

    await cdp.eval("document.querySelector('.rail-list-controls .rail-opt-chip').click(); true");
    await sleep(250);
    await cdp.eval(clickText('.rail-sort-menu .rail-menu-item', 'Oldest'));
    await sleep(600);
    const byOldest = await cdp.eval(READ_ALL_PROJECTS);
    results.push(`sort=Oldest n=${byOldest.length} first3=${JSON.stringify(byOldest.slice(0, 3))}`);
    results.push(`  (Newest first3=${JSON.stringify(byNewest.slice(0, 3))} last3=${JSON.stringify(byNewest.slice(-3))})`);
    // Oldest must be Newest reversed, UP TO TIES: two projects last active in
    // the same second are tie-broken by name in BOTH directions, so they keep
    // their relative order instead of mirroring. That displaces them by one
    // position and no more, so the honest assertion is the displacement, and
    // the measured maximum is reported rather than hidden behind the threshold.
    const reversed = [...byNewest].reverse();
    const displacement = byOldest.map((label, i) => Math.abs(i - reversed.indexOf(label)));
    const worst = Math.max(0, ...displacement);
    const movers = byOldest.filter((_, i) => displacement[i] > 0);
    results.push(`  reversal: max displacement from an exact reverse = ${worst}`
      + `${movers.length ? ` (tied: ${JSON.stringify(movers)})` : ' (exact)'}`);
    check(byOldest.length === byNewest.length, 'Oldest lost or gained projects');
    check(byOldest.every((label) => byNewest.includes(label)), 'Oldest is not the same set of projects as Newest');
    check(byOldest[0] === reversed[0], 'Oldest does not start where Newest ends');
    check(worst <= 1, `Oldest is not a reversal: a project moved ${worst} positions, which no tie can explain`);

    // Back to the default before the filter test, so the two are independent.
    await cdp.eval("document.querySelector('.rail-list-controls .rail-opt-chip').click(); true");
    await sleep(250);
    await cdp.eval(clickText('.rail-sort-menu .rail-menu-item', 'Newest'));
    await sleep(400);

    // ── 3. Project filter (multi-select) ──────────────────────────────────
    const projectChipSel = '.rail-list-controls .rail-opt-chip:nth-of-type(2)';
    await cdp.eval(`document.querySelector('${projectChipSel}').click(); true`);
    await sleep(350);
    const options = await cdp.eval("[...document.querySelectorAll('.rail-project-menu .rail-menu-item')].map((e) => e.textContent.trim())");
    results.push(`project menu lists ${options.length} projects, first3=${JSON.stringify(options.slice(0, 3))}`);
    check(options.length > 3, `expected several project options, saw ${options.length}`);
    await cdp.shot('5-project-menu');

    // Tick two, one at a time, re-querying because each click re-renders.
    const picked = [];
    for (const index of [0, 1]) {
      const label = await cdp.eval(`(() => {
        const rows = [...document.querySelectorAll('.rail-project-menu .rail-menu-item')];
        const row = rows[${index}];
        if (!row) return null;
        const name = row.querySelector('.rail-menu-label').textContent.trim();
        row.click();
        return name;
      })()`);
      picked.push(label);
      await sleep(350);
    }
    const menuStillOpen = await cdp.eval("document.querySelector('.rail-project-menu') ? true : false");
    const checkedCount = await cdp.eval("document.querySelectorAll('.rail-project-menu .rail-menu-item.checked').length");
    results.push(`picked ${JSON.stringify(picked)}; menu stayed open=${menuStillOpen}, checked=${checkedCount}`);
    check(menuStillOpen, 'the menu closed after one pick, so multi-select is impossible');
    check(checkedCount === 2, `expected 2 ticked rows, saw ${checkedCount}`);
    await cdp.shot('6-two-projects-picked');

    // The menu is capped, not merely fitted: unbounded, it would run 1300px
    // down a 1600px screen.
    const menuBox = await cdp.eval(`(() => {
      const r = document.querySelector('.rail-project-menu').getBoundingClientRect();
      return { h: Math.round(r.height), bottom: Math.round(r.bottom), viewport: window.innerHeight };
    })()`);
    results.push(`project menu box: ${menuBox.h}px tall, bottom at ${menuBox.bottom} of ${menuBox.viewport}`);
    check(menuBox.h <= 470, `menu is ${menuBox.h}px tall, expected it capped near 460`);
    check(menuBox.bottom <= menuBox.viewport, 'the menu runs off the bottom of the screen');

    await cdp.eval("document.querySelector('.menu-backdrop').click(); true");
    await sleep(500);

    // Reopening floats what is picked to the top, so a selection made and then
    // scrolled past can still be seen and undone.
    await cdp.eval(`document.querySelector('${projectChipSel}').click(); true`);
    await sleep(350);
    const reopened = await cdp.eval("[...document.querySelectorAll('.rail-project-menu .rail-menu-item')].slice(0, 2).map((e) => e.classList.contains('checked'))");
    results.push(`reopened menu: first two rows checked=${JSON.stringify(reopened)}`);
    check(reopened.every(Boolean), 'the picked projects are not at the top on reopen');
    await cdp.shot('6b-pinned-on-reopen');
    await cdp.eval("document.querySelector('.menu-backdrop').click(); true");
    await sleep(400);
    const filteredView = await cdp.eval(`({
      chip: document.querySelector('${projectChipSel} .rail-opt-value').textContent.trim(),
      active: document.querySelector('${projectChipSel}').classList.contains('active'),
      projects: [...document.querySelectorAll('.pg-label')].map((e) => e.textContent.trim()),
      count: document.querySelector('.rail-count').textContent.trim(),
    })`);
    results.push(`filtered rail: chip='${filteredView.chip}' active=${filteredView.active} `
      + `projects=${JSON.stringify(filteredView.projects)} count='${filteredView.count}'`);
    check(filteredView.chip === '2 projects', `chip says '${filteredView.chip}'`);
    check(filteredView.active, 'the chip does not read as active while it is filtering');
    check(filteredView.projects.length === 2, `rail shows ${filteredView.projects.length} projects, expected 2`);
    check(filteredView.count.includes('/'), `head count '${filteredView.count}' does not read as a narrowing`);
    await cdp.shot('7-rail-filtered');

    // ── 4. Search disables collapse-all rather than lying ─────────────────
    await cdp.eval(`(() => {
      const input = document.querySelector('.rail-find');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'harbor');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await sleep(600);
    const whileSearching = await cdp.eval(`({
      disabled: document.querySelector('.rail-collapse-all').disabled,
      title: document.querySelector('.rail-collapse-all').getAttribute('title'),
    })`);
    results.push(`while searching: collapse-all disabled=${whileSearching.disabled} title='${whileSearching.title}'`);
    check(whileSearching.disabled, 'collapse-all stayed clickable during a search, where it cannot change the view');
    check(/clear it/i.test(whileSearching.title || ''), 'the disabled button does not say why');
    await cdp.eval(`(() => {
      const input = document.querySelector('.rail-find');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await sleep(400);

    // ── 5. Both choices survive a reload ──────────────────────────────────
    await cdp.eval("document.querySelector('.rail-list-controls .rail-opt-chip').click(); true");
    await sleep(250);
    await cdp.eval(clickText('.rail-sort-menu .rail-menu-item', 'Busiest'));
    await sleep(400);
    await cdp.send('Page.reload');
    await sleep(3500);
    await waitFor(cdp, "document.querySelector('.rail-list-controls') ? true : false", 'rail controls after reload');
    await sleep(800);
    const persisted = await cdp.eval(`({
      sort: document.querySelector('.rail-list-controls .rail-opt-chip .rail-opt-value').textContent.trim(),
      projects: document.querySelector('${projectChipSel} .rail-opt-value').textContent.trim(),
      shown: [...document.querySelectorAll('.pg-label')].map((e) => e.textContent.trim()),
    })`);
    results.push(`after reload: sort='${persisted.sort}' filter='${persisted.projects}' projects=${JSON.stringify(persisted.shown)}`);
    check(persisted.sort === 'Busiest', `sort did not persist: '${persisted.sort}'`);
    check(persisted.projects === '2 projects', `project filter did not persist: '${persisted.projects}'`);
    // Measured, not eyeballed: the longest sort label and the filter chip must
    // both render whole at the rail's own default width. 'Most sessions' was
    // the first spelling and it clipped to "Most sessio..." right here.
    const clipped = await cdp.eval(`[...document.querySelectorAll('.rail-list-controls .rail-opt-value')]
      .map((e) => ({ text: e.textContent.trim(), scroll: e.scrollWidth, client: e.clientWidth }))`);
    results.push(`  chip labels at the default width: ${JSON.stringify(clipped)}`);
    for (const label of clipped) {
      check(label.scroll <= label.client + 1, `'${label.text}' is clipped in its chip (${label.scroll} > ${label.client})`);
    }
    await cdp.shot('8-persisted');

    // ── 6. Clearing gives every project back ──────────────────────────────
    await cdp.eval(`document.querySelector('${projectChipSel}').click(); true`);
    await sleep(350);
    await cdp.eval("document.querySelector('.rail-menu-clear').click(); true");
    await sleep(500);
    const cleared = await cdp.eval(`({
      chip: document.querySelector('${projectChipSel} .rail-opt-value').textContent.trim(),
      projects: document.querySelectorAll('.pg-label').length,
    })`);
    results.push(`cleared: chip='${cleared.chip}' projects=${cleared.projects}`);
    check(cleared.chip === 'All projects', `chip says '${cleared.chip}' after Clear`);
    check(cleared.projects > 2, 'clearing the filter did not give the other projects back');
    await cdp.shot('9-cleared');
    // Clear deliberately leaves the menu OPEN so another pick can follow; the
    // drive has to dismiss it before touching the chip again.
    await cdp.eval("document.querySelector('.menu-backdrop')?.click(); true");
    await sleep(400);

    // ── 7. Date grouping still narrows by project ─────────────────────────
    // Under date grouping one group holds sessions from several projects, so
    // the filter has to work per session or it answers this mode wrong.
    await cdp.eval(clickText('.sidebar-filter-chip', 'All'));
    await sleep(500);
    await cdp.eval("[...document.querySelectorAll('.rail-grouping-toggle button')].find((b) => b.textContent.trim() === 'Date').click(); true");
    await sleep(700);
    const dateHeads = await cdp.eval("[...document.querySelectorAll('.pg-label')].slice(0, 3).map((e) => e.textContent.trim())");
    const dateSessions = await cdp.eval("document.querySelectorAll('.sr').length");
    await cdp.eval(`document.querySelector('${projectChipSel}').click(); true`);
    await sleep(350);
    const pickedUnderDate = await cdp.eval(`(() => {
      const rows = [...document.querySelectorAll('.rail-project-menu .rail-menu-item')];
      if (!rows.length) return null;
      const row = rows.find((r) => r.querySelector('.rail-menu-label').textContent.trim() === 'harbor') || rows[0];
      const name = row.querySelector('.rail-menu-label').textContent.trim();
      row.click();
      return name;
    })()`);
    check(pickedUnderDate !== null, 'the project menu listed nothing under date grouping');
    await sleep(400);
    await cdp.eval("document.querySelector('.menu-backdrop').click(); true");
    await sleep(600);
    const underDate = await cdp.eval(`({
      heads: [...document.querySelectorAll('.pg-label')].slice(0, 3).map((e) => e.textContent.trim()),
      sessions: document.querySelectorAll('.sr').length,
      projects: [...new Set([...document.querySelectorAll('.sr-project')].map((e) => e.textContent.trim()))],
    })`);
    results.push(`date grouping: heads ${JSON.stringify(dateHeads)} (${dateSessions} sessions) `
      + `-> filtered to '${pickedUnderDate}': heads ${JSON.stringify(underDate.heads)} (${underDate.sessions} sessions)`);
    results.push(`  project labels on the surviving rows: ${JSON.stringify(underDate.projects)}`);
    check(underDate.sessions > 0, 'the project filter emptied the date-grouped rail');
    check(underDate.sessions < dateSessions, 'the project filter did not narrow under date grouping');
    check(underDate.heads.some((h) => /Today|Yesterday|\d/.test(h)), 'date groups stopped being dates');
    await cdp.shot('10-date-grouping-filtered');

    // ── 8. The narrowest rail the user can drag to ────────────────────────
    await cdp.eval(`(() => {
      const raw = JSON.parse(localStorage.getItem('harbor-rail') || '{}');
      localStorage.setItem('harbor-rail', JSON.stringify({ ...raw, width: 190, grouping: 'project', projectFilter: [] }));
      return true;
    })()`);
    await cdp.send('Page.reload');
    await sleep(3500);
    await waitFor(cdp, "document.querySelector('.rail-list-controls') ? true : false", 'rail controls at min width');
    await sleep(900);
    const narrow = await cdp.eval(`(() => {
      const row = document.querySelector('.rail-list-controls');
      const rail = document.querySelector('.rail');
      const railBox = rail.getBoundingClientRect();
      const kids = [...row.children].map((el) => {
        const r = el.getBoundingClientRect();
        return { cls: el.className.split(' ')[0], w: Math.round(r.width), right: Math.round(r.right) };
      });
      return {
        railWidth: Math.round(railBox.width),
        rowHeight: Math.round(row.getBoundingClientRect().height),
        scroll: row.scrollWidth, client: row.clientWidth,
        insideRail: kids.every((k) => k.right <= Math.round(railBox.right) + 1),
        chipGlyphsHidden: getComputedStyle(document.querySelector('.rail-opt-chip .rail-opt-glyph')).display === 'none',
        // The icon-only button has no label to fall back on, so its glyph must
        // survive every step-down or it renders as an empty box.
        foldGlyph: (() => {
          const svg = document.querySelector('.rail-collapse-all .rail-opt-glyph');
          if (!svg) return { present: false };
          const r = svg.getBoundingClientRect();
          return {
            present: true,
            shown: getComputedStyle(svg).display !== 'none',
            w: Math.round(r.width), h: Math.round(r.height),
            paths: svg.querySelectorAll('path').length,
          };
        })(),
        labels: [...row.querySelectorAll('.rail-opt-value')].map((e) => e.textContent.trim()),
        kids,
      };
    })()`);
    results.push(`min-width rail (${narrow.railWidth}px): h=${narrow.rowHeight}px scroll=${narrow.scroll}/${narrow.client} `
      + `chipGlyphsHidden=${narrow.chipGlyphsHidden} labels=${JSON.stringify(narrow.labels)} kids=${JSON.stringify(narrow.kids)}`);
    results.push(`  fold button glyph: ${JSON.stringify(narrow.foldGlyph)}`);
    check(narrow.railWidth === 190, `rail did not go to its minimum: ${narrow.railWidth}px`);
    check(narrow.scroll <= narrow.client + 1, `controls row overflows at the minimum width: ${narrow.scroll} > ${narrow.client}`);
    check(narrow.insideRail, 'a control sits outside the rail at the minimum width');
    check(narrow.labels.length === 2 && narrow.labels.every((l) => l.length > 0), 'a control lost its label at the minimum width');
    check(narrow.foldGlyph.present && narrow.foldGlyph.shown && narrow.foldGlyph.w > 0 && narrow.foldGlyph.paths === 3,
      `the icon-only fold button drew nothing at the minimum width: ${JSON.stringify(narrow.foldGlyph)}`);
    await cdp.shot('11-min-width');

    const errors = await cdp.eval("(window.__harborConsoleErrors || []).length");
    results.push(`renderer console errors tracked: ${errors}`);
  } finally {
    await sleep(500);
    try { child.kill(); } catch { /* already gone */ }
  }

  const verdict = fail.length ? `FAIL\n${fail.join('\n')}` : 'PASS';
  const report = `${verdict}\n\n${results.join('\n')}\nscreenshots: ${OUT}\n`;
  fs.writeFileSync(path.join(OUT, 'verdict.txt'), report);
  console.log(report);
  process.exit(fail.length ? 1 : 0);
}

main().catch((e) => { console.error('DRIVE FAILED:', e.message); process.exit(2); });
