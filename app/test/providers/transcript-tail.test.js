'use strict';

// The main process answers questions about a transcript's END from its tail,
// never from the whole file (2026-10-09: reading orchestration workers' codex
// logs whole crashed two launches with a main-process heap OOM). These specs
// pin the two halves of that: the tail answer equals the whole-file answer, and
// the read is bounded no matter how large the file is.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { realTmpDir } = require('../support/real-tmpdir.js');
const {
  TranscriptParser,
  readTailLines,
  readTranscriptTailRecords,
  readTranscriptLastSignal,
} = require('../../src/main/providers/transcript.js');

const TS = '2026-10-09T07:00:00.000Z';
const user = (text) => ({ type: 'user', timestamp: TS, message: { role: 'user', content: text } });
const assistantText = (text) => ({
  type: 'assistant',
  timestamp: TS,
  message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text }], stop_reason: 'end_turn' },
});
const toolUse = (id) => ({
  type: 'assistant',
  timestamp: TS,
  message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'ls' } }], stop_reason: 'tool_use' },
});
const toolResult = (id) => ({
  type: 'user',
  timestamp: TS,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
});

// More than one start window (1MB) of finished turns ahead of the ending under
// test, so the tail read is genuinely partial and its first line is cut.
function padding() {
  const lines = [];
  for (let i = 0; i < 1500; i += 1) {
    lines.push(user(`question ${i} ${'x'.repeat(400)}`));
    lines.push(toolUse(`toolu_pad_${i}`));
    lines.push(toolResult(`toolu_pad_${i}`));
    lines.push(assistantText(`answer ${i} ${'y'.repeat(400)}`));
  }
  return lines;
}

async function writeJsonl(name, records, { trailingNewline = true } = {}) {
  const dir = await fsp.mkdtemp(path.join(realTmpDir(), 'harbor-transcript-tail-'));
  const file = path.join(dir, name);
  const body = records.map((record) => (typeof record === 'string' ? record : JSON.stringify(record))).join('\n');
  await fsp.writeFile(file, trailingNewline ? `${body}\n` : body);
  return file;
}

function wholeFileSignal(file, provider = 'claude') {
  const parser = new TranscriptParser(provider);
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { parser.applyLine(JSON.parse(line)); } catch { /* partial */ }
  }
  return parser.header.lastSignal;
}

function wholeFileTailRecords(file, maxRecords = 128) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const records = [];
  for (let index = lines.length - 1; index >= 0 && records.length < maxRecords; index -= 1) {
    const line = lines[index].trim();
    if (!line) continue;
    try { records.unshift(JSON.parse(line)); } catch { /* partial */ }
  }
  return records;
}

test('the last signal read from the tail equals the whole-file parse for every ending', async () => {
  const endings = {
    idle: [user('ship it'), toolUse('toolu_a'), toolResult('toolu_a'), assistantText('Done.')],
    'tool-pending': [user('run the tests'), toolUse('toolu_b')],
    'user-turn': [user('one more thing')],
  };
  for (const [expected, tail] of Object.entries(endings)) {
    const file = await writeJsonl(`${expected}.jsonl`, [...padding(), ...tail]);
    assert.ok(fs.statSync(file).size > 2 * 1024 * 1024, 'fixture must be larger than the start window');
    const whole = wholeFileSignal(file);
    assert.equal(whole, expected, `fixture sanity: whole-file parse of the ${expected} ending`);
    assert.equal(await readTranscriptLastSignal(file), whole, `tail parse of the ${expected} ending`);
  }
});

test('resume tail records equal the whole-file records, including a final message larger than the start window', async () => {
  const huge = assistantText(`final report ${'z'.repeat(3 * 1024 * 1024)}`);
  const file = await writeJsonl('records.jsonl', [...padding(), user('summarize'), huge]);
  const tail = await readTranscriptTailRecords(file);
  assert.equal(tail.length, 128);
  assert.deepEqual(tail, wholeFileTailRecords(file));
  assert.equal(tail.at(-1).message.content[0].text.length, huge.message.content[0].text.length, 'the long final message is whole, never clipped');
});

test('a short file is read from its first byte, and an unterminated last line is still offered', async () => {
  const file = await writeJsonl('short.jsonl', [user('a'), assistantText('b'), '{"type":"user","mess'], { trailingNewline: false });
  const lines = await readTailLines(file, { minLines: 100 });
  assert.equal(lines.length, 3);
  assert.equal(JSON.parse(lines[0]).message.content, 'a');
  assert.throws(() => JSON.parse(lines[2]), 'a half-written line fails to parse, exactly as it did from a whole-file split');
});

test('the tail read is bounded by maxBytes however many lines were asked for', async () => {
  const file = await writeJsonl('bounded.jsonl', padding());
  const size = fs.statSync(file).size;
  const maxBytes = 512 * 1024;
  const lines = await readTailLines(file, { minLines: 1_000_000, startBytes: 64 * 1024, maxBytes });
  const bytes = lines.reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0);
  assert.ok(size > 4 * maxBytes, 'fixture is far larger than the cap');
  assert.ok(bytes <= maxBytes, `read ${bytes} bytes against a ${maxBytes} cap`);
  assert.ok(lines.length > 0);
  // Every line is a complete record: the cut first line of the window is dropped.
  for (const line of lines) JSON.parse(line);
  const whole = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.deepEqual(lines, whole.slice(whole.length - lines.length), 'the lines are exactly the newest ones, in order');
});
