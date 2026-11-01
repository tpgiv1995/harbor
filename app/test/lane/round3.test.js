'use strict';

const { test, assert, fs, path, fixture, git } = require('./support.cjs');
const cp = require('node:child_process');
const source = path.resolve(__dirname, '../../src/shared/lane');

function injectedOwner(t) {
  const f = fixture(t, { size: 2 });
  const original = cp.spawnSync;
  const observed = { pid: process.ppid, created: Date.now() - 30000, state: 'live' };
  cp.spawnSync = (bin, args, options) => {
    if (/powershell/i.test(bin) && args.join(' ').includes('Get-Process -Id')) {
      return { status: 0, stdout: JSON.stringify([observed]), stderr: '' };
    }
    return original(bin, args, options);
  };
  t.after(() => { cp.spawnSync = original; });
  for (const file of Object.keys(require.cache)) if (file.startsWith(source + path.sep)) delete require.cache[file];
  const identities = require(source + '/identity.cjs');
  const { Pool } = require(source + '/pool.cjs');
  const owner = { bootId: identities.identity().bootId, pid: observed.pid, created: observed.created + 10000, source: 'self' };
  return { ...f, pool: new Pool({ dir: f.dir }), identities, owner, observed };
}

test('G1 dirty manifest and untracked work permit environment receipts without index writes', t => {
  const f = fixture(t); const lane = f.lease();
  fs.writeFileSync(path.join(lane.path, 'package-lock.json'), '{"lockfileVersion":3,"packages":{"edited":{}}}\n');
  fs.writeFileSync(path.join(lane.path, 'working-notes.txt'), 'unfinished synthetic work\n');
  git(lane.path, ['update-index', '--assume-unchanged', 'tracked.txt']);
  const index = path.join(git(lane.path, ['rev-parse', '--absolute-git-dir']), 'index');
  const before = fs.readFileSync(index);
  const begin = f.pool.environment(lane, false);
  assert.notEqual(begin.environment.expected, lane.environment.expected);
  const ready = f.pool.environment({ ...lane, fingerprint: begin.environment.expected }, true);
  assert.equal(ready.environment.stale, false);
  assert.deepEqual(fs.readFileSync(index), before);
  assert.throws(() => f.pool.checkpoint({ ...lane, final: f.base }), e => e.code === 'DIRTY');
  assert.throws(() => f.release(lane), e => e.code === 'DIRTY');
});

test('G1 environment receipts do not inspect Git operation state', t => {
  const f = fixture(t); const lane = f.lease();
  const admin = git(lane.path, ['rev-parse', '--absolute-git-dir']);
  fs.writeFileSync(path.join(admin, 'index.lock'), 'synthetic in-progress operation');
  const before = fs.readFileSync(path.join(admin, 'index'));
  const begin = f.pool.environment(lane, false);
  assert.equal(f.pool.environment({ ...lane, fingerprint: begin.environment.expected }, true).environment.stale, false);
  assert.deepEqual(fs.readFileSync(path.join(admin, 'index')), before);
  assert.throws(() => f.pool.checkpoint({ ...lane, final: f.base }), e => e.code === 'GIT_OPERATION');
});

test('G2 self identity rejects later PID reuse and preserves the unknown earlier range', t => {
  const { identities, owner, observed } = injectedOwner(t);
  observed.created = owner.created + 1001;
  assert.equal(identities.ownerState(owner), 'gone');
  observed.created = owner.created + 1000;
  assert.equal(identities.ownerState(owner), 'live');
  observed.created = owner.created - 120000;
  assert.equal(identities.ownerState(owner), 'live');
  observed.created = owner.created - 120001;
  assert.equal(identities.ownerState(owner), 'unknown');
  observed.state = 'gone';
  assert.equal(identities.ownerState(owner), 'gone');
});

test('G2 OS-sourced owner creation time comparisons are exact', t => {
  const { identities, owner, observed } = injectedOwner(t);
  const osOwner = { ...owner, source: 'os', created: observed.created };
  assert.equal(identities.ownerState(osOwner), 'live');
  observed.created++;
  assert.equal(identities.ownerState(osOwner), 'gone');
});

test('G2 lock contention retains a live holder with a ten-second startup gap', t => {
  const { pool, dir, owner } = injectedOwner(t);
  const file = path.join(dir, 'global.lock');
  fs.writeFileSync(file, JSON.stringify({ ...owner, token: 'synthetic-live-holder' }));
  const oldWait = process.env.HARBOR_LANES_LOCK_WAIT_MS;
  process.env.HARBOR_LANES_LOCK_WAIT_MS = '25';
  try {
    assert.throws(() => pool.store.lock('global'), e => e.code === 'LOCK_BUSY');
    assert.equal(JSON.parse(fs.readFileSync(file)).token, 'synthetic-live-holder');
  } finally {
    if (oldWait === undefined) delete process.env.HARBOR_LANES_LOCK_WAIT_MS; else process.env.HARBOR_LANES_LOCK_WAIT_MS = oldWait;
  }
});

test('G2 recover-lock refuses to remove a live holder with a ten-second startup gap', t => {
  const { pool, dir, owner } = injectedOwner(t);
  const file = path.join(dir, 'global.lock');
  fs.writeFileSync(file, JSON.stringify({ ...owner, token: 'synthetic-live-holder' }));
  assert.throws(() => pool.store.recoverLock('global'), e => e.code === 'LOCK_BUSY');
  assert.equal(JSON.parse(fs.readFileSync(file)).token, 'synthetic-live-holder');
});

test('G2 lease reconciliation retains a live preparer with a ten-second startup gap', t => {
  const f = injectedOwner(t);
  const first = f.pool.lease({ repo: 'sample', lane: 'preparing', branch: 'work/preparing', base: f.base, type: 'write', ownerPid: process.pid });
  f.pool.transaction('sample', state => {
    state.lanes.preparing.state = 'preparing'; state.lanes.preparing.preparer = f.owner;
    state.repos.sample.slots[first.slot].state = 'preparing';
    f.pool.store.save(state, 'synthetic-preparer-gap');
  });
  const next = f.pool.lease({ repo: 'sample', lane: 'next', branch: 'work/next', base: f.base, type: 'write', ownerPid: process.pid });
  const state = f.pool.store.load();
  assert.equal(next.state, 'running');
  assert.equal(state.lanes.preparing.state, 'preparing');
  assert.equal(state.repos.sample.slots[first.slot].state, 'preparing');
});
