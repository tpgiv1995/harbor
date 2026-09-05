'use strict';
const { execPath: guiNodeExec } = require('../support/gui-node.js');

// THE SWEEP KILLS MANAGED ORPHANS AND NOTHING ELSE. The audit that preceded
// this code proved the failure mode live: a naive parent-is-dead test flags
// the daemon's own keepers after a legitimate daemon restart, plus half of
// Windows. Every spec here is two-sided for that reason: each kill assertion
// travels with a survival assertion under the same conditions, because a
// sweep that kills everything passes any kill-only spec and a sweep that
// never fires passes any survival-only spec.

const { afterEach, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const {
  resolveOrphanPolicy, parseProcessTable, findManagedOrphans, findDeadPtySessions, decideKills, sweepOrphans, DEFAULT_PATTERNS,
} = require('../../src/daemon/orphan-sweep.js');
const { SessionClient } = require('../../src/daemon/client.js');

const ROOT = path.resolve(__dirname, '../..');
const DAEMON = path.join(ROOT, 'src/daemon/daemon.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const cleanups = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()(); });

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

const T = (rows) => {
  const table = new Map();
  for (const r of rows) table.set(r.pid, { ppid: r.ppid, command: r.cmd, created: r.created });
  return table;
};

test('1. the orphan test: pattern scope, recycled pids, and unreadable facts all refuse correctly', () => {
  const MCP = 'node C:\\Users\\x\\.local\\lib\\mcp-servers\\node_modules\\some\\server.js';
  const table = T([
    { pid: 100, ppid: 1, cmd: 'C:\\Windows\\explorer.exe', created: 50 },            // orphan, NOT managed
    { pid: 200, ppid: 999, cmd: MCP, created: 50 },                                   // managed, parent missing -> orphan
    { pid: 300, ppid: 100, cmd: MCP, created: 60 },                                   // managed, parent alive and older -> NOT orphan
    { pid: 400, ppid: 500, cmd: MCP, created: 50 },                                   // managed, parent RECYCLED (younger) -> orphan
    { pid: 500, ppid: 1, cmd: 'whatever.exe', created: 90 },
    { pid: 600, ppid: 700, cmd: MCP, created: 50 },                                   // managed, parent age unreadable -> refuse
    { pid: 700, ppid: 1, cmd: 'x.exe', created: 0 },
    { pid: 800, ppid: 999, cmd: MCP, created: 0 },                                    // own age unreadable -> refuse
  ]);
  const orphans = findManagedOrphans(table, DEFAULT_PATTERNS);
  assert.deepEqual(orphans.map((o) => o.pid).sort(), [200, 400],
    'exactly the managed true orphans: never the unmanaged one, the parented one, or the unreadable ones');
});

test('2. hysteresis: one sighting is never a kill, two consecutive are, and a vanished suspect is forgotten', () => {
  const suspects = new Map();
  const orphan = { pid: 42, created: 7, command: 'x' };
  assert.deepEqual(decideKills([orphan], suspects), [], 'first sighting only counts');
  assert.deepEqual(decideKills([orphan], suspects).map((k) => k.pid), [42], 'second consecutive sighting kills');
  decideKills([], suspects);
  assert.equal(suspects.size, 0, 'a suspect that stopped appearing is dropped, not remembered forever');
  // A recycled pid with a NEW creation time is a NEW suspect, not sighting #2.
  decideKills([orphan], suspects);
  assert.deepEqual(decideKills([{ pid: 42, created: 8, command: 'x' }], suspects), [],
    'same pid reborn with a different birth time restarts the count');
});

test('3. the parseable and the broken process table', () => {
  const rows = [{ ProcessId: 5, ParentProcessId: 1, CommandLine: 'a', Created: 10 }];
  assert.equal(parseProcessTable(JSON.stringify(rows)).get(5).created, 10);
  assert.equal(parseProcessTable(JSON.stringify(rows[0])).size, 1, 'a single row unwrapped by ConvertTo-Json still parses');
  assert.equal(parseProcessTable('garbage'), null);
  assert.equal(parseProcessTable('[]'), null);
});

test('4. policy: off unless win32, off on 0, patterns overridable', () => {
  const on = resolveOrphanPolicy({});
  assert.equal(on.enabled, process.platform === 'win32');
  assert.equal(resolveOrphanPolicy({ HARBOR_SESSIOND_ORPHAN_INTERVAL_MS: '0' }).enabled, false);
  const custom = resolveOrphanPolicy({ HARBOR_SESSIOND_ORPHAN_PATTERNS: 'my-marker-dir' });
  assert.equal(custom.patterns.length, 1);
  assert.ok(custom.patterns[0].test('node C:\\tmp\\my-marker-dir\\svc.js'));
});

test('4b. dead-pty detection: absent and recycled pids are dead, live and young and unreadable are not', () => {
  const now = Date.parse('2026-08-20T12:00:00Z');
  const FT = (epochMs) => (epochMs + 11644473600000) * 10000; // epoch ms -> FileTime
  const startedAt = new Date(now - 10 * 60_000).toISOString(); // sessions 10 min old
  const table = T([
    { pid: 10, ppid: 1, cmd: 'x', created: FT(now - 11 * 60_000) },  // born before the session: the real child
    { pid: 20, ppid: 1, cmd: 'x', created: FT(now - 2 * 60_000) },   // born AFTER the session: a recycled pid
    { pid: 30, ppid: 1, cmd: 'x', created: 0 },                      // unreadable birth: refuse
  ]);
  const sessions = [
    { id: 'live', pid: 10, exit: null, created_at: startedAt },
    { id: 'recycled', pid: 20, exit: null, created_at: startedAt },
    { id: 'gone', pid: 40, exit: null, created_at: startedAt },
    { id: 'unreadable', pid: 30, exit: null, created_at: startedAt },
    { id: 'young', pid: 41, exit: null, created_at: new Date(now - 3000).toISOString() },
    { id: 'exited', pid: 42, exit: { code: 0 }, created_at: startedAt },
  ];
  const dead = findDeadPtySessions(table, sessions, now);
  assert.deepEqual(dead.map((d) => d.id).sort(), ['gone', 'recycled'],
    'dead means provably dead: an absent pid or a stranger wearing it, never a live child, a fresh spawn, an unreadable row, or an already-exited session');
});

test('5b. end to end: a session whose exit event was lost AND whose pid the keeper cannot judge is reaped by the daemon sweep, while a live one survives', {
  skip: process.platform !== 'win32' && 'windows-only sweep',
  timeout: 90_000,
}, async () => {
  // The harness-churn shape: onExit dropped (the deterministic seam) and the
  // keeper's own child watch effectively blind (interval set far beyond the
  // spec's horizon). Only the daemon's table-verified reap can learn the
  // truth, through the keeper's terminate verb.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deadpty-'));
  const socketPath = path.join(dir, 'daemon.sock');
  const daemon = spawn(guiNodeExec, [DAEMON], {
    windowsHide: true,
    env: {
      ...process.env,
      HARBOR_SESSIOND_DIR: dir,
      HARBOR_SESSIOND_SOCKET: socketPath,
      HARBOR_SESSIOND_TEST_DROP_PTY_EXIT: '1',
      HARBOR_SESSIOND_CHILD_WATCH_MS: '600000',
      HARBOR_SESSIOND_ORPHAN_INTERVAL_MS: '700',
      // The dead-pty reap ignores sessions younger than 10s; keep the spec
      // honest about that wait rather than tuning it away.
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
  const deadSess = await client.request('spawn', { argv: [comspec, '/d', '/c', 'exit 7'], cwd: os.tmpdir(), env: childEnv, cols: 80, rows: 24 });
  const liveSess = await client.request('spawn', { argv: [comspec, '/d', '/c', 'ping -n 600 127.0.0.1 > NUL'], cwd: os.tmpdir(), env: childEnv, cols: 80, rows: 24 });

  const found = await (async () => {
    const until = Date.now() + 45_000; // 10s youth guard + snapshots + two sightings + terminate
    while (Date.now() < until) {
      const listed = await client.request('list');
      const row = listed.sessions.find((s) => s.id === deadSess.id);
      if (row && row.exit) return row.exit;
      await sleep(300);
    }
    return null;
  })();
  assert.ok(found, `the daemon must reap a session whose child the process table proves dead: ${stderr}`);
  assert.equal(found.code, null, 'a reaped exit never fabricates a code');

  const after = await client.request('list');
  const liveRow = after.sessions.find((s) => s.id === liveSess.id);
  assert.ok(liveRow && liveRow.exit === null, 'the session with a genuinely live child must survive every sweep');
});

test('5. end to end on real processes: the managed orphan dies with its child, the unmanaged orphan and the parented twin survive', {
  skip: process.platform !== 'win32' && 'windows-only sweep',
  timeout: 60_000,
}, async () => {
  // Real orphans: an intermediary spawns a detached marker child and exits.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orphan-sweep-'));
  cleanups.push(() => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }); } catch {} });
  const managedDir = path.join(dir, 'fake-mcp-marker');
  fs.mkdirSync(managedDir);
  const idler = path.join(managedDir, 'idler.js');
  // The managed idler spawns ITS OWN child, so the tree-kill half is provable.
  fs.writeFileSync(idler, `
    const { spawn } = require('node:child_process');
    const fs = require('node:fs');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
    fs.writeFileSync(process.argv[2], JSON.stringify({ pid: process.pid, child: child.pid }));
    setInterval(() => {}, 1000);
  `);
  const plainIdler = path.join(dir, 'plain-idler.js');
  fs.writeFileSync(plainIdler, `
    require('node:fs').writeFileSync(process.argv[2], JSON.stringify({ pid: process.pid }));
    setInterval(() => {}, 1000);
  `);

  const orphanOf = async (script, marker) => {
    const markerPath = path.join(dir, marker);
    const mid = spawn(guiNodeExec, ['-e', `
      const { spawn } = require('node:child_process');
      spawn(process.execPath, [${JSON.stringify(script)}, ${JSON.stringify(markerPath)}], { stdio: 'ignore', detached: true, windowsHide: true }).unref();
      setTimeout(() => process.exit(0), 300);
    `], { stdio: 'ignore' });
    await new Promise((resolve) => mid.once('exit', resolve));
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(markerPath)) {
      if (Date.now() > deadline) throw new Error(`marker never appeared: ${marker}`);
      await sleep(50);
    }
    return JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  };

  const managed = await orphanOf(idler, 'managed.json');       // orphan, matches pattern
  const unmanaged = await orphanOf(plainIdler, 'plain.json');  // orphan, does NOT match
  // The parented twin: same managed path, but ITS PARENT IS THIS TEST, alive.
  const parented = spawn(guiNodeExec, [idler, path.join(dir, 'parented.json')], { stdio: 'ignore', windowsHide: true });
  cleanups.push(() => {
    try { parented.kill(); } catch {}
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(dir, 'parented.json'), 'utf8'));
      if (rec.child) { try { process.kill(rec.child); } catch {} }
    } catch {}
  });
  for (const record of [managed, unmanaged]) {
    cleanups.push(() => { for (const pid of [record.pid, record.child].filter(Boolean)) { try { process.kill(pid); } catch {} } });
  }
  await sleep(300);
  assert.ok(alive(managed.pid) && alive(unmanaged.pid), 'both orphans are really running before the sweep');

  const policy = resolveOrphanPolicy({ HARBOR_SESSIOND_ORPHAN_PATTERNS: 'fake-mcp-marker' });
  const suspects = new Map();
  const logs = [];
  const run = () => sweepOrphans({ policy, suspects, log: (m) => logs.push(m) });

  await run();
  assert.ok(alive(managed.pid), 'HYSTERESIS: the first sighting must not kill');
  await run();
  const deadline = Date.now() + 8000;
  while (alive(managed.pid) && Date.now() < deadline) await sleep(100);
  assert.ok(!alive(managed.pid), 'the managed orphan dies on the second sighting');
  assert.ok(!alive(managed.child), 'and the tree-kill takes its child with it');
  assert.ok(alive(unmanaged.pid), 'the unmanaged orphan is untouchable whatever its parent looks like');
  assert.ok(alive(parented.pid), 'the managed process with a LIVE parent is untouchable');
  assert.ok(logs.some((l) => l.includes(`orphan-kill pid=${managed.pid}`)), 'every kill leaves a log line');
});
