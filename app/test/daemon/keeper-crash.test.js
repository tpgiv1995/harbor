'use strict';
const { execPath: guiNodeExec } = require('../support/gui-node.js');

// A CLIENT THAT DIES RUDELY MUST NOT TAKE THE SESSION WITH IT (2026-08-09).
//
// The daemon learned this on 2026-08-06: a socket 'error' with no listener is
// an uncaught exception, and `read ECONNRESET` killed it with every session it
// owned. keeper.js was the missed sibling. On 2026-08-09 at 02:40, during a
// machine-wide memory stall (one runaway grep at 36G), the app's stalled
// connections timed out and reset, and THREE keepers each caught an unhandled
// ECONNRESET and crashed mid-session, killing the live claudes inside them,
// including the session Pat was actively talking to. The keeper logs hold the
// identical 483-byte stack all three died with.
//
// The keeper is driven DIRECTLY here (no daemon in between), because the crash
// is the keeper's own: a raw client connects, sends a torn request, and resets
// the connection; then an observer attaches and resets mid-stream. After both,
// the keeper must still be alive and still answer requests.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const KEEPER = path.resolve(__dirname, '../../src/daemon/keeper.js');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function request(socketPath, verb, params = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = '';
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`${verb} timed out`)); }, 3000);
    socket.on('error', (error) => { clearTimeout(timer); reject(error); });
    socket.once('connect', () => {
      socket.write(`${JSON.stringify({ type: 'request', request_id: 'probe', verb, params })}\n`);
    });
    socket.on('data', (chunk) => {
      buffer += chunk;
      const line = buffer.split('\n').find((l) => l.includes('"response"'));
      if (line) {
        clearTimeout(timer);
        socket.destroy();
        resolve(JSON.parse(line));
      }
    });
  });
}

test('a keeper survives clients that reset mid-request and mid-observe', { skip: process.platform === 'win32' && 'AF_UNIX reset harness' }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-keeper-crash-'));
  const socketPath = path.join(dir, 'keeper.sock');
  const statePath = path.join(dir, 'state.json');
  const configPath = path.join(dir, 'config.json');
  const logPath = path.join(dir, 'keeper.log');
  fs.writeFileSync(configPath, JSON.stringify({
    id: 'keeper-crash-test',
    argv: ['/bin/bash', '--noprofile', '--norc', '-c', 'while sleep 0.05; do echo tick; done'],
    cwd: dir, env: { PATH: process.env.PATH }, cols: 80, rows: 24,
    agent: null, agent_session: null, created_at: new Date().toISOString(),
    state_path: statePath, keeper_socket: socketPath,
  }));
  const logFd = fs.openSync(logPath, 'a');
  const keeper = spawn(guiNodeExec, [KEEPER, configPath], { windowsHide: true, stdio: ['ignore', logFd, logFd] });
  fs.closeSync(logFd);
  t.after(async () => {
    try {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (state.pid) { try { process.kill(-state.pid, 'SIGKILL'); } catch { try { process.kill(state.pid, 'SIGKILL'); } catch {} } }
    } catch {}
    if (keeper.exitCode === null) { keeper.kill('SIGKILL'); await new Promise((r) => keeper.once('exit', r)); }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const ready = Date.now() + 5000;
  while (!fs.existsSync(statePath) && Date.now() < ready) await sleep(25);
  assert.ok(fs.existsSync(statePath), `keeper never came up: ${fs.readFileSync(logPath, 'utf8')}`);

  // 1. The 02:40 shape. On AF_UNIX there is no RST; what a stalled client's
  // abrupt teardown looks like from the keeper's side is a peer that closed
  // with the keeper's own reply still unread in its queue, which surfaces on
  // the keeper as `read ECONNRESET` (the exact stack all three dead keepers
  // logged). So: send a real request, never read the response, destroy.
  await new Promise((resolve) => {
    const rude = net.createConnection(socketPath);
    rude.on('error', () => resolve());
    rude.once('connect', () => {
      rude.pause();
      rude.write(`${JSON.stringify({ type: 'request', request_id: 'rude', verb: 'screen', params: {} })}\n`);
      setTimeout(() => { rude.destroy(); resolve(); }, 100);
    });
  });
  await sleep(400);
  assert.equal(keeper.exitCode, null,
    `a reset client crashed the keeper: ${fs.readFileSync(logPath, 'utf8')}`);

  // 2. Same rudeness on the write path: an observer attaches, frames flow to
  // it (the pty prints continuously), and the observer resets mid-stream.
  await new Promise((resolve) => {
    const observer = net.createConnection(socketPath);
    observer.on('error', () => resolve());
    observer.once('connect', () => {
      observer.pause();
      observer.write(`${JSON.stringify({ type: 'request', request_id: 'obs', verb: 'observe', params: {} })}\n`);
      setTimeout(() => { observer.destroy(); resolve(); }, 250);
    });
  });
  await sleep(600);
  assert.equal(keeper.exitCode, null,
    `a reset observer crashed the keeper: ${fs.readFileSync(logPath, 'utf8')}`);

  // 3. Still serving, not merely still breathing: a well-behaved request
  // answers, and the session inside is untouched.
  const answer = await request(socketPath, 'process');
  assert.equal(answer.ok, true);
  assert.equal(answer.result.running, true, 'the session died with the rude clients');
});
