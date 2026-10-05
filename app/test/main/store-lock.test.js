'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { realTmpDir } = require('../support/real-tmpdir.js');
const { createNoteStore } = require('../../src/main/providers/notes.js');
const { createTaskStore } = require('../../src/main/providers/tasks.js');

async function lockOwner(t, lock, stale = false) {
  const child = spawn(process.execPath, [path.join(__dirname, '../support/store-lock-owner.cjs'), lock, stale ? 'stale' : 'held'], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const closed = once(child, 'close');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.stdin.end('release');
    assert.equal((await closed)[0], 0);
    t.diagnostic(`lock owner pid: ${child.pid} confirmed closed`);
  });
  await once(child.stdout, 'data');
  if (stale) assert.equal((await closed)[0], 0);
  t.diagnostic(`lock owner pid: ${child.pid}`);
  return async () => {
    child.stdin.end('release');
    assert.equal((await closed)[0], 0);
    t.diagnostic(`lock owner pid: ${child.pid} closed`);
  };
}

for (const [kind, createStore, type] of [['notes', createNoteStore, 'note.add'], ['tasks', createTaskStore, 'task.add']]) {
  function fixture(t, options = {}) {
    const dir = fs.mkdtempSync(path.join(realTmpDir(), `harbor-${kind}-lock-`));
    const file = path.join(dir, `${kind}.json`);
    const store = createStore({ file, ...options });
    t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    return { dir, file, lock: `${file}.lock`, store };
  }

  test(`${kind}: a held cross-process lock refuses a mutation and retry preserves both writes`, { timeout: 15000 }, async (t) => {
    const { file, lock, store } = fixture(t, { now: () => 42 });
    assert.equal((await store.mutate({ type, title: 'before' })).ok, true);
    const before = fs.readFileSync(file, 'utf8');
    const release = await lockOwner(t, lock);
    const past = new Date(Date.now() - 30000);
    fs.utimesSync(lock, past, past);
    const result = await store.mutate({ type, title: 'refused' });
    assert.equal(result.ok, false);
    assert.equal(result.retryable, true);
    assert.match(result.reason, /lock.*retry/i);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.equal(fs.existsSync(lock), true, 'a refusal must not release another process lock');
    await release();
    const resultAfter = await store.mutate({ type, title: 'after' });
    assert.equal(resultAfter.ok, true, resultAfter.reason);
    assert.deepEqual(resultAfter.doc[kind].map((item) => item.title), ['before', 'after']);
    assert.equal(fs.existsSync(lock), false);
  });

  test(`${kind}: an expired lock left by an exited owner recovers`, { timeout: 5000 }, async (t) => {
    const { lock, store } = fixture(t);
    await lockOwner(t, lock, true);
    const rm = fsp.rm;
    t.mock.method(fsp, 'rm', (target, ...args) => target === lock
      ? Promise.reject(Object.assign(new Error('stale lock denied'), { code: 'EACCES' })) : rm(target, ...args));
    const refused = await store.mutate({ type, title: 'refused' });
    assert.equal(refused.ok, false);
    assert.equal(refused.retryable, true);
    t.mock.restoreAll();
    const result = await store.mutate({ type, title: 'recovered' });
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.doc[kind][0].title, 'recovered');
    assert.equal(fs.existsSync(lock), false);
  });

  test(`${kind}: an unavailable lock never writes the document or backup`, async (t) => {
    const { file, lock, store } = fixture(t);
    assert.equal((await store.mutate({ type, title: 'before' })).ok, true);
    const before = fs.readFileSync(file, 'utf8');
    const mkdir = fsp.mkdir;
    t.mock.method(fsp, 'mkdir', (target, ...args) => target === lock
      ? Promise.reject(Object.assign(new Error('lock denied'), { code: 'EACCES' })) : mkdir(target, ...args));
    const result = await store.mutate({ type, title: 'refused' });
    assert.equal(result.ok, false);
    assert.equal(result.retryable, true);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.equal(fs.existsSync(`${file}.bak`), false);
  });

  test(`${kind}: a read cannot repair ids while its lock is unavailable`, async (t) => {
    const { file, lock, store } = fixture(t);
    const before = JSON.stringify({ version: 1, [kind]: [{ title: 'hand written' }] });
    fs.writeFileSync(file, before);
    const mkdir = fsp.mkdir;
    t.mock.method(fsp, 'mkdir', (target, ...args) => target === lock
      ? Promise.reject(Object.assign(new Error('lock denied'), { code: 'EACCES' })) : mkdir(target, ...args));
    const result = await store.read();
    assert.equal(result.ok, true);
    assert.equal(result.repairDeferred, true);
    assert.equal(result.doc[kind][0].title, 'hand written');
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    t.mock.restoreAll();
    assert.equal((await store.read()).ok, true);
    assert.ok(JSON.parse(fs.readFileSync(file, 'utf8'))[kind][0].id);
  });

  test(`${kind}: a missing parent is created before the first lock`, async (t) => {
    const { dir } = fixture(t);
    const store = createStore({ file: path.join(dir, 'new', 'nested', `${kind}.json`) });
    t.after(() => store.close());
    const result = await store.mutate({ type, title: 'first' });
    assert.equal(result.ok, true, result.reason);
  });

  test(`${kind}: lock ownership does not permit overwriting an unreadable document`, async (t) => {
    const { file, store } = fixture(t, { logger: { error() {} } });
    assert.equal((await store.mutate({ type, title: 'before' })).ok, true);
    const before = fs.readFileSync(file, 'utf8');
    const readFile = fsp.readFile;
    t.mock.method(fsp, 'readFile', (target, ...args) => target === file
      ? Promise.reject(Object.assign(new Error('read denied'), { code: 'EACCES' })) : readFile(target, ...args));
    const result = await store.mutate({ type, title: 'must not overwrite' });
    assert.equal(result.ok, false);
    assert.match(result.reason, /could not be read/);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    const loaded = await store.read();
    assert.equal(loaded.ok, false, 'an inaccessible file is not a successful empty read');
    assert.equal(loaded.retryable, true);
    assert.ok(loaded.doc);
    assert.match(loaded.reason, /could not be read.*retry/);
  });
}
