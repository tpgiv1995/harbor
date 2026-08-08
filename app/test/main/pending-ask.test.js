'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createPendingAskReader } = require('../../src/main/providers/pending-ask.js');

// Live-caught 2026-07-27 (Pat's second report the same day, and the angriest):
// the question card STILL said "the question text and option 1 scrolled out of
// the terminal view" even though the transcript merge shipped that morning.
//
// The merge itself was fine. Replaying Pat's real transcript through the real
// parser sets pendingAsk correctly, and merging it onto the real clipped
// fixture produces the full question. What failed was WHERE the card looked:
// `pendingAsk` was a side effect of the streaming transcript TAIL, so it was
// only ever as current as the last read that landed. His window proved it: at
// 20:51 it was still rendering the conversation as of 20:38:24, missing both
// the assistant briefing (20:38:46) and the AskUserQuestion (20:38:55) that
// the card was, at that moment, asking about.
//
// A streamed cache cannot be trusted to be current at the instant a 700ms poll
// reads it, and there is no reason to depend on one: the transcript FILE is the
// authority and answers in milliseconds. This reader is that read.

function writeTranscript(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-pending-ask-'));
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

const assistantAsk = (id, questions) => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input: { questions } }] },
});

const toolResult = (id) => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
});

const QUESTIONS = [{
  question: 'Where should the per-office PDFs get generated each quarter?',
  header: 'Where it runs',
  multiSelect: false,
  options: [
    { label: 'In the publish workflow (Recommended)', description: 'CI does it.' },
    { label: 'Local RUNBOOK step only', description: 'You do it.' },
    { label: 'Both: CI, plus a one-command local script', description: 'Either path works.' },
  ],
}];

test('reads the live AskUserQuestion straight off the transcript file', () => {
  const file = writeTranscript([
    { type: 'user', message: { role: 'user', content: 'hello' } },
    assistantAsk('toolu_live', QUESTIONS),
  ]);
  const reader = createPendingAskReader();
  const ask = reader.read(file);
  assert.equal(ask.toolId, 'toolu_live');
  assert.equal(ask.questions[0].question, 'Where should the per-office PDFs get generated each quarter?');
  // Normalized on the way out, so the card's badge logic never sees the marker
  // still glued inside the label (the shape spec 6f caught in the merge).
  assert.equal(ask.questions[0].options[0].label, 'In the publish workflow');
  assert.equal(ask.questions[0].options[0].recommended, true);
});

test('an answered question is not a live one', () => {
  const file = writeTranscript([
    assistantAsk('toolu_done', QUESTIONS),
    toolResult('toolu_done'),
  ]);
  assert.equal(createPendingAskReader().read(file), null);
});

test('the newest unanswered question wins over an older answered one', () => {
  const older = [{ ...QUESTIONS[0], question: 'Old question?' }];
  const file = writeTranscript([
    assistantAsk('toolu_old', older),
    toolResult('toolu_old'),
    assistantAsk('toolu_new', QUESTIONS),
  ]);
  const ask = createPendingAskReader().read(file);
  assert.equal(ask.toolId, 'toolu_new');
});

// The file is read on every 700ms poll of every open window. Re-parsing a
// 3MB transcript at that rate is not acceptable, and neither is a cache that
// can go stale: the whole point of this reader is that it cannot lag. So the
// cache key is the file's own identity (size + mtime), which changes on every
// append Claude makes.
test('a repeat read of an unchanged file does not re-read the bytes', () => {
  const file = writeTranscript([assistantAsk('toolu_live', QUESTIONS)]);
  let reads = 0;
  const reader = createPendingAskReader({
    readTail: (p, bytes) => { reads += 1; return fs.readFileSync(p, 'utf8'); },
  });
  reader.read(file);
  reader.read(file);
  reader.read(file);
  assert.equal(reads, 1, 'cached by size+mtime');
});

test('an appended answer invalidates the cache', async () => {
  const file = writeTranscript([assistantAsk('toolu_live', QUESTIONS)]);
  const reader = createPendingAskReader();
  assert.ok(reader.read(file), 'live before the answer');
  await new Promise((r) => setTimeout(r, 12));
  fs.appendFileSync(file, JSON.stringify(toolResult('toolu_live')) + '\n');
  assert.equal(reader.read(file), null, 'answered after it');
});

// A day-long session is tens of megabytes; only the tail can be read. The tail
// must still be big enough that a question asked before a large tool result
// stays visible, and a tool_use whose id is cut in half by the window boundary
// must not be reported as live.
test('only the tail is read, and a half-cut record is not a live question', () => {
  const filler = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(40_000) }] } };
  const file = writeTranscript([
    assistantAsk('toolu_ancient', QUESTIONS),
    filler, filler, filler, filler, filler,
  ]);
  const reader = createPendingAskReader({ tailBytes: 50_000 });
  assert.equal(reader.read(file), null, 'a question scrolled out of the tail is not reported');
});

test('a missing or unparseable file is null, never a throw', () => {
  const reader = createPendingAskReader();
  assert.equal(reader.read('/nonexistent/nope.jsonl'), null);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-pending-ask-'));
  const junk = path.join(dir, 'junk.jsonl');
  fs.writeFileSync(junk, 'not json\n{"also":\n');
  assert.equal(reader.read(junk), null);
});

test('a question with no options at all is not a card', () => {
  const file = writeTranscript([assistantAsk('toolu_empty', [{ question: '', options: [] }])]);
  assert.equal(createPendingAskReader().read(file), null);
});
