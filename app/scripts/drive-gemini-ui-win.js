'use strict';

// Gemini (Google's Antigravity CLI) UI look-and-assert drive (2026-11-23). ISOLATED and OFFSCREEN, like
// drive-folder-labels.js: the shipped NewSessionConfig and SessionTile are built with vite against a
// stand-in window.harbor (scripts/gemini-ui-fixture.jsx) and rendered in ONE hidden, non-focusable,
// offscreen Electron window with the network refused. Nothing here reads a real config, store, daemon or
// credential, launches an agent or opens a visible window; the fixture registry carries Gemini in the shape the
// launch side sends. It writes a PNG per state and a verdict to app/verify/gemini-ui/.
//   node scripts/drive-gemini-ui-win.js   (from app/)
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const appDir = path.resolve(__dirname, '..');
const work = path.join(appDir, 'verify', 'gemini-ui');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function buildAndDrive() {
  fs.mkdirSync(work, { recursive: true });
  const html = path.join(work, 'index.html');
  fs.writeFileSync(html, '<div id="root"></div><script type="module" src="/scripts/gemini-ui-fixture.jsx"></script>');
  await (await import('vite')).build({ root: appDir, configFile: false, base: './', logLevel: 'warn',
    build: { outDir: path.join(work, 'build'), emptyOutDir: true, rollupOptions: { input: html } } });
  require('esbuild').stop();
  const env = { ...process.env, HARBOR_NO_DAEMON_START: '1' };
  for (const [key, name] of Object.entries({ HOME: 'home', USERPROFILE: 'home', APPDATA: 'roaming', LOCALAPPDATA: 'local',
    TEMP: 'tmp', TMP: 'tmp', HARBOR_USER_DATA_DIR: 'user-data', HARBOR_SESSIOND_DIR: 'sessiond', HARBOR_CONTEXT_DIR: 'context' })) {
    env[key] = path.join(work, 'isolation', name); fs.mkdirSync(env[key], { recursive: true });
  }
  env.HARBOR_SESSIOND_SOCKET = path.join(env.HARBOR_SESSIOND_DIR, 'unused.sock');
  for (const key of ['ELECTRON_RUN_AS_NODE', 'HARBOR_ALLOW_REAL_SIGNALS', 'HARBOR_ALLOW_REAL_LAUNCH', 'HARBOR_ALLOW_REAL_DIALOGS']) delete env[key];
  const child = require('node:child_process').spawn(require('electron'), [__filename], { cwd: appDir, env, windowsHide: true, stdio: 'inherit' });
  const timer = setTimeout(() => child.kill(), 90000);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }).finally(() => clearTimeout(timer));
  console.log(JSON.stringify({ electronPid: child.pid, closed: true, code }));
  const report = JSON.parse(fs.readFileSync(path.join(work, 'result.json'), 'utf8'));
  console.log(JSON.stringify(report.checks, null, 2));
  assert.equal(code, 0, report.error); assert.equal(report.ok, true);
}

async function until(win, script, label) {
  const deadline = Date.now() + 8000;
  let value;
  do { value = await win.webContents.executeJavaScript(script); if (value) return value; await delay(40); } while (Date.now() < deadline);
  throw new Error(`timed out waiting for ${label}`);
}

async function drive() {
  const { app, BrowserWindow } = require('electron');
  const report = { checks: [], windows: [] };
  let win;
  app.setPath('home', process.env.HOME);
  app.setPath('userData', process.env.HARBOR_USER_DATA_DIR);
  app.setPath('sessionData', path.join(process.env.HARBOR_USER_DATA_DIR, 'chromium'));
  app.on('window-all-closed', () => {});
  const finish = (code) => {
    clearTimeout(timer);
    if (win && !win.isDestroyed()) win.destroy();
    fs.writeFileSync(path.join(work, 'result.json'), JSON.stringify(report, null, 2)); app.exit(code);
  };
  const timer = setTimeout(() => { report.error = '80 second deadline'; finish(2); }, 80000);
  const check = (name, passed, detail) => report.checks.push({ name, passed: Boolean(passed), detail });
  const shot = async (name) => {
    win.webContents.invalidate(); await delay(150);
    fs.writeFileSync(path.join(work, `${name}.png`), (await win.webContents.capturePage()).toPNG());
    report.windows.push({ name, visible: win.isVisible(), focused: win.isFocused() });
    assert.equal(win.isVisible(), false); assert.equal(win.isFocused(), false);
  };
  const open = (query, width = 1220, height = 760) => {
    win.setSize(width, height);
    return win.loadFile(path.join(work, 'build', 'verify/gemini-ui/index.html'), { query });
  };
  try {
    await app.whenReady();
    win = new BrowserWindow({ show: false, focusable: false, skipTaskbar: true, width: 1220, height: 760,
      webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true, sandbox: true } });
    win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !/^(file|data|devtools):/.test(details.url) }));

    // 1. New session popover: four provider tabs, each with its mark; Gemini selected.
    await open({ surface: 'popover', provider: 'gemini' }, 900, 760);
    await until(win, `document.querySelectorAll('.new-session-providers button').length === 4`, 'four provider tabs');
    await until(win, `document.querySelector('.model-select-val')?.textContent === 'Gemini default'`, 'the Gemini model');
    const tabs = await win.webContents.executeJavaScript(`[...document.querySelectorAll('.new-session-providers button')].map(b => ({
      label: b.textContent.trim(), active: b.classList.contains('active'),
      logoLoaded: (() => { const i = b.querySelector('img'); return Boolean(i && i.complete && i.naturalWidth > 0); })(),
      logoSrc: decodeURIComponent(b.querySelector('img')?.getAttribute('src') || '').slice(0, 400),
      rect: (r => ({ left: r.left, right: r.right, width: r.width, height: r.height }))(b.getBoundingClientRect()) }))`);
    check('popover offers four provider tabs, Gemini last', tabs.map((t) => t.label).join('|') === 'Claude|Codex|Cursor|Gemini', JSON.stringify(tabs.map((t) => t.label)));
    check('every tab, Gemini included, shows a loaded mark', tabs.every((t) => t.logoLoaded), JSON.stringify(tabs.map((t) => [t.label, t.logoLoaded])));
    check('the Gemini tab is the active one', tabs[3].active && tabs.slice(0, 3).every((t) => !t.active));
    check('the Gemini mark is the Gemini asset, not the Claude one', /gemini/i.test(tabs[3].logoSrc) && !/claude/i.test(tabs[3].logoSrc), tabs[3].logoSrc.slice(0, 90));
    const popover = await win.webContents.executeJavaScript(`(() => { const p = document.querySelector('.new-session-popover'); const r = p.getBoundingClientRect(); return { left: r.left, right: r.right, scrollW: p.scrollWidth, clientW: p.clientWidth, start: document.querySelector('.new-session-start')?.textContent, hasPlan: Boolean(document.querySelector('[aria-label=Plan]')), efforts: [...document.querySelectorAll('.cap-seg button')].map(b => b.textContent), model: document.querySelector('.model-select-val')?.textContent }; })()`);
    check('the action says Start Gemini session', popover.start === 'Start Gemini session', popover.start);
    check('Gemini offers its own efforts low..xhigh with the lone Gemini root giving no Plan choice', popover.efforts.join(',') === 'low,medium,high,xhigh' && !popover.hasPlan, JSON.stringify(popover));
    check('the popover does not scroll sideways with four tabs', popover.scrollW <= popover.clientW + 1, JSON.stringify(popover));
    await shot('01-popover-gemini');

    // 2. The Gemini model list: a family with fewer efforts constrains the choice.
    await win.webContents.executeJavaScript(`document.querySelector('.model-select').click()`);
    await until(win, `document.querySelectorAll('.model-select-row').length === 3`, 'three Gemini model rows');
    const rows = await win.webContents.executeJavaScript(`[...document.querySelectorAll('.model-select-row-label')].map(r => r.textContent)`);
    check('Gemini model rows are its families, Default first', rows.join('|') === 'Gemini default|Gemini 4 Neon|Gemini 4 Hydrogen', rows.join('|'));
    await shot('02-popover-gemini-models');
    await win.webContents.executeJavaScript(`[...document.querySelectorAll('.model-select-row')].find(r => /Hydrogen/.test(r.textContent)).click()`);
    await until(win, `document.querySelectorAll('.cap-seg button').length === 2`, 'Hydrogen efforts');
    const hydrogen = await win.webContents.executeJavaScript(`[...document.querySelectorAll('.cap-seg button')].map(b => b.textContent + (b.classList.contains('on') ? '*' : '')).join(',')`);
    check('Hydrogen offers only its own two efforts, one chosen', /^low\*?,medium\*?$/.test(hydrogen) && hydrogen.includes('*'), hydrogen);
    await shot('03-popover-gemini-hydrogen');

    // 3. Switching the tab to another provider and back keeps each provider's own choices.
    await win.webContents.executeJavaScript(`[...document.querySelectorAll('.new-session-providers button')].find(b => /Cursor/.test(b.textContent)).click()`);
    await until(win, `document.querySelector('.new-session-start')?.textContent === 'Start Cursor session'`, 'Cursor tab');
    await shot('04-popover-cursor');

    // 4. Four windows: the model chip carries each provider's own mark.
    await open({ surface: 'tiles' }, 1220, 600);
    await until(win, `document.querySelectorAll('.win2').length === 4`, 'four windows');
    await delay(400);
    const chips = await win.webContents.executeJavaScript(`[...document.querySelectorAll('.win2')].map(w => {
      const chip = w.querySelector('.model-chip'); const img = chip?.querySelector('img.logomk');
      return { provider: chip?.dataset.provider, name: chip?.querySelector('.model-name')?.textContent, effort: chip?.querySelector('.eff')?.textContent,
        badge: chip?.querySelector('.model-acct')?.textContent || null,
        logoLoaded: Boolean(img && img.complete && img.naturalWidth > 0), logo: decodeURIComponent(img?.getAttribute('src') || '').slice(0, 400),
        pill: w.querySelector('.apill')?.textContent || null,
        clipped: chip ? chip.scrollWidth > chip.clientWidth + 1 : null }; })`);
    check('four windows, four providers', chips.map((c) => c.provider).join('|') === 'claude|codex|cursor|gemini', JSON.stringify(chips.map((c) => c.provider)));
    check('every window chip shows its loaded mark', chips.every((c) => c.logoLoaded), JSON.stringify(chips.map((c) => [c.provider, c.logoLoaded])));
    const gem = chips[3];
    check('the Gemini window chip names the model, effort and plan badge, with the Gemini mark', gem.name === 'Gemini 4 Neon' && gem.effort === 'high' && gem.badge === 'G' && /<title>Gemini<\/title>/.test(gem.logo), JSON.stringify({ ...gem, logo: gem.logo.slice(0, 80) }));
    check('a Gemini window has no second plan pill beside the chip', gem.pill === null, String(gem.pill));
    check('the cursor window keeps the trailing pill rule (no home, so none)', chips[2].badge === null);
    check('no chip is clipped', chips.every((c) => c.clipped === false), JSON.stringify(chips.map((c) => c.clipped)));
    await shot('05-four-windows');

    // 5. The plan picker's Other row names Gemini and still fits its 256px menu on one line.
    await open({ surface: 'other' }, 400, 140);
    await until(win, `Boolean(document.querySelector('.plan-pick-other .rail-menu-label'))`, 'the Other row');
    const other = await win.webContents.executeJavaScript(`(() => { const l = document.querySelector('.plan-pick-other .rail-menu-label'); return { text: l.textContent, fits: l.scrollWidth <= l.clientWidth, w: l.clientWidth, sw: l.scrollWidth }; })()`);
    check('the Other row names Codex, Cursor and Gemini and is not cut off', other.text === 'Other: Codex, Cursor, Gemini…' && other.fits, JSON.stringify(other));
    await shot('06-plan-picker-other');

    // 6. The setup wizard: the Gemini card on the providers step, then the defaults row.
    await open({ surface: 'wizard' }, 1180, 900);
    await until(win, `Boolean(document.querySelector('.setup-step[data-step=providers]'))`, 'the wizard rail');
    const stepTitles = await win.webContents.executeJavaScript(`[...document.querySelectorAll('.setup-step-title')].map(e => e.textContent)`);
    check('the wizard names the providers step for all three CLIs', stepTitles.includes('Codex, Cursor and Gemini'), JSON.stringify(stepTitles));
    await win.webContents.executeJavaScript(`document.querySelector('.setup-step[data-step=providers]').click()`);
    await until(win, `Boolean(document.querySelector('[data-provider=gemini]'))`, 'the Gemini card');
    await delay(300);
    const card = await win.webContents.executeJavaScript(`(() => { const c = document.querySelector('.setup-card[data-provider=gemini]'); const inputs = [...c.querySelectorAll('input.sf-input')].map(i => i.value); return { text: c.innerText.replace(/\\s+/g, ' '), inputs, on: c.querySelector('.sf-switch')?.dataset.on, lede: document.querySelector('.setup-lede').innerText.replace(/\\s+/g, ' ') }; })()`);
    check('the Gemini card is on, found at the detected agy path, with the binary prefilled', card.on === '1' && card.inputs[0] === 'C:/Tools/agy/agy.exe' && /Found at C:\/Tools\/agy\/agy.exe/.test(card.text), JSON.stringify(card));
    check('the home field is empty (own profile) and the first-run consent note names the terminal', card.inputs[1] === '' && /answer them in the session's terminal/.test(card.text) && /Harbor never handles that sign-in/.test(card.text), card.text.slice(0, 400));
    check('the lede says Codex, Cursor and Gemini', /Codex, Cursor and Gemini sessions/.test(card.lede), card.lede);
    await shot('07-wizard-providers-gemini');
    await win.webContents.executeJavaScript(`document.querySelector('.setup-card[data-provider=gemini] .setup-signin').click()`);
    await until(win, `/never opens a terminal/.test(document.querySelector('.setup-card[data-provider=gemini]').innerText)`, 'the sign-in note');
    const manual = await win.webContents.executeJavaScript(`document.querySelector('.setup-card[data-provider=gemini] .setup-cmd code')?.textContent`);
    check('a sign-in that cannot open a terminal hands back the manual command', /agy$/.test(manual || ''), manual);
    await shot('08-wizard-gemini-signin-note');
    await win.webContents.executeJavaScript(`document.querySelector('.setup-step[data-step=defaults]').click()`);
    await until(win, `document.querySelectorAll('.setup-card .sf-seg button, .setup-card [role=radio]').length > 0`, 'the defaults step');
    await delay(400);
    const defaults = await win.webContents.executeJavaScript(`document.querySelector('.setup-body').innerText.replace(/\\s+/g, ' ')`);
    check('the defaults step offers Gemini as a provider', /Gemini/.test(defaults), defaults.slice(0, 300));
    await shot('09-wizard-defaults');

    report.ok = report.checks.every((c) => c.passed); finish(report.ok ? 0 : 1);
  } catch (error) { report.error = error.stack; report.ok = false; finish(1); }
}
(process.versions.electron ? drive() : buildAndDrive()).catch((error) => { console.error(error); process.exitCode = 1; });
