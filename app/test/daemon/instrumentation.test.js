'use strict';

// Two silent daemon deaths on 2026-08-14 left no process verdict and erased
// the only evidence that could distinguish a signal, an abort, and memory
// growth. These specs drive the detached CLI path against relocated stores,
// because that is the Windows production path and the place an orphaned
// watcher would accumulate across interrupted harness runs.

const { afterEach, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { SessionClient } = require('../../src/daemon/client.js');

const ROOT = path.resolve(__dirname, '../../..');
const CLI = path.join(ROOT, 'bin/harbor-sessiond');
const stores = [];
const processes = new Set();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

function startHarness(intervalMs = 25) {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'hbr-instrument-'));
  stores.push(store);
  const env = {
    ...process.env,
    HARBOR_SESSIOND_DIR: store,
    HARBOR_SESSIOND_SOCKET: path.join(store, 'daemon.sock'),
    HARBOR_SESSIOND_RSS_INTERVAL_MS: String(intervalMs),
    HARBOR_SESSIOND_READY_TIMEOUT_MS: '10000',
    // These specs pin EXIT CAPTURE, the watcher's original duty, so the
    // supervisor's respawn lane (2026-08-30) is opted out: a respawned daemon
    // here would resurrect what spec 1 just killed and leak past teardown.
    // The respawn/wedge lanes are pinned by test/daemon/self-heal.test.js.
    HARBOR_SESSIOND_RESPAWN_MAX: '0',
  };
  const result = JSON.parse(execFileSync(process.execPath, [CLI, 'start', '--json'], { env, encoding: 'utf8', timeout: 15000 }));
  assert.equal(result.started, true);
  assert.ok(result.pid > 1, 'start must identify the daemon, not only its watcher');
  assert.ok(result.watcherPid > 1, 'detached start must identify its watcher');
  processes.add(result.pid);
  processes.add(result.watcherPid);
  return { ...result, env, log: path.join(store, 'sessiond.log') };
}

async function waitFor(read, predicate, message, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (predicate(value)) return value;
    await sleep(25);
  }
  assert.fail(message);
}

const readLog = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };
const rssLines = (text) => text.split('\n').filter((line) => / rss pid=/.test(line));

afterEach(async () => {
  for (const pid of processes) {
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
  processes.clear();
  await sleep(50);
  for (const store of stores.splice(0)) fs.rmSync(store, { recursive: true, force: true });
});

test('a killed daemon names its signal or code in its relocated store log', { timeout: 20000 }, async () => {
  const run = startHarness();
  process.kill(run.pid, 'SIGKILL');
  const log = await waitFor(
    () => readLog(run.log),
    (text) => new RegExp(`daemon exit pid=${run.pid} code=(?:null|[0-9]+) signal=(?:SIGKILL|none).* kind=crash`).test(text),
    'watcher did not record the killed daemon verdict',
  );
  assert.match(log, /uptime_ms=\d+ kind=crash/);
});

test('a clean daemon stop is identified as clean and never as a crash', { timeout: 20000 }, async () => {
  const run = startHarness();
  const client = new SessionClient({ socketPath: run.env.HARBOR_SESSIOND_SOCKET });
  try { await client.request('shutdown'); } finally { client.close(); }
  const log = await waitFor(
    () => readLog(run.log),
    (text) => text.includes(`daemon exit pid=${run.pid}`),
    'watcher did not record the clean daemon stop',
  );
  assert.match(log, new RegExp(`daemon exit pid=${run.pid} code=(?:0|1) signal=none .*kind=clean`));
  assert.doesNotMatch(log, new RegExp(`daemon exit pid=${run.pid}.*kind=crash`));
});

test('rss samples repeat at the override and stop with the daemon', { timeout: 20000 }, async () => {
  const run = startHarness(20);
  const before = await waitFor(
    () => readLog(run.log),
    (text) => rssLines(text).length >= 3,
    'daemon did not write repeated rss samples',
  );
  assert.match(before, new RegExp(`rss pid=${run.pid} rss_bytes=\\d+ heap_used_bytes=\\d+ sessions=0`));
  process.kill(run.pid, 'SIGTERM');
  await waitFor(() => alive(run.watcherPid), (value) => !value, 'watcher did not finish after daemon stop');
  const count = rssLines(readLog(run.log)).length;
  await sleep(100);
  assert.equal(rssLines(readLog(run.log)).length, count, 'rss sampling continued after daemon stop');
});

test('the watcher count returns from one to zero when its daemon dies', { timeout: 20000 }, async () => {
  const run = startHarness();
  assert.equal([run.watcherPid].filter(alive).length, 1);
  process.kill(run.pid, 'SIGKILL');
  await waitFor(() => [run.watcherPid].filter(alive).length, (count) => count === 0, 'watcher became an orphan');
  assert.equal([run.watcherPid].filter(alive).length, 0);
});
