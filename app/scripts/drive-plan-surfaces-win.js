'use strict';

// Windows prod-drive for every surface that lists the plans (2026-10-21, Pat added a
// fifth Claude plan, G, and asked for "the ui everywhere in harbor" to carry it). An
// ISOLATED Harbor (tmp userData and state, no daemon start, born offscreen) runs on a
// COPY of the real ~/.harbor/config.json, so it renders exactly the profile list the
// live app does: five Claude plans and three codex plans, eight in all.
//
// Since 2026-10-29 (a sixth Claude plan, I, and Pat: "remove all the buttons in the side panel
// except for the claude plan buttons ... keep one 'o' button for other ... via the modal") the
// rail head and a hovered project row draw one button per Claude plan plus one "+O", and no
// per-project Orch chip; "+O" must open the Session configuration window on the first other
// provider with that provider's plans in its Plan picker.
//
// What it proves, at the rail widths that matter (the default the app picks for this
// profile count, Pat's own 278px at his 120% zoom, and the widest the rail is ever dragged):
//   - the rail head's "+letter" launch row keeps one line, never hangs past the rail,
//     and fits Pat's rail with 8px to spare (at pre-fix HEAD it needed 302px);
//   - the hovered project row's launch buttons stay inside the rail;
//   - the rail meters carry one row per Claude plan, in config order and colour;
//   - the File menu, the Session configuration Plan picker, the empty-stage launch
//     buttons and the title-bar Plan usage menu each name every plan.
// Usage meters read the real homes' usage read-only (no token is refreshed or written).
//
// Usage: node scripts/drive-plan-surfaces-win.js   (from app/)
// Writes screenshots and a verdict to %TEMP%\harbor-drive-plan-surfaces\

const { spawn, execSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP_DIR = path.resolve(__dirname, '..');
const ELECTRON = path.join(APP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT = 9351;
const OUT = path.join(os.tmpdir(), 'harbor-drive-plan-surfaces');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const { railLaunchPlan, railWidthForProfileCount } = require('../src/renderer/profiles.cjs');

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
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) {
      throw new Error(`page threw: ${result.exceptionDetails.text} ${result.exceptionDetails.exception?.description || ''}`);
    }
    return result.result.value;
  }

  async shot(name) {
    const result = await this.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(OUT, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(result.data, 'base64'));
    return file;
  }
}

async function waitFor(cdp, expression, label, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await cdp.eval(expression);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await sleep(250);
  }
}

const click = (selector) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return false;
  el.click();
  return true;
})()`;
const texts = (selector) => `[...document.querySelectorAll(${JSON.stringify(selector)})].map((node) => node.textContent.trim())`;
const escape = `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`;

// Geometry of the rail head and a hovered project row at a given rail width. The
// width is applied the way the resize handle applies it (the --rail-width custom
// property on the rail), so no reload or stored state is involved.
const railGeometry = (width) => `(() => {
  const rail = document.querySelector('.rail');
  rail.style.setProperty('--rail-width', '${width}px');
  void rail.offsetWidth;
  const railBox = rail.getBoundingClientRect();
  const inner = railBox.right - 1; // the rail's own 1px right border
  const head = [...document.querySelectorAll('.rail-head .sidebar-global-new')].map((b) => b.getBoundingClientRect());
  const tops = new Set(head.map((b) => Math.round(b.top)));
  const eyebrow = document.querySelector('.rail-eyebrow').getBoundingClientRect();
  const actions = document.querySelector('.sidebar-project-actions');
  let project = null;
  if (actions) {
    actions.style.display = 'flex';
    const boxes = [...actions.querySelectorAll('.sidebar-proj-new')].map((b) => b.getBoundingClientRect());
    project = { count: boxes.length, letters: [...actions.querySelectorAll('.sidebar-proj-new')].map((b) => b.textContent.trim()).join(' '),
      orchChip: Boolean(actions.querySelector('.sidebar-orch-btn')) || [...actions.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Orch'), overhang: boxes.length ? Math.round((Math.max(...boxes.map((b) => b.right)) - inner) * 10) / 10 : null,
      oneLine: new Set(boxes.map((b) => Math.round(b.top))).size <= 1 };
    actions.style.display = '';
  }
  return {
    requested: ${width},
    width: Math.round(railBox.width),
    computed: getComputedStyle(rail).width,
    inline: rail.style.getPropertyValue('--rail-width'),
    zoom: getComputedStyle(document.documentElement).zoom + '/' + getComputedStyle(document.body).zoom + '/' + devicePixelRatio,
    firstLeft: head.length ? Math.round(head[0].left) : null,
    buttons: head.length,
    letters: [...document.querySelectorAll('.rail-head .sidebar-global-new')].map((b) => b.textContent.trim()).join(' '),
    oneLine: tops.size === 1,
    overhang: Math.round((Math.max(...head.map((b) => b.right)) - inner) * 10) / 10,
    eyebrowWidth: Math.round(eyebrow.width),
    project,
  };
})()`;

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-plan-surfaces-drive-'));
  const userData = path.join(tmp, 'userData');
  const cacheDir = path.join(tmp, 'cache');
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });

  const realConfig = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.harbor', 'config.json'), 'utf8'));
  // The window opens only after the history bridge has indexed every transcript.
  // From an EMPTY cache that is a full scan of ~10k transcripts, far past any
  // drive's patience (measured 2026-10-21: no page in 75s), while the live app
  // resumes from its saved index in about a second. Seed the drive's cache with
  // copies of the live app's saved indexes so it boots the way the app does.
  const realCache = realConfig.paths?.cacheDir || path.join(os.homedir(), '.cache', 'harbor');
  for (const name of fs.readdirSync(realCache)) {
    if (/^(index|provider-row-facts|background-fold|session-titles|cursor-models|claude-models|usage-[\w-]+)\.json$/.test(name)) {
      fs.copyFileSync(path.join(realCache, name), path.join(cacheDir, name));
    }
  }
  const profiles = realConfig.profiles || [];
  const claudeProfiles = profiles.filter((p) => (p.provider || 'claude') === 'claude');
  const launch = railLaunchPlan(profiles);
  const otherProfiles = profiles.filter((p) => p.provider === launch.otherProvider);
  realConfig.paths = {
    ...realConfig.paths,
    cacheDir,
    tasksFile: path.join(tmp, 'tasks.json'),
    notesFile: path.join(tmp, 'notes.json'),
    boardsDir: path.join(tmp, 'boards'),
    projectIconsDir: path.join(tmp, 'project-icons'),
  };
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify(realConfig, null, 2));

  const env = {
    ...process.env,
    HARBOR_E2E: '1',
    HARBOR_E2E_USER_DATA: userData,
    HARBOR_E2E_FAKE_DIALOG: APP_DIR,
    HARBOR_NO_DAEMON_START: '1',
    HARBOR_SESSIOND_DIR: path.join(tmp, 'sessiond'),
    HARBOR_CONTEXT_DIR: path.join(tmp, 'context'),
    HARBOR_NO_ICON_GEN: '1',
    HARBOR_NO_TITLER: '1',
    HARBOR_CLI_UPDATES_FILE: path.join(tmp, 'cli-updates.json'),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(ELECTRON, [APP_DIR, `--remote-debugging-port=${PORT}`, '--no-focus-steal'], {
    env, stdio: 'ignore', detached: false,
  });

  const facts = { profiles: profiles.map((p) => p.letter).join(' '), claude: claudeProfiles.map((p) => p.letter).join(' ') };
  const shots = [];
  const problems = [];
  let failure = '';
  try {
    let target = null;
    // An isolated boot took ~40s on this machine (measured 2026-10-21), past the 30s other drives allow;
    // by 2026-10-29 the cold codex/cursor rescan E2E mode forces ran past 120s, so wait up to 6 minutes.
    for (let i = 0; i < 720 && !target; i += 1) {
      await sleep(500);
      try {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        target = list.find((item) => item.type === 'page' && !/devtools/.test(item.url));
      } catch { /* not listening yet */ }
    }
    if (!target) throw new Error('the isolated Harbor never exposed a page');
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    const cdp = new Cdp(ws);
    await cdp.send('Page.enable');
    // Pat's window (measured 2026-10-21): 1721x1033 device pixels on a 150% display,
    // with Harbor zoomed one step (zoom level 1 = 120%), so 1.8 device pixels per CSS
    // pixel and a 956x574 CSS viewport. His rail is 500 device pixels = 278 CSS.
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 956, height: 574, deviceScaleFactor: 1.8, mobile: false });

    await waitFor(cdp, `document.querySelectorAll('.rail-head .sidebar-global-new').length === ${launch.count}`, 'one rail launch button per Claude plan, plus +O');
    await waitFor(cdp, `document.querySelectorAll('.rail-meters .rm-row:not(.rm-sys)').length === ${claudeProfiles.length}`, 'one meter row per Claude plan');
    await sleep(2500); // let the first usage read land so the meters show real values

    // 1. Rail head and hovered project row at each width that matters.
    const PAT_RAIL = 278;
    const widths = [...new Set([railWidthForProfileCount(launch.count), PAT_RAIL, 420])];
    const wantLetters = [...claudeProfiles.map((p) => `+${p.letter}`), '+O'].join(' ');
    facts.rail = [];
    for (const width of widths) {
      const g = await cdp.eval(railGeometry(width));
      facts.rail.push(g);
      // A measurement taken at the wrong width proves nothing (2026-10-29: every width read 340).
      if (Math.abs(g.width - width) > 1) problems.push(`asked for a ${width}px rail, measured ${g.width}px`);
      if (!g.oneLine) problems.push(`rail head wraps at ${width}px`);
      if (g.overhang > 0) problems.push(`rail head "+O" hangs ${g.overhang}px past the rail at ${width}px`);
      if (g.letters !== wantLetters) problems.push(`rail head reads "${g.letters}", want "${wantLetters}"`);
      if (g.project && g.project.letters !== wantLetters) problems.push(`project row reads "${g.project.letters}", want "${wantLetters}"`);
      if (g.project?.orchChip) problems.push('the project row still carries an Orch chip');
      if (g.project && (g.project.overhang > 0 || !g.project.oneLine)) problems.push(`hovered project row overflows at ${width}px (${JSON.stringify(g.project)})`);
    }
    // The narrowest width at which the head still fits, for the record.
    let fits = null;
    for (let width = 240; width <= 420 && fits === null; width += 2) {
      const g = await cdp.eval(railGeometry(width));
      if (g.oneLine && g.overhang <= 0) fits = width;
    }
    facts.headFitsFrom = fits;
    // Room to spare at Pat's width, not a knife edge: font rounding moved the fit a
    // pixel or two between captures while this was tuned.
    if (fits === null || fits > PAT_RAIL - 8) problems.push(`the rail head needs ${fits}px; Pat's rail is ${PAT_RAIL}px and wants 8px of slack`);
    await cdp.eval(railGeometry(PAT_RAIL));
    shots.push(await cdp.shot(`1-rail-at-${PAT_RAIL}`));
    // The hovered project row, held open the way :hover opens it (buttons shown, the age label hidden), so its buttons are seen, not just measured.
    await cdp.eval(`(() => { const a = document.querySelector('.sidebar-project-actions'); if (!a) return false; a.style.display = 'flex'; const m = a.closest('.sidebar-project-wrap')?.querySelector('.pg-meta'); if (m) m.style.display = 'none'; return true; })()`);
    shots.push(await cdp.shot(`1b-project-row-at-${PAT_RAIL}`));
    await cdp.eval(`(() => { const a = document.querySelector('.sidebar-project-actions'); if (!a) return true; a.style.display = ''; const m = a.closest('.sidebar-project-wrap')?.querySelector('.pg-meta'); if (m) m.style.display = ''; return true; })()`);

    // 2. Rail meters: one row per Claude plan, config order, the profile's colour.
    facts.meters = await cdp.eval(`[...document.querySelectorAll('.rail-meters .rm-row:not(.rm-sys)')].map((row) => ({
      letter: row.querySelector('.rm-b')?.textContent.trim(),
      color: getComputedStyle(row).color,
      clipped: row.scrollWidth > row.clientWidth + 1,
    }))`);
    const meterLetters = facts.meters.map((m) => m.letter).join(' ');
    if (meterLetters !== facts.claude) problems.push(`meter rows read "${meterLetters}", config says "${facts.claude}"`);
    for (const m of facts.meters) if (m.clipped) problems.push(`meter row ${m.letter} is clipped`);
    for (const p of claudeProfiles) {
      const [r, gg, b] = [1, 3, 5].map((i) => parseInt(p.color.slice(i, i + 2), 16));
      const row = facts.meters.find((m) => m.letter === p.letter);
      if (!row || row.color !== `rgb(${r}, ${gg}, ${b})`) problems.push(`the ${p.letter} meter row is ${row?.color}, expected rgb(${r}, ${gg}, ${b})`);
    }

    // 3. File menu: one "New <plan> session" per profile.
    await cdp.eval(click('.app-menu-btn'));
    await waitFor(cdp, 'Boolean(document.querySelector(".app-menu-dropdown"))', 'the app menu');
    facts.fileMenu = await cdp.eval(texts('.app-menu-item[data-action^="new-session:"]'));
    shots.push(await cdp.shot('2-file-menu'));
    for (const p of profiles) if (!facts.fileMenu.includes(`New ${p.label} session`)) problems.push(`File menu lacks "New ${p.label} session"`);
    await cdp.eval(click('.app-menu-backdrop'));
    await sleep(300);

    // 4. Empty-stage launch buttons.
    facts.stageSlot = await cdp.eval(`(() => {
      const row = document.querySelector('.slot-actions');
      if (!row) return null;
      const boxes = [...row.querySelectorAll('.slot-btn')].map((b) => b.getBoundingClientRect());
      const box = row.getBoundingClientRect();
      return { labels: [...row.querySelectorAll('.slot-btn')].map((b) => b.textContent.trim()),
        lines: new Set(boxes.map((b) => Math.round(b.top))).size,
        inside: boxes.every((b) => b.left >= box.left - 1 && b.right <= box.right + 1) };
    })()`);
    if (facts.stageSlot) {
      shots.push(await cdp.shot('3-empty-stage'));
      if (facts.stageSlot.labels.length !== profiles.length) problems.push(`empty stage shows ${facts.stageSlot.labels.length} launch buttons for ${profiles.length} profiles`);
      if (!facts.stageSlot.inside) problems.push('an empty-stage launch button sits outside its row');
    }

    // 5. Session configuration: the Plan picker lists every Claude plan.
    await cdp.eval(click('.rail-head .sidebar-global-new'));
    await waitFor(cdp, 'Boolean(document.querySelector(".new-session-popover .config-account"))', 'the Session configuration Plan picker');
    facts.planPicker = await cdp.eval(`(() => {
      const box = document.querySelector('.config-account').getBoundingClientRect();
      const buttons = [...document.querySelectorAll('.config-account button')];
      return { labels: buttons.map((b) => b.textContent.trim()),
        inside: buttons.every((b) => { const r = b.getBoundingClientRect(); return r.left >= box.left - 1 && r.right <= box.right + 1 && r.bottom <= box.bottom + 1; }),
        truncated: buttons.filter((b) => b.scrollWidth > b.clientWidth + 1).map((b) => b.textContent.trim()) };
    })()`);
    shots.push(await cdp.shot('4-session-config-plan-picker'));
    if (facts.planPicker.labels.length !== claudeProfiles.length) problems.push(`Plan picker shows ${facts.planPicker.labels.length} Claude plans, config has ${claudeProfiles.length}`);
    if (!facts.planPicker.inside || facts.planPicker.truncated.length) problems.push(`Plan picker geometry: ${JSON.stringify(facts.planPicker)}`);
    await cdp.eval(escape);
    await sleep(300);
    if (await cdp.eval('Boolean(document.querySelector(".new-session-popover"))')) {
      await cdp.eval(click('.new-session-popover .cap-close, .new-session-popover [aria-label="Close"], .menu-backdrop'));
      await sleep(300);
    }

    // 5b. "+O" opens the Session configuration window on the first other provider, whose Plan
    // picker lists that provider's plans.
    if (launch.otherProvider) {
      await cdp.eval(click('.rail-head .sidebar-global-new.launch-other'));
      await waitFor(cdp, 'Boolean(document.querySelector(".new-session-popover"))', 'the Session configuration window from +O');
      await sleep(800);
      facts.otherWindow = await cdp.eval(`(() => ({
        provider: document.querySelector('.new-session-providers button.active')?.textContent.trim() || null,
        plans: [...document.querySelectorAll('.config-account button')].map((b) => b.textContent.trim()),
        active: document.querySelector('.config-account button.active')?.textContent.trim() || null,
      }))()`);
      shots.push(await cdp.shot('4b-plus-o-session-config'));
      if (facts.otherWindow.plans.length !== otherProfiles.length) problems.push(`+O window shows ${facts.otherWindow.plans.length} plans, config has ${otherProfiles.length} ${launch.otherProvider} plans`);
      for (const p of otherProfiles) if (!facts.otherWindow.plans.some((label) => label.includes(p.label))) problems.push(`+O window lacks the ${p.label} plan`);
      await cdp.eval(escape);
      await sleep(300);
      if (await cdp.eval('Boolean(document.querySelector(".new-session-popover"))')) {
        await cdp.eval(click('.new-session-popover .new-session-close'));
        await sleep(300);
      }
    }

    // 6. Title-bar Plan usage menu: every plan, grouped by provider.
    await cdp.eval(click('button[aria-label="Plan usage"]'));
    await waitFor(cdp, 'document.querySelectorAll(".plan-usage-row").length > 0', 'the Plan usage menu rows', 60_000);
    facts.planUsage = await cdp.eval(texts('.plan-usage-row .plan-usage-identity strong'));
    shots.push(await cdp.shot('5-plan-usage-menu'));
    for (const p of claudeProfiles) if (!facts.planUsage.includes(p.label)) problems.push(`Plan usage menu lacks ${p.label}`);
    ws.close();
    failure = problems.join('; ');
  } catch (error) {
    failure = [error.message, ...problems].join('; ');
  } finally {
    try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch { /* already gone */ }
    await sleep(500);
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }

  process.stdout.write(`${failure ? 'FAIL' : 'PASS'}\n\n`);
  for (const [key, value] of Object.entries(facts)) process.stdout.write(`  ${key}: ${JSON.stringify(value)}\n`);
  process.stdout.write(`\nfailure: ${failure || '(none)'}\nscreenshots: ${OUT}\n`);
  for (const shot of shots) process.stdout.write(`  ${shot}\n`);
  process.exit(failure ? 1 : 0);
}

main();
