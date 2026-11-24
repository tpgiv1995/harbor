'use strict';

// Gemini sessions are lane citizens like the other providers' (2026-11-23): the pool can bind one, and Harbor refuses to
// resume it in a slot its lane owns. Before this a Gemini session could not be bound at all (the pool's provider list
// had three names) and a resume was refused only as "without a lane record", which is wrong for a bound one.
const { test, assert, path, fixture, throwsCode, commit } = require('./support.cjs');
const { poolSlotRefusal } = require('../../src/shared/lane/resume-guard.cjs');
const { sessionKey, PROVIDERS } = require('../../src/shared/lane/lookup.cjs');

const SESSION = '32fe68ca-b177-4dba-86f4-6272f59c04b9';

test('the pool knows gemini beside the other three', () => {
  assert.deepEqual(PROVIDERS, ['claude', 'codex', 'cursor', 'gemini']);
  assert.equal(typeof sessionKey({ provider: 'gemini', configHome: path.resolve('/profile'), session: SESSION }), 'string');
  assert.equal(sessionKey({ provider: 'gemini', configHome: null, session: SESSION }), null);
});

test('a Gemini session bound to a lane is refused a resume in that lane\'s slot, naming the lane', (t) => {
  const f = fixture(t);
  const env = { HARBOR_LANES_DIR: f.dir };
  const lane = f.lease();
  const binding = { provider: 'gemini', configHome: f.root, session: SESSION };
  assert.match(poolSlotRefusal({ ...binding, cwd: lane.path }, { env }), /without a lane record/, 'unbound: refused, with no lane to name');
  f.pool.bindSession({ ...lane, ...binding });
  assert.match(poolSlotRefusal({ ...binding, cwd: lane.path }, { env }), /belongs to lane first, which is running in workspace-pool slot 1/);
  assert.match(poolSlotRefusal({ provider: 'gemini', cwd: path.join(lane.path, 'sub') }, { env }), /does not start sessions in workspace-pool slot 1/, 'a new launch is refused too');
  const final = commit(lane.path, 'first\n');
  f.pool.release({ ...lane, final });
  assert.match(poolSlotRefusal({ ...binding, cwd: lane.path }, { env }), /has been released for the next lane/);
});

test('the binding is keyed by the Gemini profile root: another root is another session', (t) => {
  const f = fixture(t);
  const lane = f.lease();
  f.pool.bindSession({ ...lane, provider: 'gemini', configHome: f.root, session: SESSION });
  const env = { HARBOR_LANES_DIR: f.dir };
  const elsewhere = path.join(f.root, 'another-profile');
  assert.match(poolSlotRefusal({ provider: 'gemini', configHome: elsewhere, session: SESSION, cwd: lane.path }, { env }), /without a lane record/);
});

test('an unknown provider still cannot be bound', (t) => {
  const f = fixture(t);
  const lane = f.lease();
  throwsCode(() => f.pool.bindSession({ ...lane, provider: 'nothing', configHome: f.root, session: SESSION }), 'INVALID_ARGUMENT');
});
