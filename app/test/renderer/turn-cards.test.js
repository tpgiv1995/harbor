'use strict';

// The per-turn cards (2026-10-19): "Edited N files" at the end of a finished
// turn, aggregated from the parsed action rows, and the task checklist card's
// rendering. The parsed shapes come from the REAL parser, so the card and the
// parser are tested together.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { TranscriptParser, actionForToolUse } = require('../../src/main/providers/transcript.js');
const { splitTurns, turnEdits, planTurns, turnRunning, editTotals, fileBadge, filesLabel } = require('../../src/renderer/stage/turn-cards.cjs');

let clock = Date.parse('2026-10-19T15:00:00.000Z');
const ts = () => new Date((clock += 1000)).toISOString();
const user = (text) => ({ type: 'user', timestamp: ts(), message: { role: 'user', content: text } });
const use = (id, name, input) => ({ type: 'assistant', timestamp: ts(), message: { id: `m-${id}`, role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
const ok = (id, isError = false) => ({ type: 'user', timestamp: ts(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok', is_error: isError }] } });
const edit = (id, file, oldS, newS) => [use(id, 'Edit', { file_path: file, old_string: oldS, new_string: newS }), ok(id)];

function parse(lines) {
  const p = new TranscriptParser('claude');
  for (const line of lines) p.applyLine(line);
  return p.blocks;
}

test('edits to the same file sum into one row, keyed by full path', () => {
  const blocks = parse([
    user('go'),
    ...edit('e1', '/repo/src/a.js', 'one', 'one\ntwo'),
    ...edit('e2', '/repo/src/a.js', 'x\ny\nz', 'x'),
    ...edit('e3', '/other/src/a.js', 'p', 'q'),
  ]);
  const rows = turnEdits(blocks);
  assert.deepEqual(rows.map((r) => [r.path, r.name, r.added, r.removed, r.edits]), [
    ['/repo/src/a.js', 'a.js', 3, 4, 2],
    ['/other/src/a.js', 'a.js', 1, 1, 1],
  ]);
  assert.equal(rows[0].diffs.length, 2, 'each Edit keeps its own diff preview');
  assert.deepEqual(editTotals(rows), { added: 4, removed: 5 });
});

test('Write counts its lines as added and none removed, with no diff', () => {
  const rows = turnEdits(parse([user('go'), use('w1', 'Write', { file_path: '/r/new.md', content: 'a\nb\nc' }), ok('w1')]));
  assert.deepEqual(rows.map((r) => [r.name, r.added, r.removed, r.diffs.length]), [['new.md', 3, 0, 0]]);
});

test('MultiEdit sums across its edits and keeps its row as before', () => {
  const blocks = parse([user('go'), use('m1', 'MultiEdit', { file_path: '/r/s.css', edits: [
    { old_string: 'a', new_string: 'a\nb' },
    { old_string: 'c\nd', new_string: 'e' },
  ] }), ok('m1')]);
  const action = blocks.find((b) => b.kind === 'action');
  assert.equal(action.verb, 'MultiEdit');
  assert.equal(action.chip, '/r/s.css');
  const [row] = turnEdits(blocks);
  assert.deepEqual([row.added, row.removed], [3, 3]);
  assert.ok(row.diffs[0].lines.length > 0);
});

test('NotebookEdit counts as an edited file with an unknown removed count', () => {
  const action = actionForToolUse({ name: 'NotebookEdit', input: { notebook_path: '/r/n.ipynb', new_source: 'x\ny', edit_mode: 'replace' } });
  assert.deepEqual(action.files, [{ path: '/r/n.ipynb', added: 2, removed: null }]);
  const rows = turnEdits([{ kind: 'action', key: 'b1', status: 'ok', ...action }]);
  assert.equal(rows[0].removed, null);
});

test('a failed edit changed nothing and is not counted', () => {
  const blocks = parse([user('go'), use('e1', 'Edit', { file_path: '/r/a.js', old_string: 'a', new_string: 'b' }), ok('e1', true)]);
  assert.deepEqual(turnEdits(blocks), []);
});

test('turns split at each prompt; a queued message joins the running turn', () => {
  const blocks = parse([
    user('first'),
    ...edit('e1', '/r/a.js', 'a', 'b'),
    user('second'),
    ...edit('e2', '/r/b.js', 'a', 'b'),
    { type: 'queue-operation', operation: 'enqueue', timestamp: ts(), content: 'also this' },
    ...edit('e3', '/r/c.js', 'a', 'b'),
  ]);
  const turns = splitTurns(blocks);
  assert.equal(turns.length, 2);
  assert.deepEqual(turns.map((t) => turnEdits(t).map((r) => r.name)), [['a.js'], ['b.js', 'c.js']]);
});

test('the card waits for the turn to finish: no edits on the running last turn', () => {
  const blocks = parse([user('first'), ...edit('e1', '/r/a.js', 'a', 'b'), user('second'), ...edit('e2', '/r/b.js', 'a', 'b')]);
  const working = planTurns(blocks, true);
  assert.deepEqual(working.map((t) => [t.running, t.edits.length]), [[false, 1], [true, 0]]);
  const settled = planTurns(blocks, false);
  assert.deepEqual(settled.map((t) => [t.running, t.edits.length]), [[false, 1], [false, 1]]);
});

test('no card for a turn that edited nothing', () => {
  const blocks = parse([user('go'), use('r1', 'Read', { file_path: '/r/a.js' }), ok('r1'), use('b1', 'Bash', { command: 'ls' }), ok('b1')]);
  assert.deepEqual(planTurns(blocks, false)[0].edits, []);
});

test('labels and badges', () => {
  assert.equal(filesLabel(1), 'Edited 1 file');
  assert.equal(filesLabel(4), 'Edited 4 files');
  assert.deepEqual(fileBadge('/x/Conversation.jsx'), { label: 'JSX', tone: 'js' });
  assert.deepEqual(fileBadge('a.PY'), { label: 'PY', tone: 'py' });
  assert.equal(fileBadge('/x/Makefile'), null, 'no extension: the generic glyph');
  assert.equal(fileBadge('/x/.env'), null, 'a dotfile is not an extension');
});

// Source assertions, like the other renderer suites.
const conversation = fs.readFileSync(path.resolve(__dirname, '../../src/renderer/stage/Conversation.jsx'), 'utf8');
const styles = fs.readFileSync(path.resolve(__dirname, '../../src/renderer/styles.css'), 'utf8');

const taskCard = fs.readFileSync(path.resolve(__dirname, '../../src/renderer/stage/TaskCard.jsx'), 'utf8');

test('the conversation renders both cards and only the running turn\'s checklist is live', () => {
  assert.match(conversation, /import \{ TaskCard \} from '\.\/TaskCard\.jsx';/);
  assert.match(conversation, /block\.kind === 'tasks'\) return <TaskCard tasks=\{block\.tasks\} live=\{live\} \/>/);
  assert.match(conversation, /item\.live = turn\.running/);
  assert.match(conversation, /item\.type === 'edits'\) return <EditsCard/);
  assert.match(conversation, /const EDITS_SHOWN = 3;/);
  assert.match(conversation, /`Show \$\{files\.length - EDITS_SHOWN\} more`/);
  assert.match(taskCard, /task\.activeForm \|\| task\.subject/, 'an in-progress row reads its activeForm');
  for (const selector of ['.conv-tasks', '.conv-task-icon.todo circle', '.conv-task-icon.doing .arc', '.conv-task-icon.done circle', '.conv-edits', '.conv-edit-row.static', '.conv-edits-more', '.conv-edit-add', '.conv-edit-del']) {
    assert.ok(styles.includes(`${selector} {`), `${selector} is styled`);
  }
});

// ---- totals that survive eviction, and real diff counts ----------------------

const { MAX_BLOCKS } = require('../../src/main/providers/transcript.js');
const say = (text) => ({ type: 'assistant', timestamp: ts(), message: { id: `m-say-${clock}`, role: 'assistant', content: [{ type: 'text', text }] } });
const res = (id, toolUseResult, isError = false) => ({ type: 'user', timestamp: ts(), toolUseResult, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok', is_error: isError }] } });
const parser = (lines) => {
  const p = new TranscriptParser('claude');
  for (const line of lines) p.applyLine(line);
  return p;
};
const rowsOf = (turn) => turn.edits.map((r) => `${r.name} +${r.added} -${r.removed}`);

test('an older turn keeps its true "Edited N files" after its action rows are evicted', () => {
  const lines = [user('turn A: edit 20 files')];
  for (let i = 0; i < 20; i += 1) lines.push(...edit(`e${i}`, `/r/a${i}.js`, 'x', 'y'));
  lines.push(user('turn B'));
  for (let i = 0; i < MAX_BLOCKS - 10; i += 1) lines.push(say(`note ${i}`));
  const p = parser(lines);
  const turns = planTurns(p.blocks, false);
  assert.equal(turns[0].blocks[0].text, 'turn A: edit 20 files', 'turn A\'s prompt is still in the window');
  assert.ok(turns[0].blocks.filter((b) => b.kind === 'action').length < 20, 'most of its action rows were evicted');
  assert.equal(turns[0].edits.length, 20, 'the card still says 20 files');
  assert.equal(turns[0].key, turns[0].blocks[0].key, 'keyed by its prompt');
});

test('a prompt-led turn hands the card the SAME array each render, so the memo holds', () => {
  const p = parser([user('go'), ...edit('e1', '/r/a.js', 'a', 'b'), user('next'), ...edit('e2', '/r/b.js', 'a', 'b')]);
  const one = planTurns(p.blocks, true);
  const two = planTurns(p.blocks, true);
  assert.equal(one[0].edits, two[0].edits);
  assert.equal(one[1].edits.length, 0, 'the running turn shows no card');
  p.applyLine(say('more text in turn two'));
  assert.equal(planTurns(p.blocks, true)[0].edits, one[0].edits, 'an append elsewhere leaves the finished turn\'s rows alone');
});

test('an Edit counts from its structuredPatch, not from old_string/new_string', () => {
  const p = parser([
    user('fix'),
    use('e', 'Edit', { file_path: '/r/x.js', old_string: 'a\nb\nc\nd\ne', new_string: 'a\nb\nC\nd\ne' }),
    res('e', { filePath: '/r/x.js', structuredPatch: [{ oldStart: 1, oldLines: 5, newStart: 1, newLines: 5, lines: [' a', ' b', '-c', '+C', ' d', ' e'] }] }),
  ]);
  assert.deepEqual(rowsOf(planTurns(p.blocks, false)[0]), ['x.js +1 -1']);
  assert.equal(p.blocks.find((b) => b.kind === 'action').pill.text, '+1 −1', 'the row\'s own pill says the same');
});

test('a Write over an existing file shows the real removals; a new file keeps its line count', () => {
  const big = Array.from({ length: 300 }, (_, i) => `l${i}`).join('\n');
  const p = parser([
    user('rewrite'),
    use('w', 'Write', { file_path: '/r/big.js', content: big }),
    res('w', { type: 'update', filePath: '/r/big.js', structuredPatch: [{ lines: ['-old1', '-old2', '+new1', ' l2'] }] }),
    use('n', 'Write', { file_path: '/r/new.md', content: 'a\nb\nc' }),
    res('n', { type: 'create', filePath: '/r/new.md', structuredPatch: [] }),
  ]);
  assert.deepEqual(rowsOf(planTurns(p.blocks, false)[0]), ['big.js +1 -2', 'new.md +3 -0']);
  const [overwrite, created] = p.blocks.filter((b) => b.kind === 'action');
  assert.equal(overwrite.pill.text, '+1 −2');
  assert.equal(created.pill.text, '3 lines');
});

test('a patch carried by a record with several results is not attributed to one of them', () => {
  const p = parser([
    user('go'),
    use('e1', 'Edit', { file_path: '/r/a.js', old_string: 'a\nb', new_string: 'a\nc' }),
    use('e2', 'Edit', { file_path: '/r/b.js', old_string: 'a', new_string: 'b' }),
    { type: 'user', timestamp: ts(), toolUseResult: { structuredPatch: [{ lines: ['-x', '-y', '-z'] }] }, message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'e1', content: 'ok' }, { type: 'tool_result', tool_use_id: 'e2', content: 'ok' },
    ] } },
  ]);
  assert.deepEqual(rowsOf(planTurns(p.blocks, false)[0]), ['a.js +2 -2', 'b.js +1 -1'], 'the call\'s own counts stand');
});

test('the turn keeps a bounded amount of diff preview on its prompt', () => {
  const lines = [user('big edit run')];
  for (let i = 0; i < 80; i += 1) lines.push(...edit(`e${i}`, `/r/f${i % 4}.js`, Array.from({ length: 10 }, (_, j) => `o${i}-${j}`).join('\n'), Array.from({ length: 10 }, (_, j) => `n${i}-${j}`).join('\n')));
  const p = parser(lines);
  const rows = p.blocks[0].edits;
  assert.equal(rows.length, 4);
  assert.ok(rows.every((r) => r.edits === 20 && r.diffs.length <= 6));
  const kept = rows.reduce((n, r) => n + r.diffs.reduce((m, d) => m + d.lines.length, 0), 0);
  assert.ok(kept <= 400, `${kept} preview lines kept`);
});

test('the last turn runs exactly while the session works', () => {
  assert.equal(turnRunning({ working: true }), true);
  assert.equal(turnRunning({ working: false, lastSignal: 'tool-pending' }), false, 'workingState already ended it');
  assert.equal(turnRunning(null), false);
});

test('the leading partial turn is keyed "head", which does not move as the window slides', () => {
  const p = parser([...edit('e1', '/r/a.js', 'a', 'b'), ...edit('e2', '/r/b.js', 'a', 'b'), user('next')]);
  const [head] = planTurns(p.blocks, false);
  assert.equal(head.key, 'head');
  assert.deepEqual(head.edits.map((r) => r.name), ['a.js', 'b.js'], 'no prompt to hold totals: counted from the rows');
});

const webConversation = fs.readFileSync(path.resolve(__dirname, '../../web/src/conversation/Conversation.jsx'), 'utf8');
const webStyles = fs.readFileSync(path.resolve(__dirname, '../../web/src/conversation/conversation.css'), 'utf8');

test('the phone draws the same checklist card, styled statically in its own sheet', () => {
  assert.match(webConversation, /import \{ TaskCard \} from '\.\.\/\.\.\/\.\.\/src\/renderer\/stage\/TaskCard\.jsx';/);
  assert.match(webConversation, /block\.kind === 'tasks'\) return <TaskCard tasks=\{block\.tasks\} live=\{live\} \/>/);
  assert.match(webConversation, /turnRunning\(header\)/);
  for (const selector of ['.conv-tasks', '.conv-task', '.conv-task-icon.todo circle', '.conv-task-icon.doing .arc', '.conv-task-icon.done circle', '.conv-task-icon.done path']) {
    assert.ok(webStyles.includes(`${selector} {`), `${selector} is styled on the phone`);
  }
  assert.match(taskCard, /key=\{task\.id\}/, 'rows keyed by task id, not position');
  assert.match(conversation, /key: `edits-\$\{turn\.key\}`/, 'the Edited card is keyed by its turn, not by blocks[0]');
  assert.doesNotMatch(conversation, /function TaskIcon|function TaskCard/, 'one TaskCard, shared');
});

test('an Edit\'s diff preview is redrawn from its patch, so context lines are not shown as changes', () => {
  const p = parser([
    user('fix'),
    use('e', 'Edit', { file_path: '/r/x.js', old_string: 'keep\nold', new_string: 'keep\nnew' }),
    res('e', { structuredPatch: [{ lines: [' keep', '-old', '+new'] }] }),
  ]);
  const action = p.blocks.find((b) => b.kind === 'action');
  assert.deepEqual(action.diff, [{ t: 'del', s: 'old' }, { t: 'add', s: 'new' }]);
  assert.deepEqual(planTurns(p.blocks, false)[0].edits[0].diffs[0].lines, action.diff);
});
