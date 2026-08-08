'use strict';

// bin/harbor-tasks: the command line a Claude session drives.
//
// The reducer's behaviour is proven in test/shared and the file's durability in
// test/main; this file is about the CLI being safe to hand to an agent. Three
// properties decide that:
//   * It edits the SAME file the app does (spec 1), or an agent is confidently
//     editing something nobody can see.
//   * It NEVER guesses which task was meant (spec 5). A fuzzy match that picks
//     one is how the wrong thing gets deleted.
//   * A refusal is loud: non-zero exit and the reason on stderr (specs 4, 6, 8).
//
// Every case runs against a throwaway HARBOR_TASKS_FILE, never the real list.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLI = path.join(__dirname, '..', '..', '..', 'bin', 'harbor-tasks');
const { resolveTasksFile, defaultUserDataDir } = require('../../src/shared/tasks-file.cjs');

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-tasks-cli-'));
  return { dir, file: path.join(dir, 'tasks.json') };
}

function run(file, args, extraEnv = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HARBOR_TASKS_FILE: file, ...extraEnv },
  });
  return { code: result.status, out: result.stdout || '', err: result.stderr || '' };
}

function json(file, args) {
  const result = run(file, [...args, '--json']);
  assert.equal(result.code, 0, `${args.join(' ')} failed: ${result.err}`);
  return JSON.parse(result.out);
}

test('1) the CLI resolves the SAME file the app does, by the same rule', () => {
  // One rule in shared/tasks-file.cjs, used by both ends. If these ever diverge,
  // an agent edits a file the app never shows.
  assert.equal(
    resolveTasksFile({ env: { HARBOR_TASKS_FILE: '/tmp/x/tasks.json' }, configuredFile: '/c/t.json' }),
    '/tmp/x/tasks.json',
    'env outranks everything',
  );
  assert.equal(
    resolveTasksFile({ env: {}, configuredFile: '/configured/tasks.json' }),
    '/configured/tasks.json',
  );
  assert.equal(
    resolveTasksFile({ env: {}, userDataPath: '/real/userData' }),
    path.join('/real/userData', 'tasks.json'),
  );
  // And with no Electron to ask, the derived default matches each platform's
  // real userData location.
  assert.equal(
    defaultUserDataDir({ env: {}, homedir: '/home/x', platform: 'linux' }),
    '/home/x/.config/harbor',
  );
  assert.equal(
    defaultUserDataDir({ env: { XDG_CONFIG_HOME: '/cfg' }, homedir: '/home/x', platform: 'linux' }),
    '/cfg/harbor',
  );
  assert.equal(
    defaultUserDataDir({ env: {}, homedir: '/Users/x', platform: 'darwin' }),
    '/Users/x/Library/Application Support/harbor',
  );
  assert.equal(
    defaultUserDataDir({ env: { APPDATA: 'C:\\Users\\x\\AppData\\Roaming' }, homedir: 'C:\\Users\\x', platform: 'win32' }),
    path.join('C:\\Users\\x\\AppData\\Roaming', 'harbor'),
  );

  const { file } = sandbox();
  assert.equal(run(file, ['file']).out.trim(), file, 'and it says which file, out loud');
});

test('2) add, list and show carry every field an agent needs, in JSON', () => {
  const { file } = sandbox();
  const added = json(file, [
    'add', 'Renew the A&V equipment lease',
    '--due', 'today', '--star', '--my-day', '--tag', 'work', '--tag', 'renewals',
    '--notes', 'Alex has the vendor list',
  ]);
  assert.equal(added.ok, true);
  assert.equal(added.task.title, 'Renew the A&V equipment lease');
  assert.equal(added.task.starred, true);
  assert.equal(added.task.myDay, true);
  assert.equal(added.task.dueState, 'today');
  assert.deepEqual(added.task.tags, ['work', 'renewals']);
  assert.equal(added.task.notes, 'Alex has the vendor list');
  assert.equal(added.task.level, 1);
  assert.ok(added.task.createdAt.endsWith('Z'), 'timestamps are ISO, not epoch ms');

  const listed = json(file, ['list']);
  assert.equal(listed.count, 1);
  assert.equal(listed.tasks[0].id, added.task.id);
  assert.equal(listed.file, file);

  const shown = json(file, ['show', 'A&V']);
  assert.equal(shown.task.id, added.task.id, 'a unique phrase finds it');
});

test('3) three levels of sub-task from the command line, and the fourth is refused by name', () => {
  const { file } = sandbox();
  json(file, ['add', 'Level one']);
  json(file, ['add', 'Level two', '--parent', 'Level one']);
  const three = json(file, ['add', 'Level three', '--parent', 'Level two']);
  assert.equal(three.task.level, 3);

  const refused = run(file, ['add', 'Level four', '--parent', 'Level three']);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /three levels deep/);
  assert.match(refused.err, /Level three/, 'the refusal names the task that is already at the bottom');
  assert.equal(json(file, ['list']).count, 3, 'and nothing was written');
});

test('4) done cascades and undone restores, exactly as it does in the app', () => {
  const { file } = sandbox();
  json(file, ['add', 'Parent task']);
  json(file, ['add', 'Child task', '--parent', 'Parent task']);
  json(file, ['add', 'Grandchild task', '--parent', 'Child task']);
  json(file, ['add', 'Finished early', '--parent', 'Parent task']);
  json(file, ['done', 'Finished early']);

  json(file, ['done', 'Parent task']);
  const all = json(file, ['list', '--view', 'completed']);
  assert.equal(all.count, 4, 'the whole branch closed');

  json(file, ['undone', 'Parent task']);
  const open = json(file, ['list']);
  const titles = open.tasks.map((t) => t.title).sort();
  assert.deepEqual(titles, ['Child task', 'Grandchild task', 'Parent task']);
  const done = json(file, ['list', '--view', 'completed']);
  assert.deepEqual(done.tasks.map((t) => t.title), ['Finished early'],
    'the one finished on its own stays finished');
});

test('5) an ambiguous title is an ERROR listing the candidates, never a guess', () => {
  const { file } = sandbox();
  json(file, ['add', 'Review the renewal deck']);
  json(file, ['add', 'Review the census file']);

  const ambiguous = run(file, ['done', 'Review the']);
  assert.equal(ambiguous.code, 1);
  assert.match(ambiguous.err, /matches 2 tasks/);
  assert.match(ambiguous.err, /renewal deck/);
  assert.match(ambiguous.err, /census file/);
  assert.equal(json(file, ['list']).count, 2, 'and nothing was changed');

  const missing = run(file, ['done', 'a task that does not exist']);
  assert.equal(missing.code, 1);
  assert.match(missing.err, /no task matches/);

  // A longer phrase resolves it, and so does the id.
  assert.equal(run(file, ['done', 'renewal deck']).code, 0);
  const remaining = json(file, ['list']);
  assert.equal(run(file, ['done', remaining.tasks[0].id]).code, 0);
});

test('6) dates are read the way a human writes them, and nonsense is refused', () => {
  const { file } = sandbox();
  const today = require('../../src/shared/tasks-model.cjs').dayKey();
  const shift = require('../../src/shared/tasks-model.cjs').shiftDay;

  const added = json(file, ['add', 'Dated task', '--due', 'tomorrow']);
  assert.equal(added.task.dueDate, shift(today, 1));

  assert.equal(json(file, ['update', 'Dated', '--due', '+3d']).task.dueDate, shift(today, 3));
  assert.equal(json(file, ['update', 'Dated', '--due', 'today']).task.dueDate, today);
  assert.equal(json(file, ['update', 'Dated', '--due', '2026-12-25']).task.dueDate, '2026-12-25');
  assert.equal(json(file, ['update', 'Dated', '--due', 'none']).task.dueDate, null);

  const bad = run(file, ['update', 'Dated', '--due', 'next thursday-ish']);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /could not read/);
});

test('7) update changes only what was asked, including tags in both directions', () => {
  const { file } = sandbox();
  json(file, ['add', 'Tagged task', '--tag', 'work', '--tag', 'eb', '--star', '--my-day']);
  const updated = json(file, ['update', 'Tagged', '--untag', 'EB', '--tag', 'ops', '--no-star']);
  assert.deepEqual(updated.task.tags, ['work', 'ops'], 'untag is case-insensitive');
  assert.equal(updated.task.starred, false);
  assert.equal(updated.task.myDay, true, 'a field nobody mentioned is left alone');
  assert.equal(updated.task.title, 'Tagged task');

  const nothing = run(file, ['update', 'Tagged']);
  assert.equal(nothing.code, 1);
  assert.match(nothing.err, /nothing to change/);
});

test('8) lists, moving between them, and the refusal to delete the last one', () => {
  const { file } = sandbox();
  json(file, ['list-add', 'example-org']);
  json(file, ['add', 'Renewal review', '--list', 'example']);
  assert.equal(json(file, ['show', 'Renewal'])?.task.list, 'example-org', 'a partial list name resolves');

  const lists = json(file, ['lists']);
  assert.deepEqual(lists.lists.map((l) => l.name), ['Tasks', 'example-org']);
  assert.equal(lists.lists.find((l) => l.name === 'example-org').open, 1);

  json(file, ['list-rename', 'example-org', 'Example EB']);
  assert.equal(json(file, ['show', 'Renewal']).task.list, 'Example EB');

  json(file, ['list-rm', 'Example EB']);
  assert.equal(json(file, ['list']).count, 0, 'deleting a list takes its tasks');

  const last = run(file, ['list-rm', 'Tasks']);
  assert.equal(last.code, 1);
  assert.match(last.err, /only list/);
});

test('9) rm reports what went with it, and an unknown command explains itself', () => {
  const { file } = sandbox();
  json(file, ['add', 'Parent']);
  json(file, ['add', 'Child', '--parent', 'Parent']);
  const removed = json(file, ['rm', 'Parent']);
  assert.equal(removed.removed, 2, 'the sub-task went too, and it says so');
  assert.equal(json(file, ['list']).count, 0);

  const unknown = run(file, ['frobnicate']);
  assert.equal(unknown.code, 1);
  assert.match(unknown.err, /unknown command/);
  assert.match(unknown.err, /harbor-tasks list/, 'and prints the usage');

  assert.equal(run(file, ['--help']).code, 0);
});

test('10) two processes writing at once do not lose a task', () => {
  // The reason the store locks across processes at all: Harbor is no longer the
  // only writer. Twelve concurrent CLI adds is the shape of an agent scripting a
  // breakdown while the app is open.
  const { file } = sandbox();
  json(file, ['add', 'anchor']);

  const children = Array.from({ length: 12 }, (_, i) => spawnSync(
    process.execPath,
    [CLI, 'add', `concurrent ${i}`, '--json'],
    { encoding: 'utf8', env: { ...process.env, HARBOR_TASKS_FILE: file } },
  ));
  for (const [i, child] of children.entries()) {
    assert.equal(child.status, 0, `add ${i} failed: ${child.stderr}`);
  }

  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(doc.tasks.length, 13, 'every one survived');
  for (let i = 0; i < 12; i += 1) {
    assert.ok(doc.tasks.some((t) => t.title === `concurrent ${i}`), `concurrent ${i} is there`);
  }
});
