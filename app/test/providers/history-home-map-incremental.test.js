'use strict';
// EACH HOME'S INPUTS ARE READ ONLY AS FAR AS THEY CHANGED (2026-11-06). The
// home map re-parsed every home's history.jsonl and re-listed every
// session-env and file-history folder on almost every rail refresh. It now
// reads a grown history file from where it stopped and re-lists a folder only
// when it changed. Whatever happens to the files, the map must equal the one a
// fresh index (reading everything whole) builds.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHistoryIndex } = require('../../src/main/providers/history-index.js');

const uuid = (n) => `${String(n).padStart(8, '0')}-aaaa-bbbb-cccc-dddddddddddd`;

test('the incremental home map equals a whole read through appends, partial lines, odd separators, rewrites and new folders', (t) => {
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'hb-home-map-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const homes = ['alpha', 'beta'].map((id) => ({ id, configHome: path.join(tmp, `.claude-${id}`) }));
  for (const home of homes) fs.mkdirSync(path.join(home.configHome, 'session-env'), { recursive: true });
  const options = { projectsDir: path.join(tmp, 'projects'), cacheDir: path.join(tmp, 'cache'), profiles: homes, refreshFloorMs: 0, readOnly: true };
  fs.mkdirSync(options.projectsDir, { recursive: true });
  const incremental = createHistoryIndex(options);
  const fresh = () => createHistoryIndex(options).buildHomeMap();
  const history = (home) => path.join(home.configHome, 'history.jsonl');
  const line = (n, extra = '') => `${JSON.stringify({ display: `prompt ${n}${extra}`, sessionId: uuid(n) })}\n`;
  const check = (label) => assert.deepEqual(incremental.buildHomeMap(), fresh(), label);

  fs.writeFileSync(history(homes[0]), line(1) + line(2));
  fs.writeFileSync(history(homes[1]), line(2) + line(3));
  check('first build');

  fs.appendFileSync(history(homes[0]), line(2) + line(4));
  check('after appends (session 2 now leans to alpha)');

  fs.appendFileSync(history(homes[1]), line(5).slice(0, 20));
  check('with a half-written last line');
  fs.appendFileSync(history(homes[1]), line(5).slice(20));
  check('once that line completes');

  fs.appendFileSync(history(homes[1]), line(6, ' inside') + line(7, '\r') + `${JSON.stringify({ sessionId: uuid(8) })}`);
  check('with a line separator inside a prompt and a last line with no newline');
  fs.appendFileSync(history(homes[1]), `\n${line(9)}`);
  check('after the newline arrives');

  fs.writeFileSync(history(homes[0]), line(3));
  check('after a rewrite to a shorter file');
  fs.writeFileSync(history(homes[0]), line(3).replace('prompt', 'PROMPT') + line(10) + line(10));
  check('after a rewrite with a different first line');

  fs.mkdirSync(path.join(homes[1].configHome, 'session-env', uuid(3)));
  fs.mkdirSync(path.join(homes[0].configHome, 'file-history', uuid(11)), { recursive: true });
  check('after new session-env and file-history folders');

  fs.rmSync(history(homes[1]));
  check('after a history file is deleted');
});

test('a prompt appended to a large history file costs only its own bytes', (t) => {
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'hb-home-map-cost-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const home = { id: 'alpha', configHome: path.join(tmp, '.claude') };
  fs.mkdirSync(home.configHome, { recursive: true });
  const file = path.join(home.configHome, 'history.jsonl');
  const lines = [];
  for (let i = 0; i < 4000; i += 1) lines.push(JSON.stringify({ display: `prompt ${i} ${'x'.repeat(200)}`, sessionId: uuid(i % 300) }));
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  let readBytes = 0;
  const countingFs = {
    ...fs,
    readFileSync: (target, ...rest) => { const out = fs.readFileSync(target, ...rest); if (String(target) === file) readBytes += out.length; return out; },
    readSync: (fd, buffer, offset, length, position) => { const got = fs.readSync(fd, buffer, offset, length, position); readBytes += got; return got; },
  };
  const projectsDir = path.join(tmp, 'projects'); fs.mkdirSync(projectsDir);
  const index = createHistoryIndex({ projectsDir, cacheDir: path.join(tmp, 'cache'), profiles: [home], refreshFloorMs: 0, readOnly: true, fs: countingFs });
  index.buildHomeMap();
  readBytes = 0;
  fs.appendFileSync(file, `${JSON.stringify({ display: 'one more prompt', sessionId: uuid(299) })}\n`);
  index.buildHomeMap();
  assert.ok(readBytes < 2048, `read ${readBytes} bytes after a one-line append to a ${fs.statSync(file).size}-byte history`);
});

// Astra review round 2, N1 and N6.
test('a same-size rewrite and a folder that would not list are both read again', (t) => {
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'hb-home-map-r2-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const home = { id: 'alpha', configHome: path.join(tmp, '.claude') };
  fs.mkdirSync(path.join(home.configHome, 'session-env', uuid(42)), { recursive: true });
  const file = path.join(home.configHome, 'history.jsonl');
  fs.writeFileSync(file, `${JSON.stringify({ display: `long ${'x'.repeat(400)}`, sessionId: uuid(1) })}\n`);
  let failListing = true;
  const flakyFs = {
    ...fs,
    readdirSync: (target, ...rest) => {
      if (failListing && String(target).endsWith('session-env')) { failListing = false; const e = new Error('denied'); e.code = 'EACCES'; throw e; }
      return fs.readdirSync(target, ...rest);
    },
  };
  const projectsDir = path.join(tmp, 'projects'); fs.mkdirSync(projectsDir);
  const options = { projectsDir, cacheDir: path.join(tmp, 'cache'), profiles: [home], refreshFloorMs: 0, readOnly: true };
  const incremental = createHistoryIndex({ ...options, fs: flakyFs });
  const fresh = () => createHistoryIndex(options).buildHomeMap();
  const first = incremental.buildHomeMap();
  assert.equal(first[uuid(42)], undefined, 'the folder would not list the first time');
  assert.deepEqual(incremental.buildHomeMap(), fresh(), 'and is read again once it lists, with nothing else changed');
  const later = new Date(Date.now() + 5000);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(uuid(1), uuid(7)));
  fs.utimesSync(file, later, later);
  assert.deepEqual(incremental.buildHomeMap(), fresh(), 'a same-size rewrite past the first 256 bytes is read again');
});

// Astra review round 3: a history file swapped in with the same size and mtime,
// file ids that only differ past 2^53, and a history file that would not open
// once must all end up read like a fresh index reads them.
test('swapped-in files, huge file ids and a failed open are all read again', (t) => {
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'hb-home-map-r3-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const home = { id: 'alpha', configHome: path.join(tmp, '.claude') };
  fs.mkdirSync(home.configHome, { recursive: true });
  const file = path.join(home.configHome, 'history.jsonl');
  const line = (n, pad = '') => `${JSON.stringify({ display: `prompt ${pad}`, sessionId: uuid(n) })}\n`;
  const when = new Date('2026-11-06T08:00:00Z');
  let failOpen = true;
  let fakeIno = null;
  const trickyFs = {
    ...fs,
    openSync: (target, ...rest) => {
      if (failOpen && String(target) === file) { failOpen = false; const e = new Error('denied'); e.code = 'EACCES'; throw e; }
      return fs.openSync(target, ...rest);
    },
    fstatSync: (fd, options) => {
      const info = fs.fstatSync(fd, options);
      if (fakeIno !== null && options?.bigint) info.ino = fakeIno;
      return info;
    },
  };
  const projectsDir = path.join(tmp, 'projects'); fs.mkdirSync(projectsDir);
  const options = { projectsDir, cacheDir: path.join(tmp, 'cache'), profiles: [home], refreshFloorMs: 0, readOnly: true };
  const incremental = createHistoryIndex({ ...options, fs: trickyFs });
  const fresh = () => createHistoryIndex(options).buildHomeMap();

  fs.writeFileSync(file, line(1, 'x'.repeat(300))); fs.utimesSync(file, when, when);
  assert.deepEqual(incremental.buildHomeMap(), {}, 'the first open failed');
  assert.deepEqual(incremental.buildHomeMap(), fresh(), 'and is retried with nothing else changed');

  const aside = path.join(home.configHome, 'aside.jsonl');
  fs.writeFileSync(aside, line(2, 'x'.repeat(300))); fs.utimesSync(aside, when, when);
  fs.renameSync(aside, file);
  assert.deepEqual(incremental.buildHomeMap(), fresh(), 'a file swapped in with the same size and mtime');

  fakeIno = 9007199254740992n;
  incremental.buildHomeMap();
  fakeIno = 9007199254740993n; // the same Number, a different file
  // Same first 256 bytes (the session id sits past them), grown: only the
  // file identity says it is another file.
  fs.writeFileSync(file, line(3, 'x'.repeat(300)) + line(4));
  assert.deepEqual(incremental.buildHomeMap(), fresh(), 'file ids that differ only past 2^53');
});
