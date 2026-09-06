'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { composeTaskPrompt, YOLO_CWD } = require('../../src/renderer/tasks/assign-to-claude.cjs');

const task = { id: 't-exact-42', title: 'Ship the thing', notes: 'Keep the API stable.', dueDate: '2026-08-25', tags: ['harbor', 'release'] };

test('configured assignment includes task context, verbatim instructions, and task safety clauses', () => {
  const extra = 'Use the existing seam.\nPreserve this wording exactly: $HOME and "quotes".';
  const prompt = composeTaskPrompt({ task, listName: 'Harbor', extraInstructions: extra });
  assert.match(prompt, /Title: Ship the thing/);
  assert.match(prompt, /Note:\nKeep the API stable\./);
  assert.match(prompt, /Due date: 2026-08-25/);
  assert.match(prompt, /List: Harbor/);
  assert.match(prompt, /Tags: harbor, release/);
  assert.ok(prompt.includes(extra));
  assert.match(prompt, /harbor-tasks done t-exact-42/);
  assert.match(prompt, /exact task ID.*never by its title/i);
  assert.match(prompt, /Do not add, complete, or modify any other Harbor task/);
});

test('YOLO assignment tells Claude to locate the project and uses the requested launch cwd', () => {
  const prompt = composeTaskPrompt({ task, listName: 'Harbor', yolo: true });
  assert.equal(YOLO_CWD, 'C:\\dev');
  assert.match(prompt, /locate the correct project yourself/i);
  assert.match(prompt, /Implement this task fully and verify the result in production terms/);
  assert.match(prompt, /harbor-tasks done t-exact-42/);
  assert.match(prompt, /Do not add, complete, or modify any other Harbor task/);
});
