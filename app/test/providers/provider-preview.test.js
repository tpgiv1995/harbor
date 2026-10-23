'use strict';

// Codex and cursor transcript previews come from the provider scan, and read
// only a bounded head and tail of the rollout: the main process never reads a
// whole transcript (docs/claude/views.md). Every record below is SYNTHETIC.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { realTmpDir } = require('../support/real-tmpdir.js');
const { buildProviderPreview, WHOLE_MAX_BYTES, TAIL_MAX_BYTES, HEAD_BYTES } = require('../../src/main/providers/provider-preview.js');
const { createProviderHistory } = require('../../src/main/providers/provider-history.js');
const { createSidebarBridge } = require('../../src/main/sidebar-bridge.js');

const CODEX_ID = '019f8250-89cc-73d3-9c1a-30007bced9ff';
const COLD_ID = '019f4d31-2dfb-7840-90c1-a3e2964bd4e8';
const noZstd = typeof zlib.zstdCompressSync !== 'function' && 'runtime has no zstd';

const at = (n) => new Date(Date.UTC(2026, 6, 21, 1, 35, n)).toISOString();
const sessionMeta = (id) => JSON.stringify({ timestamp: at(0), type: 'session_meta', payload: { id, session_id: id, timestamp: at(0), cwd: '/home/user/dev/widget', originator: 'codex_cli_rs' } });
const item = (type, text, n) => JSON.stringify({ timestamp: at(n), type: 'event_msg', payload: { type: 'item_completed', item: { type, id: `i${n}`, content: [{ type: type === 'UserMessage' ? 'text' : 'Text', text }] } } });
const userItem = (text, n) => item('UserMessage', text, n);
const agentItem = (text, n) => item('AgentMessage', text, n);
// Tool output a rollout carries between turns; it never reaches the preview.
const noise = (bytes, n) => JSON.stringify({ timestamp: at(n), type: 'response_item', payload: { type: 'function_call_output', output: 'o'.repeat(bytes) } });

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(realTmpDir(), 'provider-preview-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('a small rollout previews its first prompt, recent prompts and last reply', async (t) => {
  const dir = tmp(t);
  const file = path.join(dir, `rollout-2026-07-21T01-35-28-${CODEX_ID}.jsonl`);
  fs.writeFileSync(file, [sessionMeta(CODEX_ID), userItem('Fix the flaky widget test.', 1), agentItem('Looking.', 2),
    userItem('Now run it twice.', 3), agentItem('Both runs pass.', 4)].join('\n'));
  const text = await buildProviderPreview({ id: CODEX_ID, meta: { provider: 'codex', path: file, cwd: '/home/user/dev/widget' } });
  assert.match(text, /^Fix the flaky widget test\./);
  assert.match(text, /provider {5}codex/);
  assert.match(text, /first prompt:\n {2}Fix the flaky widget test\./);
  assert.match(text, /recent prompts:\n {2}• Now run it twice\./);
  assert.match(text, /last reply:\n {2}Both runs pass\./);
  assert.match(text, new RegExp(`session id {3}${CODEX_ID}`));
});

test('a large rollout is read as a bounded head and tail, never the middle', async (t) => {
  const dir = tmp(t);
  const file = path.join(dir, `rollout-2026-07-21T01-35-28-${CODEX_ID}.jsonl`);
  const chunk = 100 * 1024;
  // Enough tool output after the middle prompt that it sits beyond both the
  // head and the tail windows.
  const gap = Math.ceil((HEAD_BYTES + TAIL_MAX_BYTES) / chunk) + 4;
  const lines = [sessionMeta(CODEX_ID), userItem('Opening prompt.', 1), agentItem('Starting.', 2)];
  lines.push(...Array.from({ length: gap }, (_, i) => noise(chunk, 3)));
  lines.push(userItem('MIDDLE PROMPT nobody reads.', 4));
  lines.push(...Array.from({ length: gap }, (_, i) => noise(chunk, 5)));
  lines.push(userItem('Recent prompt.', 6), agentItem('The final answer.', 7));
  fs.writeFileSync(file, lines.join('\n'));
  assert.ok(fs.statSync(file).size > WHOLE_MAX_BYTES + HEAD_BYTES + TAIL_MAX_BYTES);

  const text = await buildProviderPreview({ id: CODEX_ID, meta: { provider: 'codex', path: file, cwd: '/home/user/dev/widget' } });
  assert.match(text, /first prompt:\n {2}Opening prompt\./, 'the head');
  assert.match(text, /recent prompts:\n {2}• Recent prompt\./, 'the tail');
  assert.match(text, /last reply:\n {2}The final answer\./);
  assert.doesNotMatch(text, /MIDDLE PROMPT/, 'nothing between the head and the tail was read');
});

test('the bridge answers codex previews from the provider scan, compressed ones from their copy, claude ids from the index', { skip: noZstd }, async (t) => {
  const dir = tmp(t);
  const home = path.join(dir, '.codex');
  const day = path.join(home, 'sessions', '2026', '07', '21');
  fs.mkdirSync(day, { recursive: true });
  fs.writeFileSync(path.join(day, `rollout-2026-07-21T01-35-28-${CODEX_ID}.jsonl`),
    [sessionMeta(CODEX_ID), userItem('Plain worker prompt.', 1), agentItem('Plain worker done.', 2)].join('\n'));
  fs.writeFileSync(path.join(day, `rollout-2026-07-14T01-35-28-${COLD_ID}.jsonl.zst`),
    zlib.zstdCompressSync(Buffer.from([sessionMeta(COLD_ID), userItem('Compressed worker prompt.', 1), agentItem('Compressed worker done.', 2)].join('\n'))));
  const providerHistory = createProviderHistory({
    codexRoots: [{ root: path.join(home, 'sessions'), profileId: null, configHome: home }],
    cursorRoot: path.join(dir, 'none'),
    metadataFile: path.join(dir, 'cache', 'provider-session-metadata.json'),
  });
  await providerHistory.listSessions({});
  const asked = [];
  const history = {
    on() {}, removeAllListeners() {}, close() {},
    sessionPreview: async (id) => { asked.push(id); return `claude preview ${id}\n`; },
    sessionMeta: async (id) => { throw new Error(`session ${id} not in index`); },
  };
  const bridge = createSidebarBridge({ history, providerHistory, providerSessionLinker: null, delegationIndex: null, createControlClient: () => ({}) });
  t.after(() => bridge.close());

  assert.match(await bridge.getSessionPreview(CODEX_ID), /last reply:\n {2}Plain worker done\./);
  assert.match(await bridge.getSessionPreview(COLD_ID), /last reply:\n {2}Compressed worker done\./);
  assert.equal(await bridge.getSessionPreview('claude-id'), 'claude preview claude-id\n');
  assert.deepEqual(asked, ['claude-id'], 'only the claude id reached the index');

  // getSessionMeta stays cheap for a compressed row: no path, no copy; the
  // readable form is what a transcript reader gets.
  assert.equal((await bridge.getSessionMeta(COLD_ID)).path, null);
  assert.match((await bridge.getReadableSessionMeta(COLD_ID)).path, /codex-rollouts/);
});
