'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const { realTmpDir } = require('../support/real-tmpdir.js');
const path = require('node:path');

const {
  createTranscriptProvider: createTranscriptProviderImpl,
  TranscriptParser,
  LineBuffer,
  modelDisplay,
  userTextFor,
  imageFromPart,
  imagesFromContent,
  actionForToolUse,
  MAX_BLOCKS,
  transcriptPathFor,
  findProviderTranscript,
} = require('../../src/main/providers/transcript.js');

const TEST_CONTEXT_DIR = fs.mkdtempSync(path.join(realTmpDir(), 'harbor-transcript-context-'));
process.env.HARBOR_CONTEXT_DIR = TEST_CONTEXT_DIR;
const createTranscriptProvider = (options) => createTranscriptProviderImpl({
  contextCacheDir: TEST_CONTEXT_DIR,
  ...options,
});

const TINY_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const TINY_PNG_URI = `data:image/png;base64,${TINY_PNG_B64}`;

function imagePart(mediaType = 'image/png', data = TINY_PNG_B64) {
  return { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
}

// Fixture lines mirror the REAL Claude Code JSONL shape (verified against the
// live corpus 2026-07-18): assistant events carry one content block each with
// a message envelope; tool results come back on later user events.
const TS = '2026-07-18T05:00:00.000Z';

test('real Codex rollout fixture maps identity, one user turn, tools, and final answer', () => {
  const fixture = fs.readFileSync(path.join(__dirname, '../fixtures/codex-rollout.jsonl'), 'utf8');
  const p = new TranscriptParser('codex');
  for (const line of fixture.trim().split('\n')) p.applyLine(JSON.parse(line));
  assert.equal(p.header.model.id, 'gpt-5.6-sol');
  assert.deepEqual(p.blocks.map((block) => block.kind), ['user', 'action', 'assistant']);
  assert.equal(p.blocks[0].text, 'Inspect the fixture.');
  assert.equal(p.blocks[1].verb, 'Ran');
  assert.equal(p.blocks[1].status, 'ok');
  assert.equal(p.blocks[2].text, 'The fixture is readable.');
});

// Codex writes a custom_tool_call's input as the JAVASCRIPT it is about to run,
// not as JSON: `const r = await tools.exec_command({"cmd":"npm test"})`. A
// survey of the real store found exactly two tool names in use, `exec` with
// this shape (440 calls) and `wait` with plain JSON (77), so taken literally
// this was the shape of nearly every action row a codex session has, and every
// one of them read `Exec  const r = await tools.exec_command({"cmd":"npm te…`:
// the snippet, not the command. `exec` is the transport, `exec_command` is the
// tool, `cmd` is the argument.
test('codex exec snippets render as the command they run, not the snippet', () => {
  const p = new TranscriptParser('codex');
  p.applyLine({
    timestamp: TS,
    type: 'response_item',
    payload: {
      type: 'custom_tool_call',
      call_id: 'call-1',
      name: 'exec',
      input: 'const r = await tools.exec_command({"cmd":"npm test -- limiter","yield_time_ms":10000});\nreturn r;',
    },
  });
  assert.equal(p.blocks[0].verb, 'Ran');
  assert.equal(p.blocks[0].chip, 'npm test -- limiter');
});

// A brace inside a quoted command must not end the object early, and anything
// that is NOT this shape has to keep its old behaviour exactly: `wait` is plain
// JSON, and an input that parses as neither still has to produce a row rather
// than throw.
test('codex tool input that is not an exec snippet is unchanged', () => {
  const p = new TranscriptParser('codex');
  p.applyLine({
    timestamp: TS,
    type: 'response_item',
    payload: {
      type: 'custom_tool_call',
      call_id: 'call-brace',
      name: 'exec',
      input: 'const r = await tools.exec_command({"cmd":"awk \'{print $1}\' access.log"});',
    },
  });
  p.applyLine({
    timestamp: TS,
    type: 'response_item',
    payload: { type: 'function_call', call_id: 'call-2', name: 'wait', arguments: '{"cell_id":"36","yield_time_ms":30000}' },
  });
  p.applyLine({
    timestamp: TS,
    type: 'response_item',
    payload: { type: 'custom_tool_call', call_id: 'call-3', name: 'exec', input: 'not json and no tools call' },
  });
  assert.equal(p.blocks[0].chip, "awk '{print $1}' access.log");
  assert.equal(p.blocks[1].verb, 'Wait');
  assert.equal(p.blocks[2].verb, 'Exec');
  assert.equal(p.blocks[2].chip, 'not json and no tools call');
});

// Cursor spells the same two arguments differently (Read{path},
// Write{path,contents}), so a cursor file action used to draw a verb with no
// filename beside it and a confident "0 lines".
test('cursor file tools name their file, because path is file_path', () => {
  assert.equal(actionForToolUse({ name: 'Read', input: { path: '/w/src/nav.css' } }).chip, 'nav.css');
  const wrote = actionForToolUse({ name: 'Write', input: { path: '/w/out/report.html', contents: 'a\nb\nc' } });
  assert.equal(wrote.chip, 'report.html');
  assert.equal(wrote.pill.text, '3 lines');
});

// Codex 0.147.0 stopped writing event_msg user_message/agent_message and moved
// the conversation into event_msg item_completed (item.type UserMessage /
// AgentMessage, text in content parts). Found 2026-08-08 when Pat's real
// 4.5MB review rollout parsed to 16 tool actions and ZERO text: the window
// would have opened without his prompt or the verdict. The response_item
// message lines are NOT the conversation: role developer and the first role
// user carry injected scaffolding (skills instructions, AGENTS.md,
// environment_context), and rendering them would bury the real prompt.
// CommandExecution items mirror the custom_tool_call lines the parser already
// renders, so parsing them too would double every action row. Shapes below
// mirror the real rollout byte layout, including the part-type case split
// (user parts 'text', agent parts 'Text').
test('codex 0.147.0: the conversation is the item stream, and scaffolding never renders', () => {
  const p = new TranscriptParser('codex');
  const lines = [
    { timestamp: TS, type: 'session_meta', payload: { session_id: 'x', cwd: '/tmp/p' } },
    { timestamp: TS, type: 'turn_context', payload: { model: 'gpt-5.6-sol' } },
    { timestamp: TS,
      type: 'response_item',
      payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<skills_instructions>never render</skills_instructions>' }] } },
    { timestamp: TS,
      type: 'response_item',
      payload: { type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: '# AGENTS.md instructions for /tmp/p' },
          { type: 'input_text', text: '<environment_context><cwd>/tmp/p</cwd></environment_context>' },
        ] } },
    { timestamp: TS,
      type: 'event_msg',
      payload: { type: 'item_completed', item: { type: 'UserMessage', id: 'u1', content: [{ type: 'text', text: 'review this doc please' }] } } },
    { timestamp: TS,
      type: 'event_msg',
      payload: { type: 'item_completed', item: { type: 'Reasoning', id: 'r1', summary_text: [], raw_content: [] } } },
    { timestamp: TS,
      type: 'response_item',
      payload: { type: 'custom_tool_call', call_id: 'c1', name: 'shell', input: JSON.stringify({ command: 'ls' }) } },
    { timestamp: TS,
      type: 'response_item',
      payload: { type: 'custom_tool_call_output', call_id: 'c1', output: 'ok' } },
    { timestamp: TS,
      type: 'event_msg',
      payload: { type: 'item_completed', item: { type: 'CommandExecution', id: 'e1', command: ['/bin/bash', '-lc', 'ls'], exit_code: 0 } } },
    { timestamp: TS,
      type: 'event_msg',
      payload: { type: 'item_completed', item: { type: 'AgentMessage', id: 'a1', phase: 'final', content: [{ type: 'Text', text: 'The verdict is fine.' }] } } },
    { timestamp: TS, type: 'event_msg', payload: { type: 'task_complete' } },
  ];
  for (const line of lines) p.applyLine(line);
  assert.deepEqual(p.blocks.map((block) => block.kind), ['user', 'action', 'assistant']);
  assert.equal(p.blocks[0].text, 'review this doc please');
  assert.equal(p.blocks[1].status, 'ok');
  assert.equal(p.blocks[2].text, 'The verdict is fine.');
  assert.equal(p.header.lastSignal, 'idle');
});

test('Cursor agent transcript maps content blocks and tool calls without duplicates', () => {
  const p = new TranscriptParser('cursor');
  p.applyLine({ role: 'user', message: { content: [{ type: 'text', text: 'Check Cursor.' }] } });
  p.applyLine({ role: 'assistant', message: { content: [
    { type: 'text', text: 'Checking.' },
    { type: 'tool_use', id: 'tool-1', name: 'Shell', input: { command: 'pwd' } },
  ] } });
  p.applyLine({ role: 'assistant', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }] } });
  assert.deepEqual(p.blocks.map((block) => block.kind), ['user', 'assistant', 'action']);
  assert.equal(p.blocks[2].status, 'ok');
});

test('provider transcript paths match current Codex and Cursor stores', () => {
  // A codex rollout filename carries a launch timestamp before the session id,
  // so no honest exact path exists; discovery scans the dated dirs instead.
  assert.equal(transcriptPathFor({ provider: 'codex', sessionId: 'abc', cwd: '/work/x', home: '/home/test' }), null);

  // These paths are built with path.join, so the SEPARATOR is the host's. The
  // literal posix string this used to assert was therefore a spec that could
  // only ever pass on Linux, and it failed on a Windows runner about code that
  // was behaving correctly. Composing the expectation the same way keeps the
  // parts that carry meaning — the cwd munge, the store's directory names, the
  // doubled session id — asserted, without asserting the platform.
  assert.equal(
    transcriptPathFor({ provider: 'cursor', sessionId: 'abc', cwd: '/work/x', home: '/home/test' }),
    path.join('/home/test', '.cursor', 'projects', 'work-x', 'agent-transcripts', 'abc', 'abc.jsonl'),
  );
  // The munge itself is platform-PURE string work, so a drive-lettered cwd is
  // assertable from either OS. Cursor collapses every RUN of non-alphanumerics
  // to one dash: 'C:\' and '\.', two junk characters each, become ONE '-'.
  // This assertion used to spell the per-character munge ('C--dev-x'), a shape
  // no cursor dir on disk has ever had; the spec itself encoded the bug that
  // kept every Windows cursor row from finding its transcript (2026-08-23).
  assert.equal(
    transcriptPathFor({ provider: 'cursor', sessionId: 'abc', cwd: 'C:\\dev\\x', home: '/home/test' }),
    path.join('/home/test', '.cursor', 'projects', 'C-dev-x', 'agent-transcripts', 'abc', 'abc.jsonl'),
  );
  assert.equal(
    transcriptPathFor({ provider: 'cursor', sessionId: 'abc', cwd: 'C:\\dev\\.orch\\e1-lane', home: '/home/test' }),
    path.join('/home/test', '.cursor', 'projects', 'C-dev-orch-e1-lane', 'agent-transcripts', 'abc', 'abc.jsonl'),
  );
  // Claude's is the deterministic one the window-open path depends on.
  assert.equal(
    transcriptPathFor({ provider: 'claude', sessionId: 'sess', cwd: 'C:\\dev\\harbor', home: '/home/test' }),
    path.join('/home/test', '.claude', 'projects', 'C--dev-harbor', 'sess.jsonl'),
  );
  assert.equal(transcriptPathFor({ provider: 'claude', sessionId: 'sess', cwd: null, home: '/home/test' }), null);
});

function userLine(content, extra = {}) {
  return { type: 'user', message: { role: 'user', content }, timestamp: TS, uuid: 'u1', ...extra };
}

function assistantLine(blocks, extra = {}) {
  const { effort, usage, model, stop_reason, ...rest } = extra;
  return {
    type: 'assistant',
    effort: effort ?? 'high',
    message: {
      model: model || 'claude-opus-4-8',
      role: 'assistant',
      content: blocks,
      usage: usage ?? null,
      stop_reason: stop_reason ?? null,
    },
    timestamp: TS,
    uuid: 'a1',
    ...rest,
  };
}

// Copied from the real 2026-08-04 transcript shapes that exposed fake ready.
// Claude writes this prose record separately from the following tool record.
const REAL_TEXT_TOOL_USE = {
  type: 'assistant',
  uuid: 'f932f553-c585-4e65-90ff-5a24a8b8a5c0',
  parentUuid: '44d9208c-6d5c-405a-aa02-cf7c16a016e2',
  timestamp: '2026-08-04T19:01:24.277Z',
  message: {
    model: 'claude-opus-5',
    role: 'assistant',
    content: [{
      type: 'text',
      text: "Now let me check the sibling egress paths and the two other items' ground truth.",
    }],
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: { input_tokens: 1, cache_creation_input_tokens: 6966, cache_read_input_tokens: 156690, output_tokens: 2384 },
  },
};

const REAL_TEXT_END_TURN = {
  type: 'assistant',
  uuid: '6ee50398-f31e-450e-b9cd-c0a11545c343',
  parentUuid: '8ce689e7-1062-48dc-9aa5-16c2819e566e',
  timestamp: '2026-08-04T19:23:54.182Z',
  message: {
    model: 'claude-opus-5',
    role: 'assistant',
    content: [{ type: 'text', text: 'Both check out. Details follow.' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 2, cache_creation_input_tokens: 1723, cache_read_input_tokens: 254946, output_tokens: 1806 },
  },
};

test('long assistant reports render whole; only pathological blocks clip, visibly', () => {
  // Live-caught 2026-07-20 (Pat: "looks like your message got cut off"): a
  // ~6k-char final report was silently amputated at 4,000 chars with a bare
  // ellipsis. Real prose must never clip; the perf guard applies only to
  // pathological blocks and must SAY it clipped.
  const report = 'All gates green. '.repeat(600); // ~10k chars of real prose
  const p = new TranscriptParser();
  p.applyLine(assistantLine([{ type: 'text', text: report }]));
  const block = p.blocks.find((b) => b.kind === 'assistant');
  assert.ok(block, 'assistant block rendered');
  assert.ok(block.text.includes(report.trim().slice(-80)), 'the END of a long report is present');
  assert.ok(!block.text.includes('…') || report.includes('…'), 'no silent ellipsis amputation');

  const pathological = 'x'.repeat(80_000);
  const p2 = new TranscriptParser();
  p2.applyLine(assistantLine([{ type: 'text', text: pathological }]));
  const clipped = p2.blocks.find((b) => b.kind === 'assistant');
  assert.ok(clipped.text.length < pathological.length, 'pathological block is bounded');
  assert.match(clipped.text, /clipped by Harbor/i, 'a clip announces itself');
});

test('a /model switch moves the header chip the instant the CLI confirms it', () => {
  // Live-caught 2026-07-20 (Pat: "i cant change a session model like at all").
  // A /model command writes NO assistant message; the CLI records it as two
  // user rows: <command-name>/model</command-name> and a <local-command-stdout>
  // "Set model to <NAME>" confirmation. header.model only ever read the last
  // ASSISTANT message's model, so every switch (cap menu, composer, raw
  // terminal) stayed invisible until the next reply and read as "did nothing".
  // The confirmation line is authoritative and path-independent; the chip must
  // follow it.
  const p = new TranscriptParser();
  p.applyLine(assistantLine([{ type: 'text', text: 'working' }], { model: 'claude-opus-4-8' }));
  assert.equal(p.header.model.tone, 'opus', 'starts on the model of the last reply');

  p.applyLine(userLine('<command-name>/model</command-name>\n  <command-args>fable</command-args>'));
  // The real confirmation carries ANSI bold around the name.
  p.applyLine(userLine('<local-command-stdout>Set model to [1mFable 5[22m and saved as your default for new sessions</local-command-stdout>'));
  assert.equal(p.header.model.name, 'Fable 5', 'chip name follows the switch confirmation');
  assert.equal(p.header.model.tone, 'fable', 'chip tint follows the switch confirmation');
  assert.equal(p.header.model.id, 'claude-fable-5', 'a canonical id backs the cap-menu current-row highlight');

  // A later real reply on the new model must not regress the chip.
  p.applyLine(assistantLine([{ type: 'text', text: 'done' }], { model: 'claude-fable-5' }));
  assert.equal(p.header.model.tone, 'fable', 'the reply confirms, not resets');

  // Switching again with no reply in between still tracks reality.
  p.applyLine(userLine('<local-command-stdout>Set model to [1mOpus 4.8[22m</local-command-stdout>'));
  assert.equal(p.header.model.tone, 'opus', 'the most recent switch wins');
});

test('an /effort switch moves the effort badge on its confirmation, not the next reply', () => {
  // Same invisibility as /model: /effort emits no assistant message, only a
  // "Set effort level to <LEVEL> (...)" confirmation (verified 2.1.216).
  const p = new TranscriptParser();
  p.applyLine(assistantLine([{ type: 'text', text: 'working' }], { effort: 'high' }));
  assert.equal(p.header.effort, 'high', 'starts on the effort of the last reply');
  p.applyLine(userLine('<local-command-stdout>Set effort level to xhigh (saved as your default for new sessions): Deeper reasoning</local-command-stdout>'));
  assert.equal(p.header.effort, 'xhigh', 'the effort badge follows the switch confirmation');
});

test('user and assistant image parts become block.images with data URIs', () => {
  const p = new TranscriptParser();
  p.applyLine(userLine([
    { type: 'text', text: 'see screenshot' },
    imagePart(),
  ]));
  p.applyLine(assistantLine([
    { type: 'text', text: 'here is the fix' },
    imagePart('image/jpeg', 'abc123'),
  ], { stop_reason: 'end_turn' }));

  assert.equal(p.blocks.length, 2);
  assert.equal(p.blocks[0].kind, 'user');
  assert.equal(p.blocks[0].text, 'see screenshot');
  assert.deepEqual(p.blocks[0].images, [{ mediaType: 'image/png', dataUri: TINY_PNG_URI }]);
  assert.equal(p.blocks[1].kind, 'assistant');
  assert.equal(p.blocks[1].text, 'here is the fix');
  assert.deepEqual(p.blocks[1].images, [{ mediaType: 'image/jpeg', dataUri: 'data:image/jpeg;base64,abc123' }]);
});

function enqueueLine(content) {
  return { type: 'queue-operation', operation: 'enqueue', content, timestamp: TS, sessionId: 's1' };
}
function queuedCommandLine(prompt, origin = { kind: 'human' }) {
  return {
    type: 'attachment',
    attachment: { type: 'queued_command', prompt, origin },
    timestamp: TS,
    uuid: 'q1',
  };
}

test('a text-only message sent while Claude is busy (enqueue, empty queued_command) renders', () => {
  const p = new TranscriptParser();
  p.applyLine(enqueueLine('i dont mind you using my real chrome'));
  p.applyLine(queuedCommandLine([])); // text-only queued messages carry an empty prompt
  assert.equal(p.blocks.length, 1);
  assert.equal(p.blocks[0].kind, 'user');
  assert.equal(p.blocks[0].text, 'i dont mind you using my real chrome');
  assert.equal(p.blocks[0].queued, true);
  assert.equal(p.blocks[0].images, undefined);
});

test('an image message while busy renders once with its image attached (no dup text)', () => {
  const p = new TranscriptParser();
  p.applyLine(enqueueLine('[Image #6] not a fan of the chip'));
  p.applyLine(queuedCommandLine([{ type: 'text', text: '[Image #6] not a fan of the chip' }, imagePart()]));
  assert.equal(p.blocks.length, 1, 'one block, not duplicated');
  assert.equal(p.blocks[0].text, '[Image #6] not a fan of the chip');
  assert.equal(p.blocks[0].queued, true);
  assert.deepEqual(p.blocks[0].images, [{ mediaType: 'image/png', dataUri: TINY_PNG_URI }]);
});

test('a non-human queued_command image is not rendered', () => {
  const p = new TranscriptParser();
  p.applyLine(queuedCommandLine([imagePart()], { kind: 'system' }));
  assert.equal(p.blocks.length, 0);
});

test('trim never drops user turns to keep images or tool blocks', () => {
  const p = new TranscriptParser();
  // Fill well past the cap with tool/thinking blocks around a user message.
  p.push({ kind: 'user', text: 'keep me', ts: TS });
  for (let i = 0; i < 400; i += 1) p.push({ kind: 'assistant', text: `noise ${i}`, ts: TS });
  const users = p.blocks.filter((b) => b.kind === 'user');
  assert.ok(users.some((b) => b.text === 'keep me'), 'the user turn survived the trim');
});

test('user prompt images stay user-attributed while tool_result images are assistant-attributed', () => {
  const p = new TranscriptParser();
  p.applyLine(userLine([imagePart()]));
  assert.equal(p.blocks.length, 1);
  assert.equal(p.blocks[0].text, '');
  assert.equal(p.blocks[0].images.length, 1);

  const p2 = new TranscriptParser();
  p2.applyLine(assistantLine([{ type: 'tool_use', id: 'tu-img', name: 'Read', input: { file_path: '/x.png' } }]));
  p2.applyLine(userLine([{ type: 'tool_result', tool_use_id: 'tu-img', content: [imagePart('image/png', 'zz')] }]));
  const imgBlock = p2.blocks.find((b) => b.images?.length);
  assert.equal(imgBlock.kind, 'assistant');
  assert.deepEqual(imgBlock.images, [{ mediaType: 'image/png', dataUri: 'data:image/png;base64,zz' }]);
});

test('imageFromPart ignores malformed parts', () => {
  assert.equal(imageFromPart(null), null);
  assert.equal(imageFromPart({ type: 'text', text: 'nope' }), null);
  assert.equal(imageFromPart({ type: 'image', source: { type: 'url', url: 'http://x' } }), null);
  assert.deepEqual(imageFromPart(imagePart()), { mediaType: 'image/png', dataUri: TINY_PNG_URI });
});

test('parses the user -> action -> result -> reply arc', () => {
  const p = new TranscriptParser();
  p.applyLine(userLine('Fix the reconnect banner'));
  p.applyLine(assistantLine([{ type: 'tool_use', id: 'tu1', name: 'Edit', input: { file_path: '/a/b/banner.jsx', old_string: 'x\ny', new_string: 'x\ny\nz' } }]));
  assert.equal(p.header.lastSignal, 'tool-pending');
  const changed = p.applyLine(userLine([{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }]));
  assert.equal(changed.length, 1);
  p.applyLine(assistantLine([{ type: 'text', text: 'Done.' }], { stop_reason: 'end_turn', usage: { input_tokens: 4, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 6_000 } }));

  assert.deepEqual(p.blocks.map((b) => b.kind), ['user', 'action', 'assistant']);
  const action = p.blocks[1];
  assert.equal(action.verb, 'Edited');
  assert.equal(action.chip, 'banner.jsx');
  assert.equal(action.status, 'ok');
  assert.equal(action.pill.text, '+3 −2');
  assert.equal(p.header.lastSignal, 'idle');
  assert.equal(p.header.model.name, 'Opus 4.8');
  assert.equal(p.header.effort, 'high');
  assert.equal(p.header.contextPct, null, 'no learned window: tokens, never a guessed percent');
  assert.equal(p.header.contextTokens, 96_004);
});

test('tool errors mark the action row err with an error pill', () => {
  const p = new TranscriptParser();
  p.applyLine(assistantLine([{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'exit 1' } }]));
  p.applyLine(userLine([{ type: 'tool_result', tool_use_id: 'tu1', content: 'boom', is_error: true }]));
  assert.equal(p.blocks[0].status, 'err');
  assert.equal(p.blocks[0].pill.text, 'error');
});

test('skips sidechains, meta users, caveats, stdout, thinking, and system framing', () => {
  const p = new TranscriptParser();
  p.applyLine(userLine('real prompt', { isSidechain: true }));
  p.applyLine(userLine('meta text', { isMeta: true }));
  p.applyLine(userLine('<local-command-caveat>Caveat: ignore</local-command-caveat>'));
  p.applyLine(userLine('<local-command-stdout>output</local-command-stdout>'));
  p.applyLine(userLine('<system-reminder>recall</system-reminder>'));
  p.applyLine(assistantLine([{ type: 'thinking', thinking: 'hmm', signature: 'x' }]));
  p.applyLine({ type: 'ai-title', title: 'nope' });
  p.applyLine({ type: 'summary', summary: 'nope' });
  assert.equal(p.blocks.length, 0);
});

test('slash-command wrappers render as compact command bubbles', () => {
  const p = new TranscriptParser();
  p.applyLine(userLine('<command-name>/model</command-name><command-message>model</command-message><command-args>opus</command-args>'));
  assert.equal(p.blocks.length, 1);
  assert.equal(p.blocks[0].text, '/model opus');
  assert.equal(p.blocks[0].command, true);
});

test('user turn pending marks working; turn_duration settles it', () => {
  const p = new TranscriptParser();
  p.applyLine(userLine('do the thing'));
  const now = Date.now();
  assert.deepEqual(p.workingState(now, now), { working: true, text: 'Thinking…' });
  // Stale file: never shimmer.
  assert.equal(p.workingState(now - 600_000, now).working, false);
  p.applyLine({ type: 'system', subtype: 'turn_duration', durationMs: 5, timestamp: TS });
  assert.equal(p.workingState(now, now).working, false);
});

test('real text-only tool_use assistant record keeps the turn working', () => {
  const p = new TranscriptParser();
  p.applyLine(REAL_TEXT_TOOL_USE);
  const now = Date.now();
  assert.equal(p.header.lastSignal, 'user-turn');
  assert.deepEqual(p.workingState(now - 600_000, now, true), { working: true, text: 'Thinking…' });
});

test('real text-only end_turn assistant record makes and keeps the turn ready', () => {
  const p = new TranscriptParser();
  p.applyLine(REAL_TEXT_END_TURN);
  const now = Date.now();
  assert.equal(p.header.lastSignal, 'idle');
  assert.deepEqual(p.workingState(now, now, true), { working: false, text: null });
  assert.deepEqual(p.workingState(now - 600_000, now, true), { working: false, text: null });
});

test('stop_sequence is terminal while max_tokens and missing stop reasons stay bounded in flight', () => {
  const terminal = new TranscriptParser();
  terminal.applyLine(assistantLine([{ type: 'text', text: 'stopped' }], { stop_reason: 'stop_sequence' }));
  assert.equal(terminal.header.lastSignal, 'idle');

  const now = Date.now();
  for (const stopReason of ['max_tokens', null]) {
    const p = new TranscriptParser();
    p.applyLine(assistantLine([{ type: 'text', text: 'not terminal' }], { stop_reason: stopReason }));
    assert.equal(p.header.lastSignal, 'user-turn');
    assert.equal(p.workingState(now - 600_000, now, null).working, false);
    assert.equal(p.workingState(now, now, false).working, false);
  }
});

test('stale in-flight turn stays working while its beacon owner is alive', async (t) => {
  const dir = await fsp.mkdtemp(path.join(realTmpDir(), 'harbor-transcript-liveness-'));
  const contextDir = path.join(dir, 'context');
  const file = path.join(dir, 'session.jsonl');
  const sessionId = 'stale-owner-two-sided';
  await fsp.mkdir(contextDir);
  writeLines(file, [userLine('take as long as needed')], 'w');
  const stale = new Date(Date.now() - 600_000);
  await fsp.utimes(file, stale, stale);
  await fsp.writeFile(path.join(contextDir, `${sessionId}.json`), JSON.stringify({
    session_id: sessionId,
    pid: 424242,
  }));

  let ownerAlive = true;
  const provider = createTranscriptProvider({
    contextCacheDir: contextDir,
    getSessionMeta: async () => ({ path: file }),
    readProcessCmdline: () => {
      if (!ownerAlive) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
      return '/home/test/.local/bin/claude\0--resume\0stale-owner-two-sided\0';
    },
    watchFactory: () => ({ on: () => {}, close: () => {} }),
  });
  t.after(async () => {
    provider.closeAll();
    await fsp.rm(dir, { recursive: true, force: true });
  });
  const updates = [];
  provider.emitter.on('update', (update) => updates.push(update));

  await provider.open(sessionId);
  assert.equal(updates.at(-1).header.working, true);
  assert.equal(updates.at(-1).header.processAlive, true);

  ownerAlive = false;
  await provider.refresh(sessionId);
  assert.equal(updates.at(-1).header.working, false);
  assert.equal(updates.at(-1).header.processAlive, false);
});

// 2026-08-21: Pat sent into a session idle for 41 minutes; the CLI wrote his
// message to the transcript instantly, and for the 36 seconds the model spent
// reading a ~470k-token context before its first token the window said
// "ready". On win32 the exact cmdline check is unavailable, liveness fell to
// the statusline beacon, and the beacon repaints only on interactive
// activity, so it was 41 minutes stale while the transcript was seconds
// fresh. A transcript write IS a beacon: the freshest evidence of life
// decides, and only when both are stale is the owner called dead.
test('a fresh transcript write is itself life: a stale beacon cannot mark a mid-answer session dead', async (t) => {
  const dir = await fsp.mkdtemp(path.join(realTmpDir(), 'harbor-transcript-beacon-'));
  const contextDir = path.join(dir, 'context');
  const beaconHome = path.join(dir, 'home');
  const beaconDir = path.join(beaconHome, 'statusline-state');
  const file = path.join(dir, 'session.jsonl');
  const sessionId = 'stale-beacon-fresh-write';
  await fsp.mkdir(contextDir);
  await fsp.mkdir(beaconDir, { recursive: true });
  writeLines(file, [userLine('whats the ICS link?')], 'w');
  const beaconFile = path.join(beaconDir, `${sessionId}.json`);
  await fsp.writeFile(beaconFile, '{}');
  const staleBeacon = new Date(Date.now() - 41 * 60_000);
  await fsp.utimes(beaconFile, staleBeacon, staleBeacon);
  const priorPin = process.env.HARBOR_BEACON_HOMES;
  process.env.HARBOR_BEACON_HOMES = beaconHome;

  const provider = createTranscriptProvider({
    contextCacheDir: contextDir,
    getSessionMeta: async () => ({ path: file }),
    // No readProcessCmdline and no teed pid: liveness must fall to the
    // beacon branch on every platform, the way win32 always does.
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
  assert.equal(updates.at(-1).header.working, true, 'a just-written unanswered prompt must render as working');
  assert.equal(updates.at(-1).header.text, 'Thinking…');
  assert.equal(updates.at(-1).header.processAlive, true);

  // Two-sided: when the transcript goes stale alongside the beacon, the
  // owner is honestly dead and the shimmer must settle.
  const staleFile = new Date(Date.now() - 11 * 60_000);
  await fsp.utimes(file, staleFile, staleFile);
  await provider.refresh(sessionId);
  assert.equal(updates.at(-1).header.working, false, 'a stale transcript beside a stale beacon stays dead');
  assert.equal(updates.at(-1).header.processAlive, false);
});

test('finished turn stays ready even while its beacon owner is alive', () => {
  const p = new TranscriptParser();
  p.applyLine(userLine('finish this'));
  p.applyLine({ type: 'system', subtype: 'turn_duration', durationMs: 5, timestamp: TS });
  const now = Date.now();
  assert.equal(p.workingState(now - 600_000, now, true).working, false);
});

test('stale in-flight turn stops working when its beacon owner is dead', () => {
  const p = new TranscriptParser();
  p.applyLine(userLine('take as long as needed'));
  const now = Date.now();
  assert.equal(p.workingState(now - 600_000, now, false).working, false);
});

test('in-flight turn with no beacon keeps the 180 second recency fallback', () => {
  const p = new TranscriptParser();
  p.applyLine(userLine('fallback only'));
  const now = Date.now();
  assert.equal(p.workingState(now - 30_000, now, null).working, true);
  assert.equal(p.workingState(now - 600_000, now, null).working, false);
});

// The cache chip's facts, captured from the assistant records' own usage:
// the API writes which TTL each cache write used (cache_creation's
// ephemeral_1h/5m breakdown, real bytes verified against Pat's transcript
// 2026-08-21), and every record with cache activity marks the cache
// touched. Nothing here is guessed: no cache fields, no facts, no chip.
test('cache facts ride the header from the session\'s own usage records', () => {
  const p = new TranscriptParser();
  p.applyLine(assistantLine([{ type: 'text', text: 'warm' }], {
    usage: {
      input_tokens: 2,
      cache_read_input_tokens: 462869,
      cache_creation_input_tokens: 304,
      cache_creation: { ephemeral_1h_input_tokens: 304, ephemeral_5m_input_tokens: 0 },
    },
  }));
  assert.equal(p.header.cacheTtlMs, 60 * 60_000);
  assert.equal(p.header.cacheTouchedMs, Date.parse(TS));

  // Overage drops the CLI to the 5-minute tier; the session's own records
  // say so and the chip must follow.
  const later = '2026-08-21T07:00:00.000Z';
  p.applyLine(assistantLine([{ type: 'text', text: 'tier drop' }], {
    timestamp: later,
    usage: {
      input_tokens: 2,
      cache_read_input_tokens: 470000,
      cache_creation_input_tokens: 58,
      cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 58 },
    },
  }));
  assert.equal(p.header.cacheTtlMs, 5 * 60_000);
  assert.equal(p.header.cacheTouchedMs, Date.parse(later));

  // A cache READ with no breakdown (older CLI shape) still refreshes the
  // touch clock and keeps the learned TTL rather than guessing a new one.
  const readOnly = '2026-08-21T07:02:00.000Z';
  p.applyLine(assistantLine([{ type: 'text', text: 'refresh' }], {
    timestamp: readOnly,
    usage: { input_tokens: 2, cache_read_input_tokens: 470058, cache_creation_input_tokens: 0 },
  }));
  assert.equal(p.header.cacheTtlMs, 5 * 60_000);
  assert.equal(p.header.cacheTouchedMs, Date.parse(readOnly));

  // No usage at all (synthetic records) leaves every cache fact alone.
  p.applyLine(assistantLine([{ type: 'text', text: 'no usage' }], { timestamp: '2026-08-21T07:05:00.000Z' }));
  assert.equal(p.header.cacheTouchedMs, Date.parse(readOnly));

  // A session that never reported cache activity carries no facts.
  const bare = new TranscriptParser();
  bare.applyLine(assistantLine([{ type: 'text', text: 'plain' }], { usage: { input_tokens: 9, output_tokens: 3 } }));
  assert.equal(bare.header.cacheTtlMs, null);
  assert.equal(bare.header.cacheTouchedMs, null);
});

test('pending tool names the working text', () => {
  const p = new TranscriptParser();
  p.applyLine(assistantLine([{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }]));
  const now = Date.now();
  const state = p.workingState(now, now);
  assert.equal(state.working, true);
  assert.match(state.text, /Running npm test/);
});

test('block window slides at MAX_BLOCKS without leaking pending tools', () => {
  const p = new TranscriptParser();
  for (let i = 0; i < MAX_BLOCKS + 40; i += 1) {
    p.applyLine(userLine(`prompt ${i}`));
  }
  assert.equal(p.blocks.length, MAX_BLOCKS);
  assert.equal(p.blocks[0].text, 'prompt 40');
});

test('block window retains an early inline image while later text slides', () => {
  const p = new TranscriptParser();
  p.applyLine(userLine([{ type: 'text', text: 'early screenshot' }, imagePart()]));
  for (let i = 0; i < MAX_BLOCKS + 40; i += 1) {
    p.applyLine(userLine(`later prompt ${i}`));
  }

  assert.equal(p.blocks.length, MAX_BLOCKS);
  assert.deepEqual(p.blocks[0].images, [{ mediaType: 'image/png', dataUri: TINY_PNG_URI }]);
  assert.equal(p.blocks.at(-1).text, `later prompt ${MAX_BLOCKS + 39}`);
});

test('modelDisplay and context window mapping', () => {
  assert.equal(modelDisplay('claude-fable-5').name, 'Fable 5');
  assert.equal(modelDisplay('claude-sonnet-5').tone, 'sonnet');
  assert.equal(modelDisplay('claude-haiku-4-5-20251001').name, 'Haiku 4.5');
  assert.equal(modelDisplay('claude-next-9000').name, 'Next 9000');
});

test('action mapping covers the everyday tools', () => {
  assert.equal(actionForToolUse({ name: 'Read', input: { file_path: '/x/y.md' } }).verb, 'Read');
  assert.equal(actionForToolUse({ name: 'Grep', input: { pattern: 'foo' } }).chip, 'foo');
  assert.equal(actionForToolUse({ name: 'Write', input: { file_path: '/x/a.js', content: 'l1\nl2' } }).pill.text, '2 lines');
  const mcp = actionForToolUse({ name: 'mcp__example-ops__teams_send_dm', input: {} });
  assert.equal(mcp.verb, 'Teams Send Dm');
  assert.equal(mcp.cv, 'example-ops');
  assert.equal(actionForToolUse({ name: 'TodoWrite', input: {} }).verb, 'Updated todos');
});

test('userTextFor strips reminders but keeps the human text around them', () => {
  const mixed = userTextFor('do it\n<system-reminder>noise</system-reminder>');
  assert.equal(mixed.text, 'do it');
  assert.equal(userTextFor('[Request interrupted by user]').text, 'Interrupted');
});

test('LineBuffer holds partial trailing lines across feeds', () => {
  const lb = new LineBuffer();
  assert.deepEqual(lb.feed('{"a":1}\n{"b"'), ['{"a":1}']);
  assert.deepEqual(lb.feed(':2}\n'), ['{"b":2}']);
  assert.equal(lb.rest, '');
});

// ---- provider tailing against a real temp file ----

function writeLines(file, objs, flag = 'a') {
  fs.writeFileSync(file, objs.map((o) => JSON.stringify(o)).join('\n') + '\n', { flag });
}

async function waitFor(fn, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 40));
  }
  return false;
}

test('provider emits replace on open, appends on live writes, resolves results in place', async () => {
  const dir = await fsp.mkdtemp(path.join(realTmpDir(), 'harbor-transcript-'));
  const file = path.join(dir, 'session.jsonl');
  writeLines(file, [userLine('first prompt')], 'w');

  const provider = createTranscriptProvider({
    getSessionMeta: async () => ({ path: file }),
  });
  const updates = [];
  provider.emitter.on('update', (u) => updates.push(u));

  const res = await provider.open('sess-1');
  assert.equal(res.ok, true);
  assert.equal(updates.length >= 1, true);
  const first = updates[0];
  assert.equal(first.replace.length, 1);
  assert.equal(first.replace[0].text, 'first prompt');
  assert.equal(first.header.working, true); // fresh file, user turn pending

  writeLines(file, [
    assistantLine([{ type: 'tool_use', id: 'tu9', name: 'Bash', input: { command: 'ls' } }]),
  ]);
  assert.equal(await waitFor(() => updates.some((u) => u.append?.some((b) => b.kind === 'action'))), true,
    'tool_use append never arrived');

  writeLines(file, [userLine([{ type: 'tool_result', tool_use_id: 'tu9', content: 'ok' }])]);
  assert.equal(await waitFor(() => updates.some((u) => u.changed?.some((b) => b.status === 'ok'))), true,
    'in-place result resolution never arrived');

  provider.close('sess-1');
  provider.closeAll();
  await fsp.rm(dir, { recursive: true, force: true });
});

test('provider opens before the transcript exists and picks it up on creation', async () => {
  const dir = await fsp.mkdtemp(path.join(realTmpDir(), 'harbor-transcript-'));
  const file = path.join(dir, 'fresh.jsonl');
  const provider = createTranscriptProvider({
    getSessionMeta: async () => ({ path: file }),
  });
  const updates = [];
  provider.emitter.on('update', (u) => updates.push(u));
  const res = await provider.open('sess-2');
  assert.equal(res.ok, true);
  assert.equal(updates[0].replace.length, 0);

  writeLines(file, [userLine('born just now')], 'w');
  assert.equal(await waitFor(() => updates.some((u) => (u.append || u.replace || []).some((b) => b.text === 'born just now'))), true,
    'newborn transcript content never arrived');
  provider.closeAll();
  await fsp.rm(dir, { recursive: true, force: true });
});

test('refcounted open/close', async () => {
  const dir = await fsp.mkdtemp(path.join(realTmpDir(), 'harbor-transcript-'));
  const file = path.join(dir, 's.jsonl');
  writeLines(file, [userLine('x')], 'w');
  const provider = createTranscriptProvider({ getSessionMeta: async () => ({ path: file }) });
  await provider.open('s');
  await provider.open('s');
  provider.close('s');
  assert.equal(provider.openCount(), 1);
  provider.close('s');
  assert.equal(provider.openCount(), 0);
  provider.closeAll();
  await fsp.rm(dir, { recursive: true, force: true });
});

test('provider survives the MAX_BLOCKS window sliding mid-tail without losing rows', async () => {
  const dir = await fsp.mkdtemp(path.join(realTmpDir(), 'harbor-transcript-'));
  const file = path.join(dir, 'long.jsonl');
  const many = [];
  for (let i = 0; i < MAX_BLOCKS + 5; i += 1) many.push(userLine(`p${i}`));
  writeLines(file, many, 'w');
  const provider = createTranscriptProvider({ getSessionMeta: async () => ({ path: file }) });
  const updates = [];
  provider.emitter.on('update', (u) => updates.push(u));
  await provider.open('long');
  assert.equal(updates[0].replace.length, MAX_BLOCKS);

  writeLines(file, [userLine('the-straw')]);
  assert.equal(await waitFor(() => updates.slice(1).some((u) =>
    (u.replace || []).concat(u.append || []).some((b) => b.text === 'the-straw'))), true,
    'append across the sliding window was lost');
  provider.closeAll();
  await fsp.rm(dir, { recursive: true, force: true });
});

test('a large live append yields while parsing so the main loop keeps ticking', async (t) => {
  const dir = await fsp.mkdtemp(path.join(realTmpDir(), 'harbor-transcript-stall-'));
  const file = path.join(dir, 'large-live.jsonl');
  await fsp.writeFile(file, '');
  const provider = createTranscriptProvider({
    getSessionMeta: async () => ({ path: file }),
    contextCacheDir: path.join(dir, 'context'),
    watchFactory: () => ({ on: () => {}, close: () => {} }),
  });
  t.after(async () => {
    provider.closeAll();
    await fsp.rm(dir, { recursive: true, force: true });
  });
  await provider.open('large-live');

  let lastTick = Date.now();
  let maxGapMs = 0;
  let ticks = 0;
  const timer = setInterval(() => {
    const now = Date.now();
    maxGapMs = Math.max(maxGapMs, now - lastTick);
    lastTick = now;
    ticks += 1;
  }, 10);
  const markerSeen = new Promise((resolve) => {
    provider.emitter.on('update', (update) => {
      const blocks = [...(update.replace || []), ...(update.append || [])];
      if (blocks.some((block) => block.text === 'large-append-marker')) resolve();
    });
  });
  const row = `${JSON.stringify(userLine('small payload'))}\n`;
  const bytes = row.repeat(Math.ceil((8 * 1024 * 1024) / row.length))
    + `${JSON.stringify(userLine('large-append-marker'))}\n`;

  await fsp.appendFile(file, bytes);
  await provider.refresh('large-live');
  await markerSeen;
  clearInterval(timer);

  assert.ok(ticks >= 10, `parser starved the event loop; only ${ticks} timer ticks landed`);
  assert.ok(maxGapMs < 100, `parser blocked the event loop for ${maxGapMs}ms`);
});

test('provider recovers an image before the initial tail window without parsing old text', async () => {
  const dir = await fsp.mkdtemp(path.join(realTmpDir(), 'harbor-transcript-'));
  const file = path.join(dir, 'large-with-image.jsonl');
  writeLines(file, [userLine([{ type: 'text', text: 'old screenshot' }, imagePart()])], 'w');
  writeLines(file, [userLine('very-old-sentinel')]);
  const padding = `${JSON.stringify(userLine('old text'))}\n`.repeat(45_000);
  fs.appendFileSync(file, padding);
  writeLines(file, [userLine('recent tail')]);

  const provider = createTranscriptProvider({ getSessionMeta: async () => ({ path: file }) });
  const updates = [];
  provider.emitter.on('update', (u) => updates.push(u));
  await provider.open('large-with-image');

  const initial = updates[0].replace;
  assert.equal(initial.some((block) => block.images?.[0]?.dataUri === TINY_PNG_URI), true);
  assert.equal(initial.some((block) => block.text === 'recent tail'), true);
  assert.equal(initial.some((block) => block.text === 'very-old-sentinel'), false);

  writeLines(file, [userLine('new live tail')]);
  assert.equal(await waitFor(() => updates.slice(1).some((update) =>
    update.replace?.some((block) => block.text === 'new live tail'))), true,
  'image-preserving non-front trim must replace the renderer window');
  provider.closeAll();
  await fsp.rm(dir, { recursive: true, force: true });
});

test('synthetic model stamps never take the model chip', () => {
  const p = new TranscriptParser();
  p.applyLine(assistantLine([{ type: 'text', text: 'real' }], { model: 'claude-haiku-4-5-20251001' }));
  p.applyLine(assistantLine([{ type: 'text', text: 'No response requested.' }], { model: '<synthetic>' }));
  assert.equal(p.header.model.name, 'Haiku 4.5');
});

test('harness-injected user events never render or drive the shimmer', () => {
  const p = new TranscriptParser();
  p.applyLine(assistantLine([{ type: 'text', text: 'done.' }], { stop_reason: 'end_turn' }));
  p.applyLine(userLine('[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event.\n<task-notification>\n<task-id>abc</task-id>\n<status>completed</status>\n</task-notification>'));
  p.applyLine(userLine('<task-notification><task-id>xyz</task-id></task-notification>'));
  assert.deepEqual(p.blocks.map((b) => b.kind), ['assistant']);
  assert.equal(p.header.lastSignal, 'idle'); // notifications never fake a user turn
  const now = Date.now();
  assert.equal(p.workingState(now, now).working, false);
});

test('auto-compact continuation renders as a note, not a user bubble, and settles', () => {
  const p = new TranscriptParser();
  p.applyLine(userLine('real prompt'));
  p.applyLine(userLine('This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion.'));
  assert.deepEqual(p.blocks.map((b) => b.kind), ['user', 'note']);
  assert.match(p.blocks[1].text, /compacted/);
  assert.equal(p.header.lastSignal, 'idle');
  // The explicit flag works too, whatever the text says.
  const p2 = new TranscriptParser();
  p2.applyLine(userLine('summary text', { isCompactSummary: true }));
  assert.deepEqual(p2.blocks.map((b) => b.kind), ['note']);
});

test('local command stdout settles the shimmer (a finished /model must not "think")', () => {
  const p = new TranscriptParser();
  p.applyLine(userLine('<command-name>/model</command-name><command-args>haiku</command-args>'));
  assert.equal(p.header.lastSignal, 'user-turn');
  p.applyLine(userLine('<local-command-stdout>Set model to Haiku 4.5</local-command-stdout>'));
  assert.equal(p.header.lastSignal, 'idle');
  const now = Date.now();
  assert.equal(p.workingState(now, now).working, false);
});

// ---- 1M context window ratchet ----
// Replicates the REAL failure shape from d0a348c9-59b5-4095-a6f5-188306e2e54d:
//   model=claude-opus-4-8 (no [1m] suffix in transcript), pre-compact usage
//   peaked at 461028 tokens (>200k), compact_boundary preTokens=461512, then
//   post-compact usage dropped to 173063. Without the ratchet Harbor showed
//   173063/200000 = 87%; truth is 173063/1000000 = 17%.

test('the parser never fabricates a percentage: no learned window means tokens only', () => {
  // Five live incidents in four days came from dividing real tokens by a
  // GUESSED window (200k family default, or an assumed 1M). The invariant:
  // Harbor never invents a denominator. Without a window learned from
  // Claude's own math, any token count on any model id yields tokens, not %.
  const p = new TranscriptParser();
  p.applyLine(assistantLine([], {
    model: 'claude-opus-4-8',
    usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 100_000 },
    stop_reason: 'end_turn',
  }));
  assert.equal(p.header.contextPct, null, '100k of an unknown window is not a percentage');
  assert.equal(p.header.contextTokens, 100_000);
  p.applyLine(assistantLine([], {
    model: 'claude-fable-5',
    usage: { input_tokens: 4, cache_creation_input_tokens: 10_000, cache_read_input_tokens: 451_024 },
    stop_reason: 'end_turn',
  }));
  assert.equal(p.header.contextPct, null, '461k proves the window exceeds 461k, not that it is 1M');
  assert.equal(p.header.contextTokens, 461_028);
});

test('a learned window prices every usage line, through compaction', () => {
  // The 2026-07-19 incident shape: 1M session compacts, post-compact usage
  // drops to 173k; the old guesswork showed 87% (of 200k). With the window
  // learned from the tee, the gauge follows Claude's own arithmetic.
  const p = new TranscriptParser();
  p.setLearnedWindow(1_000_000);
  p.applyLine(userLine('This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion.'));
  p.applyLine(assistantLine([], {
    model: 'claude-opus-4-8',
    usage: { input_tokens: 1, cache_creation_input_tokens: 943, cache_read_input_tokens: 172_119 },
    stop_reason: 'end_turn',
  }));
  assert.equal(p.header.contextPct, 17, `expected 17, got ${p.header.contextPct}`);
});

test('provider: tee file used_percentage overrides parser contextPct when fresh', async () => {
  const dir = await fsp.mkdtemp(path.join(realTmpDir(), 'harbor-ctx-tee-'));
  const file = path.join(dir, 'session.jsonl');
  const ctxDir = path.join(dir, 'ctx');
  await fsp.mkdir(ctxDir);
  const sessionId = 'tee-sess-1';

  // Write a transcript with a low-usage assistant line (would compute 87%).
  writeLines(file, [
    assistantLine([], {
      model: 'claude-opus-4-8',
      usage: { input_tokens: 1, cache_creation_input_tokens: 943, cache_read_input_tokens: 172119 },
      stop_reason: 'end_turn',
    }),
  ], 'w');

  // Write a tee file with the authoritative 17%.
  const teeFile = path.join(ctxDir, `${sessionId}.json`);
  await fsp.writeFile(teeFile, JSON.stringify({
    session_id: sessionId, model_id: 'claude-opus-4-8[1m]', used_percentage: 17, ts: new Date().toISOString(),
  }));

  const provider = createTranscriptProvider({
    getSessionMeta: async () => ({ path: file }),
    contextCacheDir: ctxDir,
  });
  const updates = [];
  provider.emitter.on('update', (u) => updates.push(u));
  await provider.open(sessionId);

  // The tee value (17) must win over the parser value (87).
  const header = updates[updates.length - 1]?.header;
  assert.ok(header, 'no update emitted');
  assert.equal(header.contextPct, 17, `expected tee pct 17, got ${header.contextPct}`);

  provider.closeAll();
  await fsp.rm(dir, { recursive: true, force: true });
});

test('provider: recent tee beats a transcript that streams past it mid-turn', async (t) => {
  // Live-caught 2026-07-20 (Pat: "fake context # showing for various windows"):
  // an actively WORKING session writes its transcript every few seconds while
  // the statusline tee only refreshes on statusline re-renders, so the
  // "transcript grew past the tee" staleness rule voided the tee for every
  // mid-turn glance. A young 1M session under 200k tokens then fell to the L2
  // ratchet's 200k denominator: real 20% rendered as 99%.
  const dir = await fsp.mkdtemp(path.join(realTmpDir(), 'harbor-ctx-race-'));
  const file = path.join(dir, 'session.jsonl');
  const ctxDir = path.join(dir, 'ctx');
  await fsp.mkdir(ctxDir);
  const sessionId = 'tee-sess-midturn';

  writeLines(file, [
    assistantLine([], {
      model: 'claude-opus-4-8',
      usage: { input_tokens: 1, cache_creation_input_tokens: 943, cache_read_input_tokens: 197_000 },
      stop_reason: 'end_turn',
    }),
  ], 'w');

  const teeFile = path.join(ctxDir, `${sessionId}.json`);
  await fsp.writeFile(teeFile, JSON.stringify({
    session_id: sessionId, model_id: 'claude-opus-4-8', used_percentage: 20, ts: new Date().toISOString(),
  }));
  // Tee rendered a minute ago; the transcript streamed since (mtime now).
  const teeMs = Date.now() - 60 * 1000;
  await fsp.utimes(teeFile, new Date(teeMs), new Date(teeMs));
  const nowMs = Date.now();
  await fsp.utimes(file, new Date(nowMs), new Date(nowMs));

  const provider = createTranscriptProvider({
    getSessionMeta: async () => ({ path: file }),
    contextCacheDir: ctxDir,
  });
  t.after(async () => {
    provider.closeAll();
    await fsp.rm(dir, { recursive: true, force: true });
  });
  const updates = [];
  provider.emitter.on('update', (u) => updates.push(u));
  await provider.open(sessionId);

  const header = updates[updates.length - 1]?.header;
  assert.ok(header, 'no update emitted');
  assert.equal(header.contextPct, 20, `expected the recent tee pct 20, got ${header.contextPct}`);
});

test('provider: old tee matching an idle transcript still overrides parser contextPct', async (t) => {
  const dir = await fsp.mkdtemp(path.join(realTmpDir(), 'harbor-ctx-idle-'));
  const file = path.join(dir, 'session.jsonl');
  const ctxDir = path.join(dir, 'ctx');
  await fsp.mkdir(ctxDir);
  const sessionId = 'tee-sess-idle';

  writeLines(file, [
    assistantLine([], {
      model: 'claude-opus-4-8',
      usage: { input_tokens: 1, cache_creation_input_tokens: 943, cache_read_input_tokens: 199_000 },
      stop_reason: 'end_turn',
    }),
  ], 'w');

  const teeFile = path.join(ctxDir, `${sessionId}.json`);
  await fsp.writeFile(teeFile, JSON.stringify({
    session_id: sessionId, used_percentage: 20, ts: 'old',
  }));
  const idleMs = Date.now() - 60 * 60 * 1000;
  await fsp.utimes(file, new Date(idleMs), new Date(idleMs));
  await fsp.utimes(teeFile, new Date(idleMs), new Date(idleMs));

  const provider = createTranscriptProvider({
    getSessionMeta: async () => ({ path: file }),
    contextCacheDir: ctxDir,
  });
  t.after(async () => {
    provider.closeAll();
    await fsp.rm(dir, { recursive: true, force: true });
  });
  const updates = [];
  provider.emitter.on('update', (u) => updates.push(u));
  await provider.open(sessionId);

  const header = updates[updates.length - 1]?.header;
  assert.ok(header, 'no update emitted');
  assert.equal(header.contextPct, 20, `expected idle tee pct 20, got ${header.contextPct}`);
});

test('provider: tee older than a grown transcript shows honest tokens, never a guessed percent', async (t) => {
  // The 2026-07-21 incident shape generalized: with the tee outgrown and no
  // learned window, the old code divided by a guessed denominator (151k of a
  // 1M fable session rendered as 76% of 200k). The invariant: no learned
  // window, no percent; the chip carries the token count instead.
  const dir = await fsp.mkdtemp(path.join(realTmpDir(), 'harbor-ctx-stale-'));
  const file = path.join(dir, 'session.jsonl');
  const ctxDir = path.join(dir, 'ctx');
  await fsp.mkdir(ctxDir);
  const sessionId = 'tee-sess-2';

  writeLines(file, [
    assistantLine([], {
      model: 'claude-fable-5',
      usage: { input_tokens: 2, cache_creation_input_tokens: 1_423, cache_read_input_tokens: 149_981 },
      stop_reason: 'end_turn',
    }),
  ], 'w');

  // The transcript grew after this tee, so its percentage is genuinely stale.
  const teeFile = path.join(ctxDir, `${sessionId}.json`);
  await fsp.writeFile(teeFile, JSON.stringify({ session_id: sessionId, used_percentage: 15, ts: 'old' }));
  const teeMs = Date.now() - 3 * 60 * 60 * 1000;
  const transcriptMs = Date.now();
  await fsp.utimes(teeFile, new Date(teeMs), new Date(teeMs));
  await fsp.utimes(file, new Date(transcriptMs), new Date(transcriptMs));

  const provider = createTranscriptProvider({
    getSessionMeta: async () => ({ path: file }),
    contextCacheDir: ctxDir,
  });
  t.after(async () => {
    provider.closeAll();
    await fsp.rm(dir, { recursive: true, force: true });
  });
  const updates = [];
  provider.emitter.on('update', (u) => updates.push(u));
  await provider.open(sessionId);

  const header = updates[updates.length - 1]?.header;
  assert.ok(header, 'no update emitted');
  assert.equal(header.contextPct, null, `no learned window must mean no percent, got ${header.contextPct}`);
  assert.equal(header.contextTokens, 151_406, 'the honest token count rides the header');
});

test('provider: a pairable tee TEACHES the window; the learned file prices later fallbacks', async (t) => {
  // The structural core: pct = tokens/window is Claude's own arithmetic, so a
  // pairable tee plus the tokens it describes yields the window numerically,
  // persisted to <session>.learned.json. Later outgrown-tee reads divide by
  // the LEARNED window, for any model id, with no table anywhere.
  const dir = await fsp.mkdtemp(path.join(realTmpDir(), 'harbor-ctx-learn-'));
  const file = path.join(dir, 'session.jsonl');
  const ctxDir = path.join(dir, 'ctx');
  await fsp.mkdir(ctxDir);
  const sessionId = 'tee-sess-learn';

  writeLines(file, [
    assistantLine([], {
      model: 'claude-zephyr-9',
      usage: { input_tokens: 2, cache_creation_input_tokens: 1_000, cache_read_input_tokens: 149_000 },
      stop_reason: 'end_turn',
    }),
  ], 'w');
  const teeFile = path.join(ctxDir, `${sessionId}.json`);
  await fsp.writeFile(teeFile, JSON.stringify({
    session_id: sessionId, model_id: 'claude-zephyr-9', used_percentage: 15, ts: new Date().toISOString(),
  }));

  const provider = createTranscriptProvider({
    getSessionMeta: async () => ({ path: file }),
    contextCacheDir: ctxDir,
  });
  t.after(async () => {
    provider.closeAll();
    await fsp.rm(dir, { recursive: true, force: true });
  });
  const updates = [];
  provider.emitter.on('update', (u) => updates.push(u));
  await provider.open(sessionId);
  assert.equal(updates[updates.length - 1]?.header?.contextPct, 15, 'fresh tee is authoritative');

  const learnedFile = path.join(ctxDir, `${sessionId}.learned.json`);
  // The provider persists this WITHOUT open() awaiting it, so reading straight
  // after open was a race: it passed whenever the file happened to land first
  // and failed under the concurrency of a full-file run (6ms in, ENOENT). Wait
  // for the condition instead of for luck.
  assert.equal(await waitFor(() => fs.existsSync(learnedFile)), true,
    'the learned window was never persisted');
  const learned = JSON.parse(await fsp.readFile(learnedFile, 'utf8'));
  assert.ok(learned.window_tokens > 900_000 && learned.window_tokens < 1_100_000,
    `learned window should be about 1M, got ${learned.window_tokens}`);

  // The tee goes stale and the transcript grows past it: the learned window
  // keeps the gauge honest (16, not 80 of a guessed 200k).
  const teeMs = Date.now() - 20 * 60 * 1000;
  await fsp.utimes(teeFile, new Date(teeMs), new Date(teeMs));
  writeLines(file, [
    assistantLine([], {
      model: 'claude-zephyr-9',
      usage: { input_tokens: 2, cache_creation_input_tokens: 1_000, cache_read_input_tokens: 159_000 },
      stop_reason: 'end_turn',
    }),
  ]);
  const nowMs = Date.now();
  await fsp.utimes(file, new Date(nowMs), new Date(nowMs));
  const deadline = Date.now() + 8000;
  let latest = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    latest = updates[updates.length - 1]?.header;
    if (latest && latest.contextPct !== 15) break;
  }
  assert.equal(latest?.contextPct, 16, `expected 16 of the learned window, got ${latest?.contextPct}`);
});

test('provider: the learned window survives a restart (cold open, outgrown tee)', async (t) => {
  const dir = await fsp.mkdtemp(path.join(realTmpDir(), 'harbor-ctx-restart-'));
  const file = path.join(dir, 'session.jsonl');
  const ctxDir = path.join(dir, 'ctx');
  await fsp.mkdir(ctxDir);
  const sessionId = 'tee-sess-restart';

  writeLines(file, [
    assistantLine([], {
      model: 'claude-zephyr-9',
      usage: { input_tokens: 2, cache_creation_input_tokens: 1_000, cache_read_input_tokens: 159_000 },
      stop_reason: 'end_turn',
    }),
  ], 'w');
  const teeFile = path.join(ctxDir, `${sessionId}.json`);
  await fsp.writeFile(teeFile, JSON.stringify({ session_id: sessionId, used_percentage: 15, ts: 'old' }));
  await fsp.writeFile(path.join(ctxDir, `${sessionId}.learned.json`), JSON.stringify({
    window_tokens: 1_000_000, at_tokens: 150_002, used_percentage: 15, ts: new Date().toISOString(),
  }));
  const teeMs = Date.now() - 3 * 60 * 60 * 1000;
  await fsp.utimes(teeFile, new Date(teeMs), new Date(teeMs));
  const nowMs = Date.now();
  await fsp.utimes(file, new Date(nowMs), new Date(nowMs));

  const provider = createTranscriptProvider({
    getSessionMeta: async () => ({ path: file }),
    contextCacheDir: ctxDir,
  });
  t.after(async () => {
    provider.closeAll();
    await fsp.rm(dir, { recursive: true, force: true });
  });
  const updates = [];
  provider.emitter.on('update', (u) => updates.push(u));
  await provider.open(sessionId);

  const header = updates[updates.length - 1]?.header;
  assert.equal(header?.contextPct, 16, `expected 16 from the persisted window, got ${header?.contextPct}`);
});

test('provider: absurd tee math never learns a window', async (t) => {
  // pct 15 against 3 tokens implies a 20-token window: nonsense stays out of
  // the learned file (clamped to a sane [50k, 5M] range).
  const dir = await fsp.mkdtemp(path.join(realTmpDir(), 'harbor-ctx-clamp-'));
  const file = path.join(dir, 'session.jsonl');
  const ctxDir = path.join(dir, 'ctx');
  await fsp.mkdir(ctxDir);
  const sessionId = 'tee-sess-clamp';

  writeLines(file, [
    assistantLine([], {
      model: 'claude-zephyr-9',
      usage: { input_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      stop_reason: 'end_turn',
    }),
  ], 'w');
  await fsp.writeFile(path.join(ctxDir, `${sessionId}.json`), JSON.stringify({
    session_id: sessionId, used_percentage: 15, ts: new Date().toISOString(),
  }));

  const provider = createTranscriptProvider({
    getSessionMeta: async () => ({ path: file }),
    contextCacheDir: ctxDir,
  });
  t.after(async () => {
    provider.closeAll();
    await fsp.rm(dir, { recursive: true, force: true });
  });
  const updates = [];
  provider.emitter.on('update', (u) => updates.push(u));
  await provider.open(sessionId);

  await assert.rejects(
    () => fsp.access(path.join(ctxDir, `${sessionId}.learned.json`)),
    'no learned file for nonsense math',
  );
});


test('CLI warning system events render as visible notes, never silently vanish', () => {
  // Byte-shape from the live 2026-07-24 incident: /dml-gold-sweep typed into a
  // window produced ONLY these system events, and the window stayed blank.
  const p = new TranscriptParser();
  p.applyLine({
    type: 'system', subtype: 'informational', level: 'warning',
    content: 'Unknown command: /dml-gold-sweep', timestamp: '2026-07-25T02:20:09.198Z',
  });
  p.applyLine({
    type: 'system', subtype: 'informational', level: 'warning',
    content: 'Args from unknown skill: 25', timestamp: '2026-07-25T02:20:09.198Z',
  });
  // Informational chatter without a warning level still stays quiet.
  p.applyLine({ type: 'system', subtype: 'informational', level: 'info', content: 'noise' });
  const notes = p.blocks.filter((b) => b.kind === 'note');
  assert.deepEqual(notes.map((n) => [n.tone, n.text]), [
    ['warn', 'Unknown command: /dml-gold-sweep'],
    ['warn', 'Args from unknown skill: 25'],
  ]);
});

// The parser used to also keep the live AskUserQuestion for the in-window
// question card. It does not any more, and the tests for it moved with the
// behaviour to test/main/pending-ask.test.js: a value derived from this tail is
// only as current as the last read that landed, which is exactly how the card
// failed Pat on 2026-07-27. The card reads the transcript FILE on demand now.

// Live-caught twice on 2026-07-28, and it is why two of Pat's new sessions
// rendered nothing: findProviderTranscript handled cursor and codex and let
// CLAUDE fall straight through to `return null`. The only way a claude window
// ever found its transcript was `meta.path` from the harbor index, so a session
// younger than the index opened to "No transcript yet" and stayed there. The
// second time, the session was already 190 lines deep and plainly on disk.
test('a claude transcript is found from the cwd, without the index', async () => {
  const home = fs.mkdtempSync(path.join(realTmpDir(), 'harbor-find-'));
  const dir = path.join(home, '.claude', 'projects', '-home-you-dev-Innovation');
  fs.mkdirSync(dir, { recursive: true });
  const id = '12156af1-ce71-40bd-86e1-ffd34f646874';
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), '');
  assert.equal(
    await findProviderTranscript({ provider: 'claude', sessionId: id, cwd: '/home/you/dev/Innovation', home }),
    path.join(dir, `${id}.jsonl`),
  );
});

test('and found without a cwd either, because a session id is unique', async () => {
  // A window whose id has just been adopted from the daemon has no cwd yet.
  const home = fs.mkdtempSync(path.join(realTmpDir(), 'harbor-find-'));
  const dir = path.join(home, '.claude', 'projects', '-home-you-dev-Innovation');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(home, '.claude', 'projects', '-home-you-dev-other'), { recursive: true });
  const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), '');
  assert.equal(
    await findProviderTranscript({ provider: 'claude', sessionId: id, cwd: null, home }),
    path.join(dir, `${id}.jsonl`),
  );
});

test('a session with no transcript on disk is still honestly null', async () => {
  // A brand-new session writes its transcript on the FIRST message; before that
  // there is nothing to find, and inventing a path would be worse than saying
  // so. The renderer retries instead.
  const home = fs.mkdtempSync(path.join(realTmpDir(), 'harbor-find-'));
  fs.mkdirSync(path.join(home, '.claude', 'projects', '-p'), { recursive: true });
  assert.equal(
    await findProviderTranscript({ provider: 'claude', sessionId: 'not-written-yet', cwd: '/p', home }),
    null,
  );
});

// Pat, 2026-08-13: "my first messages in each session are getting lost."
// Reproduced as it actually happens: he opens a session by pasting screenshots,
// a pasted image rides in the JSONL as base64, and the resulting FIRST user
// line is bigger than the whole MAX_INITIAL_BYTES window the tile parses. On
// the real transcript he reported, that line was 1,109,121 bytes against a
// 1,048,576-byte window, so it fit in neither direction: too big for the tail,
// and cut in half by the prefix image scan, whose JSON.parse then threw.
test('the opening prompt survives being larger than the whole parse window', async (t) => {
  const dir = await fsp.mkdtemp(path.join(realTmpDir(), 'harbor-transcript-opening-'));
  const file = path.join(dir, 'huge-first.jsonl');
  // One image part carrying ~1.2MB of base64, the way a pasted screenshot does.
  const fatImage = imagePart('image/png', 'A'.repeat(1_200_000));
  writeLines(file, [
    userLine([{ type: 'text', text: 'THE-OPENING-ASK' }, fatImage]),
    assistantLine([{ type: 'text', text: 'answering the opening ask' }]),
  ], 'w');
  // Then enough ordinary traffic that the tail window starts well past it.
  const filler = [];
  for (let i = 0; i < 40; i += 1) {
    filler.push(userLine(`filler-${i} ${'x'.repeat(20_000)}`));
    filler.push(assistantLine([{ type: 'text', text: `reply-${i}` }]));
  }
  writeLines(file, filler);
  const size = fs.statSync(file).size;
  assert.ok(size > 1024 * 1024, `fixture must exceed the window, got ${size}`);

  const provider = createTranscriptProvider({ getSessionMeta: async () => ({ path: file }) });
  // Teardown registered BEFORE the assertions: a provider left open holds a
  // watcher and an interval, so a failing assertion would hang the runner
  // instead of reporting the failure.
  t.after(async () => {
    provider.closeAll();
    await fsp.rm(dir, { recursive: true, force: true });
  });
  const updates = [];
  provider.emitter.on('update', (u) => updates.push(u));
  await provider.open('huge-first');

  const blocks = updates[0].replace || [];
  const opening = blocks.filter((b) => b.kind === 'user' && String(b.text || '').includes('THE-OPENING-ASK'));
  assert.equal(opening.length, 1, 'the first message must render exactly once, never zero and never twice');
  assert.equal(blocks[0].kind, 'user', 'the opening prompt belongs at the top of the tile');
  assert.ok(String(blocks[0].text).includes('THE-OPENING-ASK'));
  // The tail is still what it was: the newest rows are present.
  assert.ok(blocks.some((b) => String(b.text || '').includes('reply-39')), 'the live tail must be unaffected');
});

test('a transcript under the window keeps exactly one copy of its opening prompt', async (t) => {
  // The seeder must not double-push a small first message, which IS reachable
  // by the prefix image scan.
  const dir = await fsp.mkdtemp(path.join(realTmpDir(), 'harbor-transcript-opening-small-'));
  const file = path.join(dir, 'small.jsonl');
  writeLines(file, [
    userLine([{ type: 'text', text: 'SMALL-OPENING' }, imagePart()]),
    assistantLine([{ type: 'text', text: 'ok' }]),
  ], 'w');
  const provider = createTranscriptProvider({ getSessionMeta: async () => ({ path: file }) });
  t.after(async () => {
    provider.closeAll();
    await fsp.rm(dir, { recursive: true, force: true });
  });
  const updates = [];
  provider.emitter.on('update', (u) => updates.push(u));
  await provider.open('small');
  const blocks = updates[0].replace || [];
  assert.equal(
    blocks.filter((b) => String(b.text || '').includes('SMALL-OPENING')).length,
    1,
    'no duplicate opening block',
  );
});
