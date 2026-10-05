'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { realTmpDir } = require('../support/real-tmpdir.js');
const { holdStoreLock } = require('../support/held-store-lock.cjs');
const quiet = { error() {} };

for (const kind of ['notes', 'tasks']) {
  const create = require(`../../src/main/providers/${kind}.js`)[kind === 'notes' ? 'createNoteStore' : 'createTaskStore'];
  const model = require(`../../src/shared/${kind}-model.cjs`);
  const add = title => ({ type: kind === 'notes' ? 'note.add' : 'task.add', title });
  function fixture(t) {
    const dir = fs.mkdtempSync(path.join(realTmpDir(), 'harbor-quarantine-'));
    const file = path.join(dir, kind + '.json');
    const stores = [];
    const open = () => { const store = create({ file, logger: quiet }); stores.push(store); return store; };
    t.after(() => { for (const store of stores) store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    return { dir, file, open };
  }
  test(`${kind}: a second reader reports quarantined corruption after the source disappears`, async t => {
    const { file, open } = fixture(t);
    fs.writeFileSync(file, '{broken');
    const first = await open().read();
    assert.equal(first.recovery.kind, 'corrupt');
    assert.equal(fs.existsSync(file), false);
    const second = await open().read();
    assert.deepEqual(second.recovery, first.recovery);
    assert.equal(fs.readFileSync(first.recovery.detail, 'utf8'), '{broken');
    assert.equal(fs.existsSync(file), false);
  });
  test(`${kind}: a mutation after quarantine refuses to start a fresh document`, async t => {
    const { file, open } = fixture(t);
    fs.writeFileSync(file, '{broken');
    const first = await open().read();
    const result = await open().mutate(add('Must not replace the missing store'));
    assert.equal(result.ok, false);
    assert.deepEqual(result.recovery, first.recovery);
    assert.equal(fs.existsSync(file), false);
    assert.equal(fs.readFileSync(first.recovery.detail, 'utf8'), '{broken');
  });
  test(`${kind}: the mutation discovering corruption also refuses to save`, async t => {
    const { file, open } = fixture(t);
    fs.writeFileSync(file, '{broken');
    const result = await open().mutate(add('Must not land'));
    assert.equal(result.ok, false);
    assert.equal(result.recovery.kind, 'corrupt');
    assert.equal(fs.existsSync(file), false);
  });
  test(`${kind}: repeated recovery reads retain the backup and refuse writes until restoration`, async t => {
    const { file, open } = fixture(t);
    const backup = JSON.stringify(model.applyOp(model.emptyDoc(), add('Survivor')).doc);
    fs.writeFileSync(file + '.bak', backup);
    fs.writeFileSync(file, '{broken');
    const first = await open().read();
    const reopened = open();
    const second = await reopened.read();
    assert.deepEqual(second.recovery, first.recovery);
    assert.deepEqual(second.doc[kind].map(item => item.title), ['Survivor']);
    assert.equal((await reopened.mutate(add('Refused'))).ok, false);
    assert.equal(fs.readFileSync(file + '.bak', 'utf8'), backup);
    assert.equal(fs.existsSync(file), false);
    // Restoring a valid main document is an explicit recovery decision.
    fs.writeFileSync(file, backup);
    assert.equal((await reopened.read()).recovery, null);
    assert.equal((await reopened.mutate(add('After restoration'))).ok, true);
    assert.equal(fs.readFileSync(first.recovery.detail, 'utf8'), '{broken');
  });
  test(`${kind}: a held-lock snapshot retains the quarantine notice without repairing`, async t => {
    const { file, open } = fixture(t);
    fs.writeFileSync(file, '{broken');
    const first = await open().read();
    await holdStoreLock(t, file + '.lock');
    const second = await open().read();
    assert.equal(second.repairDeferred, true);
    assert.deepEqual(second.recovery, first.recovery);
    assert.equal(fs.existsSync(file), false);
  });
  test(`${kind}: unrelated files and similarly named directories do not block a fresh store`, async t => {
    const { dir, file, open } = fixture(t);
    fs.writeFileSync(path.join(dir, 'other.json.corrupt-stamp'), 'other store');
    fs.mkdirSync(file + '.corrupt-directory');
    const store = open();
    assert.equal((await store.read()).recovery, null);
    assert.equal((await store.mutate(add('Fresh store'))).ok, true);
  });
}
