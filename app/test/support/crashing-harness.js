'use strict';
// A harness that CRASHES: starts an isolated daemon the ordinary way (a
// non-detached child with piped stdio, exactly how the suites and the proof
// scripts do it), spawns one long-lived session, writes the pids it made, and
// exits with no teardown at all. On Windows, libuv's job object takes the
// daemon down the instant this process exits, before the daemon's own
// harness watch can poll, so whatever survives is what the KEEPER did about it.
//
//   node crashing-harness.js <store dir>
// Writes <store>/pids.json = { daemon, child, session }.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { SessionClient } = require('../../src/daemon/client.js');

const store = process.argv[2];
const socketPath = path.join(store, 'daemon.sock');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const env = {
    ...process.env,
    HARBOR_SESSIOND_DIR: store,
    HARBOR_SESSIOND_SOCKET: socketPath,
    HARBOR_NO_DAEMON_START: '1',
    HARBOR_SESSIOND_PARENT_POLL_MS: process.env.HARBOR_SESSIOND_PARENT_POLL_MS || '150',
  };
  const daemon = spawn(process.execPath, [path.resolve(__dirname, '../../src/daemon/daemon.js')], { windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
  daemon.stderr.on('data', () => {});
  daemon.stdout.on('data', () => {});
  const deadline = Date.now() + 10000;
  for (;;) {
    try { const probe = new SessionClient({ socketPath }); const r = await probe.request('health'); probe.close(); if (r.ok) break; } catch { /* not yet */ }
    if (Date.now() > deadline) { console.error('daemon never answered'); process.exit(2); }
    await sleep(50);
  }
  const client = new SessionClient({ socketPath });
  const childEnv = {};
  for (const key of ['SystemRoot', 'PATH', 'PATHEXT', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE']) if (process.env[key]) childEnv[key] = process.env[key];
  const argv = process.platform === 'win32'
    ? [process.env.COMSPEC || 'cmd.exe', '/d', '/k', 'echo crash-canary']
    : ['/bin/sleep', '300'];
  const spawned = await client.request('spawn', { argv, cwd: store, env: childEnv, cols: 80, rows: 24 });
  const listed = await client.request('list');
  const session = listed.sessions.find((s) => s.id === spawned.id);
  fs.writeFileSync(path.join(store, 'pids.json'), JSON.stringify({ daemon: daemon.pid, child: session.pid, session: spawned.id }));
  process.exit(1); // the crash: no terminate, no daemon.kill, no cleanup
})().catch((error) => { console.error('crashing-harness failed before crashing:', error.message); process.exit(2); });
