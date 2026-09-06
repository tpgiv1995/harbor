'use strict';
const { execPath: guiNodeExec } = require('../support/gui-node.js');

// A LOST PTY EXIT EVENT MUST NOT LEAVE A FOREVER-LIVE SESSION (2026-08-20).
// ConPTY drops onExit for instant-exit children about one run in three on
// this machine (found by the exit-log spec flaking on exactly that), and a
// keeper that never learns its child died reports a dead session as live
// for as long as it runs. The seam (HARBOR_SESSIOND_TEST_DROP_PTY_EXIT)
// makes the lost event deterministic instead of a race to be won; the
// keeper's child watch must then record the honest verified-gone exit. Two
// sides in one harness: the dead child is found, and a LIVE child under the
// same dropped event and the same fast watch is never falsely declared dead.

const { afterEach, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { SessionClient } = require('../../src/daemon/client.js');

const ROOT = path.resolve(__dirname, '../..');
const DAEMON = path.join(ROOT, 'src/daemon/daemon.js');
const cleanups = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(async () => { while (cleanups.length) await cleanups.pop()(); });

test('a child whose exit event never fires is found dead by the keeper watch, and a live child never is', { timeout: 60_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-lostexit-'));
  const socketPath = path.join(dir, 'daemon.sock');
  const daemon = spawn(guiNodeExec, [DAEMON], {
    windowsHide: true,
    env: {
      ...process.env,
      HARBOR_SESSIOND_DIR: dir,
      HARBOR_SESSIOND_SOCKET: socketPath,
      HARBOR_SESSIOND_TEST_DROP_PTY_EXIT: '1',
      HARBOR_SESSIOND_CHILD_WATCH_MS: '300',
      HARBOR_NO_DAEMON_START: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  daemon.stderr.on('data', (chunk) => { stderr += chunk; });
  const client = new SessionClient({ socketPath });
  cleanups.push(async () => {
    try {
      const listed = await client.request('list');
      for (const s of listed.sessions) await client.request('terminate', { id: s.id, signal: 'SIGKILL' }).catch(() => {});
    } catch {}
    client.close();
    if (daemon.exitCode === null) { daemon.kill('SIGTERM'); await new Promise((r) => daemon.once('exit', r)); }
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }); } catch {}
  });
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const probe = new SessionClient({ socketPath });
      const result = await probe.request('health');
      probe.close();
      if (result.ok) break;
    } catch {}
    if (Date.now() > deadline) throw new Error(`daemon never answered: ${stderr}`);
    await sleep(50);
  }

  const childEnv = {};
  for (const key of ['SystemRoot', 'PATH', 'PATHEXT', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE']) {
    if (process.env[key]) childEnv[key] = process.env[key];
  }
  const comspec = process.env.COMSPEC || 'C:\\Windows\\System32\\cmd.exe';
  const instant = process.platform === 'win32'
    ? [comspec, '/d', '/c', 'exit 7']
    : ['/bin/sh', '-c', 'exit 7'];
  const longLived = process.platform === 'win32'
    ? [comspec, '/d', '/c', 'ping -n 600 127.0.0.1 > NUL']
    : ['/bin/sh', '-c', 'sleep 600'];

  const dead = await client.request('spawn', { argv: instant, cwd: os.tmpdir(), env: childEnv, cols: 80, rows: 24 });
  const live = await client.request('spawn', { argv: longLived, cwd: os.tmpdir(), env: childEnv, cols: 80, rows: 24 });

  // The dead child must be FOUND: exit recorded with the watch's reason,
  // despite onExit never firing.
  const found = await (async () => {
    const until = Date.now() + 20_000;
    while (Date.now() < until) {
      const listed = await client.request('list');
      const row = listed.sessions.find((s) => s.id === dead.id);
      if (row && row.exit) return row.exit;
      await sleep(200);
    }
    return null;
  })();
  assert.ok(found, `the dead child's session must not stay live forever: ${stderr}`);
  assert.match(found.reason || '', /found dead by the keeper watch/,
    'the record must say HOW this exit was learned, because nobody watched it die');
  assert.equal(found.code, null, 'a synthesized exit never fabricates a code');

  // The live child, under the SAME dropped event and the same 300ms watch,
  // has now survived many watch periods; it must not have been declared dead.
  const after = await client.request('list');
  const liveRow = after.sessions.find((s) => s.id === live.id);
  assert.ok(liveRow, 'the live session must still be listed');
  assert.equal(liveRow.exit, null, 'a live child must NEVER be found dead by the watch');
});
