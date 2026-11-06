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

// Claude Code 2.1.300 also writes copies of each API request into the
// transcript as `api-request-blob` records with ordinary message objects. A
// copy is not the conversation: an AskUserQuestion inside one is never the live
// question, and only the real records decide which question is still open
// (2026-10-15 CLI review).
test('a stored request copy of a question is never the live one', () => {
  const blob = (role, content) => ({ type: 'api-request-blob', hash: `h-${role}`, message: { role, content } });
  const copyOnly = writeTranscript([
    { type: 'user', message: { role: 'user', content: 'hello' } },
    blob('assistant', [{ type: 'tool_use', id: 'toolu_copy', name: 'AskUserQuestion', input: { questions: QUESTIONS } }]),
  ]);
  assert.equal(createPendingAskReader().read(copyOnly), null);
  const realAfterCopy = writeTranscript([
    blob('assistant', [{ type: 'tool_use', id: 'toolu_copy', name: 'AskUserQuestion', input: { questions: QUESTIONS } }]),
    assistantAsk('toolu_live', QUESTIONS),
    blob('user', [{ type: 'tool_result', tool_use_id: 'toolu_live', content: 'a copy of an answer is not an answer' }]),
  ]);
  assert.equal(createPendingAskReader().read(realAfterCopy)?.toolId, 'toolu_live');
});

// A busy session appends every second or so and each open window polls about
// once a second, so a changed file is the normal case. Re-reading the whole
// megabyte tail on every change cost a megabyte read and about three megabytes
// of garbage per window per poll on Harbor's main thread (measured 2026-11-06).
// With no question open, only an appended line naming AskUserQuestion can
// change the answer, so only the appended bytes are read. Counted at fs.readSync
// so the assertion holds whatever the reader's internals look like.
function countReadBytes(fn) {
  const real = fs.readSync;
  let bytes = 0;
  fs.readSync = (fd, buffer, offset, length, position) => {
    const got = real(fd, buffer, offset, length, position);
    bytes += got;
    return got;
  };
  try { fn(); } finally { fs.readSync = real; }
  return bytes;
}

const chatter = (i) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `step ${i} ${'y'.repeat(200)}` }] } });

test('a busy session with no question reads only what was appended', () => {
  const big = { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: 'z'.repeat(200_000) }] } };
  const file = writeTranscript([big, big]);
  const reader = createPendingAskReader();
  assert.equal(reader.read(file), null);
  const appendedBytes = [];
  const readBytes = countReadBytes(() => {
    for (let i = 0; i < 20; i += 1) {
      const line = JSON.stringify(chatter(i)) + '\n';
      appendedBytes.push(Buffer.byteLength(line));
      fs.appendFileSync(file, line);
      assert.equal(reader.read(file), null);
    }
  });
  const total = appendedBytes.reduce((a, b) => a + b, 0);
  // Each poll also re-reads two 256-byte continuity marks (head, and the bytes
  // before where it stopped) before and after: at most 1 KB per poll.
  const allowance = total + 20 * 1024;
  assert.ok(readBytes <= allowance, `read ${readBytes} bytes for ${total} appended over 20 polls (a full tail re-read is ${fs.statSync(file).size} per poll)`);
});

test('a question appended to a busy session is found', () => {
  const file = writeTranscript([chatter(0)]);
  const reader = createPendingAskReader();
  assert.equal(reader.read(file), null);
  fs.appendFileSync(file, JSON.stringify(chatter(1)) + '\n');
  assert.equal(reader.read(file), null);
  fs.appendFileSync(file, JSON.stringify(assistantAsk('toolu_late', QUESTIONS)) + '\n');
  assert.equal(reader.read(file)?.toolId, 'toolu_late');
  fs.appendFileSync(file, JSON.stringify(toolResult('toolu_late')) + '\n');
  assert.equal(reader.read(file), null, 'and cleared by its answer');
});

test('a question caught half-written is found once its line completes', () => {
  const file = writeTranscript([chatter(0)]);
  const reader = createPendingAskReader();
  assert.equal(reader.read(file), null);
  const line = JSON.stringify(assistantAsk('toolu_split', QUESTIONS)) + '\n';
  const cut = line.indexOf('AskUserQuestion') + 4; // the name itself is cut in half
  fs.appendFileSync(file, line.slice(0, cut));
  assert.equal(reader.read(file), null, 'a half-written record is not a question yet');
  fs.appendFileSync(file, line.slice(cut));
  assert.equal(reader.read(file)?.toolId, 'toolu_split');
});

test('a rewritten transcript is read again from scratch', async () => {
  const file = writeTranscript([chatter(0), chatter(1)]);
  const reader = createPendingAskReader();
  assert.equal(reader.read(file), null);
  await new Promise((r) => setTimeout(r, 12));
  fs.writeFileSync(file, JSON.stringify(assistantAsk('toolu_new_file', QUESTIONS)) + '\n');
  assert.equal(reader.read(file)?.toolId, 'toolu_new_file', 'a shorter file is a new file');
});

// Astra review 2026-11-06, finding 3: growth alone is not proof of an append.
// A transcript replaced by a different, LARGER file whose open question sits
// above the old read offset was read from that offset and the question hidden.
test('a transcript replaced by a larger file is read again, not continued', async () => {
  const file = writeTranscript([chatter(0), chatter(1), chatter(2)]);
  const reader = createPendingAskReader();
  assert.equal(reader.read(file), null);
  await new Promise((r) => setTimeout(r, 12));
  const replacement = [
    { type: 'user', message: { role: 'user', content: 'a different session' } },
    assistantAsk('ask-1', QUESTIONS),
    chatter(10), chatter(11), chatter(12), chatter(13),
  ];
  fs.writeFileSync(file, replacement.map((l) => JSON.stringify(l)).join('\n') + '\n');
  assert.equal(reader.read(file)?.toolId, 'ask-1', 'the open question in the replacement is found');
});

// Astra review round 2, N2: a replacement file (written aside and renamed in)
// can keep both continuity marks while a question sits between them. A new
// file identity means a full read.
test('a renamed-in replacement that keeps both marks is still read whole', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-pending-ask-'));
  const file = path.join(dir, 'session.jsonl');
  const askLine = JSON.stringify(assistantAsk('ask-mid', QUESTIONS));
  const base = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '' }] } };
  base.message.content[0].text = 'z'.repeat(Math.max(0, askLine.length - JSON.stringify(base).length));
  const filler = JSON.stringify(base);
  assert.equal(Buffer.byteLength(filler), Buffer.byteLength(askLine), 'the question takes exactly the filler\'s bytes');
  const head = JSON.stringify(chatter(0));
  const tail = [JSON.stringify(chatter(1)), JSON.stringify(chatter(2))].join('\n');
  fs.writeFileSync(file, `${head}\n${filler}\n${tail}\n`);
  const reader = createPendingAskReader();
  assert.equal(reader.read(file), null);
  await new Promise((r) => setTimeout(r, 12));
  const aside = path.join(dir, 'replacement.jsonl');
  fs.writeFileSync(aside, `${head}\n${askLine}\n${tail}\n${JSON.stringify(chatter(3))}\n`);
  fs.renameSync(aside, file);
  assert.equal(reader.read(file)?.toolId, 'ask-mid');
});

// Astra review round 3: a file swapped in with the same size and mtime is
// another file; the fast path must not return the old answer.
test('a same-size, same-mtime file swapped in is read again', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-pending-ask-'));
  const file = path.join(dir, 'session.jsonl');
  const askLine = JSON.stringify(assistantAsk('same-stamp', QUESTIONS));
  const base = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '' }] } };
  base.message.content[0].text = 'z'.repeat(Math.max(0, askLine.length - JSON.stringify(base).length));
  const filler = JSON.stringify(base);
  const when = new Date('2026-11-06T08:00:00Z');
  fs.writeFileSync(file, `${filler}\n`); fs.utimesSync(file, when, when);
  const reader = createPendingAskReader();
  assert.equal(reader.read(file), null);
  const aside = path.join(dir, 'aside.jsonl');
  fs.writeFileSync(aside, `${askLine}\n`); fs.utimesSync(aside, when, when);
  fs.renameSync(aside, file);
  assert.equal(fs.statSync(file).size, Buffer.byteLength(`${filler}\n`));
  assert.equal(reader.read(file)?.toolId, 'same-stamp');
});
