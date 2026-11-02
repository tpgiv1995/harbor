'use strict';

// Per-task token totals (2026-10-05): output tokens per API message id, summed
// across the task, riding on the prompt block as turnMeta.

const test = require('node:test');
const assert = require('node:assert/strict');
const { TranscriptParser } = require('../../src/main/providers/transcript.js');
const { turnMetaLabel, formatTokens, formatDuration, queueStateLabel, queueChip, subagentLabel } = require('../../src/renderer/stage/turn-meta.cjs');

const user = (text, ts) => ({ type: 'user', timestamp: ts, message: { role: 'user', content: text } });
const assistant = (id, out, ts, content) => ({
  type: 'assistant', timestamp: ts,
  message: { id, model: 'claude-opus-5-5', role: 'assistant', content, usage: { input_tokens: 10, output_tokens: out } },
});

test('a task sums output tokens per message id and times prompt to latest reply', () => {
  const p = new TranscriptParser('claude');
  p.applyLine(user('rename my photos', '2026-10-05T18:00:00.000Z'));
  const prompt = p.blocks.find((b) => b.kind === 'user');
  // One API message written as two lines (thinking, then tool_use), repeating its id.
  p.applyLine(assistant('msg_A', 40, '2026-10-05T18:00:05.000Z', [{ type: 'thinking', thinking: '' }]));
  const changed = p.applyLine(assistant('msg_A', 120, '2026-10-05T18:00:06.000Z', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }]));
  assert.ok(changed.includes(prompt.key), 'the prompt block is re-rendered as the total grows');
  p.applyLine(assistant('msg_B', 2300, '2026-10-05T18:00:38.000Z', [{ type: 'text', text: 'Done.' }]));
  assert.deepEqual(prompt.turnMeta, { outputTokens: 2420, durationMs: 38_000 });
  assert.equal(turnMetaLabel(prompt.turnMeta), '↓ 2.4k tokens · 38s');
});

test('the next prompt starts a fresh total and leaves the last one alone', () => {
  const p = new TranscriptParser('claude');
  p.applyLine(user('first', '2026-10-05T18:00:00.000Z'));
  p.applyLine(assistant('m1', 500, '2026-10-05T18:00:10.000Z', [{ type: 'text', text: 'one' }]));
  p.applyLine(user('second', '2026-10-05T18:01:00.000Z'));
  p.applyLine(assistant('m2', 90, '2026-10-05T18:01:04.000Z', [{ type: 'text', text: 'two' }]));
  const [first, second] = p.blocks.filter((b) => b.kind === 'user');
  assert.equal(first.turnMeta.outputTokens, 500);
  assert.deepEqual(second.turnMeta, { outputTokens: 90, durationMs: 4000 });
});

test('formatting matches the CLI working line', () => {
  assert.equal(formatTokens(25), '25');
  assert.equal(formatTokens(2400), '2.4k');
  assert.equal(formatTokens(12_400), '12k');
  assert.equal(formatTokens(1_200_000), '1.2M');
  assert.equal(formatDuration(65_000), '1m 05s');
  assert.equal(turnMetaLabel({ outputTokens: 0, durationMs: 1 }), null);
  assert.equal(turnMetaLabel(null), null);
});

test('the live chip reads steadily through the stretches the CLI hides its line', () => {
  const { parseTokenCount, liveMeterLabel } = require('../../src/renderer/stage/turn-meta.cjs');
  assert.equal(parseTokenCount('↓ 2.4k'), 2400);
  assert.equal(parseTokenCount('↓ 25'), 25);
  assert.equal(parseTokenCount(null), null);
  const startMs = Date.parse('2026-10-05T18:00:00.000Z');
  const now = startMs + 38_000;
  // CLI line hidden (prose streaming): elapsed still ticks, transcript total shows.
  assert.equal(liveMeterLabel({ startMs, now, cliTokens: null, turnTokens: 900 }), '38s · ↓ 900');
  // The larger of the two counts wins.
  assert.equal(liveMeterLabel({ startMs, now, cliTokens: 2400, turnTokens: 900 }), '38s · ↓ 2.4k');
  // Before the prompt lands in the transcript, the CLI's own elapsed is used.
  assert.equal(liveMeterLabel({ startMs: null, cliElapsed: '3s', cliTokens: 25 }), '3s · ↓ 25');
  assert.equal(liveMeterLabel({}), null);
});

// A queued message's state, in words under its bubble and as a header count
// (2026-11-01, Pat: messages "sticking in the queue" seen only in the terminal).
test('queueStateLabel: waiting says so, a long wait is noted, a quick one and old blocks say nothing', () => {
  const at = '2026-11-02T03:00:00.000Z';
  assert.match(queueStateLabel({ queued: true, queueState: 'waiting', ts: at }), /^Waiting in Claude's queue/);
  assert.equal(queueStateLabel({ queued: true, queueState: 'delivered', ts: at, deliveredTs: '2026-11-02T03:01:12.000Z' }), "Waited 1m 12s in Claude's queue");
  assert.equal(queueStateLabel({ queued: true, queueState: 'delivered', ts: at, deliveredTs: '2026-11-02T03:00:04.000Z' }), null);
  assert.equal(queueStateLabel({ queued: true, ts: at }), null, 'a block parsed before queue states existed');
  assert.equal(queueStateLabel({ kind: 'user', text: 'hi' }), null);
});

test('queueChip: counts what waits and says who sent it', () => {
  assert.equal(queueChip(null), null);
  assert.equal(queueChip({ waiting: 0 }), null);
  const chip = queueChip({ waiting: 3, from: { you: 1, peer: 1, task: 1 }, oldestTs: '2026-11-02T03:00:00.000Z' }, { formatTime: () => '9:00 PM' });
  assert.equal(chip.label, '3 queued');
  assert.equal(chip.title, "3 messages wait for Claude's next step (1 from you, 1 from other sessions, 1 background result). Claude reads its queue between tool calls, so a long step holds them. The oldest was sent at 9:00 PM.");
  assert.equal(queueChip({ waiting: 1, from: { you: 1 } }).title, "1 message waits for Claude's next step (1 from you). Claude reads its queue between tool calls, so a long step holds them.");
});

test('subagentLabel: what a sub-agent is doing, then what it used', () => {
  assert.equal(subagentLabel({ running: true, tools: 12, now: 'Searching queue-operation' }), '12 tools so far · Searching queue-operation');
  assert.equal(subagentLabel({ running: true, tools: 1, now: null }), '1 tool so far');
  assert.equal(subagentLabel({ running: true, tools: 0, now: null }), 'Starting');
  assert.equal(subagentLabel({ running: false, tools: 20, now: null }), 'Used 20 tools');
  assert.equal(subagentLabel({ running: false, tools: null, now: null }), null);
  assert.equal(subagentLabel(null), null);
  assert.equal(subagentLabel({ running: false, quiet: true, finished: false, tools: 4, now: null }), 'No activity for 15+ min · 4 tools so far');
  assert.equal(subagentLabel({ running: true, tools: 9, now: null, partial: true }), '9+ tools so far');
  assert.equal(subagentLabel({ running: true, tools: 0, now: null, partial: true }), 'Working (its earlier steps were too many to count)');
  assert.equal(subagentLabel({ running: false, finished: true, tools: 0, now: null, partial: true }), 'Done (its steps were too many to count)');
});
