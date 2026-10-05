'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { realTmpDir } = require('../support/real-tmpdir.js');
const { holdStoreLock } = require('../support/held-store-lock.cjs');
const { acquireStoreLock } = require('../../src/main/store-lock.js');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(realTmpDir(), 'harbor-lock-recovery-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, lock: path.join(dir, 'document.json.lock') };
}

function abandoned(lock, owner, age) {
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'owner'), owner);
  const past = new Date(Date.now() - age);
  fs.utimesSync(lock, past, past);
}

test('a live unrelated parent pid cannot veto recovery past the 60 second ceiling', { timeout: 6000 }, async (t) => {
  const { lock } = fixture(t);
  process.kill(process.ppid, 0); // Liveness query only, never a signal.
  abandoned(lock, String(process.ppid), 65000);
  assert.equal(await acquireStoreLock(lock), true);
});

for (const owner of ['', 'not-a-pid']) {
  test(`an ${owner ? 'invalid' : 'empty'} owner recovers after the stale age`, { timeout: 6000 }, async (t) => {
    const { lock } = fixture(t);
    abandoned(lock, owner, 20000);
    assert.equal(await acquireStoreLock(lock), true);
  });
}

test('an unreadable owner recovers after the stale age', { timeout: 6000 }, async (t) => {
  const { lock } = fixture(t);
  abandoned(lock, String(process.ppid), 20000);
  const read = fsp.readFile;
  t.mock.method(fsp, 'readFile', (file, ...args) => file === path.join(lock, 'owner')
    ? Promise.reject(Object.assign(new Error('owner denied'), { code: 'EACCES' })) : read(file, ...args));
  assert.equal(await acquireStoreLock(lock), true);
});

test('EPERM cannot veto recovery past the ceiling', { timeout: 6000 }, async (t) => {
  const { lock } = fixture(t);
  abandoned(lock, String(process.ppid), 65000);
  t.mock.method(process, 'kill', (_pid, signal) => {
    assert.equal(signal, 0);
    throw Object.assign(new Error('owner liveness denied'), { code: 'EPERM' });
  });
  assert.equal(await acquireStoreLock(lock), true);
});

for (const kind of ['notes', 'tasks']) {
  const { [kind === 'notes' ? 'createNoteStore' : 'createTaskStore']: createStore } = require(`../../src/main/providers/${kind}.js`);
  for (const corrupt of [false, true]) {
    test(`${kind}: read under a held lock returns ${corrupt ? 'the backup without quarantine' : 'the document without repairing ids'}`, { timeout: 7000 }, async (t) => {
      const { dir } = fixture(t);
      const file = path.join(dir, `${kind}.json`);
      const saved = JSON.stringify({ version: 1, [kind]: [{ title: 'Saved work' }] });
      const before = corrupt ? '{interrupted JSON' : saved;
      fs.writeFileSync(file, before);
      if (corrupt) fs.writeFileSync(file + '.bak', saved);
      const store = createStore({ file, logger: { error() {} } });
      t.after(() => store.close());
      await holdStoreLock(t, file + '.lock');
      const entries = fs.readdirSync(dir).sort();
      const result = await store.read();
      assert.equal(result.ok, true);
      assert.equal(result.repairDeferred, true);
      assert.equal(result.doc[kind][0].title, 'Saved work');
      assert.equal(fs.readFileSync(file, 'utf8'), before);
      assert.deepEqual(fs.readdirSync(dir).sort(), entries, 'read must not save, back up, or quarantine');
      if (corrupt) {
        assert.equal(fs.readFileSync(file + '.bak', 'utf8'), saved);
        assert.equal(result.recovery.kind, 'backup-read-only');
      }
    });
  }
}
