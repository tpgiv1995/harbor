'use strict';

// The team chart's transcript fold and its tailer (main/providers/team-fold.js,
// team-worker.js). Synthetic transcripts only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { realTmpDir } = require('../support/real-tmpdir.js');
const { createFold, applyLine, foldSnapshot, actionSummary } = require('../../src/main/providers/team-fold.js');
const { createTailer, createTeamWatcher } = require('../../src/main/providers/team-worker.js');

const ts = (n) => new Date(Date.parse('2026-11-02T10:00:00Z') + n * 1000).toISOString();
const line = (row) => JSON.stringify(row);
const user = (n, text) => line({ type: 'user', timestamp: ts(n), message: { role: 'user', content: text } });
const toolUse = (n, id, name, input, model = 'claude-opus-5-5') => line({ type: 'assistant', timestamp: ts(n), message: { model, stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }] } });
const toolResult = (n, id) => line({ type: 'user', timestamp: ts(n), message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
const reply = (n, text, model = 'claude-opus-5-5') => line({ type: 'assistant', timestamp: ts(n), message: { model, stop_reason: 'end_turn', content: [{ type: 'text', text }] } });

test('a claude turn: prompt, open tool, result, reply', () => {
  const fold = createFold();
  applyLine(fold, user(0, 'Paint the hull blue'), 'claude');
  assert.equal(fold.working, true);
  applyLine(fold, toolUse(1, 'tu1', 'Bash', { command: 'npm test -- hull' }), 'claude');
  let snap = foldSnapshot(fold);
  assert.equal(snap.openTools.length, 1);
  assert.equal(snap.openTools[0].name, 'Bash');
  assert.equal(snap.openTools[0].summary, 'npm test -- hull');
  applyLine(fold, toolResult(2, 'tu1'), 'claude');
  assert.equal(foldSnapshot(fold).openTools.length, 0);
  applyLine(fold, reply(3, 'The hull is blue now.'), 'claude');
  snap = foldSnapshot(fold);
  assert.equal(snap.working, false);
  assert.equal(snap.turnsEnded, 1);
  assert.equal(snap.model, 'claude-opus-5-5');
  assert.equal(snap.lastPrompt, 'Paint the hull blue');
  assert.equal(snap.lastText, 'The hull is blue now.');
  assert.deepEqual(snap.actions.map((a) => a.name), ['Bash']);
});

test('slash commands and hook chatter are not requests', () => {
  const fold = createFold();
  applyLine(fold, user(0, '<command-name>/model</command-name>'), 'claude');
  applyLine(fold, user(1, '<system-reminder>x</system-reminder>'), 'claude');
  assert.equal(fold.lastPrompt, null);
});

test('a background-task notice is not the latest request; the words a person typed stay', () => {
  const fold = createFold();
  applyLine(fold, user(0, 'Rig the mainsail'), 'claude');
  applyLine(fold, user(1, '<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n<summary>Background command "sleep" completed (exit code 0)</summary>\n</task-notification>'), 'claude');
  applyLine(fold, user(2, '[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event.'), 'claude');
  applyLine(fold, user(3, '<local-command-stdout>done</local-command-stdout>'), 'claude');
  assert.equal(fold.lastPrompt, 'Rig the mainsail');
  applyLine(fold, user(4, '<system-reminder>context</system-reminder>\nCheck the anchor chain'), 'claude');
  assert.equal(fold.lastPrompt, 'Check the anchor chain', 'a reminder wrapped around typed words leaves the words');
});

test('only the last five actions are kept', () => {
  const fold = createFold();
  for (let i = 0; i < 8; i += 1) applyLine(fold, toolUse(i, `t${i}`, 'Read', { file_path: `C:\\x\\file${i}.txt` }), 'claude');
  const snap = foldSnapshot(fold);
  assert.equal(snap.actions.length, 5);
  assert.equal(snap.actions.at(-1).summary, 'file7.txt');
});

test('a huge tool-result line closes its tool without being parsed', () => {
  const fold = createFold();
  applyLine(fold, toolUse(0, 'big', 'Read', { file_path: 'a.txt' }), 'claude');
  const huge = line({ type: 'user', timestamp: ts(1), message: { content: [{ type: 'tool_result', tool_use_id: 'big', content: 'x'.repeat(400 * 1024) }] } });
  applyLine(fold, huge, 'claude');
  assert.equal(foldSnapshot(fold).openTools.length, 0);
});

test('a codex rollout: turn context, task events, tool calls and messages', () => {
  const fold = createFold();
  applyLine(fold, line({ timestamp: ts(0), type: 'turn_context', payload: { model: 'gpt-6-astra', effort: 'high' } }), 'codex');
  applyLine(fold, line({ timestamp: ts(1), type: 'event_msg', payload: { type: 'task_started' } }), 'codex');
  applyLine(fold, line({ timestamp: ts(2), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Review the lights lane' }] } }), 'codex');
  applyLine(fold, line({ timestamp: ts(3), type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'c1', name: 'exec', input: 'const r = await tools.exec_command({cmd:"git log -1"})' } }), 'codex');
  let snap = foldSnapshot(fold);
  assert.equal(snap.working, true);
  assert.equal(snap.openTools[0].summary, 'git log -1');
  applyLine(fold, line({ timestamp: ts(4), type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: [] } }), 'codex');
  applyLine(fold, line({ timestamp: ts(5), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Two findings.' }] } }), 'codex');
  applyLine(fold, line({ timestamp: ts(6), type: 'event_msg', payload: { type: 'task_complete' } }), 'codex');
  snap = foldSnapshot(fold);
  assert.equal(snap.model, 'gpt-6-astra');
  assert.equal(snap.effort, 'high');
  assert.equal(snap.working, false);
  assert.equal(snap.turnsEnded, 1);
  assert.equal(snap.lastPrompt, 'Review the lights lane');
  assert.equal(snap.lastText, 'Two findings.');
});

test('action summaries never carry a whole input', () => {
  assert.equal(actionSummary('Edit', { file_path: 'C:\\dev\\x\\src\\hull.js' }), 'hull.js');
  assert.ok(actionSummary('Bash', { command: 'x'.repeat(500) }).length <= 90);
});

function tmp(name) {
  const dir = fs.mkdtempSync(path.join(realTmpDir(), `team-${name}-`));
  return dir;
}

test('the tailer reads only the last bytes on first sight, then only appended bytes, and restarts on a shrink', async () => {
  const dir = tmp('tail');
  const file = path.join(dir, 's.jsonl');
  // 3 MB of old turns, then a final prompt: only the tail is read.
  const filler = `${reply(0, 'old')}\n`;
  fs.writeFileSync(file, filler.repeat(Math.ceil((3 * 1024 * 1024) / filler.length)));
  fs.appendFileSync(file, `${user(10, 'Newest request')}\n`);
  const tailer = createTailer({ firstReadCap: 64 * 1024 });
  let { entry } = await tailer.read(file, 'claude');
  assert.equal(entry.fold.lastPrompt, 'Newest request');
  assert.equal(entry.offset, fs.statSync(file).size);
  // A partial last line is held back until it is complete.
  const partial = toolUse(11, 'tu9', 'Grep', { pattern: 'mast' });
  fs.appendFileSync(file, partial.slice(0, 20));
  ({ entry } = await tailer.read(file, 'claude'));
  assert.equal(foldSnapshot(entry.fold).openTools.length, 0);
  fs.appendFileSync(file, `${partial.slice(20)}\n`);
  ({ entry } = await tailer.read(file, 'claude'));
  assert.equal(foldSnapshot(entry.fold).openTools[0].name, 'Grep');
  // Truncated and rewritten: the fold restarts.
  fs.writeFileSync(file, `${user(20, 'Fresh start')}\n`);
  ({ entry } = await tailer.read(file, 'claude'));
  assert.equal(entry.fold.lastPrompt, 'Fresh start');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the watcher posts facts for tracked files and a turn-ended event on a real change, not on first read', async () => {
  const dir = tmp('watch');
  const file = path.join(dir, 'lead.jsonl');
  fs.writeFileSync(file, `${user(0, 'Plan the voyage')}\n${reply(1, 'Planned.')}\n`);
  const posts = [];
  const listeners = new Map();
  const watchImpl = (target, callback) => { listeners.set(target, callback); return { close() {}, on() {} }; };
  const watcher = createTeamWatcher({ post: (message) => posts.push(message), watchImpl });
  watcher.track([{ id: 'lead', path: file, provider: 'claude' }]);
  await watcher.flushNow();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].changed.lead.lastPrompt, 'Plan the voyage');
  assert.deepEqual(posts[0].events, [], 'catching up on history is not an event');
  fs.appendFileSync(file, `${user(2, 'Now sail')}\n${reply(3, 'Sailing.')}\n`);
  listeners.get(file)();
  await watcher.flushNow();
  assert.deepEqual(posts.at(-1).events, [{ id: 'lead', kind: 'turn-ended' }]);
  watcher.track([]);
  assert.deepEqual(posts.at(-1).removed, ['lead']);
  watcher.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a claude member lists its running helpers from the subagents folder', async () => {
  const dir = tmp('helpers');
  const file = path.join(dir, 'abc.jsonl');
  fs.writeFileSync(file, `${user(0, 'Check the charts')}\n`);
  const helpers = path.join(dir, 'abc', 'subagents');
  fs.mkdirSync(helpers, { recursive: true });
  fs.writeFileSync(path.join(helpers, 'agent-h1.jsonl'), `${toolUse(1, 'x1', 'Read', { file_path: 'chart.png' }, 'claude-sonnet-5-5')}\n`);
  fs.writeFileSync(path.join(helpers, 'agent-h1.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: 'Read the charts', model: 'sonnet', finished: false }));
  const posts = [];
  const watcher = createTeamWatcher({ post: (message) => posts.push(message), watchImpl: () => ({ close() {}, on() {} }) });
  watcher.track([{ id: 'abc', path: file, provider: 'claude' }]);
  await watcher.flushNow();
  const [helper] = posts[0].changed.abc.helpers;
  assert.equal(helper.id, 'h1');
  assert.equal(helper.description, 'Read the charts');
  assert.equal(helper.model, 'claude-sonnet-5-5');
  assert.equal(helper.finished, false);
  assert.equal(helper.openTool.name, 'Read');
  watcher.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
