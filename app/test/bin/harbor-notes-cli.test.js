'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLI = path.join(__dirname, '..', '..', '..', 'bin', 'harbor-notes');

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-notes-cli-'));
  return path.join(dir, 'notes.json');
}

function run(file, args, input) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    input,
    env: { ...process.env, HARBOR_NOTES_FILE: file },
  });
}

function json(file, args, input) {
  const result = run(file, [...args, '--json'], input);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('harbor-notes edits only a throwaway file end to end with JSON output', () => {
  const file = sandbox();
  assert.equal(json(file, ['file']).file, file);
  const added = json(file, ['add', '--title', 'Outlook reply', '--tag', 'email'], 'Hello team,\n\n- First point\n');
  assert.equal(added.note.title, 'Outlook reply');
  assert.match(added.note.body, /First point/);
  assert.deepEqual(added.note.tags, ['email']);

  const id = added.note.id;
  assert.equal(json(file, ['show', 'Outlook']).note.id, id);
  assert.equal(json(file, ['update', id, '--append', 'Thanks, Pat']).note.body.endsWith('Thanks, Pat'), true);
  assert.equal(json(file, ['pin', id]).note.pinned, true);
  assert.equal(json(file, ['list']).notes[0].id, id);
  assert.equal(json(file, ['unpin', id]).note.pinned, false);
  assert.equal(json(file, ['rm', id]).removed, 1);
  assert.equal(json(file, ['list']).count, 0);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).notes.length, 0);
});

test('harbor-notes groups notes, filters by group and topic, and reassigns on delete', () => {
  const file = sandbox();
  const group = json(file, ['group', 'add', 'Teams replies', '--color', '#4EC9B6']).group;
  assert.equal(group.name, 'Teams replies');
  assert.equal(group.color, '#4ec9b6');

  const inGroup = json(file, ['add', '--title', 'Standup', '--body', 'notes', '--group', 'Teams', '--topic', 'urgent']).note;
  assert.equal(inGroup.groupId, group.id);
  assert.deepEqual(inGroup.tags, ['urgent']);
  json(file, ['add', '--title', 'Groceries', '--body', 'milk', '--topic', 'errand']);

  assert.deepEqual(json(file, ['list', '--group', 'Teams']).notes.map((n) => n.title), ['Standup']);
  assert.deepEqual(json(file, ['list', '--topic', 'urgent']).notes.map((n) => n.title), ['Standup']);
  assert.equal(json(file, ['group', 'list']).groups.find((g) => g.id === group.id).count, 1);

  json(file, ['group', 'rename', group.id, 'Teams DMs']);
  assert.equal(json(file, ['group', 'list']).groups.find((g) => g.id === group.id).name, 'Teams DMs');
  assert.equal(json(file, ['group', 'color', group.id, 'clear']).group.color, null);

  // --topic on update replaces the note's topics.
  assert.deepEqual(json(file, ['update', inGroup.id, '--topic', 'done']).note.tags, ['done']);

  const removed = json(file, ['group', 'rm', group.id]);
  assert.equal(removed.movedNotes, 1);
  assert.equal(json(file, ['list']).count, 2, 'the note survives its group');
  assert.equal(json(file, ['show', 'Standup']).note.groupId, 'group-default');
});

test('harbor-notes group rm refuses the only group and an ambiguous name', () => {
  const file = sandbox();
  const only = run(file, ['group', 'rm', 'Notes']);
  assert.equal(only.status, 1);
  assert.match(only.stderr, /only group/);

  json(file, ['group', 'add', 'Alpha one']);
  json(file, ['group', 'add', 'Alpha two']);
  const ambiguous = run(file, ['group', 'rm', 'Alpha']);
  assert.equal(ambiguous.status, 1);
  assert.match(ambiguous.stderr, /matches 2 groups/);
});

test('harbor-notes refuses an ambiguous title fragment and lists candidates', () => {
  const file = sandbox();
  json(file, ['add', '--title', 'Reply to Alex', '--body', 'one']);
  json(file, ['add', '--title', 'Reply to Morgan', '--body', 'two']);
  const result = run(file, ['show', 'Reply to']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /matches 2 notes/);
  assert.match(result.stderr, /Reply to Alex/);
  assert.match(result.stderr, /Reply to Morgan/);
});
