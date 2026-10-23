'use strict';
// Codex rollout parsing in the conversation window: turns end where codex
// says they end, tool rows take their status from real exit codes, token
// counts drive the gauge and the per-task meter, apply_patch renders as an
// edit, and request_user_input renders as a question. Every fixture here is
// SYNTHETIC, built from the record shapes codex 0.160 CLI and desktop
// rollouts write (record types and keys only, no real rollout content).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { realTmpDir } = require('../support/real-tmpdir.js');

const {
  createTranscriptProvider: createTranscriptProviderImpl,
  TranscriptParser,
  actionForApplyPatch,
  parseApplyPatch,
  codexActionFor,
  readPrefixImageBlocks,
  readLocalImage,
  localImageCacheStats,
  readTranscriptLastSignal,
  MAX_BLOCKS,
} = require('../../src/main/providers/transcript.js');

const TEST_CONTEXT_DIR = fs.mkdtempSync(path.join(realTmpDir(), 'harbor-codex-transcript-context-'));
const createTranscriptProvider = (options) => createTranscriptProviderImpl({
  contextCacheDir: TEST_CONTEXT_DIR,
  ...options,
});

const TINY_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const TINY_PNG_URI = `data:image/png;base64,${TINY_PNG_B64}`;

const CTS = (sec) => `2026-10-15T12:00:${String(sec).padStart(2, '0')}.000Z`;
const cx = {
  taskStarted: (sec, window = 258_400) => ({ timestamp: CTS(sec), type: 'event_msg', payload: { type: 'task_started', turn_id: 't1', started_at: 1, model_context_window: window } }),
  user: (sec, text, extra = []) => ({ timestamp: CTS(sec), type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', id: `u${sec}`, content: [...(text ? [{ type: 'text', text }] : []), ...extra] } } }),
  agent: (sec, text, phase, more = {}) => ({ timestamp: CTS(sec), type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', id: `a${sec}`, content: [{ type: 'Text', text }], ...(phase ? { phase } : {}), ...more } } }),
  exec: (sec, callId, cmd) => ({ timestamp: CTS(sec), type: 'response_item', payload: { type: 'custom_tool_call', id: `ci-${callId}`, call_id: callId, name: 'exec', status: 'completed', input: `const r = await tools.exec_command(${JSON.stringify({ cmd })});\nreturn r;` } }),
  command: (sec, exitCode, status = exitCode === 0 ? 'completed' : 'failed') => ({ timestamp: CTS(sec), type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution', id: `x${sec}`, command: ['/bin/zsh', '-lc', 'x'], exit_code: exitCode, status, source: 'unified_exec_startup' } } }),
  output: (sec, callId, output, kind = 'custom_tool_call_output') => ({ timestamp: CTS(sec), type: 'response_item', payload: { type: kind, call_id: callId, output } }),
  tokens: (sec, { last, totalOut, window = 258_400, lastOut = 0 }) => ({ timestamp: CTS(sec), type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: last - lastOut, cached_input_tokens: 0, output_tokens: lastOut, reasoning_output_tokens: 0, total_tokens: last }, total_token_usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: totalOut, reasoning_output_tokens: 0, total_tokens: 0 }, model_context_window: window }, rate_limits: {} } }),
  complete: (sec, extra = {}) => ({ timestamp: CTS(sec), type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1', duration_ms: 4200, ...extra } }),
  aborted: (sec) => ({ timestamp: CTS(sec), type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 't1', reason: 'interrupted', duration_ms: 3100 } }),
};
const outArray = (text) => [{ type: 'input_text', text }];
function codexParser(lines, options) {
  const p = new TranscriptParser('codex', null, options);
  const changed = [];
  for (const line of lines) changed.push(...p.applyLine(line));
  return { p, changed };
}

test('codex: a commentary message keeps the turn in flight; only final_answer ends it', () => {
  const { p } = codexParser([cx.taskStarted(0), cx.user(1, 'fix the build'), cx.agent(2, 'Looking at the logs first.', 'commentary')]);
  assert.equal(p.header.lastSignal, 'user-turn');
  assert.equal(p.workingState(Date.now()).working, true, 'commentary must not paint the window ready');
  p.applyLine(cx.exec(3, 'c1', 'npm test'));
  p.applyLine(cx.agent(4, 'Tests are running.', 'commentary'));
  assert.equal(p.header.lastSignal, 'tool-pending', 'commentary while a tool runs leaves the tool pending');
  p.applyLine(cx.output(5, 'c1', outArray('ok')));
  assert.equal(p.header.lastSignal, 'user-turn', 'an answered call leaves the model owing the next step');
  p.applyLine(cx.agent(6, 'Fixed.', 'final_answer'));
  assert.equal(p.header.lastSignal, 'idle');
  assert.equal(p.header.turnEnd, null, 'turnEnd waits for the task itself to end');
  p.applyLine(cx.complete(7));
  assert.equal(p.header.turnEnd, 'complete');
  assert.equal(p.header.turnError, null);
  assert.deepEqual(p.blocks.map((b) => b.kind), ['user', 'assistant', 'action', 'assistant', 'assistant']);
});

test('codex: an AgentMessage with no phase (older rollouts) still ends the turn', () => {
  const { p } = codexParser([cx.user(1, 'hi'), cx.agent(2, 'Hello.')]);
  assert.equal(p.header.lastSignal, 'idle');
  // The legacy event shape follows the same phase rule.
  const legacy = codexParser([
    { timestamp: CTS(1), type: 'event_msg', payload: { type: 'user_message', message: 'go' } },
    { timestamp: CTS(2), type: 'event_msg', payload: { type: 'agent_message', message: 'on it', phase: 'commentary' } },
  ]).p;
  assert.equal(legacy.header.lastSignal, 'user-turn');
  legacy.applyLine({ timestamp: CTS(3), type: 'event_msg', payload: { type: 'agent_message', message: 'done', phase: 'final_answer' } });
  assert.equal(legacy.header.lastSignal, 'idle');
});

test('codex: turn_aborted ends the turn, stops running rows and leaves the Interrupted marker', () => {
  const { p, changed } = codexParser([cx.taskStarted(0), cx.user(1, 'long job'), cx.exec(2, 'c1', 'sleep 600'), cx.aborted(9)]);
  const action = p.blocks.find((b) => b.kind === 'action');
  assert.equal(action.status, 'err');
  assert.deepEqual(action.pill, { text: 'interrupted', tone: 'err' });
  assert.ok(changed.includes(action.key), 'the stopped row re-renders in place');
  const marker = p.blocks.at(-1);
  assert.equal(marker.kind, 'user');
  assert.equal(marker.text, 'Interrupted');
  assert.equal(marker.command, true);
  assert.equal(p.header.lastSignal, 'idle');
  assert.equal(p.header.turnEnd, 'aborted');
  assert.equal(p.pendingTools.size, 0);
  assert.equal(p.blocks[0].turnMeta.durationMs, 3100, "codex's own task clock is the duration");
  // A late output for the aborted call changes nothing.
  assert.deepEqual(p.applyLine(cx.output(10, 'c1', outArray('aborted'))), []);
});

test('codex: a failed task shows an amber warning and sets turnError; the next task clears it', () => {
  const error = { message: 'stream disconnected before completion', codex_error_info: { response_too_many_failed_attempts: { http_status_code: 500 } } };
  const { p } = codexParser([cx.taskStarted(0), cx.user(1, 'go'), cx.complete(5, { error, last_agent_message: null })]);
  const note = p.blocks.at(-1);
  assert.equal(note.kind, 'note');
  assert.equal(note.tone, 'warn');
  assert.equal(note.text, 'stream disconnected before completion');
  assert.equal(p.header.turnEnd, 'error');
  assert.deepEqual(p.header.turnError, { message: 'stream disconnected before completion', ts: CTS(5) });
  assert.equal(p.header.lastSignal, 'idle');
  p.applyLine(cx.taskStarted(6));
  assert.equal(p.header.turnEnd, null, 'turnEnd is null while a task runs');
  assert.equal(p.header.turnError, null);
  assert.equal(p.header.lastSignal, 'user-turn');
});

test('codex: tool status comes from the real exit code, not the word "error" in the output', () => {
  const { p } = codexParser([
    cx.user(0, 'check'),
    // exit 0, but the output talks about errors: still a success.
    cx.exec(1, 'ok1', 'grep -c error app.log'), cx.command(2, 0), cx.output(3, 'ok1', outArray('Process exited with code 0\n42 error lines')),
    // a real failure, with an ARRAY output (codex 0.160).
    cx.exec(4, 'bad1', 'npm test'), cx.command(5, 1), cx.output(6, 'bad1', outArray('1 failing')),
    // one exec ran two commands and the last one failed.
    cx.exec(7, 'two', 'make a; make b'), cx.command(8, 0), cx.command(9, 2), cx.output(10, 'two', outArray('done')),
  ]);
  const [ok, bad, two] = p.blocks.filter((b) => b.kind === 'action');
  assert.equal(ok.status, 'ok');
  assert.equal(ok.pill, undefined);
  assert.equal(bad.status, 'err');
  assert.deepEqual(bad.pill, { text: 'exit 1', tone: 'err' });
  assert.equal(two.status, 'err');
  assert.deepEqual(two.pill, { text: 'exit 2', tone: 'err' });
});

test('codex: with no execution item, an exit code in the output text is the fallback (string or array)', () => {
  const { p } = codexParser([
    cx.exec(1, 's1', 'false'), cx.output(2, 's1', 'Chunk ID: x\nProcess exited with code 3\n'),
    cx.exec(3, 's2', 'cat notes'), cx.output(4, 's2', 'error: this is just text the command printed'),
    cx.exec(5, 'a1', 'false'), cx.output(6, 'a1', outArray('Process exited with code 7')),
  ]);
  const [s1, s2, a1] = p.blocks.filter((b) => b.kind === 'action');
  assert.equal(s1.status, 'err');
  assert.equal(s1.pill.text, 'exit 3');
  assert.equal(s2.status, 'ok', 'the bare word "error" is not a failure');
  assert.equal(a1.status, 'err');
});

test('codex: an execution that lands after its call resolved is not pinned on another row', () => {
  const { p } = codexParser([
    cx.exec(1, 'c1', 'npm run long'), cx.output(2, 'c1', outArray('Process running with session ID 9')),
    cx.exec(3, 'c2', 'ls'), cx.output(4, 'c2', outArray('a b')),
    cx.command(5, 1),
  ]);
  assert.deepEqual(p.blocks.map((b) => b.status), ['ok', 'ok']);
});

test('codex: MCP calls show their tool and server, and the item decides failure either side of the output', () => {
  const mcpCall = (sec, callId, args) => ({ timestamp: CTS(sec), type: 'response_item', payload: { type: 'function_call', id: `fc-${callId}`, call_id: callId, name: 'js', namespace: 'mcp__cua_repl', arguments: JSON.stringify(args) } });
  const mcpItem = (sec, id, failed) => ({ timestamp: CTS(sec), type: 'event_msg', payload: { type: 'item_completed', item: { type: 'McpToolCall', id, server: 'cua_repl', tool: 'js', status: failed ? 'failed' : 'completed', result: { content: [], isError: failed } } } });
  const { p, changed } = codexParser([
    mcpCall(1, 'm1', { code: 'await page.click()', title: 'Open the settings page' }),
    mcpItem(2, 'm1', true),
    cx.output(3, 'm1', outArray('Timed out'), 'function_call_output'),
    mcpCall(4, 'm2', { code: 'x' }),
    cx.output(5, 'm2', outArray('fine'), 'function_call_output'),
  ]);
  const [m1, m2] = p.blocks;
  assert.equal(m1.verb, 'Js');
  assert.equal(m1.cv, 'cua_repl', 'the server shows, like a Claude MCP row');
  assert.equal(m1.chip, 'Open the settings page', "the call's own title is the chip");
  assert.equal(m1.status, 'err');
  assert.equal(m2.status, 'ok');
  // The item arriving AFTER the output still marks the row.
  const late = p.applyLine(mcpItem(6, 'm2', true));
  assert.equal(m2.status, 'err');
  assert.deepEqual(late, [m2.key]);
  assert.ok(changed.includes(m1.key));
  // A non-MCP namespace names itself on the right.
  const clock = codexActionFor({ type: 'function_call', name: 'sleep', namespace: 'clock', arguments: '{"ms":1000}' });
  assert.equal(clock.verb, 'Sleep');
  assert.equal(clock.cv, 'clock');
  // An MCP tool called from inside an exec snippet keeps working as before.
  const inSnippet = codexActionFor({ type: 'custom_tool_call', name: 'exec', input: 'await tools.mcp__azure__list_users({"top":5})' });
  assert.equal(inSnippet.verb, 'List Users');
  assert.equal(inSnippet.cv, 'azure');
});

test('codex: token_count drives the context gauge from codex\'s own window, and the task meter', () => {
  const { p, changed } = codexParser([
    cx.tokens(0, { last: 9_000, totalOut: 1_000 }), // the previous task's last report
    cx.taskStarted(1, 250_000),
    cx.user(2, 'next task'),
    cx.tokens(12, { last: 50_000, totalOut: 1_150, lastOut: 150, window: 250_000 }),
    cx.tokens(22, { last: 62_500, totalOut: 1_400, lastOut: 250, window: 250_000 }),
  ]);
  assert.equal(p.header.contextTokens, 62_500);
  assert.equal(p.header.contextPct, 25, '62.5k of codex\'s stated 250k window');
  const prompt = p.blocks.find((b) => b.kind === 'user');
  assert.deepEqual(prompt.turnMeta, { outputTokens: 400, durationMs: 20_000 });
  assert.ok(changed.includes(prompt.key));
  p.applyLine(cx.complete(30, { duration_ms: 27_500 }));
  assert.deepEqual(prompt.turnMeta, { outputTokens: 400, durationMs: 27_500 });
  // After the task ends, a stray report does not keep charging it.
  p.applyLine(cx.tokens(40, { last: 63_000, totalOut: 1_500, lastOut: 100 }));
  assert.equal(prompt.turnMeta.outputTokens, 400);
});

test('codex: a tail that starts mid-session measures the task from its first report, and no window means no percent', () => {
  const { p } = codexParser([
    cx.user(1, 'resume'),
    { timestamp: CTS(5), type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 40_000, output_tokens: 300, total_tokens: 40_300 }, total_token_usage: { output_tokens: 90_300 } } } },
  ]);
  assert.equal(p.header.contextTokens, 40_300);
  assert.equal(p.header.contextPct, null, 'never invent a denominator');
  assert.equal(p.blocks[0].turnMeta.outputTokens, 300);
  // A rate-limit-only report (info null) changes nothing.
  assert.deepEqual(p.applyLine({ timestamp: CTS(6), type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: {} } }), []);
});

test('codex: turn_context carries effort and the approval/sandbox policies', () => {
  const { p } = codexParser([{
    timestamp: CTS(0),
    type: 'turn_context',
    payload: { model: 'gpt-6-sol', effort: 'xhigh', approval_policy: 'never', sandbox_policy: { type: 'workspace-write', network_access: false } },
  }]);
  assert.equal(p.header.model.id, 'gpt-6-sol');
  assert.equal(p.header.effort, 'xhigh');
  assert.equal(p.header.approvalPolicy, 'never');
  assert.equal(p.header.sandboxPolicy, 'workspace-write');
  p.applyLine({ timestamp: CTS(1), type: 'turn_context', payload: { model: 'gpt-6-sol', sandbox_policy: 'danger-full-access', approval_policy: { granular: {} } } });
  assert.equal(p.header.sandboxPolicy, 'danger-full-access');
  assert.equal(p.header.approvalPolicy, 'granular');
  assert.equal(p.header.effort, 'xhigh', 'a turn_context with no effort keeps the last one');
});

test('codex: one compaction (record + item pair) draws one note; each new compaction draws another', () => {
  const item = (sec) => ({ timestamp: CTS(sec), type: 'event_msg', payload: { type: 'item_completed', item: { type: 'ContextCompaction', id: `cc${sec}` } } });
  const record = (sec) => ({ timestamp: CTS(sec), type: 'compacted', payload: { message: '', replacement_history: [] } });
  const { p } = codexParser([cx.user(0, 'go'), item(1), record(2), item(3), record(4), record(5)]);
  const notes = p.blocks.filter((b) => b.kind === 'note');
  assert.equal(notes.length, 3);
  assert.equal(notes[0].text, 'Session compacted: earlier context was summarized.');
  assert.equal(notes[0].tone, undefined, 'a compaction is a quiet divider, not a warning');
});

test('codex: a live Harbor codex pane keeps a long silent command working; without it the window settles', async (t) => {
  const dir = await fsp.mkdtemp(path.join(realTmpDir(), 'harbor-codex-owner-'));
  const file = path.join(dir, 'rollout-2026-10-15T12-00-00-codex-owner.jsonl');
  const sessionId = 'codex-owner';
  const lines = [cx.taskStarted(0), cx.user(1, 'run the migration'), cx.exec(2, 'c1', 'npm run migrate')];
  await fsp.writeFile(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  const stale = new Date(Date.now() - 4 * 60_000); // past the 3-minute recency window
  await fsp.utimes(file, stale, stale);
  const priorPin = process.env.HARBOR_BEACON_HOMES;
  process.env.HARBOR_BEACON_HOMES = path.join(dir, 'no-beacons');
  let paneAlive = true;
  const asked = [];
  const provider = createTranscriptProvider({
    getSessionMeta: async () => ({ path: file, provider: 'codex' }),
    providerPaneAlive: async (id, prov) => { asked.push([id, prov]); return paneAlive; },
    watchFactory: () => ({ on: () => {}, close: () => {} }),
  });
  t.after(async () => {
    if (priorPin === undefined) delete process.env.HARBOR_BEACON_HOMES;
    else process.env.HARBOR_BEACON_HOMES = priorPin;
    provider.closeAll();
    await fsp.rm(dir, { recursive: true, force: true });
  });
  const updates = [];
  provider.emitter.on('update', (update) => updates.push(update));
  await provider.open(sessionId);
  assert.deepEqual(asked[0], [sessionId, 'codex']);
  assert.equal(updates.at(-1).header.processAlive, true);
  assert.equal(updates.at(-1).header.working, true, 'a 4-minute silent command in a live codex pane is still working');
  assert.equal(updates.at(-1).header.text, 'Running npm run migrate…');
  // Two-sided: the pane goes away, and the same stale rollout settles.
  paneAlive = false;
  await provider.refresh(sessionId);
  assert.equal(updates.at(-1).header.processAlive, null, 'no pane is "unknown", not "dead"');
  assert.equal(updates.at(-1).header.working, false);
});

test('codex: a mid-task steer joins the open task; the prompt keeps the whole meter', () => {
  const { p } = codexParser([
    cx.taskStarted(0),
    cx.user(1, 'build it'),
    cx.tokens(5, { last: 10_000, totalOut: 100, lastOut: 100 }),
    cx.user(10, 'also run lint'), // the steer: no task_started before it
    cx.tokens(20, { last: 20_000, totalOut: 300, lastOut: 200 }),
    cx.complete(31, { duration_ms: 30_000 }),
  ]);
  const [prompt, steer] = p.blocks.filter((b) => b.kind === 'user');
  assert.equal(steer.text, 'also run lint', 'the steer still renders');
  assert.deepEqual(prompt.turnMeta, { outputTokens: 300, durationMs: 30_000 }, 'the prompt carries the whole task');
  assert.equal(steer.turnMeta, undefined, 'the steer is not a task of its own');
  // The next task_started opens a new turn as before.
  p.applyLine(cx.taskStarted(40));
  p.applyLine(cx.user(41, 'next'));
  p.applyLine(cx.tokens(50, { last: 21_000, totalOut: 350, lastOut: 50 }));
  const next = p.blocks.filter((b) => b.kind === 'user').at(-1);
  assert.deepEqual(next.turnMeta, { outputTokens: 50, durationMs: 9_000 });
  assert.equal(prompt.turnMeta.outputTokens, 300);
  // With no task_started ever seen (a tail that began mid-session), each
  // message still opens its own turn.
  const tail = codexParser([cx.user(1, 'a'), cx.user(2, 'b')]).p;
  assert.ok(tail.turn.block === tail.blocks[1]);
});

test('codex: the last command in an exec call decides its row, so a handled grep miss is not red', () => {
  const { p } = codexParser([
    cx.exec(1, 'handled', 'grep -q TODO a.js || echo none'), cx.command(2, 1), cx.command(3, 0), cx.output(4, 'handled', outArray('none')),
    cx.exec(5, 'failed', 'make a; make b'), cx.command(6, 0), cx.command(7, 2), cx.output(8, 'failed', outArray('done')),
  ]);
  const [handled, failed] = p.blocks.filter((b) => b.kind === 'action');
  assert.equal(handled.status, 'ok');
  assert.equal(handled.pill, undefined);
  assert.equal(failed.status, 'err');
  assert.deepEqual(failed.pill, { text: 'exit 2', tone: 'err' });
});

const PATCH = [
  '*** Begin Patch',
  '*** Update File: src/app/limiter.js',
  '@@ function limit',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  '+const c = 4;',
  '*** End Patch',
].join('\n');

test('codex: apply_patch renders like a Claude Edit row, whichever way it was sent', () => {
  const freeform = codexActionFor({ type: 'custom_tool_call', name: 'apply_patch', input: PATCH });
  assert.equal(freeform.verb, 'Edited');
  assert.equal(freeform.chip, 'limiter.js');
  assert.equal(freeform.chipTitle, 'src/app/limiter.js');
  assert.deepEqual(freeform.pill, { text: '+2 −1', tone: 'ok' });
  assert.deepEqual(freeform.diff, [{ t: 'del', s: 'const b = 2;' }, { t: 'add', s: 'const b = 3;' }, { t: 'add', s: 'const c = 4;' }]);
  const json = codexActionFor({ type: 'function_call', name: 'apply_patch', arguments: JSON.stringify({ input: PATCH }) });
  assert.deepEqual(json, freeform);
  const snippet = codexActionFor({ type: 'custom_tool_call', name: 'exec', input: `const r = await tools.apply_patch(${JSON.stringify(PATCH)});\nreturn r;` });
  assert.deepEqual(snippet, freeform);
  const heredoc = codexActionFor({ type: 'custom_tool_call', name: 'exec', input: `await tools.exec_command(${JSON.stringify({ cmd: `apply_patch <<'EOF'\n${PATCH}\nEOF` })})` });
  assert.deepEqual(heredoc, freeform);
  // In a session the row resolves like any other call.
  const { p } = codexParser([{ timestamp: CTS(0), type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'p1', name: 'apply_patch', input: PATCH } }, cx.output(1, 'p1', outArray('Success. Updated the following files:\nM src/app/limiter.js'))]);
  assert.equal(p.blocks[0].status, 'ok');
});

test('codex: a multi-file patch names every file; add-only writes and delete-only deletes', () => {
  const multi = actionForApplyPatch([
    '*** Begin Patch',
    '*** Add File: docs/new.md',
    '+# New',
    '+body',
    '*** Update File: C:\\dev\\harbor\\a.js',
    '*** Move to: C:\\dev\\harbor\\b.js',
    '-x',
    '+y',
    '*** Delete File: old.txt',
    '*** End Patch',
  ].join('\n'));
  assert.equal(multi.verb, 'Edited');
  assert.equal(multi.chip, 'new.md +2 more');
  assert.equal(multi.chipTitle, 'docs/new.md\nC:\\dev\\harbor\\a.js → C:\\dev\\harbor\\b.js\nold.txt');
  assert.equal(multi.pill.text, '+3 −1');
  assert.equal(multi.diff[0].t, 'ctx', 'each file is headed in the preview');
  assert.equal(multi.diff[0].s, 'new.md');
  assert.equal(actionForApplyPatch('*** Begin Patch\n*** Add File: a.txt\n+one\n*** End Patch').verb, 'Wrote');
  const del = actionForApplyPatch('*** Begin Patch\n*** Delete File: gone.txt\n*** End Patch');
  assert.equal(del.verb, 'Deleted');
  assert.deepEqual(del.pill, { text: 'deleted', tone: 'ok' });
  // A pure rename has no lines to count: it says so instead of "+0 −0".
  const moved = actionForApplyPatch('*** Begin Patch\n*** Update File: src/old.js\n*** Move to: src/new.js\n*** End Patch');
  assert.equal(moved.verb, 'Edited');
  assert.equal(moved.chip, 'new.js');
  assert.equal(moved.chipTitle, 'src/old.js → src/new.js');
  assert.deepEqual(moved.pill, { text: 'renamed', tone: 'ok' });
  assert.equal(actionForApplyPatch('no patch here'), null);
  // A long patch previews a bounded slice and says how much more there is.
  const long = actionForApplyPatch(`*** Begin Patch\n*** Update File: big.js\n${Array.from({ length: 40 }, (_, i) => `+line ${i}`).join('\n')}\n*** End Patch`);
  assert.equal(long.pill.text, '+40 −0');
  assert.equal(long.diff.at(-1).s, '… 26 more lines');
  assert.deepEqual(parseApplyPatch('*** Begin Patch\n*** Update File: a\n+b\n*** End Patch')[0].added, 1);
});

test('codex: local_image parts render as the image in the live window, and as a marker elsewhere', async (t) => {
  const dir = await fsp.mkdtemp(path.join(realTmpDir(), 'harbor-codex-image-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const png = path.join(dir, 'shot.png');
  await fsp.writeFile(png, Buffer.from(TINY_PNG_B64, 'base64'));
  const missing = path.join(dir, 'gone.png');
  const line = cx.user(1, 'what is this?', [{ type: 'local_image', path: png }, { type: 'local_image', path: missing }]);
  const live = codexParser([line], { loadLocalImages: true }).p;
  assert.equal(live.blocks.length, 1);
  assert.equal(live.blocks[0].text, 'what is this?');
  assert.deepEqual(live.blocks[0].images, [{ mediaType: 'image/png', dataUri: TINY_PNG_URI }]);
  assert.deepEqual(live.blocks[0].attachments, [{ path: missing, name: 'gone.png' }], 'a vanished file stays a marker, never a broken image');
  const plain = codexParser([line]).p;
  assert.equal(plain.blocks[0].images, undefined);
  assert.deepEqual(plain.blocks[0].attachments.map((a) => a.name), ['shot.png', 'gone.png']);
  // An image with no text is still the user's turn.
  const imageOnly = codexParser([cx.user(2, '', [{ type: 'local_image', path: png }])], { loadLocalImages: true }).p;
  assert.equal(imageOnly.blocks[0].kind, 'user');
  assert.equal(imageOnly.blocks[0].images.length, 1);
});

test('codex: request_user_input questions become a question block and header.pendingQuestion until answered', () => {
  const asked = cx.agent(3, 'Two quick questions before I start.', 'final_answer', {
    delivery: 'async',
    questions: [
      { title: 'Which environment?', options: ['staging', 'production'] },
      { title: 'Anything else I should know?', options: null },
    ],
  });
  const { p } = codexParser([cx.taskStarted(0), cx.user(1, 'deploy it'), asked, cx.complete(4)]);
  const block = p.blocks.find((b) => b.kind === 'question');
  assert.ok(block, 'the question renders as a question block, not plain prose');
  assert.equal(block.text, 'Two quick questions before I start.');
  assert.deepEqual(block.questions, [
    { title: 'Which environment?', options: ['staging', 'production'] },
    { title: 'Anything else I should know?', options: null },
  ]);
  assert.equal(block.answered, false);
  assert.deepEqual(p.header.pendingQuestion, { id: 'a3', ts: CTS(3), questions: block.questions });
  assert.equal(p.header.lastSignal, 'idle');
  const changed = p.applyLine(cx.user(5, 'staging'));
  assert.equal(p.header.pendingQuestion, null);
  assert.equal(block.answered, true);
  assert.ok(changed.includes(block.key));
});

// The 0.160 TUI writes a question as
// `function_call request_user_input` and the answer as that call's
// function_call_output; shapes as measured on real 0.160 rollouts.
const cliAsk = (sec, callId) => ({ timestamp: CTS(sec), type: 'response_item', payload: {
  type: 'function_call', id: `fc_${callId}`, name: 'request_user_input', call_id: callId,
  arguments: JSON.stringify({ questions: [
    { header: 'Color', id: 'color', question: 'Which color?', options: [{ label: 'Red', description: 'Choose red.' }, { label: 'Blue', description: 'Choose blue.' }] },
    { header: 'Fruit', id: 'fruit', question: 'Which fruit?', options: [{ label: 'Apple', description: 'Choose apple.' }, { label: 'Pear', description: 'Choose pear.' }] },
  ] }),
} });
const cliAnswer = (sec, callId) => cx.output(sec, callId, JSON.stringify({ answers: { color: { answers: ['Blue'] }, fruit: { answers: ['Pear'] } } }), 'function_call_output');

test('codex: a CLI request_user_input call is a question block, not a running tool, until its output lands', () => {
  const { p } = codexParser([cx.taskStarted(0), cx.user(1, 'ask me two things'), cliAsk(2, 'call_q')]);
  assert.equal(p.blocks.filter((b) => b.kind === 'action').length, 0, 'no "Running request user input" row');
  const block = p.blocks.find((b) => b.kind === 'question');
  assert.ok(block, 'the question renders as a question block');
  assert.deepEqual(block.questions, [
    { title: 'Which color?', options: ['Red', 'Blue'] },
    { title: 'Which fruit?', options: ['Apple', 'Pear'] },
  ]);
  assert.equal(block.answered, false);
  assert.deepEqual(p.header.pendingQuestion, { id: 'call_q', ts: CTS(2), questions: block.questions });
  assert.equal(p.workingState(Date.now(), Date.now(), true).working, false, 'waiting on the user is not working');
  const changed = p.applyLine(cliAnswer(3, 'call_q'));
  assert.equal(block.answered, true);
  assert.ok(changed.includes(block.key), 'the answered block re-renders in place');
  assert.equal(p.header.pendingQuestion, null);
  assert.equal(p.header.lastSignal, 'user-turn', 'answered: the model owes the next step');
  p.applyLine(cx.agent(4, 'Blue, Pear', 'final_answer'));
  p.applyLine(cx.complete(5));
  assert.equal(p.header.lastSignal, 'idle');
  assert.deepEqual(p.blocks.map((b) => b.kind), ['user', 'question', 'assistant']);
});

test('codex: a CLI question left open when its turn died is no longer pending once the next turn starts', () => {
  const { p } = codexParser([cx.taskStarted(0), cx.user(1, 'ask me'), cliAsk(2, 'call_dead')]);
  assert.ok(p.header.pendingQuestion);
  p.applyLine(cx.taskStarted(10));
  assert.equal(p.header.pendingQuestion, null);
});

test('codex: the live provider reads local images into the window', async (t) => {
  const dir = await fsp.mkdtemp(path.join(realTmpDir(), 'harbor-codex-live-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const png = path.join(dir, 'paste.png');
  await fsp.writeFile(png, Buffer.from(TINY_PNG_B64, 'base64'));
  const file = path.join(dir, 'rollout.jsonl');
  const lines = [cx.taskStarted(0, 200_000), cx.user(1, 'see image', [{ type: 'local_image', path: png }]), cx.tokens(2, { last: 30_000, totalOut: 10, lastOut: 10, window: 200_000 })];
  await fsp.writeFile(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  const provider = createTranscriptProvider({
    getSessionMeta: async () => ({ path: file, provider: 'codex' }),
    watchFactory: () => ({ on: () => {}, close: () => {} }),
  });
  t.after(() => provider.closeAll());
  const updates = [];
  provider.emitter.on('update', (update) => updates.push(update));
  await provider.open('codex-live');
  const last = updates.at(-1);
  assert.equal(last.replace[0].images[0].dataUri, TINY_PNG_URI);
});

test('codex: a local image is read and encoded once per path+size+mtime, not on every parse', async (t) => {
  const dir = await fsp.mkdtemp(path.join(realTmpDir(), 'harbor-codex-imgcache-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const png = path.join(dir, 'shot.png');
  await fsp.writeFile(png, Buffer.from(TINY_PNG_B64, 'base64'));
  const before = localImageCacheStats();
  const first = readLocalImage(png);
  const second = readLocalImage(png);
  assert.deepEqual(first, { mediaType: 'image/png', dataUri: TINY_PNG_URI });
  assert.deepEqual(second, first);
  assert.equal(second.dataUri, first.dataUri, 'one shared string');
  let after = localImageCacheStats();
  assert.equal(after.reads - before.reads, 1, 'read once');
  assert.equal(after.hits - before.hits, 1, 'the second parse hit the cache');
  // Two parsers (the opening scan and the live tail) share it too.
  codexParser([cx.user(1, 'see', [{ type: 'local_image', path: png }])], { loadLocalImages: true });
  codexParser([cx.user(1, 'see', [{ type: 'local_image', path: png }])], { loadLocalImages: true });
  after = localImageCacheStats();
  assert.equal(after.reads - before.reads, 1);
  // A changed file is read again.
  await fsp.writeFile(png, Buffer.concat([Buffer.from(TINY_PNG_B64, 'base64'), Buffer.from([0])]));
  assert.notEqual(readLocalImage(png).dataUri, TINY_PNG_URI);
  assert.equal(localImageCacheStats().reads - before.reads, 2);
  // A vanished file is a marker again, never the stale cached image.
  await fsp.rm(png);
  assert.equal(readLocalImage(png), null);
  // Bounded by entry count.
  for (let i = 0; i < 40; i += 1) {
    const file = path.join(dir, `n${i}.png`);
    await fsp.writeFile(file, Buffer.from(TINY_PNG_B64, 'base64'));
    readLocalImage(file);
  }
  assert.ok(localImageCacheStats().entries <= 32);
});

test('codex: the prefix image seeder brings back local_image prompts from before the tail window', async (t) => {
  const dir = await fsp.mkdtemp(path.join(realTmpDir(), 'harbor-codex-prefix-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const png = path.join(dir, 'early.png');
  await fsp.writeFile(png, Buffer.from(TINY_PNG_B64, 'base64'));
  const file = path.join(dir, 'rollout.jsonl');
  const lines = [
    cx.taskStarted(0),
    cx.user(1, 'what is on screen?', [{ type: 'local_image', path: png }]),
    cx.agent(2, 'A button.', 'final_answer'),
    { timestamp: CTS(3), type: 'event_msg', payload: { type: 'user_message', message: 'and this', local_images: [png] } },
  ];
  const text = `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`;
  await fsp.writeFile(file, text);
  const blocks = await readPrefixImageBlocks(file, Buffer.byteLength(text), 'codex');
  assert.equal(blocks.length, 2, 'both codex image shapes are seeded');
  assert.equal(blocks[0].text, 'what is on screen?');
  assert.equal(blocks[0].images[0].dataUri, TINY_PNG_URI);
  assert.equal(blocks[1].images[0].dataUri, TINY_PNG_URI);
});

test('codex: a CLI question whose turn ended unanswered stops saying it is waiting', () => {
  for (const end of [cx.aborted(9), cx.complete(9, { error: { message: 'boom' } }), cx.taskStarted(9)]) {
    const p = codexParser([cx.taskStarted(0), cx.user(1, 'ask me'), cliAsk(2, 'call_gone')]).p;
    const block = p.blocks.find((b) => b.kind === 'question');
    const changed = p.applyLine(end);
    assert.equal(p.header.pendingQuestion, null);
    assert.equal(block.answered, false, 'nobody answered it');
    assert.equal(block.closed, true, `settled by ${end.payload.type}`);
    assert.ok(changed.includes(block.key), 'the card re-renders in place');
  }
  // An answered one stays answered, not closed.
  const p = codexParser([cx.taskStarted(0), cx.user(1, 'ask'), cliAsk(2, 'call_ok'), cliAnswer(3, 'call_ok'), cx.complete(4)]).p;
  const answered = p.blocks.find((b) => b.kind === 'question');
  assert.equal(answered.answered, true);
  assert.equal(answered.closed, undefined);
});

test('codex: a TUI question whose block the cap evicted still settles when its answer lands', () => {
  const lines = [cx.taskStarted(0), cx.user(1, 'ask me'), cliAsk(2, 'call_far')];
  for (let i = 0; i < MAX_BLOCKS + 5; i += 1) lines.push(cx.agent(3, `note ${i}`, 'commentary'));
  const { p } = codexParser(lines);
  assert.ok(!p.blocks.some((b) => b.kind === 'question'), 'the question block was evicted');
  assert.ok(p.header.pendingQuestion, 'the session still waits on it');
  p.applyLine(cliAnswer(4, 'call_far'));
  assert.equal(p.header.pendingQuestion, null);
  assert.equal(p.codexQuestionCalls.size, 0);
});

// Main asks a transcript's END whether its session finished
// (readTranscriptLastSignal). Codex narrates mid-task, so a commentary message
// at the end of the tail must not read as a finished turn.
test('codex: the tail signal stays in flight through commentary and settles on task_complete', async (t) => {
  const dir = await fsp.mkdtemp(path.join(realTmpDir(), 'harbor-codex-signal-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'rollout.jsonl');
  const write = (lines) => fsp.writeFile(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  const lines = [cx.taskStarted(0), cx.user(1, 'refactor it'), cx.agent(2, 'Reading the module first.', 'commentary')];
  await write(lines);
  assert.equal(await readTranscriptLastSignal(file, 'codex'), 'user-turn');
  lines.push(cx.exec(3, 'c1', 'npm test'));
  await write(lines);
  assert.equal(await readTranscriptLastSignal(file, 'codex'), 'tool-pending');
  lines.push(cx.output(4, 'c1', outArray('ok')), cx.agent(5, 'Done.', 'final_answer'), cx.complete(6));
  await write(lines);
  assert.equal(await readTranscriptLastSignal(file, 'codex'), 'idle');
});

// The block cap evicts old rows, and a live update then names them in
// `removed`. A long codex task must keep working through that: its prompt
// keeps the meter, and a call whose row was evicted while it ran leaves
// nothing behind.
test('codex: a task longer than the block cap keeps its meter and leaves no stale call state', () => {
  const lines = [cx.taskStarted(0), cx.user(1, 'migrate everything'), cx.exec(2, 'first', 'npm run long')];
  for (let i = 0; i < MAX_BLOCKS + 20; i += 1) {
    lines.push(cx.exec(3, `c${i}`, `step ${i}`), cx.command(3, 0), cx.output(3, `c${i}`, outArray('ok')));
  }
  lines.push(cx.tokens(30, { last: 40_000, totalOut: 900, lastOut: 900 }));
  const { p } = codexParser(lines);
  assert.ok(p.blocks.length <= MAX_BLOCKS);
  const prompt = p.blocks.find((b) => b.kind === 'user');
  assert.equal(prompt.text, 'migrate everything', 'the prompt outlives the rows the cap dropped');
  assert.equal(prompt.turnMeta.outputTokens, 900);
  assert.ok(!p.blocks.some((b) => b.toolId === 'first'), 'the long call\'s row was evicted');
  // Its result lands after the eviction: nothing to resolve, nothing kept.
  assert.deepEqual(p.applyLine(cx.output(31, 'first', outArray('done'))), []);
  assert.equal(p.codexExecCalls.size, 0);
  assert.equal(p.codexExits.size, 0);
  assert.equal(p.pendingTools.size, 0);
  assert.equal(p.header.lastSignal, 'user-turn');
  p.applyLine(cx.agent(32, 'All steps ran.', 'final_answer'));
  p.applyLine(cx.complete(33, { duration_ms: 33_000 }));
  assert.equal(p.header.lastSignal, 'idle');
  assert.equal(prompt.turnMeta.durationMs, 33_000);
});

test('codex: the live provider prices the gauge from token_count', async (t) => {
  const dir = await fsp.mkdtemp(path.join(realTmpDir(), 'harbor-codex-live-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'rollout.jsonl');
  const lines = [cx.taskStarted(0, 200_000), cx.user(1, 'go'), cx.tokens(2, { last: 30_000, totalOut: 10, lastOut: 10, window: 200_000 })];
  await fsp.writeFile(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  const provider = createTranscriptProvider({
    getSessionMeta: async () => ({ path: file, provider: 'codex' }),
    watchFactory: () => ({ on: () => {}, close: () => {} }),
  });
  t.after(() => provider.closeAll());
  const updates = [];
  provider.emitter.on('update', (update) => updates.push(update));
  await provider.open('codex-live');
  const last = updates.at(-1);
  assert.equal(last.header.contextTokens, 30_000);
  assert.equal(last.header.contextPct, 15);
  assert.equal(last.replace[0].turnMeta.outputTokens, 10);
});

test('codex: the live provider reports evicted rows as removed and re-renders the prompt in place', async (t) => {
  const dir = await fsp.mkdtemp(path.join(realTmpDir(), 'harbor-codex-evict-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'rollout.jsonl');
  const head = [cx.taskStarted(0), cx.user(1, 'long job')];
  for (let i = 0; i < MAX_BLOCKS - 10; i += 1) head.push(cx.exec(2, `h${i}`, `step ${i}`), cx.output(2, `h${i}`, outArray('ok')));
  await fsp.writeFile(file, `${head.map((l) => JSON.stringify(l)).join('\n')}\n`);
  const provider = createTranscriptProvider({
    getSessionMeta: async () => ({ path: file, provider: 'codex' }),
    watchFactory: () => ({ on: () => {}, close: () => {} }),
  });
  t.after(() => provider.closeAll());
  const updates = [];
  provider.emitter.on('update', (update) => updates.push(update));
  await provider.open('codex-evict');
  const promptKey = updates.at(-1).replace.find((b) => b.kind === 'user').key;
  const more = [];
  for (let i = 0; i < 20; i += 1) more.push(cx.exec(3, `c${i}`, `step ${i}`), cx.output(3, `c${i}`, outArray('ok')));
  more.push(cx.tokens(20, { last: 10_000, totalOut: 50, lastOut: 50 }));
  await fsp.appendFile(file, `${more.map((l) => JSON.stringify(l)).join('\n')}\n`);
  await provider.refresh('codex-evict');
  const update = updates.at(-1);
  assert.equal(update.replace, undefined, 'an eviction is a delta, not a wholesale replace');
  assert.equal(update.removed?.length, 1 + (MAX_BLOCKS - 10) + 20 - MAX_BLOCKS, 'the rows the cap dropped are named');
  assert.ok(!update.removed.includes(promptKey), 'the prompt is never the one evicted');
  const prompt = update.changed.find((b) => b.key === promptKey);
  assert.ok(prompt, 'the prompt re-renders in place with its meter');
  assert.equal(prompt.turnMeta.outputTokens, 50);
});
