'use strict';
// ONLY THE ROWS THAT CHANGED (2026-11-06). The rail's "every session" list was
// a 14.8 MB string of 12,000 rows, copied across the worker boundary and
// parsed on the main thread of the app and the phone server on every history
// refresh (61% of the phone server's allocations). The indexer now answers a
// caller holding its last cursor with the id order plus only the changed
// lines. The rows the rail gets must be exactly the rows the full answer
// parses to, through appends, new sessions, deleted sessions and reorders.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHistoryIndex } = require('../../src/main/providers/history-index.js');
const { createHistoryProvider, parseEmitTsv } = require('../../src/main/providers/history.js');

const FULL_ARGS = ['emit', '--all', '--with-first-prompt', '--with-cwd', '--with-path', '--with-entrypoint', '--with-meta'];

function fixture(t) {
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'hb-list-delta-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const projectsDir = path.join(tmp, 'projects');
  const cacheDir = path.join(tmp, 'cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  let clock = Date.parse('2026-11-06T10:00:00Z');
  const write = (project, id, text) => {
    const dir = path.join(projectsDir, project);
    fs.mkdirSync(dir, { recursive: true });
    clock += 60_000;
    const file = path.join(dir, `${id}.jsonl`);
    fs.appendFileSync(file, `${JSON.stringify({
      type: 'user', timestamp: new Date(clock).toISOString(), cwd: `C:\\dev\\${project}`, sessionId: id,
      message: { role: 'user', content: [{ type: 'text', text }] },
    })}\n`);
    const when = new Date(clock);
    fs.utimesSync(file, when, when);
    return file;
  };
  const index = createHistoryIndex({ projectsDir, cacheDir, refreshFloorMs: 0, readOnly: true });
  return { index, write };
}

const id = (n) => `${String(n).repeat(8)}-1111-2222-3333-444444444444`;

test('the changed-rows list equals the full list through appends, new, deleted and reordered sessions', async (t) => {
  const { index, write } = fixture(t);
  const files = {};
  files[1] = write('alpha', id(1), 'first session, about the census tool');
  files[2] = write('beta', id(2), 'second session\twith a tab and a \\ backslash');
  files[3] = write('gamma', id(3), 'third session 😀 with an emoji');
  const provider = createHistoryProvider({ historyIndex: index });
  t.after(() => provider.close());
  const full = () => parseEmitTsv(index.run(FULL_ARGS));

  assert.deepEqual(await provider.listSessions(), full(), 'first answer');

  write('alpha', id(1), 'a later prompt moves session 1 to the top');
  assert.deepEqual(await provider.listSessions(), full(), 'after an append reorders the list');

  files[4] = write('delta', id(4), 'a brand new session');
  fs.rmSync(files[2]);
  assert.deepEqual(await provider.listSessions(), full(), 'after a new session and a deleted one');

  assert.deepEqual(await provider.listSessions(), full(), 'with nothing changed');
  const rows = await provider.listSessions();
  assert.deepEqual(rows.map((row) => row.id), [id(4), id(1), id(3)]);
});

test('only changed lines cross when the caller holds the last cursor, and any other cursor gets them all', (t) => {
  const { index, write } = fixture(t);
  write('alpha', id(1), 'one');
  write('beta', id(2), 'two');
  write('gamma', id(3), 'three');
  const flags = FULL_ARGS.slice(1);
  const first = index.emitDelta(flags, null);
  assert.equal(first.full, true);
  assert.equal(first.changed.length, 3);

  const quiet = index.emitDelta(flags, first.cursor);
  assert.equal(quiet.full, false);
  assert.equal(quiet.changed.length, 0, 'nothing changed, nothing crosses');
  assert.equal(quiet.ids.length, 3);

  write('beta', id(2), 'two, again');
  const one = index.emitDelta(flags, quiet.cursor);
  assert.equal(one.changed.length, 1, 'one session changed, one line crosses');
  assert.match(one.changed[0], new RegExp(`^${id(2)}\t`));

  const stale = index.emitDelta(flags, first.cursor);
  assert.equal(stale.full, true, 'a cursor that is not the last answer gets every line');
  assert.equal(stale.changed.length, 3);

  const otherWorker = index.emitDelta(flags, { ...stale.cursor, epoch: 'another-worker' });
  assert.equal(otherWorker.full, true, 'a restarted worker answers in full');
});

test('the provider really takes the changed-rows path: a quiet refresh parses no line', async (t) => {
  const { index, write } = fixture(t);
  write('alpha', id(1), 'one');
  write('beta', id(2), 'two');
  const answers = [];
  const spy = { ...index, emitDelta: (...args) => { const answer = index.emitDelta(...args); answers.push(answer); return answer; } };
  const provider = createHistoryProvider({ historyIndex: spy });
  t.after(() => provider.close());
  await provider.listSessions();
  await provider.listSessions();
  write('beta', id(2), 'two, again');
  await provider.listSessions();
  assert.deepEqual(answers.map((a) => [a.full, a.changed.length]), [[true, 2], [false, 0], [false, 1]]);
});
