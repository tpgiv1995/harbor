'use strict';

// Harbor never starts or resumes a session inside a workspace-pool slot (stage 4, 2026-11-01).
const { test, assert, fs, path, spawnSync, fixture, commit, sha } = require('./support.cjs');
const { poolSlotRefusal, currentLaneAt } = require('../../src/shared/lane/resume-guard.cjs');

const ai = path.resolve(__dirname, '../../../bin/ai');
const SESSION = '11111111-2222-4333-8444-555555555555';

test('without a pool, or outside its slots, nothing is refused', t => {
  const f = fixture(t);
  const lane = f.lease();
  assert.equal(poolSlotRefusal({ provider: 'claude', cwd: lane.path }, { env: { HARBOR_LANES_DIR: path.join(f.root, 'no-pool') } }), null);
  assert.equal(poolSlotRefusal({ provider: 'claude', cwd: f.repo, session: SESSION, configHome: f.root }, { env: { HARBOR_LANES_DIR: f.dir } }), null);
});

test('a slot refuses new sessions and every resume, naming why', t => {
  const f = fixture(t);
  const env = { HARBOR_LANES_DIR: f.dir };
  const lane = f.lease();
  const inside = path.join(lane.path, 'sub', 'folder');
  assert.match(poolSlotRefusal({ provider: 'claude', cwd: inside }, { env }), /does not start sessions in workspace-pool slot 1 of sample/);
  assert.match(poolSlotRefusal({ provider: 'codex', cwd: lane.path, session: SESSION, configHome: f.root }, { env }), /without a lane record/);
  const binding = { provider: 'claude', configHome: f.root, session: SESSION };
  f.pool.bindSession({ ...lane, ...binding });
  assert.match(poolSlotRefusal({ ...binding, cwd: lane.path }, { env }), /belongs to lane first, which is running in workspace-pool slot 1/);
  const final = commit(lane.path, 'first\n');
  f.pool.release({ ...lane, final });
  assert.match(poolSlotRefusal({ ...binding, cwd: lane.path }, { env }), /has been released for the next lane/);
  f.lease('second');
  assert.match(poolSlotRefusal({ ...binding, cwd: lane.path }, { env }), /now holds lane second, another task's checkout/);
  assert.match(poolSlotRefusal({ provider: 'cursor', cwd: lane.path, session: 'cursor-chat' }, { env }), /without a lane record/, 'cursor names no config home, so it never matches a binding');
});

test('bin/ai refuses a launch in a slot and runs as before without a pool', t => {
  const f = fixture(t);
  const lane = f.lease();
  const base = { ...process.env, HARBOR_AI_DRY_RUN: '1', CLAUDE_CONFIG_DIR: f.root, HARBOR_LANES_DIR: f.dir };
  const run = (env, cwd = lane.path, args = ['--provider', 'cursor', '--resume-id', SESSION]) => spawnSync(process.execPath, [ai, ...args], { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 60000 });
  const refused = run(base);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /^ai: Harbor does not resume this session: it ran in workspace-pool slot 1 of sample .* without a lane record/);
  const fresh = run(base, lane.path, ['--provider', 'claude']);
  assert.equal(fresh.status, 1);
  assert.match(fresh.stderr, /does not start sessions in workspace-pool slot 1/);
  const elsewhere = run(base, f.repo);
  assert.equal(elsewhere.status, 0, elsewhere.stderr);
  assert.match(elsewhere.stdout, new RegExp(`--resume ${SESSION}`));
  const noPool = run({ ...base, HARBOR_LANES_DIR: path.join(f.root, 'no-pool') });
  assert.equal(noPool.status, 0, noPool.stderr);
  assert.equal(sha(lane.path, 'HEAD'), f.base, 'the refused launch touched nothing');
  assert.equal(fs.existsSync(path.join(f.root, 'no-pool')), false);
});

test('a pool whose snapshot cannot be read refuses slot-shaped folders and nothing else', t => {
  const f = fixture(t);
  const lane = f.lease();
  const env = { HARBOR_LANES_DIR: f.dir };
  const registry = path.join(f.dir, 'registry.json');
  fs.writeFileSync(registry, '{"repos": {"sample": ');
  assert.match(poolSlotRefusal({ provider: 'claude', cwd: lane.path }, { env }), /looks like a workspace-pool slot, and the pool's registry snapshot cannot be read \(registry.json is not usable/);
  assert.equal(poolSlotRefusal({ provider: 'claude', cwd: f.repo }, { env }), null);
  fs.rmSync(registry);
  assert.match(poolSlotRefusal({ provider: 'codex', cwd: lane.path, session: SESSION, configHome: f.root }, { env }), /registry.json is missing beside an existing journal/);
  assert.equal(currentLaneAt(lane.path, { env }), undefined);
});

test('pool state follows the real profile, not a redirected USERPROFILE', () => {
  const lookup = path.resolve(__dirname, '../../src/shared/lane/lookup.cjs');
  const env = { ...process.env, USERPROFILE: 'C:\\tools\\cursor-orch-home', HOME: 'C:\\tools\\cursor-orch-home' };
  delete env.HARBOR_LANES_DIR;
  const r = spawnSync(process.execPath, ['-e', `console.log(require(${JSON.stringify(lookup)}).defaultStateDir())`], { env, encoding: 'utf8', windowsHide: true });
  assert.equal(r.stdout.trim(), path.join(require('node:os').userInfo().homedir, '.harbor', 'lanes'));
});

test('the launch guard loads no mutable pool implementation', () => {
  const guard = path.resolve(__dirname, '../../src/shared/lane/resume-guard.cjs');
  const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(guard)}); console.log(Object.keys(require.cache).map((f) => require('path').basename(f)).join(','))`], { encoding: 'utf8', windowsHide: true });
  assert.deepEqual(r.stdout.trim().split(',').sort(), ['lookup.cjs', 'resume-guard.cjs']);
});

test('malformed snapshot records fail closed for slots and never break unrelated launches', t => {
  const f = fixture(t);
  const lane = f.lease();
  const env = { HARBOR_LANES_DIR: f.dir };
  const registry = path.join(f.dir, 'registry.json');
  const good = JSON.parse(fs.readFileSync(registry, 'utf8'));
  for (const broken of [
    { ...good, repos: null },
    { ...good, repos: { sample: null } },
    { ...good, repos: { sample: { ...good.repos.sample, slots: [null] } } },
    { ...good, lanes: [] },
  ]) {
    fs.writeFileSync(registry, JSON.stringify(broken));
    assert.match(poolSlotRefusal({ provider: 'claude', cwd: lane.path }, { env }), /registry snapshot cannot be read \(registry.json is not usable \(unexpected shape\)\)/);
    assert.equal(poolSlotRefusal({ provider: 'claude', cwd: f.repo }, { env }), null);
  }
});

test('an alias into a slot is refused even when the snapshot cannot be read', t => {
  const f = fixture(t);
  const lane = f.lease();
  const env = { HARBOR_LANES_DIR: f.dir };
  const door = path.join(f.root, 'door');
  fs.symlinkSync(lane.path, door, process.platform === 'win32' ? 'junction' : 'dir');
  assert.match(poolSlotRefusal({ provider: 'claude', cwd: door }, { env }), /does not start sessions in workspace-pool slot 1/);
  fs.writeFileSync(path.join(f.dir, 'registry.json'), '{');
  assert.match(poolSlotRefusal({ provider: 'claude', cwd: path.join(door, 'src') }, { env }), /looks like a workspace-pool slot/);
});
