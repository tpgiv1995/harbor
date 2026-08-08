'use strict';

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');

const { SessionClient } = require('../../src/daemon/client.js');

const RUN = process.env.HARBOR_RUN_LIVE_CLAUDE === '1';
const ROOT = path.resolve(__dirname, '../..');
const DAEMON = path.join(ROOT, 'src/daemon/daemon.js');
const CLAUDE = path.join(os.homedir(), '.local/bin/claude');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-sessiond-live-claude-'));
const socketPath = path.join(dir, 'daemon.sock');
const env = {
  ...process.env,
  HARBOR_SESSIOND_DIR: dir,
  HARBOR_SESSIOND_SOCKET: socketPath,
  HARBOR_NO_DAEMON_START: '1',
  HERDR_SOCKET_PATH: path.join(dir, 'isolated-herdr.sock'),
};
let daemon;
let client;
let sessionId;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitUntil(fn, timeout, message) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await sleep(500);
  }
  throw new Error(message);
}

before(async () => {
  if (!RUN) return;
  daemon = spawn(process.execPath, [DAEMON], { env, stdio: 'ignore' });
  await waitUntil(() => fs.existsSync(socketPath), 10000, 'isolated daemon did not start');
  client = new SessionClient({ socketPath });
});

after(async () => {
  if (!RUN) {
    fs.rmSync(dir, { recursive: true, force: true });
    return;
  }
  try { await client.request('terminate', { id: sessionId, signal: 'SIGKILL' }); } catch {}
  client.close();
  daemon.kill('SIGKILL');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('real Claude AskUserQuestion is fully readable in a 120x60 modeled screen', { skip: !RUN, timeout: 120000 }, async () => {
  const claudeSession = randomUUID();
  const childEnv = {
    HOME: os.homedir(),
    USER: process.env.USER || '',
    LOGNAME: process.env.LOGNAME || process.env.USER || '',
    SHELL: '/bin/bash',
    LANG: process.env.LANG || 'en_US.UTF-8',
    PATH: `${os.homedir()}/.local/bin:${os.homedir()}/.npm-global/bin:/usr/local/bin:/usr/bin:/bin`,
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude-team'),
  };
  const spawned = await client.request('spawn', {
    argv: [CLAUDE, '--session-id', claudeSession, '--model', 'haiku', '--effort', 'low', '--permission-mode', 'bypassPermissions'],
    cwd: ROOT,
    env: childEnv,
    cols: 120,
    rows: 60,
  });
  sessionId = spawned.id;
  await waitUntil(async () => {
    const screen = await client.request('screen', { id: sessionId, scrollback: 200 });
    return /[❯>]/u.test(screen.visible) && !/Loading/u.test(screen.visible);
  }, 30000, 'Claude composer did not become ready');

  const prompt = 'Use AskUserQuestion now. Ask exactly "HARBOR_SESSIOND_DIALOG_PROBE: Which harbor is readable?" Give options "North Harbor" with description "The northern test option" and "South Harbor" with description "The southern test option". Do not answer the question yourself.';
  await client.request('input', { id: sessionId, text: prompt });
  await sleep(150);
  await client.request('input', { id: sessionId, text: '\r' });
  const screen = await waitUntil(async () => {
    const value = await client.request('screen', { id: sessionId, scrollback: 500 });
    return value.visible.includes('Which harbor is readable?') && value.visible.includes('North Harbor') && value.visible.includes('South Harbor') ? value : null;
  }, 90000, 'real Claude dialog was not fully visible');
  assert.equal(screen.cols, 120);
  assert.equal(screen.rows, 60);
  assert.match(screen.visible, /Which harbor is readable\?/);
  assert.match(screen.visible, /The northern test option/);
  assert.match(screen.visible, /The southern test option/);
});
