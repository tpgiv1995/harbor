'use strict';
// The ask inbox (2026-09-05): Harbor's side of the hook lane. A request file
// from the hook becomes a claim and a pending question for a session Harbor
// shows; the answer or decline becomes the file the hook turns into the
// tool's own input; a request nobody is waiting on is dropped.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const proto = require('../../src/shared/ask-protocol.cjs');
const { createAskInbox, normalizeQuestions } = require('../../src/main/providers/ask-inbox.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'hb-ask-inbox-'));
}

const TOOL_INPUT = {
  questions: [
    { question: 'Which path?', header: 'Path', multiSelect: false, options: [{ label: 'Fast', description: 'a' }, { label: 'Careful (Recommended)', description: 'b', preview: '┌─┐' }] },
  ],
};

function request(dir, id, sessionId, extra = {}) {
  proto.writeJsonAtomic(proto.filesFor(dir, id).request, {
    v: 1, id, at: Date.now(), hookPid: process.pid, sessionId, transcriptPath: null, cwd: 'C:\\dev\\proj', toolUseId: id, toolInput: TOOL_INPUT, ...extra,
  });
}

test('a request for a session Harbor shows is claimed and listed with its questions normalized', () => {
  const dir = tmpDir();
  const inbox = createAskInbox({ dir, ownsSession: (id) => (id === 'sess-1' ? { paneId: 'pane-1', workspaceId: 'ws-1' } : null), pollMs: 3_600_000, heartbeatMs: 3_600_000 });
  const changes = [];
  inbox.emitter.on('changed', (list) => changes.push(list));
  inbox.start();
  assert.ok(fs.existsSync(proto.heartbeatPath(dir)), 'the heartbeat is written on start');
  request(dir, 'toolu_1', 'sess-1');
  inbox.scan();
  assert.ok(fs.existsSync(proto.filesFor(dir, 'toolu_1').claim), 'claimed');
  const [entry] = inbox.list();
  assert.equal(entry.sessionId, 'sess-1');
  assert.equal(entry.paneId, 'pane-1');
  assert.equal(entry.questions[0].options[1].preview, '┌─┐');
  assert.equal(entry.questions[0].options[1].label, 'Careful (Recommended)');
  assert.equal(changes.length, 1);
  inbox.stop();
  assert.equal(fs.existsSync(proto.heartbeatPath(dir)), false, 'stopping removes the heartbeat so waiting hooks step aside');
});

test('a request for a session Harbor does not show gets a PASS, no claim, nothing listed', () => {
  const dir = tmpDir();
  const inbox = createAskInbox({ dir, ownsSession: () => null, pollMs: 3_600_000, heartbeatMs: 3_600_000 });
  inbox.start();
  request(dir, 'toolu_2', 'someone-elses');
  inbox.scan();
  const files = proto.filesFor(dir, 'toolu_2');
  assert.equal(fs.existsSync(files.claim), false);
  assert.ok(fs.existsSync(files.pass), 'an explicit pass, so the hook steps aside now instead of at its deadline');
  assert.deepEqual(inbox.list(), []);
  assert.ok(fs.existsSync(files.request), 'the hook withdraws its own request; the inbox never deletes a live one');
  inbox.stop();
});

test('an answer after the hook died is refused by name, never reported as sent', () => {
  const dir = tmpDir();
  let alive = true;
  const inbox = createAskInbox({ dir, ownsSession: () => ({ paneId: 'p' }), pollMs: 3_600_000, heartbeatMs: 3_600_000, pidAlive: () => alive });
  inbox.start();
  request(dir, 'toolu_8', 'sess-1', { hookPid: 888 });
  inbox.scan();
  alive = false; // the hook stepped aside at its deadline a beat before the claim landed
  const result = inbox.answer('toolu_8', { answers: { 'Which path?': 'Fast' } });
  assert.equal(result.ok, false);
  assert.match(result.reason, /timed out/);
  assert.equal(fs.existsSync(proto.filesFor(dir, 'toolu_8').answer), false, 'no answer file is written for nobody');
  // The refusal is delivered to a card that is STILL mounted (round 2: a
  // publish from inside the reply unmounted the form before it could show
  // the reason); the next scan is what drops the dead entry.
  assert.equal(inbox.list().length, 1, 'the card stays until the next scan so the reason can be read');
  inbox.scan();
  assert.deepEqual(inbox.list(), [], 'then the card is gone');
  inbox.stop();
});

test('answer writes the file the hook consumes, and the entry leaves once the hook removes the request', () => {
  const dir = tmpDir();
  const inbox = createAskInbox({ dir, ownsSession: () => ({ paneId: 'p' }), pollMs: 3_600_000, heartbeatMs: 3_600_000 });
  inbox.start();
  request(dir, 'toolu_3', 'sess-1');
  inbox.scan();
  const result = inbox.answer('toolu_3', { answers: { 'Which path?': 'Careful (Recommended)' }, annotations: { 'Which path?': { notes: 'note' } } });
  assert.deepEqual(result, { ok: true });
  const written = proto.readJson(proto.filesFor(dir, 'toolu_3').answer);
  assert.deepEqual(written.answers, { 'Which path?': 'Careful (Recommended)' });
  assert.deepEqual(written.annotations, { 'Which path?': { notes: 'note' } });
  assert.equal(inbox.list()[0].answered, true);
  // The hook consumes the files.
  for (const file of Object.values(proto.filesFor(dir, 'toolu_3'))) { try { fs.unlinkSync(file); } catch { /* absent */ } }
  inbox.scan();
  assert.deepEqual(inbox.list(), []);
  inbox.stop();
});

test('decline writes a decline the hook turns into a deny, and an empty answer is refused', () => {
  const dir = tmpDir();
  const inbox = createAskInbox({ dir, ownsSession: () => ({ paneId: 'p' }), pollMs: 3_600_000, heartbeatMs: 3_600_000 });
  inbox.start();
  request(dir, 'toolu_4', 'sess-1');
  inbox.scan();
  assert.equal(inbox.answer('toolu_4', { answers: {} }).ok, false);
  assert.deepEqual(inbox.decline('toolu_4', 'Reply instead: do the fast path but tell me first'), { ok: true });
  assert.equal(proto.readJson(proto.filesFor(dir, 'toolu_4').answer).decline, 'Reply instead: do the fast path but tell me first');
  assert.equal(inbox.answer('nope', { answers: { a: 'b' } }).ok, false);
  inbox.stop();
});

test('a ghost request (hook process gone, or older than the ceiling) is dropped, never shown', () => {
  const dir = tmpDir();
  const inbox = createAskInbox({ dir, ownsSession: () => ({ paneId: 'p' }), pollMs: 3_600_000, heartbeatMs: 3_600_000, pidAlive: (pid) => pid !== 424242 });
  inbox.start();
  request(dir, 'toolu_5', 'sess-1', { hookPid: 424242 });
  request(dir, 'toolu_6', 'sess-1', { at: Date.now() - proto.REQUEST_MAX_AGE_MS - 1000 });
  inbox.scan();
  assert.deepEqual(inbox.list(), []);
  assert.equal(fs.existsSync(proto.filesFor(dir, 'toolu_5').request), false);
  assert.equal(fs.existsSync(proto.filesFor(dir, 'toolu_6').request), false);
  inbox.stop();
});

test('a pending question whose hook dies while waiting is dropped with its files, never left on screen', () => {
  const dir = tmpDir();
  let alive = true;
  const inbox = createAskInbox({ dir, ownsSession: () => ({ paneId: 'p' }), pollMs: 3_600_000, heartbeatMs: 3_600_000, pidAlive: () => alive });
  const changes = [];
  inbox.emitter.on('changed', (list) => changes.push(list.length));
  inbox.start();
  request(dir, 'toolu_7', 'sess-1', { hookPid: 777 });
  inbox.scan();
  assert.equal(inbox.list().length, 1, 'claimed while the hook lives');
  alive = false; // the CLI was killed; the hook went with it
  inbox.scan();
  assert.deepEqual(inbox.list(), [], 'gone from the pending set');
  const files = proto.filesFor(dir, 'toolu_7');
  assert.equal(fs.existsSync(files.request), false);
  assert.equal(fs.existsSync(files.claim), false);
  assert.deepEqual(changes, [1, 0], 'the renderer was told both ways');
  inbox.stop();
});

test('normalizeQuestions is total: junk in, a renderable shape out', () => {
  assert.deepEqual(normalizeQuestions(null), []);
  const [q] = normalizeQuestions({ questions: [{ question: ' Q ', options: [{ label: ' A ' }, null] }] });
  assert.equal(q.question, 'Q');
  assert.equal(q.header, '');
  assert.equal(q.multiSelect, false);
  assert.deepEqual(q.options.map((o) => o.label), ['A', '']);
});
