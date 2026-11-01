'use strict';
const { test } = require('./support.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { once } = require('node:events');
const source = path.resolve(__dirname, '../../src/shared/lane');
const worker = path.join(__dirname, 'worker.cjs');
function fresh() {
  for (const file of Object.keys(require.cache)) if (file.startsWith(source + path.sep)) delete require.cache[file];
  return { Pool: require(source + '/pool.cjs').Pool, ids: require(source + '/identity.cjs'), ws: require(source + '/workspace.cjs'), Store: require(source + '/store.cjs').Store };
}
function fixture(t, lib = fresh(), size = 2) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'harbor-lane-r2-'));
  const repo = path.join(root, 'repo'); const poolRoot = path.join(root, 'pool'); const dir = path.join(root, 'state');
  fs.mkdirSync(repo); fs.mkdirSync(poolRoot);
  const env = { ...process.env, HARBOR_LANES_DIR: dir, HARBOR_NO_DAEMON_START: '1', HARBOR_SESSIOND_DIR: path.join(root, 'unused-daemon'), HARBOR_LANES_LOCK_WAIT_MS: '5000' };
  const prior = Object.fromEntries(['HARBOR_LANES_DIR', 'HARBOR_NO_DAEMON_START', 'HARBOR_SESSIOND_DIR'].map(key => [key, process.env[key]]));
  for (const key of Object.keys(prior)) process.env[key] = env[key];
  t.after(() => { for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
  const g = args => lib.ws.git(repo, args);
  g(['init', '-b', 'main']); g(['config', 'user.name', 'Synthetic']); g(['config', 'user.email', 'test@example.invalid']);
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'synthetic\n'); fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n');
  fs.writeFileSync(path.join(repo, 'package-lock.json'), '{}\n'); g(['add', '.']); g(['commit', '-qm', 'Synthetic base']);
  const pool = new lib.Pool({ dir }); pool.init({ repo: 'sample', path: repo, poolRoot, size, allowlist: ['node_modules'] });
  const base = lib.ws.sha(repo, 'HEAD');
  const args = name => ({ repo: 'sample', lane: name, branch: 'work/' + name, base, type: 'write', ownerPid: process.pid });
  return { ...lib, root, repo, poolRoot, dir, pool, base, args, env };
}
test('F1 unknown owner probes do not mutate a running lease', t => {
  const lib = fresh(); let outcome = 'unknown';
  lib.ids.ownerState = () => outcome; lib.ids.ownerStates = owners => owners.map(() => outcome);
  delete require.cache[require.resolve(source + '/pool.cjs')]; lib.Pool = require(source + '/pool.cjs').Pool;
  const f = fixture(t, lib); const lane = f.pool.lease(f.args('first'));
  assert.equal(f.pool.status().lanes.first.state, 'running');
  f.pool.environment(lane, false); f.pool.release({ ...lane, final: f.base });
  const second = f.pool.lease(f.args('second')); outcome = 'gone';
  assert.equal(f.pool.status().lanes[second.lane].state, 'quarantined');
});
test('F2 status spawns zero PowerShell and lease at most two', t => {
  const original = cp.spawnSync; let calls = [];
  cp.spawnSync = (bin, args, options) => { if (/powershell/i.test(bin)) calls.push(args.join(' ')); return original(bin, args, options); };
  t.after(() => { cp.spawnSync = original; });
  const f = fixture(t); calls = [];
  let start = performance.now(); new f.Pool({ dir: f.dir }).status(); const emptyMs = performance.now() - start;
  assert.equal(calls.length, 0, 'empty status must not spawn PowerShell');
  calls = []; start = performance.now(); f.pool.lease({ ...f.args('one'), ownerPid: process.ppid }); const leaseMs = performance.now() - start;
  assert(calls.length <= 2, `lease spawned ${calls.length} PowerShell processes`);
  f.pool.lease({ ...f.args('two'), ownerPid: process.ppid }); calls = [];
  start = performance.now(); new f.Pool({ dir: f.dir }).status(); const runningMs = performance.now() - start;
  assert.equal(calls.length, 0, 'two-lane status must not spawn PowerShell');
  t.diagnostic(JSON.stringify({ emptyStatusMs: emptyMs, twoLaneStatusMs: runningMs, leaseMs }));
});
test('F3 slow preparation permits same-repository status bind and checkpoint', async t => {
  const f = fixture(t); const lane = f.pool.lease(f.args('active'));
  const child = cp.spawn(process.execPath, [worker, 'slow', JSON.stringify(f.args('slow'))], { env: f.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = once(child, 'exit'); let out = ''; let err = '';
  child.stderr.on('data', b => { err += b; });
  const ready = new Promise((resolve, reject) => { child.on('error', reject); child.stdout.on('data', b => { out += b; if (out.includes('PREPARING')) resolve(); }); child.on('exit', () => { if (!out.includes('PREPARING')) reject(new Error(err || out)); }); });
  try {
    await ready;
    f.pool.bindSession({ ...lane, provider: 'codex', configHome: path.join(f.root, 'profile'), session: 'synthetic' });
    f.pool.checkpoint({ ...lane, final: f.base });
    const state = f.pool.status(); assert.equal(state.lanes.slow.state, 'preparing'); assert.equal(state.lanes.active.state, 'awaiting-review');
  } finally { child.stdin.end('x'); await closed; }
  assert.equal(err, ''); assert.equal(f.pool.status().lanes.slow.state, 'quarantined');
});
test('F3 short lock contention waits and then succeeds', async t => {
  const f = fixture(t);
  const script = `const fs=require('node:fs'); const {Store}=require(${JSON.stringify(source + '/store.cjs')}); const s=new Store(); const unlock=s.lock('global'); fs.writeSync(1,'READY'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,250); unlock();`;
  const child = cp.spawn(process.execPath, ['-e', script], { env: f.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); const closed = once(child, 'exit');
  await once(child.stdout, 'data');
  try { assert(f.pool.status().repos.sample); } finally { await closed; }
});
test('F4 sealed awaiting-review survives owner exit and releases normally', t => {
  const f = fixture(t);
  const child = cp.spawnSync(process.execPath, [worker, 'sealed', JSON.stringify(f.args('done'))], { env: f.env, windowsHide: true, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr); const lane = JSON.parse(child.stdout);
  assert.equal(f.pool.status().lanes.done.state, 'awaiting-review');
  assert.equal(f.pool.release({ ...lane, final: f.base }).state, 'released');
});
test('F5 executable leases and every resume require an explicit owner', t => {
  const f = fixture(t);
  for (const type of ['write', 'verify', 'integration']) assert.throws(() => f.pool.lease({ ...f.args(type), type, branch: type === 'verify' ? null : 'work/' + type, ownerPid: undefined }), e => e.code === 'INVALID_ARGUMENT');
  for (const type of ['inspect', 'live']) {
    const lane = f.pool.lease({ ...f.args(type), type, branch: null, ownerPid: undefined });
    f.pool.release({ ...lane, final: f.base });
    assert.throws(() => f.pool.resume(lane), e => e.code === 'INVALID_ARGUMENT');
  }
});
test('F6 failure before atomic lock publication leaves no lock', t => {
  const f = fixture(t); const link = fs.linkSync;
  fs.linkSync = () => { throw Object.assign(new Error('Synthetic crash before link'), { code: 'INJECTED' }); };
  let unlock;
  try { assert.throws(() => { unlock = f.pool.store.lock('global'); }, e => e.code === 'INJECTED'); }
  finally { fs.linkSync = link; unlock?.(); }
  assert(!fs.existsSync(path.join(f.dir, 'global.lock'))); assert(f.pool.status().repos.sample);
});
test('F7 failed first checkout is removed and the slot is reusable', t => {
  const original = cp.spawnSync; let inject = false; const timeouts = [];
  cp.spawnSync = (bin, args, options) => {
    const result = original(bin, args, options);
    if (bin === 'git' && args.includes('worktree') && args.includes('add')) {
      timeouts.push(options.timeout);
      if (inject) { inject = false; return { ...result, status: 1, stderr: 'Synthetic failure after folder creation' }; }
    }
    return result;
  };
  t.after(() => { cp.spawnSync = original; });
  const f = fixture(t); inject = true;
  assert.throws(() => f.pool.lease(f.args('failed')), e => e.code === 'GIT_FAILED');
  const slot = f.pool.status().repos.sample.slots[1]; assert.equal(slot.state, 'free'); assert(!fs.existsSync(slot.path));
  assert.equal(f.pool.lease(f.args('next')).slot, 1); assert(timeouts.every(ms => ms === 1800000));
});
test('F8 checkpoint replay retains two generations and corrupt newest tail refuses', t => {
  const f = fixture(t); const state = f.pool.store.load();
  for (let n = 0; n < 4005; n++) { state.maxWrites = n + 1; f.pool.store.save(state, 'synthetic-update'); }
  const manifest = JSON.parse(fs.readFileSync(path.join(f.dir, 'segments.json'), 'utf8'));
  assert(manifest.current && manifest.previous);
  assert.equal(fs.readdirSync(f.dir).filter(n => /^journal.*\.jsonl$/.test(n)).length, 2);
  assert.deepEqual(new f.Store(f.dir).load(), state);
  fs.appendFileSync(path.join(f.dir, manifest.current.journal), '{torn');
  assert.throws(() => new f.Store(f.dir).load(), e => e.code === 'JOURNAL_CORRUPT');
});
test('F8 events rotation keeps only two old files', t => {
  const f = fixture(t); const current = path.join(f.dir, 'events.jsonl');
  for (let n = 0; n < 4; n++) { fs.writeFileSync(current, 'x'.repeat(5 * 1024 * 1024)); f.pool.store.event('boundary', { n }); }
  assert(fs.existsSync(path.join(f.dir, 'events.1.jsonl'))); assert(fs.existsSync(path.join(f.dir, 'events.2.jsonl')));
  assert(!fs.existsSync(path.join(f.dir, 'events.3.jsonl'))); assert(fs.statSync(current).size < 1024);
});
test('F9 checkpoint and install receipts skip environment walks but release scans', t => {
  const f = fixture(t); const lane = f.pool.lease(f.args('one')); const validate = f.ws.validateEnvironment; let walks = 0;
  f.ws.validateEnvironment = (...args) => { walks++; return validate(...args); };
  f.pool.environment(lane, false); f.pool.environment({ ...lane, fingerprint: lane.environment.expected }, true); f.pool.checkpoint({ ...lane, final: f.base });
  assert.equal(walks, 0); f.pool.release({ ...lane, final: f.base }); assert(walks > 0);
});
