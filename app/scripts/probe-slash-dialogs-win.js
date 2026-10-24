'use strict';

// Which built-in slash commands open an interactive screen, and what Harbor's
// window does with each one (2026-10-24, for the CLI-settings review). Each
// command below runs in its OWN fresh Claude session in its own isolated
// sessiond (the real CLI, the config home and folder given): type it, wait for
// the screen to settle, classify what it drew with Harbor's own parsers, press
// Esc ONCE and record whether that closed it, then end the session. Nothing is
// chosen, typed into a form, or confirmed. (One shared session was tried
// first: a slow dialog's output landed on the next command and a second Esc
// reached the prompt, so every reading is isolated now.)
//
// Commands that change something the moment they run (sign out, clear, exit,
// background, terminal setup, toggles, anything that opens a browser or starts
// a model turn) are NOT opened; they are listed under SKIPPED with the reason.
//
// Classification, in the order the window decides:
//   model-switch / permission / question  a recognized card (menu-parse.js)
//   list                                  the generic list card (generic-list.js)
//   none                                  no dialog: the command printed and returned to the prompt
//   raw                                   something is on screen the window can only show raw
// Usage (from app/):
//   ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe scripts/probe-slash-dialogs-win.js
// Env: HARBOR_PROBE_HOME (required), HARBOR_PROBE_CWD (default this checkout),
// HARBOR_PROBE_OUT (screens + results.json), HARBOR_PROBE_ONLY (comma list).

const { execPath: guiNodeExec } = require('../test/support/gui-node.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { SessionClient } = require('../src/daemon/client.js');
const { parseMenu } = require('../src/main/menu-parse.js');
const { parseGenericList } = require('../src/main/generic-list.js');
const { isDividerLine } = require('../src/shared/divider.cjs');

const DAEMON = path.join(__dirname, '../src/daemon/daemon.js');
const CLAUDE = process.env.HARBOR_PROBE_CLAUDE || path.win32.normalize(path.join(process.env.APPDATA || '', 'npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe'));
const HOME_DIR = process.env.HARBOR_PROBE_HOME;
if (!HOME_DIR) { console.error('set HARBOR_PROBE_HOME to a signed-in Claude config home'); process.exit(2); }
const CWD = process.env.HARBOR_PROBE_CWD || path.resolve(__dirname, '..', '..');
const OUT = process.env.HARBOR_PROBE_OUT || path.join(os.tmpdir(), 'harbor-slash-dialogs');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const OPEN = [
  'config', 'permissions', 'hooks', 'agents', 'memory', 'login', 'status', 'resume', 'output-style',
  'privacy-settings', 'model', 'effort', 'theme', 'help', 'plugin', 'plugins', 'mcp', 'ide', 'export', 'add-dir',
  'usage', 'context', 'rewind', 'skills', 'install-github-app', 'chrome', 'color', 'scroll-speed', 'remote-env',
  'release-notes', 'rename', 'import', 'feedback', 'powerup', 'rate-limit-options', 'usage-credits', 'extra-usage',
  'workflows', 'loops', 'daemon', 'diff', 'mobile', 'passes', 'plan', 'cd', 'cost', 'todos', 'skill-doctor',
  'keybindings-help', 'sandbox', 'statusline-help', 'approved-tools', 'vim', 'fast', 'output-styles',
];
const SKIPPED = {
  logout: 'signs out at once', clear: 'clears the conversation at once', exit: 'ends the session', quit: 'ends the session',
  compact: 'starts a summarizing turn', init: 'starts a model turn', statusline: 'starts a model turn', review: 'starts a model turn',
  'security-review': 'starts a model turn', 'pr-comments': 'starts a model turn', insights: 'starts a model turn',
  background: 'sends the session to the background', teleport: 'moves the session to the cloud', 'terminal-setup': 'changes terminal settings',
  stickers: 'opens a browser', upgrade: 'opens a browser', 'web-setup': 'starts a cloud setup', install: 'installs a build',
  branch: 'forks the conversation', fork: 'forks the conversation', keybindings: 'opens a file in an editor', tui: 'switches the renderer',
  brief: 'toggles a mode at once', focus: 'toggles a mode at once', stop: 'stops the session', recap: 'runs a model call', btw: 'needs a question',
  goal: 'needs a goal', copy: 'writes the clipboard', 'setup-bedrock': 'cloud-provider setup', 'setup-vertex': 'cloud-provider setup',
  // In Pat's homes these names are his own skills (model turns), not dialogs.
  doctor: 'a user skill of the same name runs a model turn', tasks: 'a user skill of the same name runs a model turn',
  session: 'autocompletes to a user skill that posts to Teams',
};

const lastLines = (screen, n) => String(screen).split('\n').filter((l) => l.trim()).slice(-n);
// The prompt: a "❯" line between two full-width rules near the bottom (an
// idle prompt shows a dim placeholder after the "❯", which reads as text).
function atComposer(screen) {
  // A fresh full-screen session draws its prompt under the banner with blank
  // rows below it, so the bottom is the last row with text, not the last row.
  const lines = String(screen).split('\n');
  while (lines.length && !lines.at(-1).trim()) lines.pop();
  for (let i = lines.length - 2; i >= Math.max(1, lines.length - 10); i -= 1) {
    if (/^\s*❯(?:\s.*)?$/.test(lines[i]) && isDividerLine(lines[i - 1] || '', 20) && isDividerLine(lines[i + 1] || '', 20)) return true;
  }
  return false;
}
function classify(screen) {
  const menu = parseMenu(screen);
  if (menu?.kind === 'model-switch') return { kind: 'model-switch' };
  if (menu?.permission) return { kind: 'permission' };
  if (menu) return { kind: 'question', options: menu.options.map((o) => o.label).slice(0, 8), question: menu.question.slice(0, 100) };
  const list = parseGenericList(screen);
  if (list) return { kind: 'list', title: list.title.join(' / '), rows: list.rows.length };
  if (atComposer(screen)) return { kind: 'none' };
  return { kind: 'raw' };
}
// The dialog's own heading: the first text line under the last top edge.
function heading(screen) {
  const lines = String(screen).split('\n');
  let top = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) if (/^\s*[▔─━]{8,}/.test(lines[i]) && !atComposer(lines.slice(0, i + 3).join('\n'))) { top = i; break; }
  return (lines.slice(top + 1).find((l) => l.trim() && !/^[\s─━▔]+$/.test(l)) || '').trim().slice(0, 100);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const only = process.env.HARBOR_PROBE_ONLY ? process.env.HARBOR_PROBE_ONLY.split(',') : null;
  const list = only || OPEN;
  const tmp = fs.realpathSync.native(os.tmpdir());
  const results = [];
  const env = { CLAUDE_CONFIG_DIR: HOME_DIR, TERM: 'xterm-256color' };
  for (const key of ['SystemRoot', 'PATH', 'PATHEXT', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'PROGRAMFILES', 'ProgramData']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  for (const name of list) {
    const store = fs.mkdtempSync(path.join(tmp, 'harbor-slash-probe-'));
    const socketPath = path.join(store, 'daemon.sock');
    const sessionId = randomUUID();
    let daemon; let client; let paneId;
    const screen = async () => (await client.request('screen', { id: paneId })).visible;
    const until = async (probe, ms) => {
      const t = Date.now() + ms;
      while (Date.now() < t) { if (await probe()) return true; await sleep(250); }
      return false;
    };
    // Settled: two reads 700 ms apart agree (a spinner keeps it unsettled).
    const settled = async (ms) => {
      const t = Date.now() + ms;
      let prev = await screen();
      while (Date.now() < t) {
        await sleep(700);
        const next = await screen();
        if (next === prev && !/Loading|Checking|Fetching/i.test(lastLines(next, 4).join('\n'))) return next;
        prev = next;
      }
      return prev;
    };
    try {
      daemon = spawn(guiNodeExec, [DAEMON], { windowsHide: true, stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', HARBOR_SESSIOND_DIR: store, HARBOR_SESSIOND_SOCKET: socketPath, HARBOR_NO_DAEMON_START: '1', HARBOR_SESSIOND_PARENT_PID: String(process.pid), HARBOR_SESSIOND_JOB_NAMESPACE: `harbor-slash-probe-${process.pid}` } });
      for (let i = 0; i < 150; i += 1) { try { const p = new SessionClient({ socketPath }); const r = await p.request('health'); p.close(); if (r.ok) break; } catch { /* not yet */ } await sleep(100); }
      client = new SessionClient({ socketPath, requestTimeoutMs: 30000 });
      paneId = (await client.request('spawn', { argv: [CLAUDE, '--session-id', sessionId, '--model', 'haiku', '--effort', 'low'], cwd: CWD, env, cols: 120, rows: 60, agent: 'claude', agent_session: sessionId })).id;
      // A starting CLI draws a narrow first prompt and drops what is typed into
      // it; the real one spans the pane (120 columns here).
      const ready = (text) => atComposer(text) && text.split('\n').some((l) => isDividerLine(l, 100));
      if (!(await until(async () => ready(await screen()), 60000))) {
        fs.writeFileSync(path.join(OUT, `${name}.no-prompt.txt`), await screen());
        throw new Error('the session never reached its prompt');
      }
      await sleep(2000);
      // Enter takes the command menu's TOP suggestion, not what was typed: the
      // first runs typed "/session" and Enter ran a skill whose name merely
      // contains it. So read the menu first and press Enter ONLY when its top
      // entry is seen to be exactly this command; anything else is skipped.
      await client.request('input', { id: paneId, text: `/${name}` });
      // The highlighted entry: "❯ /mcp    Manage MCP servers" (a no-break space
      // after the pointer; the prompt's own "❯ /mcp" has no description).
      const menuOf = (text) => text.split('\n').map((l) => /^\s*❯[\s\u00a0]+(\/[\w:.-]+)[\s\u00a0]{2,}\S/u.exec(l)?.[1]).filter(Boolean);
      let typed = '';
      let suggestions = [];
      for (let read = 0, prev = null; read < 8; read += 1) {
        await sleep(500);
        typed = await screen();
        suggestions = menuOf(typed);
        if (prev !== null && prev === suggestions.join(' ')) break;
        prev = suggestions.join(' ');
      }
      fs.writeFileSync(path.join(OUT, `${name}.typed.txt`), typed);
      if (suggestions[0] !== `/${name}`) {
        results.push({ cmd: `/${name}`, kind: 'not-a-command', topSuggestion: suggestions[0] });
        console.log(`/${name}: not a command here (Enter would run ${suggestions[0]}); skipped`);
        continue;
      }
      await client.request('input', { id: paneId, text: ' \r' });
      await sleep(1500);
      const shown = await settled(10000);
      const verdict = { cmd: `/${name}`, ...classify(shown), heading: heading(shown), footer: lastLines(shown, 1)[0]?.trim().slice(0, 140) || '' };
      if (/Unknown (?:skill|command)|isn't a (?:known )?command|is not a (?:known )?command/i.test(shown)) verdict.kind = 'unknown';
      if (verdict.kind === 'none') {
        const tail = shown.split(/❯ \/\S+[^\n]*\n/).pop();
        verdict.printed = tail.split('\n').filter((l) => l.trim() && !/^[\s─▔]+$/.test(l)).slice(0, 4).map((l) => l.trim().slice(0, 100));
      }
      fs.writeFileSync(path.join(OUT, `${name}.txt`), shown);
      await client.request('input', { id: paneId, text: '\x1b' });
      verdict.escCloses = verdict.kind === 'none' ? null : await until(async () => atComposer(await screen()), 4000);
      if (verdict.escCloses === false) fs.writeFileSync(path.join(OUT, `${name}.after-esc.txt`), await screen());
      results.push(verdict);
      console.log(`${verdict.cmd.padEnd(22)} ${verdict.kind.padEnd(12)} esc:${verdict.escCloses === null ? '-     ' : verdict.escCloses ? 'closes' : 'stays '} ${verdict.heading.slice(0, 50)} || ${verdict.footer.slice(0, 80)}`);
    } catch (error) {
      results.push({ cmd: `/${name}`, error: error.message });
      console.log(`/${name}: ERROR ${error.message}`);
    } finally {
      try { if (client && paneId) await client.request('terminate', { id: paneId, signal: 'SIGKILL' }); } catch { /* gone */ }
      await sleep(600);
      try { client?.close(); } catch { /* closed */ }
      if (daemon && daemon.exitCode === null) { daemon.kill(); await sleep(600); }
      try { fs.rmSync(path.join(HOME_DIR, 'projects', String(CWD).replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`), { force: true }); } catch { /* none */ }
      try { fs.rmSync(store, { recursive: true, force: true }); } catch { /* busy */ }
    }
  }
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ cli: '2.1.303', home: path.basename(HOME_DIR), results, skipped: SKIPPED }, null, 2));
  process.exit(0);
})();
