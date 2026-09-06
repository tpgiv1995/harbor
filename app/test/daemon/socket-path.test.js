'use strict';
const { execPath: guiNodeExec } = require('../support/gui-node.js');

// AF_UNIX sun_path is a fixed 108 byte field, and the kernel does not refuse an
// over-long path, it TRUNCATES it: `listen()` reports success, the socket lands
// on disk under a shortened name, and the keeper's very next chmod of the full
// name throws ENOENT inside a detached process whose stderr went to /dev/null.
// The caller saw only `spawn request timed out after 10000ms`, ten seconds
// later, with nothing written down anywhere. Both halves are proved here: the
// path has to fit, and a keeper that dies has to say why.

const { afterEach, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { SessionClient } = require('../../src/daemon/client.js');
const { resolvePaths, socketFits, listenAddress, SUN_PATH_MAX } = require('../../src/daemon/paths.js');
const { realTmpDir } = require('../support/real-tmpdir.js');

const ROOT = path.resolve(__dirname, '../..');
const DAEMON = path.join(ROOT, 'src/daemon/daemon.js');
const cleanups = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(fn, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(25);
  }
  throw new Error('condition timed out');
}

// A store deep enough that `<root>/sessions/<uuid>.sock` overflows. This is not
// hypothetical: it is the shape of the e2e fixture store, measured at 111 bytes.
function deepStore(prefix) {
  const base = fs.mkdtempSync(path.join(realTmpDir(), prefix));
  const deep = path.join(base, 'e2e-home', 'manual-check', 'a-project-directory', 'store');
  fs.mkdirSync(deep, { recursive: true });
  cleanups.push(async () => fs.rmSync(base, { recursive: true, force: true }));
  return deep;
}

async function runningDaemon(root, extraEnv = {}) {
  const env = { ...process.env, HARBOR_SESSIOND_DIR: root, HARBOR_NO_DAEMON_START: '1', ...extraEnv };
  delete env.HARBOR_SESSIOND_SOCKET;
  if (!extraEnv.HARBOR_SESSIOND_SOCKET_DIR) delete env.HARBOR_SESSIOND_SOCKET_DIR;
  const paths = resolvePaths(env);
  const child = spawn(guiNodeExec, [DAEMON], { windowsHide: true, env, stdio: 'ignore' });
  cleanups.push(async () => {
    if (child.exitCode === null) child.kill('SIGKILL');
    try {
      for (const name of fs.readdirSync(paths.sessions)) {
        if (!name.endsWith('.json') || name.endsWith('.config.json')) continue;
        const state = JSON.parse(fs.readFileSync(path.join(paths.sessions, name), 'utf8'));
        try { process.kill(state.keeper_pid, 'SIGKILL'); } catch {}
        try { process.kill(-state.pid, 'SIGKILL'); } catch {}
      }
    } catch {}
    // The relocated socket directory is outside the store, so removing the
    // store does not remove it.
    if (paths.sockets !== paths.sessions) fs.rmSync(paths.sockets, { recursive: true, force: true });
  });
  await waitUntil(async () => {
    const client = new SessionClient({ socketPath: paths.socket });
    try { return (await client.request('health')).ok; } catch { return false; } finally { client.close(); }
  });
  return { paths, env };
}

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

test('sockets stay beside their state when the store fits, and relocate per-store when it cannot', { skip: process.platform === 'win32' && 'AF_UNIX path relocation has no win32 analogue; named pipes have no sun_path limit' }, () => {
  const shallow = fs.mkdtempSync(path.join(realTmpDir(), 'sd-fits-'));
  cleanups.push(async () => fs.rmSync(shallow, { recursive: true, force: true }));

  // Two-sided on purpose. A relocation that always fired would pass a test that
  // only checked the deep case, while silently moving every real user's sockets
  // off the durable store and into a runtime directory wiped at logout.
  const fitting = resolvePaths({ HARBOR_SESSIOND_DIR: shallow });
  assert.equal(fitting.sockets, fitting.sessions, 'a store that fits keeps its sockets');

  const deep = deepStore('sd-deep-');
  const relocated = resolvePaths({ HARBOR_SESSIOND_DIR: deep, XDG_RUNTIME_DIR: '/run/user/1000' });
  assert.notEqual(relocated.sockets, relocated.sessions, 'a store that cannot hold a socket relocates');
  assert.ok(socketFits(path.join(relocated.sockets, `${'0'.repeat(36)}.sock`)), 'the relocation actually fits');
  assert.ok(!socketFits(path.join(relocated.sessions, `${'0'.repeat(36)}.sock`)), 'the store genuinely did not fit');

  // A relocated harness must never bind into the same directory as the real
  // daemon: a shared resource NAME is an ambient channel (the 2026-07-29
  // unit-name lesson, arriving here as a socket path).
  const otherDeep = deepStore('sd-deep-other-');
  const otherRelocated = resolvePaths({ HARBOR_SESSIOND_DIR: otherDeep, XDG_RUNTIME_DIR: '/run/user/1000' });
  assert.notEqual(otherRelocated.sockets, relocated.sockets, 'two stores never share a socket directory');

  const pinned = resolvePaths({ HARBOR_SESSIOND_DIR: deep, HARBOR_SESSIOND_SOCKET_DIR: '/tmp/pinned-sockets' });
  assert.equal(pinned.sockets, '/tmp/pinned-sockets', 'an explicit socket dir wins');
});

test('a store too deep for a socket still spawns a real session', { skip: process.platform === 'win32' && 'AF_UNIX path-length relocation is POSIX-only' }, async () => {
  const deep = deepStore('sd-spawn-');
  const naive = path.join(deep, 'sessions', `${'0'.repeat(36)}.sock`);
  assert.ok(Buffer.byteLength(naive) > SUN_PATH_MAX, `fixture must overflow: ${Buffer.byteLength(naive)} bytes`);

  const daemon = await runningDaemon(deep);
  const client = new SessionClient({ socketPath: daemon.paths.socket });
  cleanups.push(async () => client.close());

  const spawned = await client.request('spawn', {
    argv: ['bash', '-lc', 'echo DEEP_STORE_OK; sleep 30'],
    cwd: os.tmpdir(),
    env: { PATH: process.env.PATH, TERM: 'xterm-256color' },
    cols: 120,
    rows: 60,
  });
  assert.ok(spawned.id, 'spawn returned a session id');

  // The exact path has to exist. Under the bug `listen` succeeded and the file
  // landed truncated, so an existence check on the FULL name is the assertion
  // that fails when this regresses.
  const socketPath = path.join(daemon.paths.sockets, `${spawned.id}.sock`);
  assert.ok(fs.existsSync(socketPath), 'the keeper socket exists at its exact path');

  await waitUntil(async () => ((await client.request('screen', { id: spawned.id })).text || '').includes('DEEP_STORE_OK'));
  const info = await client.request('process', { id: spawned.id });
  assert.equal(info.running, true, 'the pty is live, not just spawned');
  await client.request('terminate', { id: spawned.id, signal: 'SIGKILL' });
});

test('a socket path that cannot fit is refused at once, naming the limit', { skip: process.platform === 'win32' && 'named pipes do not have the AF_UNIX sun_path limit' }, async () => {
  const base = fs.mkdtempSync(path.join(realTmpDir(), 'sd-refuse-'));
  cleanups.push(async () => fs.rmSync(base, { recursive: true, force: true }));
  const tooDeep = path.join(base, 'x'.repeat(80));
  fs.mkdirSync(tooDeep, { recursive: true });

  const daemon = await runningDaemon(base, { HARBOR_SESSIOND_SOCKET_DIR: tooDeep });
  const client = new SessionClient({ socketPath: daemon.paths.socket });
  cleanups.push(async () => client.close());

  const started = Date.now();
  await assert.rejects(
    client.request('spawn', {
      argv: ['bash', '-lc', 'sleep 5'], cwd: os.tmpdir(), env: { PATH: process.env.PATH }, cols: 80, rows: 24,
    }),
    (error) => {
      assert.match(error.message, /over the 108 byte AF_UNIX limit/);
      assert.match(error.message, /HARBOR_SESSIOND_SOCKET_DIR/, 'the refusal says how to fix it');
      assert.doesNotMatch(error.message, /timed out/, 'a refusal is not a timeout');
      return true;
    },
  );
  assert.ok(Date.now() - started < 2000, 'the refusal is immediate, not a 10 second deadline');
});

test('a keeper that dies during startup reports its own error instead of a timeout', { skip: process.platform === 'win32' && 'the POSIX fixture removes a socket directory; named pipes have no parent directory' }, async () => {
  const base = fs.mkdtempSync(path.join(realTmpDir(), 'sd-crash-'));
  cleanups.push(async () => fs.rmSync(base, { recursive: true, force: true }));
  const socketDir = path.join(base, 'sk');

  const daemon = await runningDaemon(base, { HARBOR_SESSIOND_SOCKET_DIR: socketDir });
  const client = new SessionClient({ socketPath: daemon.paths.socket });
  cleanups.push(async () => client.close());

  // Rip the socket directory out from under the keeper so its listen() fails.
  // Any startup crash would do; this one is reproducible without patching code.
  fs.rmSync(socketDir, { recursive: true, force: true });

  const started = Date.now();
  await assert.rejects(
    client.request('spawn', {
      argv: ['bash', '-lc', 'sleep 5'], cwd: os.tmpdir(), env: { PATH: process.env.PATH }, cols: 80, rows: 24,
    }),
    (error) => {
      assert.match(error.message, /keeper exited during startup/);
      assert.match(error.message, /listen (ENOENT|EACCES)/, 'the keeper\'s own error reaches the caller');
      assert.match(error.message, /keeper\.js/, 'and so does the file that threw');
      return true;
    },
  );
  assert.ok(Date.now() - started < 5000, 'a dead keeper is detected by its exit, not by waiting out a deadline');
});

test('win32 derives one connectable pipe address and refuses a second bind', { skip: process.platform !== 'win32' && 'named-pipe bind semantics are win32-only' }, async () => {
  const base = fs.mkdtempSync(path.join(realTmpDir(), 'sd-pipe-'));
  cleanups.push(async () => fs.rmSync(base, { recursive: true, force: true }));
  const socketPath = path.join(base, 'keeper.sock');
  const address = listenAddress(socketPath);
  const owner = require('node:net').createServer((socket) => socket.end('ok'));
  await new Promise((resolve, reject) => owner.once('error', reject).listen(address, resolve));
  cleanups.push(async () => new Promise((resolve) => owner.close(resolve)));

  const reply = await new Promise((resolve, reject) => {
    const socket = require('node:net').createConnection(address);
    let text = '';
    socket.on('data', (chunk) => { text += chunk; });
    socket.once('end', () => resolve(text));
    socket.once('error', reject);
  });
  assert.equal(reply, 'ok', 'the derived address is the address clients can actually reach');
  assert.equal(fs.existsSync(socketPath), false, 'a live named pipe leaves no socket file');

  const contender = require('node:net').createServer();
  await assert.rejects(
    new Promise((resolve, reject) => contender.once('error', reject).listen(address, resolve)),
    /EADDRINUSE/,
    'the pipe namespace refuses a second owner of the same derived address',
  );
});
