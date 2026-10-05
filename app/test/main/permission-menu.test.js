'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseMenu } = require('../../src/main/menu-parse.js');
const { fixture, labels } = require('../support/permission-dialog-fixtures.js');

for (const width of [120, 48]) for (const kind of Object.keys(labels)) {
  test(`permission parts: ${kind} at ${width} columns preserve the screen's choices and detail`, () => {
    const menu = parseMenu(fixture(kind, width));
    assert.ok(menu?.permission, 'recognized permission has structured detail');
    assert.deepEqual(menu.options.map(o => o.label), labels[kind]);
    assert.deepEqual(menu.options.map(o => o.index), labels[kind].map((_, i) => i + 1));
    assert.equal(menu.selectedIndex, 0);
    assert.match(menu.permission.question, /proceed|fetch this content/);
    const detail = menu.permission.blocks.map(b => b.text).join('\n');
    const expected = { bash: 'node blue.js', outside: 'outside\\toy', compound: 'node red.js && node blue.js', guard: 'Keep the saved blue sample.', edit: ' 1 -Red toy', write: 'Toy instruction 15', mcp: 'copies: 2', fetch: 'https://example.com/toys', plan: 'Check that each wheel turns.' };
    assert.ok(detail.includes(expected[kind]), `complete ${kind} detail`);
    if (kind === 'guard') assert.match(detail, /Hook PreToolUse:Bash requires confirmation/);
    if (kind === 'plan') assert.match(detail, /ctrl\+g to edit in Notepad/);
    if (kind === 'bash') assert.equal(menu.notesKey, '\t', 'amend uses the advertised Tab through the existing notes path');
  });
}
test('unknown tool keeps every decision line, without inventing a tool title', () => {
  const reason = Array.from({ length: 12 }, (_, i) => `Reason ${i}: keep this information.`);
  const menu = parseMenu([...reason, 'Do you want to proceed?', '❯ 1. Yes', '  2. No', 'Esc to cancel · Tab to amend'].join('\n'));
  assert.ok(menu.permission);
  assert.equal(menu.permission.toolTitle, undefined);
  for (const line of reason) assert.ok(menu.permission.blocks.some(b => b.text.includes(line)));
  assert.equal(menu.permission.question, 'Do you want to proceed?');
});
test('a permission above a fresh composer is stale, while a queued echo does not erase it', () => {
  const screen = fixture('bash');
  assert.equal(parseMenu(screen + '\n' + '─'.repeat(120) + '\n❯ new request'), null);
  assert.ok(parseMenu(screen + '\n\n❯ queued request')?.permission);
});
test('ordinary questions, resume menus and model dialogs do not become permissions', () => {
  for (const screen of ['Choose a color\n❯ 1. Blue\n  2. Red\nEnter to select · ↑/↓ to navigate · Esc to cancel', 'Resume from summary\n❯ 1. Resume\n  2. Cancel']) {
    assert.equal(parseMenu(screen)?.permission, undefined);
  }
});
test('a terminal hard wrap in a permission scope rejoins without corrupting the label', () => {
  const label = 'Yes, always allow C:\\Synthetic\\' + 'x'.repeat(65);
  const line = '   2. ' + label;
  const screen = ['─'.repeat(48), 'Bash command', 'Do you want to proceed?', '❯ 1. Yes',
    ...line.match(/.{1,48}/g), '   3. No', 'Esc to cancel · Tab to amend'].join('\n');
  const menu = parseMenu(screen);
  assert.ok(menu.permission);
  assert.equal(menu.options[1].label, label);
});
test('the native feedback label and amendment capability stay independent', () => {
  const native = parseMenu(fixture('fetch'));
  assert.equal(native.notesKey, null, 'no invented Tab key on footerless Fetch');
  const amend = parseMenu(fixture('edit') + '\nEsc to cancel · Tab to amend');
  assert.equal(amend.notesKey, '\t');
  assert.match(amend.options[2].label, /tell Claude/);
});
test('MCP tool names containing built-in tool words keep their own title', () => {
  for (const title of ['Toy - Fetch_notes (MCP)', 'Bashdesk - lookup (MCP)', 'Toy - Edit_notes (MCP)']) {
    const menu = parseMenu([title, 'Argument: blue', 'Do you want to proceed?',
      '❯ 1. Yes', '  2. No', 'Esc to cancel'].join('\n'));
    assert.ok(menu?.permission);
    assert.equal(menu.permission.toolTitle, title);
    assert.equal(menu.permission.toolName, undefined, 'an MCP name is not a built-in tool');
  }
});
