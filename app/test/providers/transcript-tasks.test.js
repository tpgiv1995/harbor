'use strict';

// The task checklist (2026-10-19): Claude Code's TaskCreate / TaskUpdate (and
// the legacy TodoWrite) draw ONE `tasks` block per turn instead of an action
// row per call. Fixture shapes mirror real Claude Code transcripts:
// TaskCreate's id is assigned in its RESULT record's toolUseResult.task.id,
// and TaskUpdate names the task by that id.

const test = require('node:test');
const assert = require('node:assert/strict');
const { TranscriptParser } = require('../../src/main/providers/transcript.js');

let clock = Date.parse('2026-10-19T15:00:00.000Z');
const ts = () => new Date((clock += 1000)).toISOString();
const user = (text) => ({ type: 'user', timestamp: ts(), promptId: `p-${text}`, message: { role: 'user', content: text } });
const use = (id, name, input) => ({ type: 'assistant', timestamp: ts(), message: { id: `m-${id}`, role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
const result = (id, text, toolUseResult, extra = {}) => ({
  type: 'user', timestamp: ts(), toolUseResult,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text, ...extra }] },
});
const create = (id, subject, activeForm) => use(id, 'TaskCreate', activeForm ? { subject, description: subject, activeForm } : { subject, description: subject });
const created = (id, taskId, subject) => result(id, `Task #${taskId} created successfully: ${subject}`, { task: { id: taskId, subject } });
const update = (id, taskId, status, more = {}) => use(id, 'TaskUpdate', { taskId, status, ...more });
// An update is applied when its result lands (and only if it worked), so a
// fixture pairs each call with the result Claude Code writes for it.
const updated = (id, taskId, fields = ['status']) => result(id, `Updated task #${taskId} ${fields.join(', ')}`, { success: true, taskId, updatedFields: fields });
const upd = (id, taskId, status, more) => [update(id, taskId, status, more), updated(id, taskId)];

function run(lines) {
  const p = new TranscriptParser('claude');
  const changed = [];
  for (const line of lines) changed.push(...p.applyLine(line));
  return { p, changed };
}
const cards = (p) => p.blocks.filter((b) => b.kind === 'tasks');
const states = (card) => card.tasks.map((t) => `${t.id}:${t.subject}:${t.status}`);

test('TaskCreate takes its id from the result and starts pending', () => {
  const { p } = run([user('go'), create('c1', 'Read the parser', 'Reading the parser'), created('c1', '1', 'Read the parser')]);
  const [card] = cards(p);
  assert.deepEqual(card.tasks, [{ id: '1', subject: 'Read the parser', activeForm: 'Reading the parser', status: 'pending' }]);
});

test('TaskUpdate moves a task through in_progress to completed, and deleted removes it', () => {
  const { p } = run([
    user('go'),
    create('c1', 'A'), created('c1', '1', 'A'),
    create('c2', 'B'), created('c2', '2', 'B'),
    create('c3', 'C'), created('c3', '3', 'C'),
    update('u1', '1', 'in_progress'), result('u1', 'Updated task #1 status', { success: true }),
    ...upd('u2', '1', 'completed'),
    ...upd('u3', '2', 'in_progress', { activeForm: 'Doing B' }),
    ...upd('u4', '3', 'deleted'),
  ]);
  const all = cards(p);
  assert.equal(all.length, 1, 'one card per turn, updated in place');
  assert.deepEqual(states(all[0]), ['1:A:completed', '2:B:in_progress']);
  assert.equal(all[0].tasks[1].activeForm, 'Doing B');
});

test('a result id that differs from the provisional one is reconciled, out of order too', () => {
  // A tail that began mid-session: the parser has seen no earlier task, so
  // its provisional ids are 1 and 2, but the session's real ids are 5 and 6,
  // and the second create's result lands first.
  const { p } = run([
    user('go'),
    create('c5', 'Five'), create('c6', 'Six'),
    created('c6', '6', 'Six'),
    created('c5', '5', 'Five'),
    ...upd('u1', '6', 'completed'),
    ...upd('u2', '5', 'in_progress'),
  ]);
  assert.deepEqual(states(cards(p)[0]), ['5:Five:in_progress', '6:Six:completed']);
});

test('a provisional id that collides with a real one is swapped, never duplicated', () => {
  // The first create's result says #2 while the second (still provisional)
  // holds 2; it gives way until its own result lands.
  const { p } = run([user('go'), create('a', 'A'), create('b', 'B'), created('a', '2', 'A')]);
  assert.deepEqual(states(cards(p)[0]), ['2:A:pending', '1:B:pending']);
  const ids = cards(p)[0].tasks.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('the id falls back to the result text when the record carries no toolUseResult', () => {
  const { p } = run([user('go'), create('c1', 'A'), result('c1', 'Task #7 created successfully: A', undefined), ...upd('u', '7', 'completed')]);
  assert.deepEqual(states(cards(p)[0]), ['7:A:completed']);
});

test('a failed TaskCreate drops its task', () => {
  const { p } = run([user('go'), create('c1', 'A'), result('c1', 'boom', undefined, { is_error: true })]);
  assert.deepEqual(cards(p)[0].tasks, []);
});

test('TodoWrite replaces the whole list each call', () => {
  const todos = (list) => use(`t${list.length}${list[0]?.status}`, 'TodoWrite', { todos: list });
  const { p } = run([
    user('go'),
    todos([{ content: 'A', status: 'pending', activeForm: 'Doing A' }, { content: 'B', status: 'pending', activeForm: 'Doing B' }]),
    todos([{ content: 'A', status: 'completed', activeForm: 'Doing A' }, { content: 'C', status: 'in_progress', activeForm: 'Doing C' }]),
  ]);
  const all = cards(p);
  assert.equal(all.length, 1);
  assert.deepEqual(all[0].tasks.map((t) => `${t.subject}:${t.status}`), ['A:completed', 'C:in_progress']);
  assert.equal(all[0].tasks[1].activeForm, 'Doing C');
});

test('a new turn gets its own card carrying the list over; the earlier card keeps its snapshot', () => {
  const { p } = run([
    user('first'),
    create('c1', 'A'), created('c1', '1', 'A'),
    create('c2', 'B'), created('c2', '2', 'B'),
    ...upd('u1', '1', 'in_progress'),
    user('second'),
    ...upd('u2', '1', 'completed'),
    ...upd('u3', '2', 'in_progress'),
  ]);
  const [first, second] = cards(p);
  assert.ok(first && second, 'two turns, two cards');
  assert.deepEqual(states(first), ['1:A:in_progress', '2:B:pending']);
  assert.deepEqual(states(second), ['1:A:completed', '2:B:in_progress']);
  assert.deepEqual(p.blocks.map((b) => b.kind), ['user', 'tasks', 'user', 'tasks']);
});

test('the card sits where the turn first used a task tool, and later calls update it in place', () => {
  const { p, changed } = run([
    user('go'),
    use('r1', 'Read', { file_path: '/a/x.js' }), result('r1', 'ok'),
    create('c1', 'A'), created('c1', '1', 'A'),
    use('r2', 'Read', { file_path: '/a/y.js' }), result('r2', 'ok'),
    ...upd('u1', '1', 'completed'),
  ]);
  assert.deepEqual(p.blocks.map((b) => b.kind), ['user', 'action', 'tasks', 'action']);
  const card = cards(p)[0];
  assert.ok(changed.includes(card.key), 'the in-place update is reported as changed');
  assert.equal(card.tasks[0].status, 'completed');
});

test('task list tools never render as action rows; TaskStop and TaskOutput still do', () => {
  const { p } = run([
    user('go'),
    create('c1', 'A'), created('c1', '1', 'A'),
    update('u1', '1', 'in_progress'),
    use('l1', 'TaskList', {}), use('g1', 'TaskGet', { taskId: '1' }),
    use('t1', 'TodoWrite', { todos: [{ content: 'A', status: 'pending' }] }),
    use('s1', 'TaskStop', { task_id: 'bash_1' }), result('s1', 'stopped'),
    use('o1', 'TaskOutput', { task_id: 'bash_1' }),
  ]);
  const actions = p.blocks.filter((b) => b.kind === 'action');
  assert.deepEqual(actions.map((b) => b.verb), ['TaskStop', 'TaskOutput']);
  assert.equal(actions[0].status, 'ok', 'TaskStop still resolves from its result');
  assert.equal(cards(p).length, 1);
});

test('an update for a task no seed reached is added when it names a subject, else keeps its old action row', () => {
  const { p } = run([user('go'), ...upd('u1', '4', 'in_progress'), ...upd('u2', '9', 'completed', { subject: 'Known by name' })]);
  assert.deepEqual(states(cards(p)[0]), ['9:Known by name:completed']);
  const rows = p.blocks.filter((b) => b.kind === 'action');
  assert.deepEqual(rows.map((b) => [b.verb, b.status]), [['TaskUpdate', 'ok']], 'the unknown task is not silently dropped');
});

// ---- the list before a large transcript's tail, and results that decide ----

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  createTranscriptProvider, readArchiveBlocksBeforeOffset, readPrefixTaskSeed, readTaskDirSeed,
  taskScanStats, MAX_INITIAL_BYTES,
} = require('../../src/main/providers/transcript.js');

const CONTEXT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-tasks-context-'));
const jsonl = (lines) => lines.map((l) => `${JSON.stringify(l)}\n`).join('');
// Padding that draws no blocks at all, so the tail holds only what a test puts there.
const padding = (bytes) => {
  const row = `${JSON.stringify({ type: 'system', subtype: 'informational', timestamp: '2026-10-19T15:00:00.000Z', filler: 'x'.repeat(900) })}\n`;
  return row.repeat(Math.ceil(bytes / Buffer.byteLength(row)));
};

// <tmp>/<home>/projects/<project>/<sessionId>.jsonl, the layout Claude Code
// writes, so the task store sits where it would: <home>/tasks/<sessionId>/.
async function sessionFile(sessionId, body, tasks = null) {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'harbor-tasks-home-'));
  const dir = path.join(home, 'projects', '-repo');
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  await fsp.writeFile(file, body);
  if (tasks) {
    const taskDir = path.join(home, 'tasks', sessionId);
    await fsp.mkdir(taskDir, { recursive: true });
    await fsp.writeFile(path.join(taskDir, '.lock'), '');
    for (const t of tasks) await fsp.writeFile(path.join(taskDir, `${t.id}.json`), JSON.stringify({ blocks: [], blockedBy: [], ...t }, null, 2));
  }
  return { home, file };
}

async function openOnce(file, sessionId, hints = {}) {
  const provider = createTranscriptProvider({ contextCacheDir: CONTEXT_DIR, getSessionMeta: async () => ({ path: file }) });
  const updates = [];
  provider.emitter.on('update', (u) => updates.push(u));
  await provider.open(sessionId, hints);
  provider.closeAll();
  return updates[0].replace;
}

// Four creates before the 1 MB tail window, two updates inside it. The
// whole-file parse is the truth the tail must match.
const HEAD = () => [
  user('plan it'),
  ...[1, 2, 3, 4].flatMap((i) => [create(`c${i}`, `Step ${i}`, `Doing step ${i}`), created(`c${i}`, String(i), `Step ${i}`)]),
];
const TAIL = () => [
  user('keep going'),
  ...upd('u2', '2', 'in_progress'),
  ...upd('u1', '1', 'completed'),
];

test('a tail that starts after the creates is seeded from the prefix and shows the right statuses', async () => {
  const sessionId = '11111111-0000-4000-8000-000000000001';
  const whole = run([...HEAD(), ...TAIL()]).p;
  const truth = states(cards(whole).at(-1));
  assert.deepEqual(truth, ['1:Step 1:completed', '2:Step 2:in_progress', '3:Step 3:pending', '4:Step 4:pending']);

  const { home, file } = await sessionFile(sessionId, jsonl(HEAD()) + padding(MAX_INITIAL_BYTES + 50_000) + jsonl(TAIL()));
  const scansBefore = taskScanStats().scans;
  const blocks = await openOnce(file, sessionId);
  const card = blocks.filter((b) => b.kind === 'tasks').at(-1);
  assert.ok(card, 'the checklist shows in a session over 1 MB');
  assert.deepEqual(states(card), truth);
  assert.equal(card.tasks[1].activeForm, 'Doing step 2', 'what the prefix knew rides along');
  assert.equal(taskScanStats().scans, scansBefore + 1, 'no task store on disk: the prefix was scanned');
  // The phone's windowed open is seeded the same way.
  const phone = await openOnce(file, sessionId, { window: { blocks: 5 } });
  assert.deepEqual(states(phone.filter((b) => b.kind === 'tasks').at(-1)), truth);
  await fsp.rm(home, { recursive: true, force: true });
});

test('the task store on disk seeds first: current statuses, a subagent\'s update, internal tasks hidden', async () => {
  const sessionId = '11111111-0000-4000-8000-000000000002';
  const disk = [
    { id: '1', subject: 'Step 1', activeForm: 'Doing step 1', status: 'completed' },
    { id: '2', subject: 'Step 2', activeForm: 'Doing step 2', status: 'in_progress' },
    { id: '3', subject: 'Step 3', activeForm: 'Doing step 3', status: 'completed' }, // a subagent finished it
    { id: '4', subject: 'Step 4', status: 'pending' },
    { id: '10', subject: 'Internal bookkeeping', status: 'pending', metadata: { _internal: true } },
  ];
  const { home, file } = await sessionFile(sessionId, jsonl(HEAD()) + padding(MAX_INITIAL_BYTES + 50_000) + jsonl(TAIL()), disk);
  const seed = await readTaskDirSeed(file, sessionId);
  assert.deepEqual(seed.tasks.map((t) => t.id), ['1', '2', '3', '4']);
  assert.equal(seed.taskSeq, 4);
  const scansBefore = taskScanStats().scans;
  const blocks = await openOnce(file, sessionId);
  assert.deepEqual(states(blocks.filter((b) => b.kind === 'tasks').at(-1)), ['1:Step 1:completed', '2:Step 2:in_progress', '3:Step 3:completed', '4:Step 4:pending']);
  assert.equal(taskScanStats().scans, scansBefore, 'the store answered; the prefix was not scanned');
  await fsp.rm(home, { recursive: true, force: true });
});

test('a seeded task the tail creates again is the same task, and leaves earlier cards', () => {
  // The store is the CURRENT list; the tail still holds task 3's create.
  const p = new TranscriptParser('claude');
  p.seedTasks({ tasks: [{ id: '1', subject: 'A', status: 'completed' }, { id: '2', subject: 'B', status: 'completed' }, { id: '3', subject: 'C', status: 'in_progress' }], taskSeq: 3, calls: [] });
  for (const line of [
    user('one'), ...upd('u1', '2', 'in_progress'),
    user('two'), create('c3', 'C', 'Doing C'), created('c3', '3', 'C'), ...upd('u3', '3', 'in_progress'),
  ]) p.applyLine(line);
  const [first, second] = cards(p);
  assert.deepEqual(states(first), ['1:A:completed', '2:B:in_progress'], 'task 3 did not exist yet at the first card');
  assert.deepEqual(states(second), ['1:A:completed', '2:B:in_progress', '3:C:in_progress'], 'no duplicate task 3');
  assert.equal(second.tasks[2].activeForm, 'Doing C');
});

test('a create whose result lands after the cut still takes its real id', async () => {
  const sessionId = '11111111-0000-4000-8000-000000000003';
  // The create's tool_use is in the prefix; its result opens the tail.
  const head = [user('plan'), create('c1', 'A'), created('c1', '1', 'A'), create('c2', 'B')];
  const tail = [created('c2', '7', 'B'), user('next'), ...upd('u7', '7', 'completed')];
  const { home, file } = await sessionFile(sessionId, jsonl(head) + padding(MAX_INITIAL_BYTES + 50_000) + jsonl(tail));
  const seed = await readPrefixTaskSeed(file, 'claude', Buffer.byteLength(jsonl(head)) + 10);
  assert.deepEqual(seed.calls.map(([id, c]) => [id, c.kind]), [['c2', 'create']], 'the pending create travels with the seed');
  const blocks = await openOnce(file, sessionId);
  assert.deepEqual(states(blocks.filter((b) => b.kind === 'tasks').at(-1)), ['1:A:pending', '7:B:completed']);
  await fsp.rm(home, { recursive: true, force: true });
});

test('a refused update changes nothing: an error result, or "not found" with success:false', () => {
  const { p } = run([
    user('x'),
    create('c1', 'Ship it'), created('c1', '1', 'Ship it'),
    create('c2', 'Test it'), created('c2', '2', 'Test it'),
    update('u1', '1', 'deleted'), result('u1', 'Error: permission denied', null, { is_error: true }),
    update('u2', '2', 'completed'), result('u2', 'Task #2 not found', { success: false, taskId: '2', updatedFields: [], error: 'Task #2 not found' }),
  ]);
  assert.deepEqual(states(cards(p)[0]), ['1:Ship it:pending', '2:Test it:pending']);
  assert.equal(p.blocks.filter((b) => b.kind === 'action').length, 0, 'still checklist calls, not rows');
});

test('an update waits for its result before the card moves', () => {
  const p = new TranscriptParser('claude');
  for (const line of [user('x'), create('c1', 'A'), created('c1', '1', 'A'), update('u1', '1', 'completed')]) p.applyLine(line);
  assert.equal(cards(p)[0].tasks[0].status, 'pending');
  const changed = p.applyLine(updated('u1', '1'));
  assert.equal(cards(p)[0].tasks[0].status, 'completed');
  assert.ok(changed.includes(cards(p)[0].key));
});

test('a TaskList result resyncs the whole list (a subagent\'s completion included), keeping activeForm', () => {
  const { p } = run([
    user('go'),
    create('c1', 'A', 'Doing A'), created('c1', '1', 'A'),
    create('c2', 'B', 'Doing B'), created('c2', '2', 'B'),
    ...upd('u1', '1', 'in_progress'),
    use('l1', 'TaskList', {}),
    result('l1', '#1 [completed] A\n#2 [in_progress] B (agent-1)\n#3 [pending] C', { tasks: [
      { id: '1', subject: 'A', status: 'completed', blockedBy: [] },
      { id: '2', subject: 'B', status: 'in_progress', owner: 'agent-1', blockedBy: [] },
      { id: '3', subject: 'C', status: 'pending', blockedBy: ['2'] },
    ] }),
  ]);
  const [card] = cards(p);
  assert.deepEqual(states(card), ['1:A:completed', '2:B:in_progress', '3:C:pending']);
  assert.equal(card.tasks[1].activeForm, 'Doing B');
  assert.equal(p.taskSeq, 3);
});

test('a phone archive page is seeded with the list as it stood where its chunk begins', async () => {
  const sessionId = '11111111-0000-4000-8000-000000000004';
  const head = HEAD();
  const page = [user('older turn'), ...upd('a3', '3', 'in_progress'), ...upd('a4', '4', 'completed')];
  // 600 KB of padding: the archive's first 512 KB chunk starts inside it.
  const body = jsonl(head) + padding(600_000) + jsonl(page);
  const { home, file } = await sessionFile(sessionId, body);
  const { blocks } = await readArchiveBlocksBeforeOffset(file, 'claude', Buffer.byteLength(body), 2);
  const card = blocks.find((b) => b.kind === 'tasks');
  assert.ok(card, 'the page draws the card');
  assert.deepEqual(states(card), ['1:Step 1:pending', '2:Step 2:pending', '3:Step 3:in_progress', '4:Step 4:completed']);
  await fsp.rm(home, { recursive: true, force: true });
});
