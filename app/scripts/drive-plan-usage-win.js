'use strict';

// Real built renderer and preload, production fixture reader, hidden window.
// No application lifecycle, daemon, real home or network is used by this drive.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const APP = path.resolve(__dirname, '..');
const OUT = process.env.HARBOR_PLAN_USAGE_SHOTS || path.resolve(APP, '../_astra/plan-usage-drive');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fixture() {
  const now = Date.now();
  const window = (kind, usedPct, hours) => ({ kind, usedPct, resetsAt: (now + hours * 3600000) / 1000, windowMinutes: kind === 'fiveHour' ? 300 : 10080 });
  const plan = (provider, id, label, windows, extra = {}) => ({ provider, id, label, email: `${id}@example.com`, windows, planType: null,
    resets: null, updatedAt: new Date(now - 60000).toISOString(), source: 'fixture', ...extra });
  return { generatedAt: new Date(now).toISOString(), plans: [
    plan('claude', 'claude-a', 'Default', [window('fiveHour', 42, 2), window('weekly', 66, 72)]),
    plan('claude', 'claude-b', 'Research', [window('fiveHour', 81, 1), window('weekly', 75, 24)], { stale: true, updatedAt: new Date(now - 240000).toISOString(), reason: 'The usage endpoint could not be reached; showing the last sample.' }),
    plan('claude', 'claude-c', 'Writing', [], { unavailable: true, updatedAt: null, reason: 'No usage sample has been reported.' }),
    plan('codex', 'codex-a', 'Default', [window('weekly', 53, 120)], { planType: 'Example plan', resets: { available: 2, nextExpiresAt: (now + 4 * 86400000) / 1000 } }),
    plan('codex', 'codex-b', 'Projects', [window('fiveHour', 0, 3), window('weekly', 19, 48)], { resetsReason: 'Reset credits could not be read with this CLI sign-in.' }),
    plan('cursor', 'cursor-a', 'Cursor', [{ kind: 'monthly', usedPct: 0.4, includedPct: 0.4, autoPct: 0, apiPct: 0.4, resetsAt: (now + 12 * 86400000) / 1000, used: 5, limit: 20, unit: 'USD' }]),
  ] };
}

async function host() {
  const { app, BrowserWindow, ipcMain, session } = require('electron');
  const root = process.env.HARBOR_DRIVE_ROOT;
  app.setPath('userData', path.join(root, 'userData'));
  const { createPlanUsageProvider } = require('../src/main/providers/plan-usage.js');
  const { METHOD_CHANNELS } = require('../src/main/rpc/channels.js');
  const { mergeSidebarModel } = require('../src/shared/sidebar-model.cjs');
  const { emptyDoc } = require('../src/shared/tasks-model.cjs');
  const provider = createPlanUsageProvider({ home: root, env: process.env,
    io: { readFile: fs.promises.readFile, readdir: () => { throw Error('Fixture must not discover homes'); } } });
  // The heavy-lifting setting goes through the production resolver with this
  // drive's relocated userData, so it must land in the drive's own profile.
  const { resolveLeanFile, readLean, writeLean, writeLeanProject } = require('../src/main/providers/provider-lean.js');
  const leanFile = resolveLeanFile({ env: {}, homedir: root, userDataPath: app.getPath('userData'),
    defaultUserDataPath: path.join(root, 'not-the-default') });
  assert.equal(leanFile, path.join(root, 'userData', 'provider-lean.json'));
  // One synthetic project override (2026-11-23) and no saved setting: the menu
  // reads Balanced and shows the project's route with its switch.
  const PROJECT = { id: 'acme', label: 'Acme App', build: 'cursor', enabled: true, folders: ['C:\\work\\acme', 'C:\\work\\.orch\\acme\\slot-*'] };
  fs.mkdirSync(path.dirname(leanFile), { recursive: true });
  fs.writeFileSync(leanFile, JSON.stringify({ projects: [PROJECT] }));
  const seeded = fs.readFileSync(leanFile, 'utf8');
  let reads = 0;
  const answers = {
    'usage:get-plans': () => { reads++; return provider.getPlans(); },
    'usage:get-lean': () => readLean(leanFile),
    'usage:set-lean': (value) => (value && typeof value === 'object' ? writeLeanProject(leanFile, value.project, value.enabled) : writeLean(leanFile, value)),
    'sidebar:get-state': () => ({ model: mergeSidebarModel({ historySessions: [], livePanes: [], workspaces: [] }) }),
    'terminal:get-state': () => ({ panes: [], workspaces: [], tabs: [], connected: false }),
    'new-session:options': () => ({ profiles: [], providers: {}, defaults: {} }),
    'setup:state': () => ({ completed: true, orchestrationEnabled: false }),
    'tasks:read': () => emptyDoc(), 'ask:list': () => [], 'project-icons:list': () => [], 'links:get': () => ({}), 'usage:get-all': () => ({}),
    'orchestration:list-runs': () => [], 'orchestration:list-delegations': () => [],
  };
  for (const { method } of METHOD_CHANNELS) ipcMain.handle(method, (_event, payload) => (answers[method] || (() => null))(payload));
  await app.whenReady();
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: /^https?:/.test(details.url) }));
  const win = new BrowserWindow({ show: false, focusable: false, x: -10000, y: -10000, width: 1440, height: 1000,
    webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true, preload: path.join(APP, 'src/preload/index.js') } });
  for (const method of ['show', 'showInactive', 'focus', 'maximize', 'moveTop', 'setAlwaysOnTop']) win[method] = () => { throw Error(`Drive refuses ${method}`); };
  const evaluate = (code) => win.webContents.executeJavaScript(code);
  async function waitFor(code) {
    const end = Date.now() + 15000;
    while (Date.now() < end) { if (await evaluate(code)) return; await sleep(100); }
    throw Error(`Timed out: ${code}`);
  }
  const click = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const shot = async (name) => {
    await sleep(150);
    const image = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, `${name}.png`), image.toPNG());
  };
  const geometry = `(() => {
    const p = document.querySelector('.plan-usage-menu'); const r = p.getBoundingClientRect();
    return { within: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight,
      overflow: [...p.querySelectorAll('.plan-usage-row, .plan-usage-window')].some(e => e.scrollWidth > e.clientWidth + 1),
      portal: p.parentElement === document.body, rows: p.querySelectorAll('.plan-usage-row').length };
  })()`;
  try {
    await win.loadFile(path.join(APP, 'dist/index.html'));
    await waitFor(`!!document.querySelector('.titlebar-controls [aria-label="Plan usage"]')`);
    assert.equal(reads, 0, 'closed dropdown must never fetch');
    await click('.titlebar-controls [aria-label="Plan usage"]');
    await waitFor(`document.querySelectorAll('.plan-usage-row').length === 6`);
    assert.deepEqual(await evaluate(geometry), { within: true, overflow: false, portal: true, rows: 6 });
    const content = await evaluate(`document.querySelector('.plan-usage-menu').textContent`);
    for (const expected of ['Claude', 'Codex', 'Cursor', 'Week 53%', 'Resets left: 2', 'Resets left: unknown', 'Stale', 'Unavailable', 'Included <1%']) assert.ok(content.includes(expected), expected);
    assert.ok(!content.includes('$'), 'no visible dollar ratio beside the Cursor percentage');
    // One group per provider, each headed by its logo, name and plan count; the
    // Claude "Default" and the Codex "Default" land in different groups. Since the
    // Lighthouse popups (f50e45d8, 2026-11-09) the logo is 14px and a hairline
    // divides each group from the one above instead of a box around each.
    const groups = await evaluate(`[...document.querySelectorAll('.plan-usage-scroll > .plan-usage-group')].map((g) => {
      const img = g.querySelector('.plan-usage-provider img');
      return { head: g.querySelector('.plan-usage-provider').textContent, logo: !!img && img.complete && img.getBoundingClientRect().width === 14,
        rows: [...g.querySelectorAll('.plan-usage-row strong')].map((s) => s.textContent), divided: getComputedStyle(g).borderTopStyle === 'solid' && parseFloat(getComputedStyle(g).borderTopWidth) > 0 };
    })`);
    assert.deepEqual(groups, [
      { head: 'Claude3 plans', logo: true, rows: ['Default', 'Research', 'Writing'], divided: false },
      { head: 'Codex2 plans', logo: true, rows: ['Default', 'Projects'], divided: true },
      { head: 'Cursor1 plan', logo: true, rows: ['Cursor'], divided: true },
    ]);
    assert.equal(await evaluate(`document.querySelectorAll('.plan-usage-row').length === document.querySelectorAll('.plan-usage-group .plan-usage-row').length`), true, 'every plan sits inside its provider group');
    await shot('groups');
    const cursorTooltip = await evaluate(`document.querySelector('section[aria-label="cursor plans"] .plan-usage-window').title`);
    for (const expected of ['Included <1% used', 'Auto 0% used', 'API <1% used']) assert.ok(cursorTooltip.includes(expected), expected);
    assert.equal(reads, 1);
    assert.equal(await evaluate(`document.querySelector('[aria-label="Plan usage"]').classList.contains('open')`), true);
    assert.ok(!content.includes('Used / limit'));
    // Heavy lifting: unset reads as Balanced, every click saves at once, and the
    // "Right now" rows follow the fixture: codex Default 53%, Projects 19%; Cursor <1%.
    const lean = `(() => {
      const g = document.querySelector('.plan-lean-seg');
      const on = [...g.querySelectorAll('[role=radio]')].filter((b) => b.getAttribute('aria-checked') === 'true').map((b) => b.textContent);
      const rows = [...document.querySelectorAll('.plan-lean-now > .plan-lean-route')].map((r) => [...r.children].map((c) => c.textContent).join(' | '));
      const cells = [...document.querySelectorAll('.plan-lean-seg button, .plan-lean-route > span, .plan-lean-switch')];
      return { labels: [...g.querySelectorAll('[role=radio]')].map((b) => b.textContent), on, rows,
        detail: document.querySelector('.plan-lean-detail')?.textContent || '',
        clipped: cells.some((b) => b.scrollWidth > b.clientWidth + 1),
        within: (() => { const p = document.querySelector('.plan-usage-menu').getBoundingClientRect(); return [g, document.querySelector('.plan-lean-now'), ...document.querySelectorAll('.plan-lean-switch')].every((e) => { const r = e.getBoundingClientRect(); return r.left >= p.left && r.right <= p.right; }); })() };
    })()`;
    const rowsAre = (rows) => `JSON.stringify([...document.querySelectorAll('.plan-lean-now > .plan-lean-route')].map((r) => [...r.children].map((c) => c.textContent).join(' | '))) === ${JSON.stringify(JSON.stringify(rows))}`;
    // The "Large general jobs" row went with the 2026-10-18 Balanced rule.
    const BALANCED = ['Image work | Projects | 19% used this week', 'Simple mechanical work | Cursor | <1% used this month', 'Everything else | Claude | '];
    // Project routes (2026-11-23): label | where builds go | how full or why not | switch.
    const projectIs = (row) => `JSON.stringify([...document.querySelectorAll('.plan-lean-projects .plan-lean-route')].map((r) => [...r.children].map((c) => c.textContent).join(' | '))) === ${JSON.stringify(JSON.stringify([row]))}`;
    const switchState = `(() => { const b = document.querySelector('.plan-lean-projects [role=switch]'); return { checked: b.getAttribute('aria-checked'), label: b.getAttribute('aria-label'), folders: document.querySelector('.plan-lean-projects .plan-lean-route-label').title }; })()`;
    await waitFor(rowsAre(BALANCED));
    let state = await evaluate(lean);
    assert.deepEqual(state.labels, ['Claude only', 'Lean Claude', 'Balanced', 'Lean OpenAI']);
    assert.deepEqual(state.on, ['Balanced']);
    assert.equal(state.clipped, false);
    assert.equal(state.within, true);
    assert.equal(fs.readFileSync(leanFile, 'utf8'), seeded, 'opening the menu must not write the setting');
    await waitFor(projectIs('Acme App builds | Cursor | <1% used this month | On'));
    assert.deepEqual(await evaluate(switchState), { checked: 'true', label: 'Send Acme App test-backed builds to Cursor', folders: 'Test-backed builds in C:\\work\\acme, C:\\work\\.orch\\acme\\slot-*' });
    // The project row's target lines up with the Right now targets above it.
    assert.equal(await evaluate(`new Set([...document.querySelectorAll('.plan-lean-route-target')].map((t) => Math.round(t.getBoundingClientRect().left))).size`), 1, 'one target column');
    await shot('lean-balanced');
    // The switch turns the override off and on, saved at once to the drive's own
    // file; the setting stays unsaved and the project keeps its folders.
    await click('.plan-lean-projects [role=switch]');
    await waitFor(projectIs('Acme App builds | Claude | Off: builds route as general work | Off'));
    assert.equal((await evaluate(switchState)).checked, 'false');
    assert.deepEqual([readLean(leanFile).saved, readLean(leanFile).projects.map((p) => [p.id, p.enabled, p.folders.length])], [false, [['acme', false, 2]]]);
    assert.equal((await evaluate(lean)).clipped, false);
    await shot('project-off');
    await click('.plan-lean-projects [role=switch]');
    await waitFor(projectIs('Acme App builds | Cursor | <1% used this month | On'));
    assert.equal(readLean(leanFile).projects[0].enabled, true);
    await click('.plan-lean-seg [data-lean="claude-only"]');
    await waitFor(rowsAre(['All work | Claude | ']));
    await waitFor(projectIs('Acme App builds | Claude | Heavy lifting is Claude only | On'));
    assert.equal(readLean(leanFile).mode, 'claude-only');
    assert.equal(readLean(leanFile).projects.length, 1, 'changing the setting keeps the project override');
    state = await evaluate(lean);
    assert.equal(state.detail, 'Claude does all the work. No Astra runs, GPT or Cursor workers.');
    await shot('lean-claude-only');
    // Lean Claude still sends image work to a GPT seat and mechanical work to Cursor (Pat, 2026-10-05).
    await click('.plan-lean-seg [data-lean="lean-claude"]');
    await waitFor(rowsAre(['Image work | Projects | 19% used this week', 'Simple mechanical work | Cursor | <1% used this month', 'Everything else | Claude | ']));
    assert.equal(readLean(leanFile).mode, 'lean-claude');
    assert.equal((await evaluate(lean)).detail, 'Claude does the work. Images go to a GPT seat, mechanical work to Cursor.');
    await shot('lean-lean-claude');
    await click('.plan-lean-seg [data-lean="lean-openai"]');
    await waitFor(rowsAre(['Image work | Projects | 19% used this week', 'Simple mechanical work | Cursor | <1% used this month', 'Connected work and reviews | Claude | ', 'Everything else | Projects | 19% used this week']));
    assert.equal(readLean(leanFile).mode, 'lean-openai');
    await waitFor(projectIs('Acme App builds | Cursor | <1% used this month | On'));
    assert.equal((await evaluate(lean)).clipped, false);
    await shot('lean-openai');
    // Arrow keys move the choice and save it, like any radio group.
    await evaluate(`document.querySelector('.plan-lean-seg [data-lean="lean-openai"]').focus()`);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Left' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Left' });
    await waitFor(`document.querySelector('.plan-lean-seg [data-lean="balanced"]').getAttribute('aria-checked') === 'true'`);
    assert.equal(await evaluate(`document.activeElement.dataset.lean`), 'balanced');
    await waitFor(rowsAre(BALANCED));
    assert.equal(readLean(leanFile).mode, 'balanced');
    assert.equal(fs.existsSync(path.join(root, '.harbor', 'provider-lean.json')), false, 'the shared home file must stay untouched');
    await evaluate(`document.fonts.ready`);
    const fonts = await evaluate(`(() => {
      const reset = document.querySelector('.plan-usage-reset');
      const style = getComputedStyle(reset);
      const probe = document.createElement('span');
      probe.textContent = '4:56pm';
      probe.style.cssText = 'position:absolute;white-space:nowrap;';
      document.body.appendChild(probe);
      const measurements = {};
      for (const [name, font, variant] of [
        ['oldTabular', '400 11px var(--font-ui)', 'tabular-nums'],
        ['oldProportional', '400 11px var(--font-ui)', 'normal'],
        ['rail', style.font, 'normal'],
      ]) {
        probe.style.font = font;
        probe.style.fontVariantNumeric = variant;
        measurements[name] = { width: probe.getBoundingClientRect().width, font: getComputedStyle(probe).font, variant };
      }
      probe.remove();
      return { resetFont: style.font, resetVariant: style.fontVariantNumeric, measurements };
    })()`);
    assert.equal(fonts.resetVariant, 'normal');
    assert.ok(fonts.resetFont.includes('IBM Plex Mono'));
    fs.writeFileSync(path.join(OUT, 'font-proof.json'), JSON.stringify(fonts, null, 2));
    await shot('wide');
    await click('.plan-usage-footer button');
    await waitFor(`!document.querySelector('.plan-usage-footer button').disabled`);
    assert.equal(reads, 2, 'refresh must fetch');
    await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape'}))`);
    await waitFor(`!document.querySelector('.plan-usage-menu')`);
    assert.equal(await evaluate(`document.activeElement.getAttribute('aria-label')`), 'Plan usage');
    await sleep(250); assert.equal(reads, 2, 'closed dropdown stays idle');
    // Resize the renderer viewport only, never the OS window.
    await win.webContents.debugger.attach('1.3');
    // Harbor's existing desktop shell has a 960px minimum width.
    await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width: 960, height: 800, deviceScaleFactor: 1, mobile: false });
    await sleep(100);
    assert.equal(await evaluate(`(() => {const r=document.querySelector('.titlebar-controls [aria-label="Plan usage"]').getBoundingClientRect();return r.left >= 0 && r.right <= innerWidth;})()`), true);
    await click('.titlebar-controls [aria-label="Plan usage"]');
    await waitFor(`document.querySelectorAll('.plan-usage-row').length === 6`);
    assert.deepEqual(await evaluate(geometry), { within: true, overflow: false, portal: true, rows: 6 });
    await waitFor(rowsAre(BALANCED));
    state = await evaluate(lean);
    assert.equal(state.clipped, false, 'segment labels fit at the 960px minimum');
    assert.equal(state.within, true);
    await shot('narrow');
    await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width: 960, height: 480, deviceScaleFactor: 1, mobile: false });
    await sleep(100);
    await evaluate(`document.querySelector('.plan-usage-menu').focus()`);
    // The heavy-lifting group is ONE stop (its checked option), then each project
    // switch, then the plan list.
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
    await waitFor(`document.activeElement.dataset.lean === 'balanced'`);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
    await waitFor(`document.activeElement.classList.contains('plan-lean-switch')`);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
    await waitFor(`document.activeElement.classList.contains('plan-usage-scroll')`);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'End', modifiers: ['control'] });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'End', modifiers: ['control'] });
    await waitFor(`document.querySelector('.plan-usage-scroll').scrollTop > 0`);
    await shot('keyboard-scroll');
    await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width: 960, height: 800, deviceScaleFactor: 1, mobile: false });
    await click('[aria-label="Close plan usage"]');
    await waitFor(`!document.querySelector('.plan-usage-menu')`);
    // A failed fixture must surface an error, with the prior data retained.
    fs.writeFileSync(process.env.HARBOR_PLAN_USAGE_FIXTURE, '{broken');
    await click('.titlebar-controls [aria-label="Plan usage"]');
    await waitFor(`!!document.querySelector('.plan-usage-message[role=alert]')`);
    await shot('refresh-error');
    assert.equal(await evaluate(`document.querySelectorAll('.plan-usage-row').length`), 6);
    const report = { result: 'PASS', reads, wide: '1440x1000', narrow: '960x800', checks: ['portal', 'six plans', 'one group per provider with logo, name and plan count, hairline between groups', 'weekly-only Codex', 'known and unknown resets', 'stale and unavailable', 'Cursor below one percent, no visible dollars, Included/Auto/API tooltip', 'refresh', 'Escape and focus return', 'outside close', 'no closed fetch', 'failed refresh retains rows', 'geometry and overflow', 'narrow trigger visible', 'keyboard scrolling at 960x480',
      'heavy lifting: unset reads Balanced, clicks and arrow keys save to the relocated profile only, Right now follows the seats, labels unclipped at 960px',
      'project routes: the override row reads Cursor, Off and Claude only correctly, its switch saves off and on to the relocated profile, setting changes keep it, unclipped at 960px, one Tab stop'] };
    fs.writeFileSync(path.join(OUT, 'verdict.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
  } finally { win.destroy(); app.quit(); }
}

async function drive() {
  fs.mkdirSync(OUT, { recursive: true });
  const root = fs.mkdtempSync(path.join(OUT, 'state-'));
  const file = path.join(root, 'fixture.json'); fs.writeFileSync(file, JSON.stringify(fixture()));
  const env = { ...process.env, HARBOR_DRIVE_ROOT: root, HARBOR_PLAN_USAGE_FIXTURE: file,
    HARBOR_E2E: '1', HARBOR_NO_USAGE_FETCH: '1', HARBOR_NO_DAEMON_START: '1',
    HARBOR_SESSIOND_DIR: path.join(root, 'sessiond'), HARBOR_CONTEXT_DIR: path.join(root, 'context'),
    HARBOR_NO_TITLER: '1', HARBOR_NO_MODEL_DISCOVERY: '1', HOME: root, USERPROFILE: root, CODEX_HOME: path.join(root, 'codex') };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(path.join(APP, 'node_modules/electron/dist/electron.exe'), [__filename, '--host'], { env, windowsHide: true, stdio: 'pipe' });
  child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
  const timer = setTimeout(() => { child.kill(); }, 60000);
  const code = await new Promise((resolve, reject) => { child.on('exit', resolve); child.on('error', reject); });
  clearTimeout(timer); assert.equal(code, 0, 'hidden UI drive failed');
}

(process.argv.includes('--host') ? host() : drive()).catch((error) => {
  console.error(error); process.exitCode = 1;
  if (process.versions.electron) require('electron').app.exit(1);
});
