'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { foldCodexRecords, readRolloutSlice, readCodexState, codexPermissionMode } = require('../../src/main/codex-state.js');
const { createCodexStatusSource, codexPaneStatus } = require('../../src/main/codex-status.js');
const { createNotifier } = require('../../src/main/notify.js');

const fixture = (name) => fs.readFileSync(path.join(__dirname, '../fixtures/codex-tui', name), 'utf8');

// Synthetic records in the 0.160.0 rollout shapes (see codex-state.js header).
let clock = Date.parse('2026-10-15T12:00:00Z');
const rec = (type, payload) => ({ timestamp: new Date(clock += 1000).toISOString(), type, payload });
const started = () => rec('event_msg', { type: 'task_started' });
const commentary = () => rec('event_msg', { type: 'item_completed', item: { type: 'AgentMessage', id: 'a1', phase: 'commentary', content: [] } });
const finalAnswer = () => rec('event_msg', { type: 'item_completed', item: { type: 'AgentMessage', id: 'a2', phase: 'final_answer', content: [] } });
const complete = (error) => rec('event_msg', { type: 'task_complete', turn_id: 't', last_agent_message: 'done', ...(error ? { error: { message: error } } : {}) });
const aborted = () => rec('event_msg', { type: 'turn_aborted', reason: 'interrupted' });
const ask = (callId) => rec('response_item', {
  type: 'function_call', name: 'request_user_input', call_id: callId,
  arguments: JSON.stringify({ questions: [{ id: 'c', header: 'Color', question: 'Which color?', options: [{ label: 'Red', description: 'r' }, { label: 'Blue', description: 'b' }] }] }),
});
const answered = (callId) => rec('response_item', { type: 'function_call_output', call_id: callId, output: '{}' });
const context = (approval, sandbox, reviewer = 'user') => rec('turn_context', { approval_policy: approval, approvals_reviewer: reviewer, sandbox_policy: { type: sandbox } });

test('the fold follows the shared contract: commentary keeps a turn in flight, task_complete ends it', () => {
  let state = foldCodexRecords([started(), commentary()]);
  assert.equal(state.turn, 'working');
  state = foldCodexRecords([finalAnswer(), complete()], state);
  assert.equal(state.turn, 'idle');
  assert.equal(state.turnEnd, 'complete');
  assert.equal(state.turnError, null);
});

test('a failed turn carries its error and an interrupt reads as aborted', () => {
  const failed = foldCodexRecords([started(), complete('stream disconnected before completion')]);
  assert.equal(failed.turnEnd, 'error');
  assert.equal(failed.turnError.message, 'stream disconnected before completion');
  const stopped = foldCodexRecords([started(), commentary(), aborted()]);
  assert.equal(stopped.turnEnd, 'aborted');
  assert.equal(stopped.turn, 'idle');
});

test('a request_user_input question is pending until its output lands', () => {
  let state = foldCodexRecords([started(), ask('call_1')]);
  assert.equal(state.pendingQuestion.callId, 'call_1');
  assert.equal(state.pendingQuestion.questions[0].question, 'Which color?');
  state = foldCodexRecords([answered('call_1')], state);
  assert.equal(state.pendingQuestion, null);
});

test('permission readback reports the mode the session actually runs under', () => {
  const mode = (records) => codexPermissionMode(foldCodexRecords(records))?.mode;
  assert.equal(mode([context('never', 'danger-full-access')]), 'bypass');
  assert.equal(mode([context('on-request', 'workspace-write', 'auto_review')]), 'auto');
  assert.equal(mode([context('on-request', 'read-only')]), 'read-only');
  assert.equal(mode([context('on-request', 'workspace-write')]), 'default');
  assert.equal(codexPermissionMode(foldCodexRecords([started()])), null, 'no turn_context yet: unknown, never a guess');
});

test('the status prefers the screen for approvals and the rollout for everything else', () => {
  const working = foldCodexRecords([started()]);
  assert.deepEqual(codexPaneStatus(working, fixture('approval-command-0.160.0.txt')),
    { status: 'blocked', kind: 'permission', msg: 'approve: echo hello > probe.txt' });
  assert.equal(codexPaneStatus(working, fixture('working-0.160.0.txt')).status, 'working');
  assert.equal(codexPaneStatus(foldCodexRecords([started(), ask('q')])).kind, 'question');
  assert.equal(codexPaneStatus(foldCodexRecords([started(), complete('boom')])).kind, 'error');
});

test('rollout slices keep only whole lines and resume where they stopped', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-codex-slice-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'rollout.jsonl');
  fs.writeFileSync(file, `${JSON.stringify(started())}\n{"type":"event_msg","payl`);
  const first = readRolloutSlice(file);
  assert.equal(first.records.length, 1, 'a torn last line is left for the next read');
  fs.appendFileSync(file, `oad":{"type":"turn_aborted"}}\n`);
  const second = readRolloutSlice(file, { from: first.offset });
  assert.equal(second.records[0].payload.type, 'turn_aborted');
});

// The whole path a status takes: rollout -> source -> notifier -> toast.
function harness(t, { screen = () => fixture('working-0.160.0.txt'), ...extra } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-codex-status-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'rollout.jsonl');
  fs.writeFileSync(file, '');
  const toasts = [];
  const events = [];
  const notifier = createNotifier({ notify: (title, body, meta) => toasts.push({ body, meta }), setBadgeCount: () => {} });
  const source = createCodexStatusSource({
    listPanes: () => [{ paneId: 'p1', workspaceId: 'w1', sessionId: 's1' }],
    transcriptPath: async () => file,
    readScreen: async () => screen(),
    emit: (event) => { events.push(event); notifier.onAgentStatusChanged(event); },
    ...extra,
  });
  const append = (...records) => fs.appendFileSync(file, records.map((r) => `${JSON.stringify(r)}\n`).join(''));
  return { source, append, toasts, events, notifier };
}

test('a Codex turn that finishes toasts like a Claude one, and only on the transition', async (t) => {
  const h = harness(t);
  h.append(started(), commentary());
  await h.source.tick();
  await h.source.tick();
  assert.deepEqual(h.events.map((e) => e.data.agent_status), ['working'], 'an unchanged status is not re-sent');
  h.append(finalAnswer(), complete());
  await h.source.tick();
  h.notifier._flushNow();
  assert.equal(h.toasts.length, 1);
  assert.match(h.toasts[0].body, /finished$/);
  assert.equal(h.toasts[0].meta.paneId, 'p1', 'a click opens the window it is about');
});

test('a failed Codex turn toasts as failed with its error', async (t) => {
  const h = harness(t);
  h.append(started());
  await h.source.tick();
  h.append(complete('You have hit your usage limit'));
  await h.source.tick();
  h.notifier._flushNow();
  assert.match(h.toasts[0].body, /failed: You have hit your usage limit/);
});

test('an approval on screen is "needs you", and answering it clears it', async (t) => {
  let screen = fixture('working-0.160.0.txt');
  const h = harness(t, { screen: () => screen });
  h.append(started());
  await h.source.tick();
  screen = fixture('approval-command-0.160.0.txt');
  await h.source.tick();
  h.notifier._flushNow();
  assert.match(h.toasts[0].body, /needs you: approve: echo hello > probe\.txt/);
  screen = fixture('working-0.160.0.txt');
  await h.source.tick();
  assert.equal(h.events.at(-1).data.agent_status, 'working');
});

test('a resync that wiped the rail re-asserts the status', async (t) => {
  const h = harness(t);
  h.append(started());
  await h.source.tick();
  const listed = { paneId: 'p1', workspaceId: 'w1', sessionId: 's1', agentStatus: null };
  const again = createCodexStatusSource({
    listPanes: () => [listed],
    transcriptPath: async () => h.source._entries.get('p1').path,
    readScreen: async () => '',
    emit: (event) => h.events.push(event),
  });
  await again.tick();
  const count = h.events.length;
  await again.tick();
  assert.equal(h.events.length, count + 1, 'rail says null, source says working: re-sent');
  listed.agentStatus = 'working';
  await again.tick();
  assert.equal(h.events.length, count + 1);
});

// ---------------------------------------------------------------------------
// A question left open when Codex died, or a turn
// killed mid-tool, never writes its end. After a resume the TUI is at rest but
// the rollout alone said blocked/working forever.
// ---------------------------------------------------------------------------

const execCall = (callId) => rec('response_item', { type: 'function_call', name: 'exec_command', call_id: callId, arguments: '{"cmd":"sleep 600"}' });

test('a new turn drops a question the previous turn never got an answer to', () => {
  const state = foldCodexRecords([started(), ask('call_dead'), started()]);
  assert.equal(state.pendingQuestion, null, 'the next task_started means the old question is gone');
  assert.equal(state.turn, 'working');
});

test('a rollout ending in an unanswered question reads idle once the resumed TUI is at rest', async (t) => {
  // The shape of the real abandoned 0.160 rollout: task_started, the
  // request_user_input call, then nothing. Its records are old (a past run).
  const h = harness(t, { screen: () => fixture('idle-composer-0.160.0.txt') });
  h.append(started(), context('on-request', 'workspace-write'), ask('call_dead'));
  await h.source.tick();
  assert.equal(h.events.at(-1).data.agent_status, 'idle', 'an idle composer, no menu, no working line: not blocked');
  assert.equal(h.source._entries.get('p1').state.pendingQuestion, null, 'the question is dropped, not just hidden');
  // A new turn after that is plainly working, never "blocked on the old question".
  let screen = fixture('working-0.160.0.txt');
  const again = harness(t, { screen: () => screen });
  again.append(started(), ask('call_dead'));
  await again.source.tick();
  again.append(started());
  await again.source.tick();
  assert.equal(again.events.at(-1).data.agent_status, 'working');
  screen = fixture('idle-composer-0.160.0.txt');
  await again.source.tick();
  assert.equal(again.events.at(-1).data.agent_status, 'idle');
});

test('a turn killed mid-tool stops reading working once the TUI is at rest', async (t) => {
  const h = harness(t, { screen: () => fixture('idle-composer-0.160.0.txt') });
  h.append(started(), execCall('c1'));
  await h.source.tick();
  assert.equal(h.events.at(-1).data.agent_status, 'idle');
});

test('a live turn is not overruled by one at-rest frame, and a working line wins back', async (t) => {
  let screen = fixture('idle-composer-0.160.0.txt');
  let wall = 0;
  const h = harness(t, { screen: () => screen, now: () => wall });
  h.append(started(), execCall('c1'));
  wall = clock + 1000; // the rollout wrote a second ago: the turn is alive
  await h.source.tick();
  assert.equal(h.events.at(-1).data.agent_status, 'working', 'one frame is not proof');
  h.append(rec('response_item', { type: 'function_call_output', call_id: 'c1', output: 'ok' }));
  wall = clock + 1000;
  await h.source.tick();
  await h.source.tick();
  assert.equal(h.events.at(-1).data.agent_status, 'working', 'new records reset the count');
  await h.source.tick();
  assert.equal(h.events.at(-1).data.agent_status, 'idle', 'at rest on three quiet reads in a row');
  screen = fixture('working-0.160.0.txt');
  await h.source.tick();
  assert.equal(h.events.at(-1).data.agent_status, 'working', 'the screen is still read, and working again wins');
});

// ---------------------------------------------------------------------------
// The first read covers the last 2 MB; a longer
// turn's task_started lies before it, the fold said idle, the screen was never
// read, and an approval in that turn never showed.
// ---------------------------------------------------------------------------

const bigOutput = (callId, bytes) => rec('response_item', { type: 'function_call_output', call_id: callId, output: 'x'.repeat(bytes) });
function longTurn(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-codex-long-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'rollout.jsonl');
  const records = [
    started(), complete(), // an earlier, finished turn
    started(), context('on-request', 'workspace-write'), // the long one: both outside the window
    ...Array.from({ length: 8 }, (_, i) => bigOutput(`c${i}`, 300 * 1024)), // ~2.3 MB of tool output
  ];
  fs.writeFileSync(file, records.map((r) => `${JSON.stringify(r)}\n`).join(''));
  assert.ok(fs.statSync(file).size > 2.2 * 1024 * 1024);
  return file;
}

test('a turn longer than the first-read window still reads as working, with its permissions', (t) => {
  const file = longTurn(t);
  const slice = readRolloutSlice(file);
  assert.equal(slice.anchored, true);
  const state = foldCodexRecords(slice.records);
  assert.equal(state.turn, 'working', 'the task_started before the window was found');
  assert.equal(codexPermissionMode(readCodexState(file))?.mode, 'default', 'the readback finds the turn_context too');
});

test('an approval during a turn longer than the window is "needs you" after a restart', async (t) => {
  const file = longTurn(t);
  const events = [];
  const source = createCodexStatusSource({
    listPanes: () => [{ paneId: 'p1', workspaceId: 'w1', sessionId: 's1' }],
    transcriptPath: async () => file,
    readScreen: async () => fixture('approval-command-0.160.0.txt'),
    emit: (event) => events.push(event),
  });
  await source.tick();
  assert.deepEqual(events.at(-1).data.agent_status, 'blocked');
  assert.equal(events.at(-1).data.agent_status_kind, 'permission');
});

test('with no turn boundary in reach the screen decides: a menu blocks, a working line works', async (t) => {
  const file = longTurn(t);
  let screen = fixture('approval-command-0.160.0.txt');
  const events = [];
  const source = createCodexStatusSource({
    listPanes: () => [{ paneId: 'p1', workspaceId: 'w1', sessionId: 's1' }],
    transcriptPath: async () => file,
    readScreen: async () => screen,
    // No scan-back: the tail alone, as when the boundary is beyond any reach.
    readSlice: (filePath, options) => readRolloutSlice(filePath, { ...options, scanBytes: 0 }),
    emit: (event) => events.push(event),
  });
  await source.tick();
  assert.equal(source._entries.get('p1').unanchored, true);
  assert.equal(events.at(-1).data.agent_status, 'blocked');
  screen = fixture('working-0.160.0.txt');
  await source.tick();
  assert.equal(events.at(-1).data.agent_status, 'working');
});

// A session whose path changes (a resumed session moves onto another file)
// is re-read from the new file.
test('a session whose transcript path changes is followed to the new file', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-codex-move-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const copy = path.join(dir, 'copy.jsonl');
  const live = path.join(dir, 'live.jsonl');
  fs.writeFileSync(copy, `${JSON.stringify(started())}\n${JSON.stringify(complete())}\n`);
  let current = copy;
  const events = [];
  const source = createCodexStatusSource({
    listPanes: () => [{ paneId: 'p1', workspaceId: 'w1', sessionId: 's1' }],
    transcriptPath: async () => current,
    readScreen: async () => fixture('working-0.160.0.txt'),
    emit: (event) => events.push(event),
  });
  await source.tick();
  assert.equal(events.at(-1).data.agent_status, 'done');
  fs.writeFileSync(live, `${JSON.stringify(started())}\n`);
  current = live;
  await source.tick();
  assert.equal(events.at(-1).data.agent_status, 'working', 'the old file is no longer what is read');
});

// ---------------------------------------------------------------------------
// A first read whose window opens inside a multibyte
// character, with a torn last line, measured its offset on the DECODED string
// (each stray continuation byte re-encodes as a 3-byte U+FFFD), so the next
// read began past the start of the torn line and that record was lost.
// ---------------------------------------------------------------------------

test('a window that opens inside a multibyte character loses no record', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-codex-utf8-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'rollout.jsonl');
  const lead = `${JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: '€€€€€€€€' } })}\n`;
  const middle = `${JSON.stringify(started())}\n`;
  const torn = JSON.stringify(rec('event_msg', { type: 'task_complete', turn_id: 't', last_agent_message: 'done' }));
  const cut = 20;
  fs.writeFileSync(file, lead + middle + torn.slice(0, cut));
  const euro = Buffer.from(lead).indexOf(Buffer.from('€'));
  const size = fs.statSync(file).size;
  // Start two bytes into a 3-byte '€': one continuation byte opens the window.
  const first = readRolloutSlice(file, { maxBytes: size - (euro + 2), scanBytes: 0 });
  assert.deepEqual(first.records.map((r) => r.payload.type), ['task_started']);
  assert.equal(first.offset, Buffer.byteLength(lead + middle), 'the offset is the first byte of the torn line');
  fs.appendFileSync(file, `${torn.slice(cut)}\n${JSON.stringify(started())}\n`);
  const second = readRolloutSlice(file, { from: first.offset });
  assert.deepEqual(second.records.map((r) => r.payload.type), ['task_complete', 'task_started']);
});

test('a rollout read past its end after a truncation starts clean', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-codex-trunc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'rollout.jsonl');
  fs.writeFileSync(file, `${JSON.stringify(started())}\n${JSON.stringify(complete())}\n`);
  const slice = readRolloutSlice(file, { from: 10_000 });
  assert.deepEqual(slice.records.map((r) => r.payload.type), ['task_started', 'task_complete']);
  assert.equal(slice.offset, fs.statSync(file).size);
});

// ---------------------------------------------------------------------------
// Once the model streams a reasoning summary, Codex's
// status line shows that summary's title, not "Working", and the pane read as
// not working (getCliQueue.working, codex-status with an unanchored rollout).
// ---------------------------------------------------------------------------

const { isCodexWorking, isCodexIdle } = require('../../src/main/codex-screen.js');

test('a titled status line is a working turn, and never an idle TUI', () => {
  const plain = fixture('working-0.160.0.txt');
  const titled = plain.replace('• Working (1s • esc to interrupt)', '• Inspecting the repo (12s • esc to interrupt)');
  const long = plain.replace('• Working (1s • esc to interrupt)', '◦ Planning the change (1h 02m 03s • esc to interrupt)');
  assert.notEqual(titled, plain);
  for (const screen of [plain, titled, long]) {
    assert.equal(isCodexWorking(screen), true);
    assert.equal(isCodexIdle(screen), false);
    assert.equal(codexPaneStatus(foldCodexRecords([]), screen).status, 'working');
  }
  // A question's footer and a pending steer's hint say "esc to interrupt" too;
  // neither is the working line.
  assert.equal(isCodexWorking(fixture('question-batch-q1-0.160.0.txt')), false);
  assert.equal(isCodexWorking(fixture('idle-composer-0.160.0.txt')), false);
  assert.equal(isCodexWorking('• Messages to be submitted after next tool call (press esc to interrupt and send immediately)'), false);
});

// ---------------------------------------------------------------------------
// The screen read (a 90-line readPane RPC + parse) ran
// every 1.5 s per pane for as long as the rollout said working, including a
// turn that had died under a TUI now at rest, and once more after an approval
// even when the rollout had already closed the turn.
// ---------------------------------------------------------------------------

test('a pane settled at idle has its screen read on a back-off, and new records restore every tick', async (t) => {
  let screen = fixture('idle-composer-0.160.0.txt');
  let reads = 0;
  let wall = 0;
  const h = harness(t, { screen: () => { reads += 1; return screen; }, now: () => wall });
  h.append(started(), execCall('c1')); // a turn killed mid-tool: never closed
  wall = clock + 60 * 60 * 1000; // its records are an hour old
  for (let i = 0; i < 40; i += 1) { // one minute of 1.5 s ticks
    await h.source.tick();
    wall += 1500;
  }
  assert.equal(h.events.at(-1).data.agent_status, 'idle');
  assert.equal(h.events.length, 1, 'the back-off never re-sends a status');
  // 7 reads in the first 10 s (every tick), then one per 6 s: 15, not 40.
  assert.equal(reads, 15);
  // The turn comes back: a new record puts the read back on the very next tick.
  h.append(rec('response_item', { type: 'function_call_output', call_id: 'c1', output: 'ok' }));
  screen = fixture('working-0.160.0.txt');
  const before = reads;
  await h.source.tick();
  assert.equal(reads, before + 1);
  assert.equal(h.events.at(-1).data.agent_status, 'working');
  wall += 1500;
  await h.source.tick();
  assert.equal(reads, before + 2, 'working: read every tick again');
});

test('a backed-off pane still re-asserts its status after a resync wiped the rail', async (t) => {
  let reads = 0;
  let wall = 0;
  const listed = { paneId: 'p1', workspaceId: 'w1', sessionId: 's1' };
  const h = harness(t, {
    screen: () => { reads += 1; return fixture('idle-composer-0.160.0.txt'); },
    now: () => wall,
    listPanes: () => [listed],
  });
  h.append(started(), execCall('c1'));
  wall = clock + 60 * 60 * 1000;
  for (let i = 0; i < 9; i += 1) { await h.source.tick(); wall += 1500; }
  const count = h.events.length;
  const readsBefore = reads;
  listed.agentStatus = null;
  await h.source.tick(); // a backed-off tick: no read, but the rail is wrong
  assert.equal(reads, readsBefore, 'still backed off');
  assert.equal(h.events.length, count + 1);
  assert.equal(h.events.at(-1).data.agent_status, 'idle');
});

test('an approval cleared by the rollout closing the turn costs no screen read', async (t) => {
  let screen = fixture('working-0.160.0.txt');
  let reads = 0;
  const h = harness(t, { screen: () => { reads += 1; return screen; } });
  h.append(started());
  await h.source.tick();
  screen = fixture('approval-command-0.160.0.txt');
  await h.source.tick();
  assert.equal(h.events.at(-1).data.agent_status, 'blocked');
  const before = reads;
  h.append(complete());
  await h.source.tick();
  await h.source.tick();
  assert.equal(h.events.at(-1).data.agent_status, 'done');
  assert.equal(reads, before, 'anchored, idle, no question: the screen has nothing to add');
});

// Two approvals of the same command read the same (the msg is the command),
// so each new prompt gets its own seq: a one-click answer names the prompt it
// was shown for, and the notifier toasts the second one too.
test('a second approval with the same words gets a new seq, and an answered one stops matching', async (t) => {
  let screen = fixture('working-0.160.0.txt');
  const h = harness(t, { screen: () => screen });
  h.append(started());
  await h.source.tick();
  screen = fixture('approval-command-0.160.0.txt');
  await h.source.tick();
  const first = h.events.at(-1).data.agent_status_seq;
  assert.equal(Number.isInteger(first), true);
  assert.equal(h.source.seqFor('p1'), first);
  await h.source.tick();
  assert.equal(h.source.seqFor('p1'), first, 'the same prompt keeps its seq');
  h.source.answered('p1');
  assert.equal(h.source.seqFor('p1'), null, 'a second click for an answered prompt has nothing to match');
  // Answered, the command ran (records), and the next approval is up before a
  // poll ever saw the pane working.
  h.append(rec('response_item', { type: 'function_call_output', call_id: 'x1', output: 'ok' }));
  await h.source.tick();
  const second = h.events.at(-1).data.agent_status_seq;
  assert.equal(h.events.at(-1).data.agent_status, 'blocked');
  assert.notEqual(second, first);
  assert.equal(h.source.seqFor('p1'), second);
  h.notifier._flushNow();
  assert.equal(h.toasts.filter((toast) => /needs you/.test(toast.body)).length, 1, 'both land in one coalesce window');
});

test('a rollout path that stops reading is forgotten, so the resolver looks again', async (t) => {
  const forgotten = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-codex-gone-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let current = path.join(dir, 'gone.jsonl');
  fs.writeFileSync(current, `${JSON.stringify(started())}\n`);
  const events = [];
  const source = createCodexStatusSource({
    listPanes: () => [{ paneId: 'p1', workspaceId: 'w1', sessionId: 's1' }],
    transcriptPath: async () => current,
    forgetPath: (id) => forgotten.push(id),
    readScreen: async () => fixture('working-0.160.0.txt'),
    emit: (event) => events.push(event),
  });
  await source.tick();
  fs.rmSync(current);
  await source.tick();
  assert.deepEqual(forgotten, ['s1']);
  current = path.join(dir, 'moved.jsonl');
  fs.writeFileSync(current, `${JSON.stringify(started())}\n${JSON.stringify(complete())}\n`);
  await source.tick();
  assert.equal(events.at(-1).data.agent_status, 'done');
});

test('a turn with a very large number of tool outputs before the window scans back without overflowing', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-codex-stubs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'rollout.jsonl');
  const out = (i) => `{"timestamp":"2026-10-15T12:00:00Z","type":"response_item","payload":{"type":"function_call_output","call_id":"c${i}","output":"ok"}}\n`;
  const fd = fs.openSync(file, 'w');
  fs.writeSync(fd, `${JSON.stringify(started())}\n${JSON.stringify(ask('q1'))}\n`);
  let chunk = '';
  for (let i = 0; i < 200_000; i += 1) {
    chunk += out(i);
    if (chunk.length > 1 << 20) { fs.writeSync(fd, chunk); chunk = ''; }
  }
  fs.writeSync(fd, chunk);
  fs.closeSync(fd);
  const slice = readRolloutSlice(file, { maxBytes: 64 * 1024 });
  assert.equal(slice.anchored, true);
  const state = foldCodexRecords(slice.records);
  assert.equal(state.turn, 'working');
  assert.equal(state.pendingQuestion?.callId, 'q1', 'unanswered: none of the outputs is its answer');
});
