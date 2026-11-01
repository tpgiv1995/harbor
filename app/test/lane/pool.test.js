'use strict';
const { test, assert, fs, path, os, spawn, spawnSync, once, Pool, git, sha, inside, identity, ownerState, cli, worker, fixture, throwsCode, run, child, commit } = require('./support.cjs');

test('new lanes refuse existing branches and lane ids without moving either ref', t => {
  const f = fixture(t); git(f.repo, ['branch', 'existing', f.base]);
  throwsCode(() => f.lease('collision', { branch: 'existing' }), 'BRANCH_TAKEN');
  const lane = f.lease(); throwsCode(() => f.lease(), 'LANE_EXISTS');
  assert.equal(sha(f.repo, 'existing'), f.base); assert.equal(sha(lane.path, 'HEAD'), f.base);
});
test('release preserves final ref and detaches; resume returns to the same slot and recorded tip', t => {
  const f = fixture(t); const lane = f.lease(); const tip = commit(lane.path, 'delivered\n');
  f.release(lane);
  assert.equal(sha(f.repo, `refs/lanes/${lane.lane}/final`), tip);
  assert.equal(git(lane.path, ['symbolic-ref', '-q', 'HEAD'], { allowFailure: true }), null);
  const resumed = f.pool.resume({ ...lane, ownerPid: process.pid });
  assert.equal(resumed.path, lane.path); assert.equal(resumed.baseSha, f.base); assert.equal(sha(resumed.path, 'HEAD'), tip);
  assert(resumed.generation > lane.generation); assert.notEqual(resumed.token, lane.token);
  throwsCode(() => f.pool.release({ ...lane, final: tip }), 'STALE_TOKEN');
});
test('resume never resets a moved branch and waits for its original slot', t => {
  const f = fixture(t, { size: 2 }); const first = f.lease(); f.release(first);
  const second = f.lease('second');
  throwsCode(() => f.pool.resume({ ...first, ownerPid: process.pid }), 'POOL_FULL');
  assert.equal(f.pool.status().repos.sample.slots[2].state, 'free');
  const other = commit(f.repo, 'new main\n'); git(f.repo, ['branch', '-f', first.branch, other]);
  f.release(second);
  throwsCode(() => f.pool.resume({ ...first, ownerPid: process.pid }), 'TIP_MOVED');
  assert.equal(sha(f.repo, first.branch), other);
});
test('dirty release is refused, live owners keep the lease, dead owners are quarantined', t => {
  const f = fixture(t); const lane = f.lease();
  const original = fs.readFileSync(path.join(lane.path, 'tracked.txt'));
  fs.writeFileSync(path.join(lane.path, 'tracked.txt'), 'not committed');
  throwsCode(() => f.release(lane), 'DIRTY'); assert.equal(f.pool.status().lanes.first.state, 'running');
  fs.writeFileSync(path.join(lane.path, 'tracked.txt'), original); f.release(lane);
  const orphan = child('dirty', f); assert.equal(orphan.exit, 0);
  const state = f.pool.status(); assert.equal(state.lanes.dirty.state, 'quarantined'); assert.equal(state.repos.sample.slots[1].state, 'quarantined');
  throwsCode(() => f.pool.recover({ repo: 'sample', slot: 1, ...orphan.lease }), 'DIRTY');
  assert.equal(fs.readFileSync(path.join(orphan.lease.path, 'unfinished.txt'), 'utf8'), 'unfinished synthetic work');
});
test('recovery needs a recorded durable final commit and rejects a live owner', t => {
  const f = fixture(t); const lane = f.lease();
  f.pool.quarantine({ ...lane, reason: 'coordinator hold' });
  throwsCode(() => f.pool.recover({ repo: 'sample', slot: 1, ...lane }), 'OWNER_LIVE');
});
test('an explicitly quarantined exited owner is recovered after its deliverable was sealed', t => {
  const f = fixture(t); const orphan = child('sealed-quarantined', f, 'sealed'); assert.equal(orphan.exit, 0);
  assert.equal(f.pool.status().lanes.sealed.state, 'quarantined');
  f.pool.recover({ repo: 'sample', ...orphan.lease });
  assert.equal(f.pool.status().repos.sample.slots[1].state, 'free');
  assert.equal(sha(f.repo, 'refs/lanes/sealed/final'), f.base);
});
test('unsealed clean orphan stays quarantined with a reason', t => {
  const f = fixture(t); const orphan = child('clean', f); assert.equal(orphan.exit, 0);
  throwsCode(() => f.pool.recover({ repo: 'sample', ...orphan.lease }), 'DELIVERABLE_MISSING');
  assert.equal(f.pool.status().repos.sample.slots[1].reason, 'DELIVERABLE_MISSING');
});
test('a real interrupted prepare remains unavailable after dead lock recovery', t => {
  const f = fixture(t); const crashed = child('crash', f); assert.equal(crashed.exit, 77);
  assert.equal(f.pool.store.recoverLock('global').recovered, false);
  assert.equal(f.pool.store.recoverLock('repo-sample').recovered, false);
  const state = f.pool.status(); assert.equal(state.repos.sample.slots[1].state, 'quarantined');
  assert.equal(state.lanes.crash.reason, 'INTERRUPTED_TRANSACTION');
  throwsCode(() => f.lease('next'), 'POOL_FULL');
});
test('two actual CLI processes racing cannot allocate the same slot', async t => {
  const f = fixture(t);
  const launch = name => new Promise((resolve, reject) => {
    const cp = spawn(process.execPath, [cli, 'lease', '--repo', 'sample', '--lane', name, '--branch', `work/${name}`, '--base', f.base, '--type', 'write', '--owner-pid', String(process.pid)], { env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = ''; cp.stdout.on('data', d => { out += d; }); cp.stderr.on('data', d => { err += d; }); cp.on('error', reject);
    cp.on('exit', code => { try { assert.equal(err, ''); resolve({ exit: code, ...JSON.parse(out) }); } catch (e) { reject(e); } });
  });
  const results = await Promise.all([launch('racer-one'), launch('racer-two')]);
  assert.equal(results.filter(r => r.ok).length, 1);
  assert(['LOCK_BUSY', 'POOL_FULL'].includes(results.find(r => !r.ok).code), JSON.stringify(results));
  assert.equal(f.pool.status().repos.sample.slots.filter(s => s.state === 'running').length, 1);
});
test('hidden index flags cannot hide changes from release or survive reuse', t => {
  const f = fixture(t); const lane = f.lease();
  const original = fs.readFileSync(path.join(lane.path, 'tracked.txt'));
  git(lane.path, ['update-index', '--skip-worktree', 'tracked.txt']);
  fs.writeFileSync(path.join(lane.path, 'tracked.txt'), 'hidden work');
  throwsCode(() => f.release(lane), 'DIRTY');
  fs.writeFileSync(path.join(lane.path, 'tracked.txt'), original);
  git(lane.path, ['update-index', '--assume-unchanged', 'package-lock.json']);
  f.release(lane); const next = f.lease('next');
  assert(!git(next.path, ['ls-files', '-v']).split('\n').some(line => /^[a-zS]/.test(line)));
});
test('generated cleanup preserves allowlisted dependencies and never follows a junction', t => {
  const f = fixture(t); const lane = f.lease();
  fs.mkdirSync(path.join(lane.path, 'node_modules')); fs.writeFileSync(path.join(lane.path, 'node_modules', 'warm.txt'), 'keep');
  fs.mkdirSync(path.join(lane.path, 'ignored')); fs.writeFileSync(path.join(lane.path, 'ignored', 'old.cache'), 'discard');
  const outside = path.join(f.root, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'precious.txt'), 'untouched');
  fs.symlinkSync(outside, path.join(lane.path, 'link-out'), process.platform === 'win32' ? 'junction' : 'dir');
  f.release(lane); const next = f.lease('next');
  assert.equal(fs.readFileSync(path.join(next.path, 'node_modules', 'warm.txt'), 'utf8'), 'keep');
  assert(!fs.existsSync(path.join(next.path, 'ignored'))); assert(!fs.existsSync(path.join(next.path, 'link-out')));
  assert.equal(fs.readFileSync(path.join(outside, 'precious.txt'), 'utf8'), 'untouched');
});
test('an environment junction into another checkout is refused without modifying its target', t => {
  const f = fixture(t); const lane = f.lease(); const outside = path.join(f.root, 'outside'); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'safe');
  fs.symlinkSync(outside, path.join(lane.path, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  throwsCode(() => f.release(lane), 'ENVIRONMENT_UNSAFE');
  assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'safe');
});
