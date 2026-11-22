'use strict';

// --help AND -h ACT ON NOTHING (2026-11-22). A session ran
// `harbor-sessiond handover --help` expecting help, and the CLI, which read no
// help flag at all, ignored the unknown flag and PERFORMED a live daemon
// handover. Every subcommand must answer --help and -h with usage alone: no
// daemon request, no store write, no process started or stopped.
//
// The seam: the CLI runs against a RELOCATED store whose pipe is held by an
// in-test stub that answers every verb as a healthy daemon would, so a
// subcommand that ignores the flag reaches the stub (and is counted) instead
// of anything real. The stub never stands in for the user's daemon: the spec
// asserts its address differs from the default store's before anything runs.
// Two-sided on purpose: the controls at the bottom show the same stub DOES
// see a plain request, and that a --help after spawn's `--` still belongs to
// the child command.

const { afterEach, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { execPath: guiNodeExec } = require('../support/gui-node.js');
const { realTmpDir } = require('../support/real-tmpdir.js');
const { resolvePaths, listenAddress } = require('../../src/daemon/paths.js');
const { readRecords, writeRecord } = require('../../src/daemon/ndjson.js');

const CLI = path.resolve(__dirname, '../../../bin/harbor-sessiond');

const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

function defaultSocketAddress() {
  const env = { ...process.env };
  delete env.HARBOR_SESSIOND_DIR;
  delete env.HARBOR_SESSIOND_SOCKET;
  const saved = process.env;
  process.env = env;
  try { return listenAddress(resolvePaths().socket); } finally { process.env = saved; }
}

// A healthy-looking daemon that does nothing but record what reached it.
async function stubDaemon() {
  const store = fs.mkdtempSync(path.join(realTmpDir(), 'hbr-sessiond-help-'));
  const socket = path.join(store, 'daemon.sock');
  assert.notEqual(listenAddress(socket), defaultSocketAddress(), 'the stub must never share the user daemon address');
  const seen = { connections: 0, verbs: [] };
  const sockets = new Set();
  const server = net.createServer((conn) => {
    seen.connections += 1;
    sockets.add(conn);
    conn.on('close', () => sockets.delete(conn));
    conn.on('error', () => {});
    readRecords(conn, (record) => {
      seen.verbs.push({ verb: record.verb, params: record.params });
      const results = { health: { ok: true, pid: null, sessions: 0 }, list: [], logs: { text: '' }, spawn: { id: 'stub' } };
      writeRecord(conn, { request_id: record.request_id, ok: true, result: results[record.verb] ?? { ok: true } });
    }, () => {});
  });
  await new Promise((resolve) => server.listen(listenAddress(socket), resolve));
  cleanups.push(async () => {
    for (const conn of sockets) conn.destroy();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(store, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  const env = {
    ...process.env,
    HARBOR_SESSIOND_DIR: store,
    HARBOR_SESSIOND_SOCKET: socket,
    HARBOR_NO_DAEMON_START: '1',
    HARBOR_SESSIOND_PARENT_PID: String(process.pid),
    HARBOR_SESSIOND_PIPE_RELEASE_TIMEOUT_MS: '200',
    HARBOR_SESSIOND_YIELD_DRAIN_MS: '0',
    HARBOR_SESSIOND_RECOVER_CONFIRM_MS: '0',
    HARBOR_SESSIOND_READY_TIMEOUT_MS: '1000',
    HARBOR_SESSIOND_REQUEST_TIMEOUT_MS: '2000',
  };
  return { store, socket, env, seen };
}

function listTree(dir) {
  const out = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      out.push(path.relative(dir, full));
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(dir);
  return out.sort();
}

// Async on purpose: the stub answers from THIS event loop, so a spawnSync
// would block it and turn every reached verb into a timeout.
function runCli(args, env, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const child = spawn(guiNodeExec, [CLI, ...args], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, timeoutMs);
    child.on('close', (status, signal) => { clearTimeout(timer); resolve({ status, signal, stdout, stderr }); });
  });
}

const SUBCOMMANDS = ['start', 'stop', 'handover', 'recover', 'serve', 'status', 'list', 'logs', 'kill', 'spawn'];
const HELP_CASES = [];
for (const command of SUBCOMMANDS) {
  for (const flag of ['--help', '-h']) {
    HELP_CASES.push([command, flag]);
    HELP_CASES.push([command, '--json', flag]);
  }
}
HELP_CASES.push(['kill', 'some-id', '--help']);
HELP_CASES.push(['logs', '--lines', '5', '-h']);
HELP_CASES.push(['spawn', '--cwd', '.', '--help', '--', 'node', '-e', '1']);
HELP_CASES.push(['--help']);
HELP_CASES.push(['-h']);

for (const args of HELP_CASES) {
  test(`harbor-sessiond ${args.join(' ')} prints usage and acts on nothing`, { timeout: 30000 }, async () => {
    const stub = await stubDaemon();
    const before = listTree(stub.store);
    const result = await runCli(args, stub.env);
    assert.equal(result.signal, null, `the CLI had to be killed: ${result.stderr}`);
    assert.equal(stub.seen.connections, 0, `reached the daemon: ${JSON.stringify(stub.seen.verbs)}`);
    assert.deepEqual(listTree(stub.store), before, 'wrote to the store');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /usage: harbor-sessiond/);
  });
}

test('control: the same stub does see a plain request', { timeout: 30000 }, async () => {
  const stub = await stubDaemon();
  const result = await runCli(['status', '--json'], stub.env);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(stub.seen.verbs.map((entry) => entry.verb), ['health']);
});

test('control: a --help after spawn\'s -- belongs to the child command', { timeout: 30000 }, async () => {
  const stub = await stubDaemon();
  const result = await runCli(['spawn', '--cwd', '.', '--', 'node', '--help'], stub.env);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(stub.seen.verbs.map((entry) => entry.verb), ['spawn']);
  assert.deepEqual(stub.seen.verbs[0].params.argv, ['node', '--help']);
});

test('bare subcommands that need arguments still refuse as before', { timeout: 30000 }, async () => {
  for (const args of [['kill'], ['spawn'], []]) {
    const stub = await stubDaemon();
    const result = await runCli(args, stub.env);
    assert.equal(result.status, 2, `${args.join(' ')}: ${result.stderr}`);
    assert.match(result.stderr, /usage: harbor-sessiond/);
    assert.equal(stub.seen.connections, 0);
  }
});
