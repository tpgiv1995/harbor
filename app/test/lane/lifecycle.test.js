'use strict';
const { test, assert, fs, path, os, spawn, spawnSync, once, Pool, git, sha, inside, identity, ownerState, cli, worker, fixture, throwsCode, run, child, commit } = require('./support.cjs');

test('CLI emits one JSON object with documented argument and refusal exits', t => {
  const f = fixture(t); assert.equal(run(['status']).ok, true);
  const bad = run(['lease', '--bogus', 'x']); assert.equal(bad.exit, 2); assert.equal(bad.code, 'INVALID_ARGUMENT');
  f.lease(); const full = run(['lease', '--repo', 'sample', '--lane', 'full', '--branch', 'work/full', '--base', f.base, '--type', 'write', '--owner-pid', String(process.pid)]);
  assert.equal(full.exit, 3); assert.equal(full.code, 'POOL_FULL');
  const stale = run(['release', '--lane', 'first', '--token', 'wrong', '--generation', '1', '--final', f.base]); assert.equal(stale.exit, 4); assert.equal(stale.code, 'STALE_TOKEN');
});
test('Windows held file causes reset to fail with the slot quarantined', { skip: process.platform !== 'win32' }, async t => {
  const f = fixture(t); const lane = f.lease(); f.release(lane); const other = commit(f.repo, 'replacement\n');
  const file = path.join(lane.path, 'tracked.txt').replace(/'/g, "''");
  const cp = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `$stream = [IO.File]::Open('${file}', [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read); [Console]::WriteLine('READY'); [Console]::ReadLine() | Out-Null; $stream.Dispose()`], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = once(cp, 'exit'); let stderr = ''; cp.stderr.on('data', d => { stderr += d; });
  try {
    const [data] = await once(cp.stdout, 'data'); assert.match(String(data), /READY/);
    assert.throws(() => f.lease('blocked', { base: other }), e => e.code === 'GIT_FAILED' && /reset/.test(e.message));
    const state = f.pool.status(); assert.equal(state.repos.sample.slots[1].state, 'quarantined'); assert.equal(state.lanes.blocked.reason, 'GIT_FAILED');
  } finally { cp.stdin.end('\n'); await closed; }
  assert.equal(stderr, '');
});

test('boot identity is stable on first and later reads; PID reuse and boot changes mean gone', t => {
  fixture(t);
  const modulePath = path.resolve(__dirname, '../../src/shared/lane/identity.cjs');
  const script = `const i=require(${JSON.stringify(modulePath)}); const first=i.identity(); const second=i.identity(); console.log(JSON.stringify({first,second,state:i.ownerState(first)}));`;
  const result = spawnSync(process.execPath, ['-e', script], { windowsHide: true, encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0); const probe = JSON.parse(result.stdout);
  assert.deepEqual(probe.first, probe.second); assert.equal(probe.state, 'live');
  const current = identity(); assert.equal(ownerState({ ...current, created: Number(current.created) - 10000 }), 'gone');
  const foreignBoot = current.bootId.startsWith('since:') ? `since:${Number(current.bootId.slice(6)) - 120}` : 'boot:synthetic-other-boot';
  assert.equal(ownerState({ ...current, bootId: foreignBoot }), 'gone');
  assert.equal(ownerState({ ...current, bootId: 'unrecognized-format' }), 'unknown');
  assert.equal(ownerState({ pid: current.pid }), 'unknown');
});
test('a crash after detach is recoverable without reattaching or losing the final ref', t => {
  const f = fixture(t); assert.equal(child('release-crash', f).exit, 77);
  f.pool.store.recoverLock('global'); f.pool.store.recoverLock('repo-sample');
  const state = f.pool.status(); const lane = state.lanes['release-crash'];
  assert.equal(lane.state, 'quarantined');
  const slot = state.repos.sample.slots[lane.slot];
  assert.equal(git(slot.path, ['symbolic-ref', '-q', 'HEAD'], { allowFailure: true }), null);
  f.pool.recover({ repo: 'sample', slot: lane.slot, generation: lane.generation, token: lane.token });
  assert.equal(f.pool.status().repos.sample.slots[lane.slot].state, 'free');
  assert.equal(sha(f.repo, 'refs/lanes/release-crash/final'), f.base);
});
test('configured but unused filters are harmless; applied filters refuse registration and checkout', t => {
  const f = fixture(t);
  git(f.repo, ['config', 'filter.synthetic.clean', 'never-execute-this']);
  git(f.repo, ['config', 'filter.synthetic.smudge', 'never-execute-this']);
  const lane = f.lease(); f.release(lane);
  fs.writeFileSync(path.join(f.repo, '.gitattributes'), 'tracked.txt filter=synthetic\n');
  git(f.repo, ['add', '.gitattributes']);
  const tree = git(f.repo, ['write-tree']); const target = git(f.repo, ['commit-tree', tree, '-p', f.base, '-m', 'Synthetic attribute']);
  throwsCode(() => f.lease('filtered', { base: target }), 'UNSUPPORTED_REPOSITORY');
  assert.equal(f.pool.status().lanes.filtered.state, 'quarantined');
});
test('a tracked path cannot be disguised as an allowlisted generated parent', t => {
  throwsCode(() => fixture(t, { allowlist: ['tracked.txt/child'] }), 'ALLOWLIST_CONFLICT');
});
test('canonical staged and unstaged work is unchanged by a full lease and release', t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.repo, 'tracked.txt'), 'staged main work'); git(f.repo, ['add', 'tracked.txt']);
  fs.writeFileSync(path.join(f.repo, 'tracked.txt'), 'unstaged main work');
  const index = fs.readFileSync(path.join(f.repo, '.git', 'index')); const status = git(f.repo, ['status', '--porcelain']);
  const lane = f.lease(); commit(lane.path, 'lane deliverable'); f.release(lane);
  assert.deepEqual(fs.readFileSync(path.join(f.repo, '.git', 'index')), index);
  assert.equal(fs.readFileSync(path.join(f.repo, 'tracked.txt'), 'utf8'), 'unstaged main work');
  assert.equal(git(f.repo, ['status', '--porcelain']), status);
});
test('a slot gitfile pointing at the canonical index is refused before any index write', t => {
  const f = fixture(t); const lane = f.lease(); const index = fs.readFileSync(path.join(f.repo, '.git', 'index'));
  // Git marks this file hidden on Windows; replace it instead of opening with CREATE_ALWAYS.
  fs.unlinkSync(path.join(lane.path, '.git'));
  fs.writeFileSync(path.join(lane.path, '.git'), `gitdir: ${path.join(f.repo, '.git')}\n`);
  throwsCode(() => f.release(lane), 'PATH_UNSAFE');
  assert.deepEqual(fs.readFileSync(path.join(f.repo, '.git', 'index')), index);
});
test('nested bare repositories are retained and refused before cleanup', t => {
  const f = fixture(t); const lane = f.lease(); f.release(lane);
  const nested = path.join(lane.path, 'ignored', 'bare'); fs.mkdirSync(nested, { recursive: true }); git(nested, ['init', '--bare']);
  throwsCode(() => f.lease('bare'), 'UNSUPPORTED_REPOSITORY'); assert(fs.existsSync(path.join(nested, 'HEAD')));
});
test('registration does not create a missing pool root', t => {
  const f = fixture(t, { register: false }); const absent = path.join(f.root, 'absent');
  throwsCode(() => f.pool.init({ repo: 'sample', path: f.repo, poolRoot: absent, size: 1 }), 'VOLUME_MISSING');
  assert(!fs.existsSync(absent));
});
test('CLI completes registration, environment receipt, session binding, release and resume', t => {
  const f = fixture(t, { register: false });
  const init = run(['init-repo', '--repo', 'sample', '--path', f.repo, '--pool-root', f.poolRoot, '--size', '1', '--allowlist', '["node_modules"]']); assert.equal(init.exit, 0);
  const leased = run(['lease', '--repo', 'sample', '--lane', 'cli-cycle', '--branch', 'work/cli-cycle', '--base', f.base, '--type', 'write', '--owner-pid', String(process.pid), '--runtimes', '{"npm":"synthetic"}']); assert.equal(leased.exit, 0);
  const lane = leased.result; const capability = ['--lane', lane.lane, '--token', lane.token, '--generation', String(lane.generation)];
  const begin = run(['env-begin', ...capability]); assert.equal(begin.exit, 0);
  const ready = run(['env-ready', ...capability, '--fingerprint', begin.result.environment.expected]); assert.equal(ready.result.environment.stale, false);
  const session = ['--provider', 'codex', '--config-home', path.join(f.root, 'profile'), '--session', 'synthetic-cli-session'];
  assert.equal(run(['bind-session', ...capability, ...session]).exit, 0);
  assert.equal(run(['checkpoint', ...capability, '--final', f.base]).result.state, 'awaiting-review');
  assert.equal(run(['release', ...capability, '--final', f.base]).result.state, 'released');
  assert.equal(run(['resolve-session', ...session]).result.session.lane, lane.lane);
  const resumed = run(['resume', ...capability, '--owner-pid', String(process.pid)]); assert.equal(resumed.exit, 0); assert.equal(resumed.result.path, lane.path);
  assert(resumed.result.generation > lane.generation);
  const fresh = ['--lane', lane.lane, '--token', resumed.result.token, '--generation', String(resumed.result.generation)];
  assert.equal(run(['quarantine', ...fresh, '--reason', 'coordinator hold']).result.state, 'quarantined');
  const held = run(['recover', '--repo', 'sample', '--slot', String(lane.slot), '--token', resumed.result.token, '--generation', String(resumed.result.generation)]);
  assert.equal(held.code, 'OWNER_LIVE'); assert.equal(held.exit, 4);
});
test('journal appends only changed records and verifies the hash chain on replay', t => {
  const f = fixture(t); const state = f.pool.store.load();
  for (let n = 0; n < 100; n++) state.lanes[`synthetic-${n}`] = { state: 'released', note: 'synthetic retained history '.repeat(20) };
  f.pool.store.save(state, 'synthetic-history');
  const journal = path.join(f.dir, 'journal.jsonl'); const before = fs.statSync(journal).size;
  state.lanes['synthetic-50'].note = 'updated'; f.pool.store.save(state, 'one-change');
  assert(fs.statSync(journal).size - before < 1024);
  const records = fs.readFileSync(journal, 'utf8').trimEnd().split('\n').map(JSON.parse);
  assert.deepEqual(Object.keys(records.at(-1).changes.lanes), ['synthetic-50']); assert(!records.at(-1).state);
  assert.deepEqual(f.pool.store.load(), state);
  records.at(-1).changes.lanes['synthetic-50'].note = 'corrupted';
  fs.writeFileSync(journal, records.map(JSON.stringify).join('\n') + '\n');
  throwsCode(() => f.pool.store.load(), 'JOURNAL_CORRUPT');
});
test('failed snapshot publication leaves the journaled preparation unavailable', t => {
  const f = fixture(t); const rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (to === path.join(f.dir, 'registry.json')) throw Object.assign(new Error('Synthetic snapshot failure'), { code: 'EACCES' });
    return rename(from, to);
  };
  try { throwsCode(() => f.lease(), 'EACCES'); } finally { fs.renameSync = rename; }
  const state = f.pool.status(); assert.equal(state.lanes.first.state, 'quarantined');
  assert.equal(state.repos.sample.slots[1].state, 'quarantined');
  assert.equal(state.lanes.first.reason, 'INTERRUPTED_TRANSACTION');
});
