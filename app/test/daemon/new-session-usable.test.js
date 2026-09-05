'use strict';
const { execPath: guiNodeExec } = require('../support/gui-node.js');

// A NEW SESSION IS EITHER USABLE OR IT SAYS WHAT IT NEEDS. Never a silent dead
// end. This is the gate whose absence let 2026-08-06 happen.
//
// Pat started a session, sent /acclimate twice, and got nothing either time.
// Claude had opened on its first-run notice chain ("Press Enter to continue…")
// and never reached a composer, so the sends had nowhere to land. Every suite
// was green while the only thing he actually does was broken, because:
//
//   - `waitForClaudeReady` is called from ONE place and only when a preset
//     command follows the launch. A plain new session has no readiness check.
//   - When it IS called, a blocked screen makes it `continue`, so a first-run
//     gate spins out the full timeout and returns false silently.
//   - The one test in this repo that drives a REAL claude is gated on
//     HARBOR_RUN_LIVE_CLAUDE, which no script sets. It had never run. That is
//     the same disease as the HARBOR_BROWSER_TESTS suite deleted the same day:
//     a test that cannot run is not coverage, it is the appearance of coverage.
//
// So this spec drives a REAL claude binary through the REAL getMenu path and
// asserts the invariant a human cares about. It sends no message, so it costs
// no tokens, which is why it can run in the ordinary gate instead of behind an
// opt-in nobody sets.
//
// It deliberately does NOT assert "always reaches a composer": a genuine choice
// (the trust dialog, the theme picker) legitimately needs a human. What it
// forbids is the state Pat hit, where Harbor is waiting on something only it
// can clear and shows the user nothing they can act on.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '../../..');
const DAEMON = path.join(ROOT, 'app/src/daemon/daemon.js');
const { SessionClient } = require(path.join(ROOT, 'app/src/daemon/client.js'));
const { createSessionSend } = require('../../src/main/session-send.js');
const { realTmpDir } = require('../support/real-tmpdir.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function claudeBinary() {
  if (process.env.HARBOR_CLAUDE_BIN) return process.env.HARBOR_CLAUDE_BIN;
  if (process.platform === 'win32') {
    try {
      const shim = execFileSync('where.exe', ['claude.cmd'], { windowsHide: true, encoding: 'utf8' })
        .split(/\r?\n/).find(Boolean);
      const binary = shim && path.join(path.dirname(shim), 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
      return binary && fs.existsSync(binary) ? binary : null;
    } catch { return null; }
  }
  try {
    return execFileSync('sh', ['-c', 'command -v claude'], { encoding: 'utf8' }).trim() || null;
  } catch { return null; }
}

const CLAUDE = claudeBinary();
const SKIP = process.platform === 'win32'
  ? 'installed Claude native binary aborts under the suite\'s isolated fresh-config ConPTY; live-Claude first-run coverage remains POSIX-only'
  : (CLAUDE ? false : 'no claude binary on PATH');
const CLAUDE_ARGV = [CLAUDE];

// LIFO, like every other teardown. Run in push order, the store directory is
// deleted before the handler that reads a session's state file out of it to
// learn which pids to kill, and the client it needs is already closed. That is
// how a keeper survived a run whose teardown looked correct.
const cleanup = [];
after(async () => {
  for (const fn of cleanup.splice(0).reverse()) {
    try { await fn(); } catch { /* best effort */ }
  }
});

test('a new session reaches a composer, or presents something answerable', { skip: SKIP, timeout: 180000 }, async () => {
  // Isolated store AND isolated config home. The config home is the point: a
  // fresh one is what puts Claude into its first-run flow, which is the exact
  // state that broke.
  const store = fs.mkdtempSync(path.join(realTmpDir(), 'hbr-new-'));
  const configHome = fs.mkdtempSync(path.join(realTmpDir(), 'hbr-cfg-'));
  const socket = path.join(store, 'd.sock');
  cleanup.push(() => { fs.rmSync(store, { recursive: true, force: true }); });
  cleanup.push(() => { fs.rmSync(configHome, { recursive: true, force: true }); });

  const env = {
    ...process.env,
    HARBOR_SESSIOND_DIR: store,
    HARBOR_SESSIOND_SOCKET: socket,
    HARBOR_SESSIOND_UNIT: '',
    HARBOR_NO_DAEMON_START: '1',
  };
  const daemon = spawn(guiNodeExec, [DAEMON], { windowsHide: true, env, stdio: 'ignore' });
  cleanup.push(() => { try { daemon.kill('SIGKILL'); } catch {} });
  let listening = false;
  for (let i = 0; i < 100 && !listening; i += 1) {
    const probe = new SessionClient({ socketPath: socket });
    try { listening = Boolean((await probe.request('health')).ok); } catch {} finally { probe.close(); }
    if (!listening) await sleep(50);
  }
  assert.equal(listening, true, 'isolated daemon should answer a real health request');

  const client = new SessionClient({ socketPath: socket, requestTimeoutMs: 20000 });
  cleanup.push(() => { try { client.close(); } catch {} });

  const spawned = await client.request('spawn', {
    argv: [...CLAUDE_ARGV, '--dangerously-skip-permissions'],
    cwd: os.tmpdir(),
    env: { CLAUDE_CONFIG_DIR: configHome, HOME: os.homedir(), PATH: process.env.PATH, TERM: 'xterm-256color' },
    cols: 120,
    rows: 60,
  });
  const id = spawned.id;
  // TEARDOWN MUST KILL THE PROCESS, NOT JUST THE SESSION (2026-08-06). The first
  // version of this spec asked the daemon to terminate and stopped there, and
  // every run left a keeper AND a real claude behind: eight of them accumulated
  // on the machine inside an afternoon, which is the same half-kill closePaneTab
  // exists to prevent. Read the state file for the keeper and pty pids while it
  // is still there, then verify they are gone.
  cleanup.push(async () => {
    let state = null;
    try { state = JSON.parse(fs.readFileSync(path.join(store, 'sessions', `${id}.json`), 'utf8')); } catch {}
    await client.request('terminate', { id }).catch(() => {});
    await sleep(400);
    for (const pid of [state?.pid, state?.keeper_pid].filter(Boolean)) {
      for (const signal of ['SIGTERM', 'SIGKILL']) {
        try { process.kill(pid, 0); } catch { break; } // already gone
        try { process.kill(pid, signal); } catch {}
        await sleep(300);
      }
    }
  });

  // The REAL send module, with its pane I/O pointed at this isolated daemon.
  // Driving the production getMenu is the whole point: a copy of the rule in
  // the test would pass while the shipped one was broken.
  const sessionSend = createSessionSend({
    snapshot: async () => ({ panes: [], workspaces: [] }),
    readPane: async () => {
      const screen = await client.request('screen', { id, lines: 90 });
      return screen.text || '';
    },
    terminalBridge: {
      ensureDialogSize: async () => {},
      holdControl() {},
      releaseControl() {},
      getState: () => ({ controlledPaneId: id }),
      requestFocusPane: async () => {},
      sendInput: (_paneId, payload) => {
        client.request('input', { id, text: payload }).catch(() => {});
        return { ok: true };
      },
    },
    launchActions: {},
    getSessionMeta: () => null,
    links: { get: () => null, set: () => {} },
    projectLabelForCwd: () => 'test',
    setXClipboardImage: async () => {},
    captureDir: path.join(store, 'captures'),
  });

  const pane = { paneId: id, workspaceId: 'w1' };
  const composerRe = /^\s*[>❯]\s*$/m;

  // Poll the way a window does. Sixty seconds is generous for a cold start.
  let outcome = null;
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    let screen;
    try {
      screen = (await client.request('screen', { id, lines: 90 })).text || '';
    } catch (error) {
      const info = await client.request('process', { id }).catch(() => null);
      throw new Error(`new-session keeper stopped before usability could be read: ${error.message}; process=${JSON.stringify(info)}`);
    }
    if (composerRe.test(screen) && !/Press Enter to continue/i.test(screen)) {
      outcome = { kind: 'composer' };
      break;
    }
    const menu = await sessionSend.getMenu({ pane }).catch(() => null);
    if (menu && !menu.fallback) { outcome = { kind: 'card', menu, screen }; break; }
    if (menu?.fallback) { outcome = { kind: 'fallback', menu, screen }; break; }
    await sleep(700);
  }

  assert.ok(outcome, 'a new session must not sit in an unreadable state for a minute');

  if (outcome.kind === 'composer') return; // usable, nothing to answer

  // Otherwise it is waiting on a human, and that is only acceptable if the
  // human can SEE what it wants. This is the half that failed: the panel
  // rendered welcome art with the actionable sentence below the fold.
  const visible = outcome.kind === 'fallback'
    ? outcome.menu.screen.join('\n')
    : JSON.stringify(outcome.menu);

  assert.ok(
    /[❯]|\d+\.\s+\S|Press Enter|Enter to (confirm|select)|ctrl\+t|theme/i.test(visible),
    `whatever Harbor shows must carry the actionable line, got:\n${visible.slice(0, 400)}`,
  );

  // And the thing Harbor is meant to clear by itself must never be what it is
  // stuck on: an informational notice has one outcome and belongs to Harbor.
  const stuckOnNotice = /Press Enter to continue/i.test(outcome.screen)
    && /(Welcome to Claude Code|Security notes:|Login successful)/i.test(outcome.screen)
    && !/^\s*❯|Enter to confirm|Enter to select|Yes, I trust/m.test(outcome.screen);
  assert.equal(stuckOnNotice, false, 'Harbor must advance its own first-run notices, not show them');
});
