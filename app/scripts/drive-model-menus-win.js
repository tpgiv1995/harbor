'use strict';

// Windows prod-drive for the Session configuration modal's model menus (2026-09-20,
// Pat: "i only have Sol for codex"). Same posture as drive-cli-updates-win.js: an
// ISOLATED Harbor instance with tmp userData and state, no daemon start, and a
// window parked off the visible desktop without activating it.
//
// The config is a copy of the REAL ~/.harbor/config.json, on purpose: the defect
// only showed on a machine with NO codex profile, which is what the real config
// was until 2026-09-28, so a fixture with a tidy codex profile would pass for the
// wrong reason. The real config has codex profiles now, so the copy drops them. Codex models come from the real launch home's models_cache.json
// (read-only). HARBOR_E2E turns discovery spawns off, so the cursor catalog is
// seeded by copying the real cache file into the drive's tmp cacheDir.
//
// Usage: node scripts/drive-model-menus-win.js   (from app/)
// Writes screenshots and a verdict to %TEMP%\harbor-drive-model-menus\

const { spawn, execSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP_DIR = path.resolve(__dirname, '..');
const ELECTRON = path.join(APP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT = 9346;
const OUT = path.join(os.tmpdir(), 'harbor-drive-model-menus');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

const clickBySelector = (selector) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return false;
  el.click();
  return true;
})()`;

const clickByText = (selector, text) => `(() => {
  const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
    .find((node) => node.textContent.trim() === ${JSON.stringify(text)});
  if (!el) return false;
  el.click();
  return true;
})()`;

const texts = (selector) => `[...document.querySelectorAll(${JSON.stringify(selector)})].map((node) => node.textContent.trim())`;

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-model-menus-drive-'));
  const userData = path.join(tmp, 'userData');
  const cacheDir = path.join(tmp, 'cache');
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });

  const realConfig = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.harbor', 'config.json'), 'utf8'));
  // The real config gained three codex profiles on 2026-09-28. Strip them from
  // the COPY so this drive keeps proving the profile-less launch home the defect
  // lived on; the profiled path is covered by the account picker it now shows.
  const realCodexProfiles = (realConfig.profiles || []).filter((profile) => profile.provider === 'codex').length;
  realConfig.profiles = (realConfig.profiles || []).filter((profile) => profile.provider !== 'codex');
  const codexProfiles = realConfig.profiles.filter((profile) => profile.provider === 'codex').length;
  const realCursorCache = path.join(realConfig.paths?.cacheDir || path.join(os.homedir(), '.cache', 'harbor'), 'cursor-models.json');
  const cursorSeeded = fs.existsSync(realCursorCache);
  if (cursorSeeded) fs.copyFileSync(realCursorCache, path.join(cacheDir, 'cursor-models.json'));
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
    HARBOR_E2E_FAKE_DIALOG: APP_DIR,
    HARBOR_NO_DAEMON_START: '1',
    HARBOR_SESSIOND_DIR: path.join(tmp, 'sessiond'),
    HARBOR_CONTEXT_DIR: path.join(tmp, 'context'),
    HARBOR_NO_ICON_GEN: '1',
    HARBOR_NO_USAGE_FETCH: '1',
    HARBOR_NO_TITLER: '1',
    HARBOR_CLI_UPDATES_FILE: path.join(tmp, 'cli-updates.json'),
  };
  // The CLI verification chain (C:\tools\claude-cli-update\verify-harbor.ps1) sets
  // ELECTRON_RUN_AS_NODE=1 for its node-mode drives. Inherited here, the child
  // would boot as plain node instead of the app and never expose a page.
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(ELECTRON, [APP_DIR, `--remote-debugging-port=${PORT}`, '--no-focus-steal'], {
    env, stdio: 'ignore', detached: false,
  });

  const facts = {};
  const shots = [];
  let failure = '';
  try {
    let target = null;
    for (let i = 0; i < 60 && !target; i += 1) {
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

    await waitFor(cdp, 'Boolean(document.querySelector(".sidebar-global-new"))', 'the rail new-session button');
    await cdp.eval(clickBySelector('.sidebar-global-new'));
    await waitFor(cdp, 'Boolean(document.querySelector(".new-session-popover"))', 'the Session configuration modal');
    await waitFor(cdp, 'document.querySelectorAll(".new-session-providers button").length >= 3', 'provider buttons');

    // Codex, with no codex profile configured.
    await cdp.eval(clickByText('.new-session-providers button', 'Codex'));
    await waitFor(cdp, `${texts('.model-select-val')}.join("|").includes("Codex default")`, 'codex defaults');
    await cdp.eval(clickBySelector('.model-select'));
    await waitFor(cdp, 'document.querySelectorAll(".model-select-row").length > 0', 'the codex model list');
    facts.codexModels = await cdp.eval(texts('.model-select-row-label'));
    shots.push(await cdp.shot('1-codex-models'));

    await cdp.eval(clickByText('.model-select-row-label', 'GPT-5.5'));
    await sleep(300);
    facts.effortsFor55 = await cdp.eval(texts('.cap-effort-ticks span'));
    shots.push(await cdp.shot('2-codex-gpt-5.5-efforts'));

    await cdp.eval(clickBySelector('.model-select'));
    await waitFor(cdp, 'document.querySelectorAll(".model-select-row").length > 0', 'the codex model list again');
    await cdp.eval(clickByText('.model-select-row-label', 'GPT-6-Astra'));
    await sleep(300);
    facts.effortsForAstra = await cdp.eval(texts('.cap-effort-ticks span'));
    shots.push(await cdp.shot('3-codex-astra-efforts'));

    // Cursor, from the discovered catalog.
    await cdp.eval(clickByText('.new-session-providers button', 'Cursor'));
    await sleep(400);
    await cdp.eval(clickBySelector('.model-select'));
    await waitFor(cdp, 'document.querySelectorAll(".model-select-row").length > 0', 'the cursor model list');
    const cursorLabels = await cdp.eval(texts('.model-select-row-label'));
    facts.cursorModelCount = cursorLabels.length;
    facts.cursorFirst = cursorLabels.slice(0, 3);
    facts.cursorList = await cdp.eval(`(() => {
      const list = document.querySelector('.model-select-list');
      const rows = list.querySelectorAll('.model-select-row');
      const last = rows[rows.length - 1];
      const box = list.getBoundingClientRect();
      last.scrollIntoView({ block: 'end' });
      const lastBox = last.getBoundingClientRect();
      return {
        scrolls: list.scrollHeight > list.clientHeight,
        insideViewport: box.top >= 0 && box.bottom <= window.innerHeight,
        lastLabel: last.textContent.trim(),
        lastReachable: lastBox.bottom <= box.bottom + 1 && lastBox.top >= box.top - 1,
      };
    })()`);
    shots.push(await cdp.shot('4-cursor-models-scrolled-to-end'));
    ws.close();

    const expectFull = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
    const problems = [];
    if (codexProfiles !== 0) problems.push(`the drive's config copy still has ${codexProfiles} codex profile(s), so it no longer proves the profile-less case`);
    for (const label of ['Codex default', 'GPT-6-Astra', 'GPT-5.6-Sol', 'GPT-5.6-Terra', 'GPT-5.6-Luna', 'GPT-5.5']) {
      if (!facts.codexModels.includes(label)) problems.push(`codex list is missing ${label}`);
    }
    if (facts.effortsFor55.join() !== 'low,medium,high,xhigh') problems.push(`GPT-5.5 efforts were ${facts.effortsFor55.join()}`);
    if (facts.effortsForAstra.join() !== expectFull.join()) problems.push(`Astra efforts were ${facts.effortsForAstra.join()}`);
    if (!cursorSeeded) problems.push('no real cursor-models.json to seed from (the live Harbor has not discovered yet)');
    else if (facts.cursorModelCount < 20 || facts.cursorFirst[0] !== 'Default') problems.push(`cursor list was ${facts.cursorModelCount} rows starting ${facts.cursorFirst[0]}`);
    if (cursorSeeded && !(facts.cursorList.scrolls && facts.cursorList.insideViewport && facts.cursorList.lastReachable)) {
      problems.push(`cursor list geometry: ${JSON.stringify(facts.cursorList)}`);
    }
    failure = problems.join('; ');
  } catch (error) {
    failure = error.message;
  } finally {
    try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch { /* already gone */ }
    await sleep(500);
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }

  process.stdout.write(`${failure ? 'FAIL' : 'PASS'}\n\n`);
  process.stdout.write(`  codex profiles in the real config: ${realCodexProfiles} (stripped from the drive's copy; copy has ${codexProfiles})\n`);
  for (const [key, value] of Object.entries(facts)) process.stdout.write(`  ${key}: ${JSON.stringify(value)}\n`);
  process.stdout.write(`\nfailure: ${failure || '(none)'}\nscreenshots: ${OUT}\n`);
  for (const shot of shots) process.stdout.write(`  ${shot}\n`);
  process.exit(failure ? 1 : 0);
}

main();
