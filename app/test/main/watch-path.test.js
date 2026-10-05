'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');
const { realTmpDir } = require('../support/real-tmpdir.js');
const { watchPath } = require('../../src/main/watch-path.js');

test('watchPath uses native realpath and preserves recursive options and callbacks', (t) => {
  const listener = () => {};
  const watcher = new EventEmitter();
  t.mock.method(fs.realpathSync, 'native', (target) => {
    assert.equal(target, 'SHORT~1');
    return 'Long directory';
  });
  t.mock.method(fs, 'watch', (target, options, callback) => {
    assert.equal(target, 'Long directory');
    assert.deepEqual(options, { recursive: true });
    assert.equal(callback, listener);
    return watcher;
  });
  const warning = t.mock.method(console, 'warn', () => {});
  assert.equal(watchPath('SHORT~1', { recursive: true }, listener), watcher);
  watcher.emit('error', new Error('watch lost'));
  assert.match(warning.mock.calls[0].arguments[0], /cannot watch SHORT~1.*watch lost/);
});

test('a failed native realpath reports degradation and never watches the unsafe spelling', (t) => {
  const failure = Object.assign(new Error('target gone'), { code: 'ENOENT' });
  t.mock.method(fs.realpathSync, 'native', () => { throw failure; });
  const watch = t.mock.method(fs, 'watch', () => { throw Error('unsafe fallback'); });
  const warning = t.mock.method(console, 'warn', () => {});
  assert.throws(() => watchPath('SHORT~1', () => {}), (error) => error === failure);
  assert.equal(watch.mock.callCount(), 0);
  assert.match(warning.mock.calls[0].arguments[0], /automatic file updates may be delayed.*target gone/);
});

test('real Windows 8.3 paths deliver Notes, Tasks, Board, and history updates', {
  skip: process.platform !== 'win32', timeout: 20000,
}, async (t) => {
  const dir = fs.mkdtempSync(path.join(realTmpDir(), 'Harbor watch long directory '));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const short = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '(New-Object -ComObject Scripting.FileSystemObject).GetFolder($env:HARBOR_WATCH_TEST_DIR).ShortPath'], {
    env: { ...process.env, HARBOR_WATCH_TEST_DIR: dir }, encoding: 'utf8', windowsHide: true, timeout: 10000,
  });
  assert.equal(short.status, 0, short.stderr || short.error?.message);
  const target = short.stdout.trim();
  if (!/~\d/.test(target)) return t.skip('This volume has no 8.3 alias for the test directory');
  assert.equal(fs.realpathSync.native(target), fs.realpathSync.native(dir));
  t.diagnostic(`8.3 target: ${target}; native target: ${fs.realpathSync.native(target)}; helper pid: ${short.pid} exited ${short.status}`);

  const { createNoteStore } = require('../../src/main/providers/notes.js');
  const { createTaskStore } = require('../../src/main/providers/tasks.js');
  const { createWhiteboardStore } = require('../../src/main/providers/whiteboard.js');
  const { createHistoryProvider } = require('../../src/main/providers/history.js');
  const notes = createNoteStore({ file: path.join(target, 'notes.json') });
  const tasks = createTaskStore({ file: path.join(target, 'tasks.json') });
  const boards = createWhiteboardStore({ dir: target });
  const history = createHistoryProvider({ projectsPath: target, historyIndex: { close() {} }, runIndexer: async () => '', debounceMs: 20 });
  t.after(() => { notes.close(); tasks.close(); boards.close(); history.close(); });
  const note = await notes.mutate({ type: 'note.add', title: 'initial' });
  const task = await tasks.mutate({ type: 'task.add', title: 'initial' });
  assert.equal(note.ok, true);
  assert.equal(task.ok, true);
  const seen = new Set();
  notes.subscribe((doc) => { if (doc.notes[0]?.title === 'outside') seen.add('notes'); });
  tasks.subscribe((doc) => { if (doc.tasks[0]?.title === 'outside') seen.add('tasks'); });
  boards.subscribe((payload) => { if (payload.id === 'outside') seen.add('board'); });
  history.on('history-changed', () => seen.add('history'));
  note.doc.notes[0].title = 'outside';
  task.doc.tasks[0].title = 'outside';
  fs.writeFileSync(path.join(dir, 'notes.json'), JSON.stringify(note.doc));
  fs.writeFileSync(path.join(dir, 'tasks.json'), JSON.stringify(task.doc));
  fs.writeFileSync(path.join(dir, 'outside.json'), JSON.stringify({ name: 'outside', elements: [] }));
  const deadline = Date.now() + 5000;
  while (seen.size < 4 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual([...seen].sort(), ['board', 'history', 'notes', 'tasks']);
});
