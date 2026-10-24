'use strict';

// bin/harbor-mcp-login runs `claude mcp login --no-browser <name>` in a real
// pty (the CLI refuses OAuth without a terminal) and reports JSON lines. These
// drive it against test/support/fake-claude-mcp.cjs, never the real CLI.
// The Electron case is the one that broke (2026-10-24): Harbor's main process
// starts this helper as Electron-run-as-Node, and a script CLI (an npm
// cli.js, the stand-in) started under that same binary inside a ConPTY gets
// no console and exits 0 without printing, so the sign-in "gave no address".

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const APP = path.resolve(__dirname, '..', '..');
const HELPER = path.join(APP, '..', 'bin', 'harbor-mcp-login');
const FAKE = path.join(APP, 'test', 'support', 'fake-claude-mcp.cjs');
const ELECTRON = path.join(APP, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');

function world(login) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-mcp-login-'));
  const state = path.join(dir, 'state.json');
  fs.writeFileSync(state, JSON.stringify({
    servers: [
      { name: 'claude.ai Meetings', target: 'https://meetings.example.com/mcp', transport: 'http', status: 'needs-auth' },
      { name: 'team-wiki', target: 'https://wiki.example.com/mcp', transport: 'http', status: 'needs-auth' },
    ],
    login,
  }));
  return { dir, state, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function run({ runner = process.execPath, name, w, onEvent }) {
  return new Promise((resolve) => {
    const env = { ...process.env, HARBOR_FAKE_CLAUDE_STATE: w.state };
    if (runner === ELECTRON) env.ELECTRON_RUN_AS_NODE = '1';
    const child = spawn(runner, [HELPER, '--claude', FAKE, '--home', w.dir, '--cwd', w.dir, '--name', name, '--timeout-ms', '20000'], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const events = [];
    let buf = '';
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        try { const ev = JSON.parse(line); events.push(ev); onEvent?.(ev, child); } catch { /* not ours */ }
      }
    });
    child.on('exit', () => resolve(events));
  });
}

const urlOf = (events) => events.find((e) => e.event === 'url')?.url || null;
const exitOf = (events) => events.find((e) => e.event === 'exit') || null;

test('a claude.ai connector: the address comes back as an event and the helper exits 0', async () => {
  const w = world({ 'claude.ai Meetings': 'claudeai' });
  try {
    const events = await run({ name: 'claude.ai Meetings', w });
    assert.equal(events[0].event, 'started');
    assert.match(urlOf(events), /^https:\/\/claude\.ai\/api\/organizations\/org-demo\/mcp\/start-auth\//);
    assert.equal(exitOf(events).code, 0);
  } finally { w.cleanup(); }
});

test('started as Electron-run-as-Node (how Harbor starts it), a script CLI still prints its address', { skip: !fs.existsSync(ELECTRON) && 'electron is not installed' }, async () => {
  const w = world({ 'claude.ai Meetings': 'claudeai' });
  try {
    const events = await run({ runner: ELECTRON, name: 'claude.ai Meetings', w });
    assert.match(urlOf(events) || '', /^https:\/\/claude\.ai\//, `no address: ${JSON.stringify(exitOf(events))}`);
    assert.equal(exitOf(events).code, 0);
  } finally { w.cleanup(); }
});

test('an OAuth sign-in waits for the browser, then exits 0 once the server answers', async () => {
  const w = world({ 'team-wiki': 'oauth-ok' });
  try {
    const events = await run({
      name: 'team-wiki', w,
      onEvent: (ev) => { if (ev.event === 'url') fs.writeFileSync(`${w.state}.approve`, ''); },
    });
    assert.match(urlOf(events), /^https:\/\/auth\.example\.com\/authorize/);
    const exit = exitOf(events);
    assert.equal(exit.code, 0);
    assert.match(exit.output, /Authenticated with "team-wiki"/);
    assert.equal(JSON.parse(fs.readFileSync(w.state, 'utf8')).servers.find((s) => s.name === 'team-wiki').status, 'connected');
  } finally { w.cleanup(); }
});

test('a refused sign-in exits non-zero with the CLI\'s own reason', async () => {
  const w = world({ 'team-wiki': 'fail' });
  try {
    const exit = exitOf(await run({ name: 'team-wiki', w }));
    assert.notEqual(exit.code, 0);
    assert.match(exit.output, /access_denied/);
  } finally { w.cleanup(); }
});

test('cancel on stdin ends a sign-in that is still waiting', async () => {
  const w = world({ 'team-wiki': 'hang' });
  try {
    const exit = exitOf(await run({ name: 'team-wiki', w, onEvent: (ev, child) => { if (ev.event === 'url') child.stdin.write('cancel\n'); } }));
    assert.equal(exit.cancelled, true);
  } finally { w.cleanup(); }
});
