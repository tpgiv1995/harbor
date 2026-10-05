'use strict';

// Windows prod-drive for the CLI update chip (Pat, 2026-09-03). Same posture as
// drive-composer-nested-win.js: an ISOLATED Harbor instance with tmp userData
// and state, no daemon start, and a window parked off the visible desktop
// without activating it.
//
// HARBOR_E2E disables the update checker on purpose (a harness must not hit the
// npm registry, GitHub or cursor's endpoint), so this drive supplies
// HARBOR_CLI_UPDATES_FIXTURE: a prepared state with two providers holding
// updates and release notes whose lines trip the Harbor impact flags. The
// checker loads it instead of the network and the UI is otherwise the real one.
//
// Usage: node scripts/drive-cli-updates-win.js   (from app/)
// Writes screenshots and a verdict to %TEMP%\harbor-drive-cli-updates\

const { spawn, execSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP_DIR = path.resolve(__dirname, '..');
const ELECTRON = path.join(APP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT = 9344;
const OUT = path.join(os.tmpdir(), 'harbor-drive-cli-updates');

const FIXTURE = {
  checkedAt: new Date(Date.now() - 4 * 60 * 1000).toISOString(),
  providers: {
    claude: {
      id: 'claude',
      label: 'Claude Code',
      installed: '2.1.258',
      latest: '2.1.260',
      source: 'npm',
      dismissed: [],
      flags: ['reverted', 'ask-dialog', 'model'],
      history: [],
      notes: {
        fetchedFor: '2.1.260',
        sections: [
          {
            version: '2.1.260',
            lines: [
              'Added a diff panel that opens beside the conversation in fullscreen mode',
              'Reverted the 2.1.258 change to how --session-id is validated',
              'Fixed the AskUserQuestion permission prompt not repainting after a resize',
            ],
          },
          {
            version: '2.1.259',
            lines: [
              'Fixed the /model picker not showing Fable 5.1 for organizations that can use it',
              'Improved the colour of a spinner',
            ],
          },
        ],
      },
    },
    codex: {
      id: 'codex',
      label: 'Codex',
      installed: '0.152.1',
      latest: '0.153.2',
      source: 'npm',
      dismissed: [],
      flags: ['rollout'],
      history: [],
      notes: {
        fetchedFor: '0.153.2',
        sections: [
          {
            version: '0.153.2',
            lines: ['Changed the rollout item_completed payload shape for tool calls'],
          },
        ],
      },
    },
    cursor: {
      id: 'cursor',
      label: 'Cursor Agent',
      installed: '2026.08.31-4057e58',
      latest: '2026.08.31-4057e58',
      source: 'cursor-agent',
      dismissed: [],
      flags: [],
      history: [],
      notes: null,
    },
  },
};

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
    const result = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
    });
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
    .find((node) => node.textContent.trim().includes(${JSON.stringify(text)}));
  if (!el) return false;
  el.click();
  return true;
})()`;

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-cli-updates-drive-'));
  const userData = path.join(tmp, 'userData');
  fs.mkdirSync(userData, { recursive: true });
  const fixtureFile = path.join(tmp, 'cli-updates-fixture.json');
  fs.writeFileSync(fixtureFile, JSON.stringify(FIXTURE, null, 2));

  const realConfig = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.harbor', 'config.json'), 'utf8'));
  realConfig.paths = {
    ...realConfig.paths,
    cacheDir: path.join(tmp, 'cache'),
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
    // The fixture makes the checker answerable with no network at all, and the
    // relocated state file keeps this drive out of the real ~/.harbor.
    HARBOR_CLI_UPDATES_FIXTURE: fixtureFile,
    HARBOR_CLI_UPDATES_FILE: path.join(tmp, 'cli-updates.json'),
    HARBOR_UPDATE_CHECK_DELAY_MS: '400',
  };
  const child = spawn(ELECTRON, [APP_DIR, `--remote-debugging-port=${PORT}`, '--no-focus-steal'], {
    env, stdio: 'ignore', detached: false,
  });

  const steps = [];
  const shots = [];
  let failure = '';
  try {
    let target = null;
    for (let i = 0; i < 60 && !target; i += 1) {
      await sleep(500);
      try {
        const list = await fetchJson(`http://127.0.0.1:${PORT}/json/list`);
        target = list.find((item) => item.type === 'page' && !/devtools/.test(item.url));
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

    // SWP_NOACTIVATE | SWP_NOZORDER keeps the proof away from the desktop.
    execSync(`powershell -NoProfile -Command "Add-Type -Name W -Namespace P -MemberDefinition '[DllImport(\\"user32.dll\\")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int cy, uint f);'; $p = Get-Process -Id ${child.pid} -ErrorAction SilentlyContinue; if ($p -and $p.MainWindowHandle -ne 0) { [P.W]::SetWindowPos($p.MainWindowHandle, [IntPtr]::Zero, -4200, 100, 1600, 1000, 0x0014) }"`, { stdio: 'ignore' });

    await waitFor(cdp, "document.querySelector('.titlebar') ? true : false", 'the title bar');

    // 1. The chip appears, with the count of undismissed updates.
    await waitFor(cdp, "document.querySelector('.updates-chip') ? true : false", 'the updates chip');
    const chipText = await cdp.eval("document.querySelector('.updates-chip').textContent.trim()");
    steps.push(`chip text: ${JSON.stringify(chipText)}`);
    if (!/^2\s*updates$/.test(chipText.replace(/\s+/g, ' '))) {
      throw new Error(`chip should read "2 updates", read ${JSON.stringify(chipText)}`);
    }
    shots.push(await cdp.shot('1-chip'));

    // 2. The menu opens through the portal with a row per provider.
    if (!await cdp.eval(clickBySelector('.updates-chip'))) throw new Error('chip did not click');
    await waitFor(cdp, "document.querySelector('.updates-menu') ? true : false", 'the updates menu');
    const rows = await cdp.eval("document.querySelectorAll('.upd-row').length");
    steps.push(`provider rows: ${rows}`);
    if (rows !== 3) throw new Error(`expected 3 provider rows, saw ${rows}`);
    const inViewport = await cdp.eval(`(() => {
      const r = document.querySelector('.updates-menu').getBoundingClientRect();
      return r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth + 1 && r.bottom <= window.innerHeight + 1;
    })()`);
    steps.push(`menu inside the viewport: ${inViewport}`);
    if (!inViewport) throw new Error('the menu escapes the viewport');
    shots.push(await cdp.shot('2-menu'));

    // 3. What's new expands and the flagged line carries its Harbor reason.
    if (!await cdp.eval(clickByText('.upd-notes-toggle', 'What'))) throw new Error('What\'s new did not click');
    await waitFor(cdp, "document.querySelector('.upd-line.flagged') ? true : false", 'a flagged note line');
    const flagged = await cdp.eval(`(() => {
      const line = document.querySelector('.upd-line.flagged');
      return {
        text: line.querySelector('.upd-line-text').textContent.trim(),
        tags: [...line.querySelectorAll('.upd-why-tag')].map((t) => t.textContent.trim()),
        why: line.querySelector('.upd-why-text')?.textContent.trim() || '',
        count: document.querySelectorAll('.upd-line.flagged').length,
      };
    })()`);
    steps.push(`flagged lines: ${flagged.count}`);
    steps.push(`first flagged line: ${JSON.stringify(flagged.text)}`);
    steps.push(`its flags: ${JSON.stringify(flagged.tags)}`);
    if (!flagged.tags.includes('reverted')) throw new Error('the Revert line was not flagged');
    if (!/may affect Harbor/.test(flagged.why)) throw new Error('the flagged line carries no reason');
    shots.push(await cdp.shot('3-notes-flagged'));

    // 4. Skip this version drops the count.
    if (!await cdp.eval(clickByText('.upd-btn', 'Skip this version'))) throw new Error('Skip did not click');
    await waitFor(
      cdp,
      "document.querySelector('.updates-chip') && /1\\s*update/.test(document.querySelector('.updates-chip').textContent) ? true : false",
      'the chip count to drop to 1',
    );
    const afterSkip = await cdp.eval("document.querySelector('.updates-chip').textContent.trim()");
    steps.push(`chip after skip: ${JSON.stringify(afterSkip)}`);
    // A skipped update must never render as "up to date": the newer version is
    // still there, the user just chose not to take it.
    const skippedRow = await cdp.eval(`(() => {
      const row = [...document.querySelectorAll('.upd-row')]
        .find((node) => node.querySelector('.upd-name')?.textContent.trim() === 'Claude Code');
      return { text: row.textContent, still: Boolean(row.querySelector('.upd-to')) };
    })()`);
    steps.push(`skipped row still names 2.1.260: ${skippedRow.still}`);
    if (/up to date/.test(skippedRow.text)) throw new Error('a skipped update rendered as "up to date"');
    if (!/skipped/.test(skippedRow.text)) throw new Error('the skipped row does not say it was skipped');
    shots.push(await cdp.shot('4-after-skip'));

    // 5. Escape closes the menu.
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(300);
    const closed = await cdp.eval("document.querySelector('.updates-menu') ? false : true");
    steps.push(`escape closed the menu: ${closed}`);
    if (!closed) throw new Error('Escape did not close the menu');
    shots.push(await cdp.shot('5-closed'));
  } catch (error) {
    failure = error.message;
  } finally {
    await sleep(300);
    try { child.kill(); } catch { /* already gone */ }
  }

  const verdict = failure ? 'FAIL' : 'PASS';
  const report = [
    verdict,
    '',
    ...steps.map((step) => `  ${step}`),
    '',
    `failure: ${failure || '(none)'}`,
    `screenshots: ${OUT}`,
    ...shots.map((shot) => `  ${shot}`),
    '',
  ].join('\n');
  fs.writeFileSync(path.join(OUT, 'verdict.txt'), report);
  console.log(report);
  process.exit(failure ? 1 : 0);
}

main().catch((error) => { console.error('DRIVE FAILED:', error.message); process.exit(2); });
