'use strict';

// Isolated named-session harness for the herdr bridge tests (REQUIREMENTS
// S4/S5, A5). Every mutating test runs against a dedicated named Herdr server
// whose socket lives under ~/.config/herdr/sessions/<name>/herdr.sock, started
// with the clean-env pattern from bin/herdr-server-clean adapted for the named
// session. The user's live daemon at ~/.config/herdr/herdr.sock is never
// mutated by these tests. Teardown stops the named server and (best effort)
// deletes the named session directory.

const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn, spawnSync, execFileSync } = require('child_process');

const HOME = os.homedir();
const HERDR_BIN = path.join(HOME, '.local/bin/herdr');
// Unique per run: back-to-back suite runs raced the previous run's session
// teardown on a fixed name (the recurring first-run flake).
const SESSION_NAME = `harbor-bridge-test-${process.pid}`;
const SESSION_DIR = path.join(HOME, '.config/herdr/sessions', SESSION_NAME);
const SOCKET_PATH = path.join(SESSION_DIR, 'herdr.sock');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Poll until predicate() is truthy or timeout. Returns the truthy value.
async function waitUntil(predicate, opts = {}) {
  const timeout = opts.timeout != null ? opts.timeout : 8000;
  const interval = opts.interval != null ? opts.interval : 100;
  const start = Date.now();
  for (;;) {
    const v = await predicate();
    if (v) return v;
    if (Date.now() - start >= timeout) throw new Error(opts.message || 'waitUntil timed out');
    await sleep(interval);
  }
}

// Strip ANSI/OSC escape sequences but keep printable text and whitespace, so
// assertions like "output contains 40 100" survive a syntax-highlighting prompt
// that interleaves colour codes between characters.
function stripAnsi(s) {
  return String(s)
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '') // CSI
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '') // OSC ... BEL / ST
    .replace(/\x1b[PX^_][\s\S]*?\x1b\\/g, '') // DCS/SOS/PM/APC
    .replace(/\x1b[@-Z\\-_]/g, '') // two-char escapes
    .replace(/\x1b[ -/]*[0-9A-Za-z]/g, '') // charset selects etc
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ''); // stray control bytes (keep \t \n \r)
}

// `pgrep -a herdr` matches the process NAME "herdr" (not the full command
// line), so unrelated processes whose argv merely mentions herdr are not
// counted. Returns a Map of pid -> command string.
function herdrProcs() {
  const res = spawnSync('pgrep', ['-a', 'herdr'], { encoding: 'utf8' });
  const map = new Map();
  if (!res.stdout) return map;
  for (const line of res.stdout.split('\n')) {
    const m = line.match(/^(\d+)\s+(.*)$/);
    if (m) map.set(Number(m[1]), m[2]);
  }
  return map;
}

function socketExists() {
  try { return fs.statSync(SOCKET_PATH).isSocket(); } catch { return false; }
}

function cleanEnv() {
  const xdgRt = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`;
  return {
    HOME,
    USER: process.env.USER || '',
    LOGNAME: process.env.LOGNAME || process.env.USER || '',
    SHELL: '/bin/bash',
    LANG: process.env.LANG || 'en_US.UTF-8',
    PATH: `${HOME}/.local/bin:${HOME}/.npm-global/bin:/usr/local/bin:/usr/bin:/bin`,
    XDG_RUNTIME_DIR: xdgRt,
    HERDR_SESSION: SESSION_NAME,
  };
}

// Stop (and best-effort delete) any existing named server so each run starts
// from a clean slate.
function stopNamedServer() {
  spawnSync(HERDR_BIN, ['server', 'stop'], { env: Object.assign({}, cleanEnv()), stdio: 'ignore', timeout: 8000 });
}

function deleteNamedSession() {
  spawnSync(HERDR_BIN, ['session', 'delete', SESSION_NAME], { env: Object.assign({}, cleanEnv()), stdio: 'ignore', timeout: 8000 });
}

// Start the named server headlessly with the clean env. Detached + unref so it
// outlives this test process's spawn handle, exactly like herdr-server-clean's
// `setsid nohup herdr server &`.
async function startNamedServer() {
  // Clean slate first.
  if (socketExists()) stopNamedServer();
  deleteNamedSession();
  await sleep(300);

  const child = spawn(HERDR_BIN, ['server'], {
    env: cleanEnv(),
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  await waitUntil(() => socketExists(), { timeout: 8000, interval: 150, message: 'named herdr socket never appeared' });
  return SOCKET_PATH;
}

async function stopAndWait() {
  stopNamedServer();
  try {
    await waitUntil(() => !socketExists(), { timeout: 6000, interval: 150, message: 'named socket still present after stop' });
  } catch (e) { /* fall through; caller asserts on pgrep */ }
  deleteNamedSession();
}

module.exports = {
  HOME,
  HERDR_BIN,
  SESSION_NAME,
  SESSION_DIR,
  SOCKET_PATH,
  sleep,
  waitUntil,
  stripAnsi,
  herdrProcs,
  socketExists,
  startNamedServer,
  stopNamedServer,
  stopAndWait,
  deleteNamedSession,
};
