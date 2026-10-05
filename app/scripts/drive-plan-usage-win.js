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
  let reads = 0;
  const answers = {
    'usage:get-plans': () => { reads++; return provider.getPlans(); },
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
    const cursorTooltip = await evaluate(`document.querySelector('section[aria-label="cursor plans"] .plan-usage-window').title`);
    for (const expected of ['Included <1% used', 'Auto 0% used', 'API <1% used']) assert.ok(cursorTooltip.includes(expected), expected);
    assert.equal(reads, 1);
    assert.equal(await evaluate(`document.querySelector('[aria-label="Plan usage"]').classList.contains('open')`), true);
    assert.ok(!content.includes('Used / limit'));
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
    await shot('narrow');
    await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width: 960, height: 480, deviceScaleFactor: 1, mobile: false });
    await sleep(100);
    await evaluate(`document.querySelector('.plan-usage-menu').focus()`);
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
    const report = { result: 'PASS', reads, wide: '1440x1000', narrow: '960x800', checks: ['portal', 'six plans', 'weekly-only Codex', 'known and unknown resets', 'stale and unavailable', 'Cursor below one percent, no visible dollars, Included/Auto/API tooltip', 'refresh', 'Escape and focus return', 'outside close', 'no closed fetch', 'failed refresh retains rows', 'geometry and overflow', 'narrow trigger visible', 'keyboard scrolling at 960x480'] };
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
