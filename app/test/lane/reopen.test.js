'use strict';

// reopen: a lane sealed for review goes back to work for a revision before it is released,
// in the same slot, under a renewed token and generation (launcher adapters, 2026-11-01).
const { test, assert, fs, path, spawnSync, fixture, throwsCode, run, commit } = require('./support.cjs');

function sealed(f, text = 'first\n') {
  const lane = f.lease();
  const final = commit(lane.path, text);
  return { lane, final, sealed: f.pool.checkpoint({ ...lane, final }) };
}

test('a sealed lane reopens for a revision under a renewed capability', t => {
  const f = fixture(t);
  const { lane, final, sealed: review } = sealed(f);
  assert.equal(review.state, 'awaiting-review');
  const reopened = f.pool.reopen({ lane: review.lane, token: review.token, generation: review.generation, ownerPid: process.pid });
  assert.equal(reopened.state, 'running');
  assert.equal(reopened.slot, lane.slot);
  assert.equal(reopened.path, lane.path);
  assert.equal(reopened.generation, review.generation + 1);
  assert.notEqual(reopened.token, review.token);
  assert.equal(reopened.finalSha, final);
  throwsCode(() => f.pool.release({ ...review, final }), 'STALE_TOKEN');
  const revised = commit(lane.path, 'revised\n');
  const resealed = f.pool.checkpoint({ ...reopened, final: revised });
  assert.equal(resealed.finalSha, revised);
  const released = f.pool.release({ ...resealed, final: revised });
  assert.equal(released.state, 'released');
  assert.equal(f.pool.status().repos.sample.slots[lane.slot].state, 'free');
});

test('reopen refuses lanes that are not sealed for review', t => {
  const f = fixture(t);
  const lane = f.lease();
  throwsCode(() => f.pool.reopen({ ...lane, ownerPid: process.pid }), 'LANE_BUSY');
  const quarantined = f.pool.quarantine({ ...lane, reason: 'synthetic repair' });
  throwsCode(() => f.pool.reopen({ ...quarantined, ownerPid: process.pid }), 'QUARANTINED');
});

test('reopen refuses a slot changed after its checkpoint and leaves the lane sealed', t => {
  const f = fixture(t, { size: 2 });
  const dirty = sealed(f);
  fs.writeFileSync(path.join(dirty.lane.path, 'stray.txt'), 'untracked synthetic work\n');
  throwsCode(() => f.pool.reopen({ ...dirty.sealed, ownerPid: process.pid }), 'DIRTY');
  assert.equal(f.pool.status().lanes.first.state, 'awaiting-review');
  const second = f.pool.lease({ repo: 'sample', lane: 'second', branch: 'work/second', base: f.base, type: 'write', ownerPid: process.pid });
  const final = commit(second.path, 'second\n');
  const review = f.pool.checkpoint({ ...second, final });
  commit(second.path, 'moved after review\n');
  throwsCode(() => f.pool.reopen({ ...review, ownerPid: process.pid }), 'TIP_MOVED');
  assert.equal(f.pool.status().lanes.second.state, 'awaiting-review');
});

test('reopen requires a live owner', t => {
  const f = fixture(t);
  const { sealed: review } = sealed(f);
  const exited = spawnSync(process.execPath, ['-e', ''], { windowsHide: true });
  throwsCode(() => f.pool.reopen({ ...review, ownerPid: exited.pid }), 'OWNER_GONE');
  assert.equal(f.pool.status().lanes.first.state, 'awaiting-review');
});

test('bound sessions follow the reopened generation', t => {
  const f = fixture(t);
  const lane = f.lease();
  const binding = { provider: 'claude', configHome: f.root, session: 'synthetic-session' };
  f.pool.bindSession({ ...lane, ...binding });
  const final = commit(lane.path, 'bound\n');
  const review = f.pool.checkpoint({ ...lane, final });
  const reopened = f.pool.reopen({ ...review, ownerPid: process.pid });
  const resolved = f.pool.resolveSession(binding);
  assert.equal(resolved.session.generation, reopened.generation);
  assert.equal(resolved.lease.token, reopened.token);
});

test('the CLI reopens a sealed lane', t => {
  const f = fixture(t);
  const { sealed: review } = sealed(f);
  const answer = run(['reopen', '--lane', review.lane, '--token', review.token, '--generation', String(review.generation), '--owner-pid', String(process.pid)]);
  assert.equal(answer.exit, 0);
  assert.equal(answer.ok, true);
  assert.equal(answer.result.state, 'running');
  assert.equal(answer.result.generation, review.generation + 1);
});
