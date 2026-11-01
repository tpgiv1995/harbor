'use strict';
const { test, assert, fs, path, os, spawn, spawnSync, once, Pool, git, sha, inside, identity, ownerState, cli, worker, fixture, throwsCode, run, child, commit } = require('./support.cjs');

test('fingerprints distinguish warm, changed lockfiles, runtime changes and interrupted installation', t => {
  const f = fixture(t); const lane = f.lease('first', { runtimes: { npm: 'synthetic-1' } }); assert.equal(lane.environment.stale, true);
  f.pool.environment(lane, false);
  const ready = f.pool.environment({ ...lane, fingerprint: lane.environment.expected }, true); assert.equal(ready.environment.stale, false);
  fs.writeFileSync(path.join(lane.path, 'package-lock.json'), '{"lockfileVersion":3,"packages":{"edited":{}}}\n');
  git(lane.path, ['add', 'package-lock.json']); git(lane.path, ['commit', '-qm', 'Synthetic in-lane dependency change']);
  assert.equal(f.release(lane).environment.stale, true);
  const warm = f.lease('warm', { runtimes: { npm: 'synthetic-1' } }); assert.equal(warm.environment.stale, false); f.release(warm);
  const runtime = f.lease('runtime', { runtimes: { npm: 'synthetic-2' } }); assert.equal(runtime.environment.stale, true); f.release(runtime);
  fs.writeFileSync(path.join(f.repo, 'package-lock.json'), '{"lockfileVersion":3,"packages":{"new":{}}}\n'); git(f.repo, ['add', 'package-lock.json']); git(f.repo, ['commit', '-qm', 'Synthetic dependency change']);
  const changed = f.lease('changed', { base: sha(f.repo, 'HEAD'), runtimes: { npm: 'synthetic-1' } }); assert.equal(changed.environment.stale, true);
  const beginning = f.pool.environment(changed, false); assert.equal(beginning.environment.stale, true);
  throwsCode(() => f.pool.environment({ ...changed, fingerprint: lane.environment.expected }, true), 'FINGERPRINT_MISMATCH');
  f.release(changed); assert.equal(f.lease('after-install').environment.stale, true);
});
test('POOL_FULL is fail-fast and integration capacity is reserved', t => {
  const f = fixture(t); const lane = f.lease(); assert.equal(lane.slot, 1);
  throwsCode(() => f.lease('full'), 'POOL_FULL');
  const integration = f.lease('integration', { type: 'integration' }); assert.equal(integration.slot, 0);
  throwsCode(() => f.lease('integration-two', { type: 'integration' }), 'POOL_FULL');
});
test('machine write cap applies across repositories while verify uses a detached ordinary slot', t => {
  const f = fixture(t, { size: 2, maxWrites: 1 }); f.lease();
  const other = path.join(f.root, 'other'); fs.mkdirSync(other); git(other, ['clone', '--no-local', f.repo, '.']);
  f.pool.init({ repo: 'other', path: other, poolRoot: f.poolRoot, size: 1 });
  throwsCode(() => f.pool.lease({ repo: 'other', lane: 'other', branch: 'work/other', base: f.base, type: 'write', ownerPid: process.pid }), 'POOL_FULL');
  const verify = f.lease('verify', { type: 'verify', branch: null }); assert.equal(verify.slot, 2);
  assert.equal(git(verify.path, ['symbolic-ref', '-q', 'HEAD'], { allowFailure: true }), null);
});
test('stale generation cannot release, quarantine, seal or alter the newer occupant', t => {
  const f = fixture(t); const old = f.lease(); f.release(old); const next = f.lease('next');
  for (const action of ['release', 'quarantine', 'checkpoint']) for (const wrong of [{ token: old.token }, { generation: old.generation }]) throwsCode(() => f.pool[action]({ ...next, ...wrong, final: f.base, reason: 'stale request' }), 'STALE_TOKEN');
  throwsCode(() => f.pool.environment({ ...next, token: old.token, generation: old.generation }, false), 'STALE_TOKEN');
  assert.equal(f.pool.status().repos.sample.slots[1].lane, next.lane);
});
test('durable session mapping stays on its lane through reuse and updates on resume', t => {
  const f = fixture(t); const lane = f.lease(); const session = { provider: 'codex', configHome: path.join(f.root, 'account'), session: 'synthetic-session' };
  f.pool.bindSession({ ...lane, ...session }); f.release(lane); const next = f.lease('next');
  assert.equal(f.pool.resolveSession(session).session.lane, lane.lane);
  throwsCode(() => f.pool.bindSession({ ...next, ...session }), 'SESSION_TAKEN'); f.release(next);
  const resumed = f.pool.resume({ ...lane, ownerPid: process.pid }); const mapping = f.pool.resolveSession(session);
  assert.equal(mapping.session.generation, resumed.generation); assert.equal(mapping.lease.path, lane.path);
  throwsCode(() => f.pool.resume({ ...resumed, ownerPid: process.pid }), 'LANE_BUSY');
});
test('pinned inspection and explicitly live reads do not allocate slots', t => {
  const f = fixture(t); const inspect = f.lease('inspect', { type: 'inspect', branch: null }); const live = f.lease('live', { type: 'live', branch: null });
  assert.equal(inspect.path, null); assert.equal(inspect.baseSha, f.base); assert.equal(live.path, f.repo);
  assert(f.pool.status().repos.sample.slots.every(s => s.state === 'free'));
});
test('unsupported nested repositories and submodules preserve content and block allocation', t => {
  const f = fixture(t); const lane = f.lease(); f.release(lane);
  const nested = path.join(lane.path, 'ignored', 'nested'); fs.mkdirSync(nested, { recursive: true }); git(nested, ['init']);
  throwsCode(() => f.lease('nested'), 'UNSUPPORTED_REPOSITORY'); assert(fs.existsSync(path.join(nested, '.git')));
  git(f.repo, ['update-index', '--add', '--cacheinfo', `160000,${f.base},module`]); git(f.repo, ['commit', '-qm', 'Synthetic submodule entry']);
  throwsCode(() => f.lease('module', { base: sha(f.repo, 'HEAD'), type: 'integration' }), 'UNSUPPORTED_REPOSITORY');
});
test('missing or replaced pool roots refuse allocation without a fallback path', t => {
  const f = fixture(t); const parked = path.join(f.root, 'parked-pool'); fs.renameSync(f.poolRoot, parked);
  throwsCode(() => f.lease(), 'VOLUME_MISSING'); assert(!fs.existsSync(f.poolRoot));
  fs.mkdirSync(f.poolRoot); throwsCode(() => f.lease(), 'VOLUME_MISSING');
});
test('inherited Git routing variables cannot modify the canonical checkout or foreign index', t => {
  const f = fixture(t); const original = fs.readFileSync(path.join(f.repo, '.git', 'index'));
  const env = { ...process.env, GIT_DIR: path.join(f.repo, '.git'), GIT_WORK_TREE: f.repo, GIT_INDEX_FILE: path.join(f.root, 'foreign-index') };
  const result = run(['lease', '--repo', 'sample', '--lane', 'cli', '--branch', 'work/cli', '--base', f.base, '--type', 'write', '--owner-pid', String(process.pid)], env);
  assert.equal(result.exit, 0); assert.equal(result.ok, true); assert(!fs.existsSync(env.GIT_INDEX_FILE));
  assert.deepEqual(fs.readFileSync(path.join(f.repo, '.git', 'index')), original); assert.equal(git(f.repo, ['status', '--porcelain']), '');
});
test('unfinished Git operations refuse release without changing HEAD', t => {
  const f = fixture(t); const lane = f.lease(); const admin = git(lane.path, ['rev-parse', '--absolute-git-dir']);
  fs.writeFileSync(path.join(admin, 'MERGE_HEAD'), f.base);
  throwsCode(() => f.release(lane), 'GIT_OPERATION'); assert.equal(sha(lane.path, 'HEAD'), f.base);
});
test('journal replays after snapshot loss and refuses a torn tail', t => {
  const f = fixture(t); const lane = f.lease(); fs.unlinkSync(path.join(f.dir, 'registry.json'));
  assert.equal(f.pool.status().lanes.first.token, lane.token);
  fs.appendFileSync(path.join(f.dir, 'journal.jsonl'), '{"torn":');
  throwsCode(() => f.pool.status(), 'JOURNAL_CORRUPT');
});
test('lock recovery never steals live or unknown owners and ignores age', t => {
  const f = fixture(t); const lock = path.join(f.dir, 'global.lock');
  fs.writeFileSync(lock, JSON.stringify({ ...identity(), token: 'live', at: '1900-01-01' }));
  throwsCode(() => f.pool.store.recoverLock('global'), 'LOCK_BUSY');
  fs.writeFileSync(lock, 'incomplete'); throwsCode(() => f.pool.store.recoverLock('global'), 'LOCK_UNKNOWN');
});
