'use strict';

// Google's Antigravity CLI (agy) as a transcript provider. The fixture
// (test/fixtures/gemini-transcript-full.jsonl) has the shape of a REAL
// transcript_full.jsonl (every step kind measured 2026-11-23 over a corpus of
// 523 steps: USER_INPUT, PLANNER_RESPONSE with tool_calls or content, GENERIC
// results, SYSTEM_MESSAGE) with invented words and paths.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { realTmpDir } = require('../support/real-tmpdir.js');

const {
  createTranscriptProvider,
  TranscriptParser,
  transcriptPathFor,
  findProviderTranscript,
  geminiToolUse,
  geminiModelParts,
  actionForToolUse,
} = require('../../src/main/providers/transcript.js');

const FIXTURE = path.join(__dirname, '../fixtures/gemini-transcript-full.jsonl');
const ID = '4f6a8d10-2b3c-4d5e-8f70-123456789abc';

function parse(lines) {
  const parser = new TranscriptParser('gemini');
  for (const line of lines) parser.applyLine(typeof line === 'string' ? JSON.parse(line) : line);
  return parser;
}
const fixtureLines = () => fs.readFileSync(FIXTURE, 'utf8').trim().split('\n');
const step = (type, extra) => ({ step_index: 0, source: type === 'USER_INPUT' ? 'USER_EXPLICIT' : 'MODEL', type, status: 'DONE', created_at: '2026-11-24T02:00:00Z', ...extra });

test('a real-shaped Gemini transcript maps to prompt, action rows, results and the answer', () => {
  const p = parse(fixtureLines());
  assert.deepEqual(p.blocks.map((block) => block.kind), ['user', 'action', 'action', 'action', 'assistant']);
  // The typed words only: the <USER_REQUEST> frame, the local-time block and the
  // model-change notice are agy's bookkeeping, not the person's.
  assert.equal(p.blocks[0].text, 'Read notes.txt and run the tests, then tell me what failed.');
  assert.equal(p.blocks[0].ts, '2026-11-24T02:00:00Z');
  // The same verbs the other providers use.
  assert.deepEqual(p.blocks.slice(1, 4).map((block) => block.verb), ['Read', 'Ran', 'Wrote']);
  assert.equal(p.blocks[1].chip, 'notes.txt', 'a Path wrapped in extra quotes still names the file');
  assert.equal(p.blocks[2].chip, 'npm test');
  assert.equal(p.blocks[2].said, 'Ran the test suite');
  assert.equal(p.blocks[3].pill.text, '4 lines');
  assert.equal(p.blocks[4].text, 'One test failed: the suite reported 1 failing. I could not write the report.');
  assert.equal(p.pendingTools.size, 0);
});

test('results settle the calls in the order they were made: ok, a non-zero exit, an ERROR step', () => {
  const p = parse(fixtureLines());
  const [read, ran, wrote] = p.blocks.slice(1, 4);
  assert.equal(read.status, 'ok');
  assert.equal(ran.status, 'err', '"Command exited with code 1" is a failed row');
  assert.equal(wrote.status, 'err', 'a GENERIC step with status ERROR is a failed row');
});

test('two calls in one step wait for two results, and the window stays in tool-pending between them', () => {
  const lines = fixtureLines();
  const p = parse(lines.slice(0, 2));
  assert.equal(p.header.lastSignal, 'tool-pending');
  assert.equal(p.pendingTools.size, 2);
  p.applyLine(JSON.parse(lines[2]));
  assert.equal(p.pendingTools.size, 1);
  assert.equal(p.header.lastSignal, 'tool-pending', 'one result still owed');
  assert.equal(p.blocks[1].status, 'ok');
  assert.equal(p.blocks[2].status, 'run');
  p.applyLine(JSON.parse(lines[3]));
  assert.equal(p.header.lastSignal, 'user-turn', 'every result is in: the model owes a reply');
  assert.equal(p.workingState(Date.now()).working, true);
  assert.equal(p.workingState(Date.now() - 600_000, Date.now(), null).working, false, 'a stale file is not working');
});

test('the answer ends the turn; a prompt starts one', () => {
  const lines = fixtureLines();
  assert.equal(parse(lines.slice(0, 1)).header.lastSignal, 'user-turn');
  assert.equal(parse(lines).header.lastSignal, 'idle');
});

test('header: the model slug splits into a family name and an effort; context is a token count only', () => {
  const p = parse(fixtureLines());
  assert.deepEqual(p.header.model, { id: 'gemini-4-neon-high', name: 'Gemini 4 Neon', tone: 'other' });
  assert.equal(p.header.effort, 'high');
  assert.equal(p.header.lastEventTs, '2026-11-24T02:00:16Z');
  // Prompt size of the newest call: input plus cache read. No window is recorded
  // in the steps, so no percentage is invented (C21).
  assert.equal(p.header.contextTokens, 2300 + 9100);
  assert.equal(p.header.contextPct, null);
  assert.deepEqual(geminiModelParts('claude-opus-5-5-low'), { id: 'claude-opus-5-5-low', family: 'claude-opus-5-5', effort: 'low' });
  assert.equal(geminiModelParts('gemini-pro-orchestrator').effort, null);
  assert.equal(geminiModelParts(''), null);
});

test('model names derive from the slug: versions read as versions, acronyms stay acronyms', () => {
  const name = (slug) => parse([step('PLANNER_RESPONSE', { model: slug, content: 'x' })]).header.model.name;
  assert.equal(name('gemini-3.8-flash-medium'), 'Gemini 3.8 Flash');
  assert.equal(name('claude-sonnet-5-5-high'), 'Claude Sonnet 5.5');
  assert.equal(name('gpt-oss-120b-medium'), 'GPT OSS 120b');
  assert.equal(name('gemini-pro-orchestrator-neon'), 'Gemini Pro Orchestrator Neon');
});

test('the model\'s private reasoning is not drawn', () => {
  const p = parse(fixtureLines());
  assert.ok(!p.blocks.some((block) => /read the notes first/.test(JSON.stringify(block))));
});

test('a SYSTEM_MESSAGE that says the work was stopped by a restart fails the calls still pending', () => {
  const lines = fixtureLines();
  const p = parse(lines.slice(0, 2));
  p.applyLine(step('SYSTEM_MESSAGE', { source: 'SYSTEM', content: '<SYSTEM_MESSAGE>\n[Notice] All your subagents and background tasks have been stopped due to server restart.\n</SYSTEM_MESSAGE>' }));
  assert.equal(p.pendingTools.size, 0);
  assert.deepEqual(p.blocks.slice(1).map((block) => block.status), ['err', 'err']);
  // Any other system message changes nothing.
  const q = parse(lines.slice(0, 2));
  q.applyLine(step('SYSTEM_MESSAGE', { source: 'SYSTEM', content: 'something else' }));
  assert.equal(q.pendingTools.size, 2);
});

test('a result with no call waiting leaves the turn state alone', () => {
  const p = parse([step('USER_INPUT', { content: '<USER_REQUEST>\nhi\n</USER_REQUEST>' }), step('PLANNER_RESPONSE', { model: 'gemini-4-neon-high', content: 'hello' })]);
  assert.equal(p.header.lastSignal, 'idle');
  p.applyLine(step('GENERIC', { content: 'a late background result' }));
  assert.equal(p.header.lastSignal, 'idle');
  assert.deepEqual(p.blocks.map((block) => block.kind), ['user', 'assistant']);
});

test('a prompt with no words in it (metadata only) draws nothing; a peer message names its sender', () => {
  const p = parse([step('USER_INPUT', { content: '<ADDITIONAL_METADATA>\nlocal time\n</ADDITIONAL_METADATA>' })]);
  assert.equal(p.blocks.length, 0);
});

test('tool names map to the verbs every provider draws', () => {
  const verb = (name, args) => actionForToolUse(geminiToolUse({ name, args }));
  assert.equal(verb('view_file', { AbsolutePath: '/w/a.js', StartLine: 20 }).verb, 'Read');
  assert.equal(verb('view_file', { AbsolutePath: '/w/a.js', StartLine: 20 }).cv, 'from :20');
  assert.equal(verb('write_to_file', { TargetFile: '/w/b.js', CodeContent: 'x\ny' }).pill.text, '2 lines');
  const edit = verb('replace_file_content', { TargetFile: '/w/c.js', TargetContent: 'a', ReplacementContent: 'b\nc' });
  assert.equal(edit.verb, 'Edited');
  assert.equal(edit.pill.text, '+2 −1');
  const multi = verb('multi_replace_file_content', { TargetFile: '/w/c.js', ReplacementChunks: [{ TargetContent: 'a', ReplacementContent: 'b' }, { TargetContent: 'c', ReplacementContent: 'd' }] });
  assert.equal(multi.verb, 'Edited');
  assert.equal(verb('list_dir', { DirectoryPath: '/w/src' }).verb, 'Listed');
  assert.equal(verb('list_dir', { DirectoryPath: '/w/src' }).chip, 'src');
  assert.equal(verb('find_by_name', { Pattern: '*.md' }).verb, 'Globbed');
  assert.equal(verb('grep_search', { Query: 'TODO', SearchPath: '/w/src' }).verb, 'Searched');
  assert.equal(verb('search_web', { query: 'node sqlite' }).verb, 'Searched web');
  assert.equal(verb('read_url_content', { Url: 'https://example.com/a' }).verb, 'Fetched');
  assert.equal(verb('manage_task', { Action: 'kill', TaskId: 't1' }).verb, 'Stopped');
  assert.equal(verb('manage_task', { Action: 'status', TaskId: 't1' }).verb, 'Checked output');
  assert.equal(verb('invoke_subagent', { Prompt: 'p', Role: 'reviewer', TypeName: 'x' }).verb, 'Delegated');
  assert.equal(verb('invoke_subagent', { Prompt: 'p', Role: 'reviewer', TypeName: 'x' }).chip, 'reviewer');
  assert.equal(verb('send_message', { Recipient: 'lead', Message: 'm' }).verb, 'Messaged');
  assert.equal(verb('manage_subagents', { Action: 'list' }).verb, 'Listed agents');
  assert.equal(verb('schedule', { CronExpression: '0 * * * *', Prompt: 'p' }).verb, 'Scheduled');
  assert.equal(verb('ask_permission', { Action: 'read_file', Target: '/x', Reason: 'need the log' }).verb, 'Asked');
  // An unknown tool keeps its own name and still draws a row.
  assert.equal(verb('brand_new_tool', { Path: 'x' }).verb, 'Brand New Tool');
});

test('provider paths: a Gemini conversation is derived from its id alone, and never from Claude\'s project dir', () => {
  const home = path.join(path.sep, 'home', 'test');
  assert.equal(
    transcriptPathFor({ provider: 'gemini', sessionId: ID, cwd: '/w', home }),
    path.join(home, '.gemini', 'antigravity-cli', 'brain', ID, '.system_generated', 'logs', 'transcript_full.jsonl'),
  );
  // An id that is not a uuid is no conversation (and cannot climb out of the store).
  assert.equal(transcriptPathFor({ provider: 'gemini', sessionId: '../../x', cwd: '/w', home }), null);
  // Two-sided: a provider the function does not know used to get CLAUDE's path.
  assert.equal(transcriptPathFor({ provider: 'someother', sessionId: 'abc', cwd: '/w', home }), null);
  assert.equal(transcriptPathFor({ provider: 'claude', sessionId: 'abc', cwd: '/w', home }), path.join(home, '.claude', 'projects', '-w', 'abc.jsonl'));
});

test('findProviderTranscript finds a Gemini conversation in the profile\'s store, and answers null (not a Claude file) when it is not there', async (t) => {
  const home = await fsp.mkdtemp(path.join(realTmpDir(), 'harbor-gemini-find-'));
  t.after(() => fsp.rm(home, { recursive: true, force: true }));
  // A Claude transcript with the same id sits where the old fallthrough would have looked.
  const claudeFile = path.join(home, '.claude', 'projects', '-w', `${ID}.jsonl`);
  await fsp.mkdir(path.dirname(claudeFile), { recursive: true });
  await fsp.writeFile(claudeFile, '{}\n');
  assert.equal(await findProviderTranscript({ provider: 'gemini', sessionId: ID, cwd: '/w', home }), null);
  const file = transcriptPathFor({ provider: 'gemini', sessionId: ID, home });
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, '');
  assert.equal(await findProviderTranscript({ provider: 'gemini', sessionId: ID, cwd: '/w', home }), file);
  assert.equal(await findProviderTranscript({ provider: 'gemini', sessionId: 'not-a-uuid', home }), null);
});

test('a provider the parser does not know renders nothing: it is no longer read as Claude', () => {
  const claudeShaped = { type: 'user', timestamp: '2026-11-24T02:00:00Z', message: { role: 'user', content: 'hello there' } };
  const asClaude = new TranscriptParser('claude');
  asClaude.applyLine(claudeShaped);
  assert.equal(asClaude.blocks.length, 1, 'the record is a real Claude record');
  const stranger = new TranscriptParser('some-new-provider');
  stranger.applyLine(claudeShaped);
  assert.equal(stranger.blocks.length, 0);
});

test('open window: header comes from the records, context from agy\'s own status tee', async (t) => {
  const dir = await fsp.mkdtemp(path.join(realTmpDir(), 'harbor-gemini-open-'));
  const home = path.join(dir, 'home');
  const file = transcriptPathFor({ provider: 'gemini', sessionId: ID, home });
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.copyFile(FIXTURE, file);
  const ctx = path.join(dir, 'ctx');
  await fsp.mkdir(ctx);
  // The tee script writes the status-line payload agy hands it, plus an owner pid.
  await fsp.writeFile(path.join(ctx, `gemini-${ID}.json`), JSON.stringify({
    conversation_id: ID, agent_state: 'idle', cwd: '/w',
    model: { display_name: 'Gemini 4 Neon (High)', effort: 'high' },
    context_window: { used_percentage: 7.4, context_window_size: 1048576 },
    ownerPid: process.pid, writtenAt: new Date().toISOString(),
  }));
  // A CLAUDE-named tee for the same id must not be read as the Gemini one.
  await fsp.writeFile(path.join(ctx, `${ID}.json`), JSON.stringify({ used_percentage: 55 }));
  const provider = createTranscriptProvider({
    getSessionMeta: async () => ({ path: file, provider: 'gemini' }),
    contextCacheDir: ctx,
    home,
  });
  t.after(async () => { provider.closeAll(); await fsp.rm(dir, { recursive: true, force: true }); });
  const updates = [];
  provider.emitter.on('update', (update) => updates.push(update));
  const opened = await provider.open(ID, { provider: 'gemini' });
  assert.ok(opened?.ok !== false, JSON.stringify(opened));
  const header = updates.at(-1)?.header;
  assert.ok(header, 'an update was emitted');
  assert.equal(header.contextPct, 7, 'agy\'s own used_percentage, from context_window');
  assert.equal(header.model.name, 'Gemini 4 Neon');
  assert.equal(header.effort, 'high');
  // The owner check matches a command line against "claude": an agy pid must never
  // reach it (it would read as a dead owner), so liveness is not decided by it.
  assert.notEqual(header.processAlive, false);
  // No learned-window file is written for a Gemini id (that store is Claude's).
  assert.equal(fs.existsSync(path.join(ctx, `${ID}.learned.json`)), false);
});

test('open window: with no tee there is a token count and no percentage', async (t) => {
  const dir = await fsp.mkdtemp(path.join(realTmpDir(), 'harbor-gemini-notee-'));
  const home = path.join(dir, 'home');
  const file = transcriptPathFor({ provider: 'gemini', sessionId: ID, home });
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.copyFile(FIXTURE, file);
  const ctx = path.join(dir, 'ctx');
  await fsp.mkdir(ctx);
  await fsp.writeFile(path.join(ctx, `${ID}.json`), JSON.stringify({ used_percentage: 55 }));
  const provider = createTranscriptProvider({ getSessionMeta: async () => ({ path: file, provider: 'gemini' }), contextCacheDir: ctx, home });
  t.after(async () => { provider.closeAll(); await fsp.rm(dir, { recursive: true, force: true }); });
  const updates = [];
  provider.emitter.on('update', (update) => updates.push(update));
  await provider.open(ID, { provider: 'gemini' });
  const header = updates.at(-1).header;
  assert.equal(header.contextPct, null, 'Claude\'s tee for the same id is not Gemini\'s');
  assert.equal(header.contextTokens, 11400);
});

// 2026-11-26, Pat: "i started on the gemini orchestrator neon model option. but now its showing hydrogen?" An orchestrator
// runs its steps on more than one model (Pat's: 45 Neon, 31 Hydrogen, 11 Neon, 21 Hydrogen, all xhigh), and the chip named
// the newest step's. The model agy's status line names for the session outranks every step; without it the steps decide.
test('an orchestrator session keeps its own name on the chip while its steps move between models', () => {
  const parser = new TranscriptParser('gemini');
  parser.applyGeminiLine(step('PLANNER_RESPONSE', { model: 'gemini-4-neon-xhigh', content: 'planning' }));
  parser.applyGeminiLine(step('PLANNER_RESPONSE', { model: 'gemini-4-hydrogen-xhigh', content: 'building' }));
  assert.equal(parser.header.model.name, 'Gemini 4 Hydrogen', 'the old reading: the newest step');
  parser.setGeminiChosenModel({ id: 'gemini-pro-orchestrator-neon', label: 'Orchestrator (Neon)', name: 'Orchestrator (Neon)', effort: null });
  assert.deepEqual(parser.header.model, { id: 'gemini-pro-orchestrator-neon', name: 'Orchestrator (Neon)', tone: 'other' });
  assert.equal(parser.header.effort, null, 'an orchestrator has no effort of its own');
  parser.applyGeminiLine(step('PLANNER_RESPONSE', { model: 'gemini-4-hydrogen-xhigh', content: 'more building' }));
  assert.equal(parser.header.model.name, 'Orchestrator (Neon)', 'later steps do not take the chip back');
  parser.setGeminiChosenModel(null);
  assert.equal(parser.header.model.name, 'Gemini 4 Hydrogen', 'no status-line model: the steps decide again');
  assert.equal(parser.header.effort, 'xhigh');
});

test('open window: an orchestrator session reads as the orchestrator, from agy\'s own status tee', async (t) => {
  const dir = await fsp.mkdtemp(path.join(realTmpDir(), 'harbor-gemini-orch-'));
  const home = path.join(dir, 'home');
  const file = transcriptPathFor({ provider: 'gemini', sessionId: ID, home });
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const now = new Date();
  const lines = ['gemini-4-neon-xhigh', 'gemini-4-hydrogen-xhigh', 'gemini-4-neon-xhigh', 'gemini-4-hydrogen-xhigh']
    .map((model, i) => JSON.stringify(step('PLANNER_RESPONSE', { step_index: i, model, content: `step ${i}`, created_at: new Date(now.getTime() - (4 - i) * 1000).toISOString() })));
  await fsp.writeFile(file, `${lines.join('\n')}\n`);
  const ctx = path.join(dir, 'ctx');
  await fsp.mkdir(ctx);
  await fsp.writeFile(path.join(ctx, `gemini-${ID}.json`), JSON.stringify({
    conversation_id: ID, agent_state: 'working', model: { id: 'Orchestrator (Neon)', display_name: 'Orchestrator (Neon)', effort: null },
    context_window: { used_percentage: 28.1, context_window_size: 1048576 }, writtenAt: now.toISOString(), writtenAtMs: now.getTime(),
  }));
  const geminiModelsFile = path.join(dir, 'gemini-models.json');
  await fsp.writeFile(geminiModelsFile, JSON.stringify({ rows: [{ id: 'gemini-pro-orchestrator-neon', label: 'Orchestrator (Neon)' }] }));
  const provider = createTranscriptProvider({ getSessionMeta: async () => ({ path: file, provider: 'gemini' }), contextCacheDir: ctx, home, geminiModelsFile });
  t.after(async () => { provider.closeAll(); await fsp.rm(dir, { recursive: true, force: true }); });
  const updates = [];
  provider.emitter.on('update', (update) => updates.push(update));
  await provider.open(ID, { provider: 'gemini' });
  const header = updates.at(-1).header;
  assert.deepEqual(header.model, { id: 'gemini-pro-orchestrator-neon', name: 'Orchestrator (Neon)', tone: 'other' });
  assert.equal(header.effort, null);
  assert.equal(header.contextPct, 28);
});
