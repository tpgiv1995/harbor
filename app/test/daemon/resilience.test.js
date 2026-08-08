'use strict';

const { afterEach, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');

const { SessionClient } = require('../../src/daemon/client.js');
const { ObserverWriter } = require('../../src/daemon/observer-writer.js');
const { appendLog, readLogTail } = require('../../src/daemon/log-file.js');

const ROOT = path.resolve(__dirname, '../..');
const DAEMON = path.join(ROOT, 'src/daemon/daemon.js');
const CLI = path.resolve(ROOT, '../bin/harbor-sessiond');
const cleanups = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(fn, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await sleep(25);
  }
  throw new Error('condition timed out');
}

async function listeningServer(handler) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-sessiond-resilience-'));
  const socket = path.join(dir, 'fixture.sock');
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    handler(socket);
  });
  await new Promise((resolve) => server.listen(socket, resolve));
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, socket, server };
}

async function runningDaemon(extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-sessiond-resilience-'));
  const socket = path.join(dir, 'daemon.sock');
  const env = {
    ...process.env,
    HARBOR_SESSIOND_DIR: dir,
    HARBOR_SESSIOND_SOCKET: socket,
    HARBOR_NO_DAEMON_START: '1',
    HERDR_SOCKET_PATH: path.join(dir, 'never-real.sock'),
    ...extraEnv,
  };
  const child = spawn(process.execPath, [DAEMON], { env, stdio: 'ignore' });
  await waitUntil(() => fs.existsSync(socket));
  cleanups.push(async () => {
    if (child.exitCode === null) child.kill('SIGKILL');
    try {
      for (const name of fs.readdirSync(path.join(dir, 'sessions'))) {
        if (!name.endsWith('.json') || name.endsWith('.config.json')) continue;
        const state = JSON.parse(fs.readFileSync(path.join(dir, 'sessions', name), 'utf8'));
        try { process.kill(state.keeper_pid, 'SIGKILL'); } catch {}
        try { process.kill(-state.pid, 'SIGKILL'); } catch {}
      }
    } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, socket, env };
}

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

test('wedged socket times out status and list while logs falls back, and healthy requests still answer', async () => {
  const wedge = await listeningServer(() => {});
  fs.writeFileSync(path.join(wedge.dir, 'sessiond.log'), 'RECOVERY_LOG_LINE\n');
  const env = {
    ...process.env,
    HARBOR_SESSIOND_DIR: wedge.dir,
    HARBOR_SESSIOND_SOCKET: wedge.socket,
    HARBOR_SESSIOND_REQUEST_TIMEOUT_MS: '150',
  };
  for (const command of ['status', 'list']) {
    const started = Date.now();
    const result = spawnSync(CLI, [command], { env, encoding: 'utf8', timeout: 2000 });
    assert.equal(result.status, 1, `${command} refuses the wedge`);
    assert.match(result.stderr, new RegExp(`${command === 'status' ? 'health' : 'list'} request timed out after 150ms`));
    assert.ok(Date.now() - started < 1500, `${command} fails fast`);
  }
  const logs = spawnSync(CLI, ['logs', '--lines', '5'], { env, encoding: 'utf8', timeout: 2000 });
  assert.equal(logs.status, 0);
  assert.match(logs.stdout, /RECOVERY_LOG_LINE/);
  assert.match(logs.stderr, /logs request timed out after 150ms; reading .*sessiond\.log directly/);

  const healthy = await runningDaemon({ HARBOR_SESSIOND_REQUEST_TIMEOUT_MS: '500' });
  for (const command of ['status', 'list', 'logs']) {
    const result = spawnSync(CLI, [command], { env: healthy.env, encoding: 'utf8', timeout: 2000 });
    assert.equal(result.status, 0, `${command} reaches a healthy daemon: ${result.stderr}`);
    assert.equal(result.stderr, '', `${command} does not use a fallback against a healthy daemon`);
  }
});

test('daemon to keeper requests time out, while the same screen request succeeds for a healthy keeper', async () => {
  const h = await runningDaemon({ HARBOR_SESSIOND_KEEPER_REQUEST_TIMEOUT_MS: '150' });
  const wedged = await listeningServer(() => {});
  fs.writeFileSync(path.join(h.dir, 'sessions', 'wedged.json'), JSON.stringify({
    id: 'wedged', keeper_socket: wedged.socket, exit: null,
  }));
  const client = new SessionClient({ socketPath: h.socket, requestTimeoutMs: 1000 });
  await assert.rejects(client.request('screen', { id: 'wedged' }), /keeper screen request timed out after 150ms/);
  const spawned = await client.request('spawn', {
    argv: ['/bin/bash', '--noprofile', '--norc'], cwd: h.dir,
    env: { PS1: 'OK> ' }, cols: 80, rows: 40,
  });
  const screen = await client.request('screen', { id: spawned.id });
  assert.equal(screen.cols, 80);
  client.close();
});

test('spawn config containing env is removed, and exited state is retained briefly then reaped', async () => {
  const h = await runningDaemon({
    HARBOR_SESSIOND_EXIT_RETENTION_MS: '150',
    HARBOR_SESSIOND_KEEPER_EXIT_DELAY_MS: '50',
  });
  const client = new SessionClient({ socketPath: h.socket, requestTimeoutMs: 1000 });
  const spawned = await client.request('spawn', {
    argv: ['/bin/bash', '--noprofile', '--norc'], cwd: h.dir,
    env: { HARBOR_SECRET_PROBE: 'must-not-stay-on-disk' }, cols: 80, rows: 40,
  });
  assert.equal(fs.existsSync(path.join(h.dir, 'sessions', `${spawned.id}.config.json`)), false);
  await client.request('terminate', { id: spawned.id, signal: 'SIGKILL' });
  await waitUntil(async () => !(await client.request('process', { id: spawned.id })).running);
  assert.ok((await client.request('process', { id: spawned.id })).exit);
  await sleep(250);
  assert.equal((await client.request('list')).sessions.some((item) => item.id === spawned.id), false);
  await assert.rejects(client.request('process', { id: spawned.id }), /not found/);
  for (const suffix of ['.json', '.config.json', '.sock']) {
    assert.equal(fs.existsSync(path.join(h.dir, 'sessions', `${spawned.id}${suffix}`)), false);
  }
  client.close();
});

test('log reads are tail-bounded and append rotation caps retained bytes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-sessiond-log-'));
  cleanups.push(async () => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'sessiond.log');
  fs.writeFileSync(file, `${'old-line\n'.repeat(2000)}TAIL_ONE\nTAIL_TWO\n`);
  assert.equal(readLogTail(file, 2, 128), 'TAIL_ONE\nTAIL_TWO\n');
  appendLog(file, 'NEW_MARKER', { maxBytes: 1024 });
  assert.ok(fs.statSync(file).size <= 1024);
  assert.match(readLogTail(file, 10, 1024), /NEW_MARKER/);
  assert.ok(fs.existsSync(`${file}.1`), 'rotation retains one bounded prior log');

  fs.writeFileSync(file, `partial-prefix\nWHOLE_ONE\nWHOLE_TWO\n`);
  assert.equal(readLogTail(file, 10, 22), 'WHOLE_ONE\nWHOLE_TWO\n');
});

test('slow observers drop frames until drain instead of writing an unbounded queue', () => {
  class SlowSocket extends EventEmitter {
    constructor() { super(); this.destroyed = false; this.writable = true; this.writes = []; }
    write(value) { this.writes.push(value); return this.writes.length !== 1; }
  }
  const socket = new SlowSocket();
  const writer = new ObserverWriter(socket);
  assert.equal(writer.send({ type: 'frame', text: 'first' }), true);
  assert.equal(writer.send({ type: 'frame', text: 'dropped-1' }), false);
  assert.equal(writer.send({ type: 'frame', text: 'dropped-2' }), false);
  assert.equal(socket.writes.length, 1);
  assert.equal(writer.droppedFrames, 2);
  socket.emit('drain');
  assert.equal(writer.send({ type: 'frame', text: 'after-drain' }), true);
  assert.equal(socket.writes.length, 3);
  assert.match(socket.writes[1], /stream-degraded/);
  assert.match(socket.writes[1], /dropped_frames/);
});
