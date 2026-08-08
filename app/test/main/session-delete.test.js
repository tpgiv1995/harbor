'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { deleteSessionTranscript } = require('../../src/main/session-delete.js');

function makeCorpus() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-del-'));
  const projectsDir = path.join(root, 'projects');
  const trashDir = path.join(root, 'trash');
  const projA = path.join(projectsDir, '-home-pat-dev-a');
  fs.mkdirSync(projA, { recursive: true });
  fs.writeFileSync(path.join(projA, 'sess-1.jsonl'), '{"type":"user"}\n');
  return { root, projectsDir, trashDir, projA };
}

test('moves the transcript into trash and removes the original', async () => {
  const { projectsDir, trashDir, projA } = makeCorpus();
  const res = await deleteSessionTranscript({
    sessionId: 'sess-1', projectsDir, trashDir, now: () => 1234,
  });
  assert.equal(res.ok, true);
  assert.equal(fs.existsSync(path.join(projA, 'sess-1.jsonl')), false, 'original removed');
  assert.equal(fs.existsSync(res.trashed), true, 'transcript is in trash');
  assert.match(res.trashed, /1234-sess-1\.jsonl$/);
});

test('refuses a live session without touching the file', async () => {
  const { projectsDir, trashDir, projA } = makeCorpus();
  const res = await deleteSessionTranscript({ sessionId: 'sess-1', isLive: true, projectsDir, trashDir });
  assert.equal(res.ok, false);
  assert.match(res.reason, /live/);
  assert.equal(fs.existsSync(path.join(projA, 'sess-1.jsonl')), true, 'live transcript untouched');
});

test('reports honestly when the transcript does not exist', async () => {
  const { projectsDir, trashDir } = makeCorpus();
  const res = await deleteSessionTranscript({ sessionId: 'missing', projectsDir, trashDir });
  assert.equal(res.ok, false);
  assert.match(res.reason, /not found/);
});

test('rejects an id with path separators', async () => {
  const { projectsDir, trashDir } = makeCorpus();
  const res = await deleteSessionTranscript({ sessionId: '../escape', projectsDir, trashDir });
  assert.equal(res.ok, false);
  assert.match(res.reason, /invalid/);
});
