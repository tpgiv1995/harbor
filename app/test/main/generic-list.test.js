'use strict';

// The generic list (main/generic-list.js, 2026-10-24): Claude Code's built-in
// list dialogs (/mcp first) read whole, so the window shows every row with the
// highlighted one marked, and a click on a row walks the "❯" there with a
// re-read after every key before it presses Enter. Fixtures are Pat's real
// /mcp screens with every name and path made generic (geometry kept).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseGenericList, locateRow } = require('../../src/main/generic-list.js');
const { parseMenu } = require('../../src/main/menu-parse.js');
const { createSessionSend, createLinkRegistry } = require('../../src/main/session-send.js');

const FIX = path.join(__dirname, '..', 'fixtures');
const read = (name) => fs.readFileSync(path.join(FIX, 'generic-list', name), 'utf8');
const MCP = read('mcp-2.1.303-120x60.txt');
const SCROLLING = read('mcp-2.1.303-scrolling-120x32.txt');

// The same screen with the "❯" on row `at` (rows in screen order), drawn the
// way the CLI draws it: the pointer two columns left of the row's text.
function withPointer(screen, at) {
  const lines = screen.split('\n');
  const rowLines = [];
  lines.forEach((line, i) => { if (/^\s*(?:❯ )?[✔⚠✗◯] /u.test(line)) rowLines.push(i); });
  return lines.map((line, i) => {
    let out = line.replace(/^(\s*)❯ ([✔⚠✗◯] )/u, '$1  $2');
    if (i === rowLines[at]) out = out.replace(/^(\s*)  ([✔⚠✗◯] )/u, '$1❯ $2');
    return out;
  }).join('\n');
}

test('the real /mcp screen reads as every row, its sections and its highlight', () => {
  const list = parseGenericList(MCP);
  assert.equal(list.kind, 'list');
  assert.deepEqual(list.title, ['Manage MCP servers', '20 servers']);
  assert.equal(list.rows.length, 20);
  assert.equal(list.selectedIndex, 1);
  assert.equal(list.rows[1].label, 'browser');
  assert.equal(list.rows[1].detail, '24 tools');
  assert.deepEqual(list.items.filter((i) => i.type === 'header').map((i) => i.text),
    ['User MCPs (C:\\Users\\you\\.claude\\.claude.json)', 'claude.ai', 'Built-in MCPs (always available)']);
  const note = list.items.find((i) => i.type === 'note');
  assert.match(note.text, /claude\.ai Hosting · ◯ hidden/);
  assert.match(note.more[0], /disable the plugin server/);
  const meetings = list.rows.find((r) => r.label === 'claude.ai Meetings');
  assert.deepEqual([meetings.glyph, meetings.tone, meetings.detail], ['⚠', 'warn', 'needs authentication']);
  assert.deepEqual(list.hints, ['https://code.claude.com/docs/en/mcp for help']);
  assert.match(list.footer, /↑\/↓ to navigate · Enter to confirm · Esc to cancel/);
});

test('the highlight is read wherever it is, including deep in a long list', () => {
  for (const at of [0, 7, 14, 19]) {
    const list = parseGenericList(withPointer(MCP, at));
    assert.equal(list.selectedIndex, at, `pointer on row ${at}`);
    assert.equal(list.rows.length, 20);
  }
});

test('a list taller than the pane: scrollbar glyphs are not row text, and hidden rows are counted', () => {
  const list = parseGenericList(SCROLLING);
  assert.equal(list.rows.length, 19);
  assert.deepEqual(list.more, { above: 0, below: 1 });
  assert.equal(list.items[0].text, 'User MCPs (C:\\Users\\you\\.claude\\.claude.json)', 'the scrollbar arrow is off the header');
  assert.equal(list.rows[0].detail, '9 tools', 'the scrollbar bar is off the row');
  assert.deepEqual(list.title, ['Manage MCP servers', '20 servers'], 'the banner and the status line drawn into the edge stay out of the title');
});

test('it never claims a dialog the five recognized shapes own, or an MCP input form', () => {
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  let recognized = 0;
  for (const file of walk(FIX).filter((f) => f.endsWith('.txt') && !f.includes(`${path.sep}generic-list${path.sep}`))) {
    const screen = fs.readFileSync(file, 'utf8');
    if (parseMenu(screen)) recognized += 1;
    assert.equal(parseGenericList(screen), null, path.relative(FIX, file));
  }
  assert.ok(recognized >= 20, `the recognized-dialog fixtures were all checked (${recognized})`);
  // A numbered pointer row is a menu, whatever else the screen says.
  assert.equal(parseGenericList('  Pick one\n  ❯ 1. Yes\n    2. No\n  ↑/↓ to navigate · Enter to confirm · Esc to cancel'), null);
  // An MCP server's input form (the Elicitation lane), as captured.
  const form = [
    '────────────────────────────────────────',
    '  MCP server “docs-search” requests your input',
    '  You are using Docs Search anonymously.',
    '  ❯ ✔ How would you like to continue?: ▸ Sign in later',
    '    Accept    Decline',
    '  Esc to cancel · ↑/↓ to navigate · Backspace to unset · → to expand',
  ].join('\n');
  assert.equal(parseGenericList(form), null);
  assert.equal(parseGenericList(form.replace(' · Backspace to unset · → to expand', '')), null, 'the form title alone refuses it');
});

test('no footer, no highlight, or a composer under it: not a list', () => {
  assert.equal(parseGenericList(MCP.replace(/↑\/↓ to navigate · Enter to confirm · Esc to cancel/, '')), null);
  assert.equal(parseGenericList(MCP.replace('❯ ✔ browser', '  ✔ browser')), null);
  assert.equal(parseGenericList(`${MCP}\n${'─'.repeat(60)}\n❯ \n${'─'.repeat(60)}`), null);
  assert.equal(parseGenericList(''), null);
});

test('rows without status glyphs: every line in the row column is a row', () => {
  const screen = ['  Select a theme', '', '    Dark mode', '  ❯ Light mode', '    High contrast', '', '  ↑/↓ to navigate · Enter to select · Esc to go back'].join('\n');
  const list = parseGenericList(screen);
  assert.deepEqual(list.rows.map((r) => r.label), ['Dark mode', 'Light mode', 'High contrast']);
  assert.equal(list.selectedIndex, 1);
  assert.deepEqual(list.title, ['Select a theme']);
});

const THEME = read('theme-2.1.303.txt');
const POWERUP = read('powerup-2.1.303.txt');
// /theme with the "❯" on row `at` and the current-value "✔" staying on row 1,
// the way the CLI draws it while you move.
function themeAt(at) {
  const lines = THEME.split('\n');
  const rows = [];
  lines.forEach((line, i) => { if (/^\s{2}(?:❯ ✔ |\s{4})\S/u.test(line) && i < lines.findIndex((l) => /╌{8}/.test(l))) rows.push(i); });
  return lines.map((line, i) => {
    const k = rows.indexOf(i);
    if (k < 0) return line;
    const label = line.replace(/^\s*(?:❯ )?(?:✔ )?\s*/u, '');
    return `  ${k === at ? '❯ ' : '  '}${k === 1 ? '✔ ' : '  '}${label}`;
  }).join('\n');
}

test('/theme: a current-value ✔ beside plain rows, an Enter + Esc footer, a preview block under the rows', () => {
  const list = parseGenericList(THEME);
  assert.equal(list.rows.length, 8);
  assert.equal(list.selectedIndex, 1);
  assert.deepEqual(list.rows.slice(0, 3).map((r) => [r.label, r.glyph]), [['Auto (match terminal)', null], ['Dark mode', '✔'], ['Light mode', null]]);
  assert.deepEqual(list.title, ['Theme', 'Choose the text style that looks best with your terminal']);
  assert.deepEqual(list.hints, ['Syntax theme: Monokai Extended (ctrl+t to disable)'], 'the code preview is not a hint');
  for (const at of [0, 4, 7]) {
    const moved = parseGenericList(themeAt(at));
    assert.equal(moved.selectedIndex, at, `pointer on row ${at}`);
    assert.equal(moved.rows.length, 8);
    assert.equal(moved.rows[1].glyph, '✔', 'the current theme keeps its mark');
  }
});

test('/powerup: "↑/↓ to select" is a list footer too', () => {
  const list = parseGenericList(POWERUP);
  assert.equal(list.rows.length, 10);
  assert.equal(list.rows[0].label, 'Talk to your codebase');
  assert.equal(list.rows[0].detail, '@ files, line refs');
  assert.equal(list.title[0], 'Power-ups 0/10 unlocked');
});

test('a plain line under a glyph row is that row continuing (the /plugin layout)', () => {
  const screen = ['  Plugins', '', '  ❯ ◯ deploy-kit · Directory · 2K installs', '      Build and deploy apps from the session', '    ◯ docs-kit · Directory · 1K installs', '      Search and cite documentation', '', '  ↑/↓ to navigate · Enter to view · Esc to go back'].join('\n');
  const list = parseGenericList(screen);
  assert.deepEqual(list.rows.map((r) => r.label), ['deploy-kit · Directory · 2K installs', 'docs-kit · Directory · 1K installs']);
  assert.deepEqual(list.rows[0].more, ['Build and deploy apps from the session']);
});

test('a toggle list stays on the raw keys: a click must never flip a setting', () => {
  const screen = ['  Data privacy', '', '  ❯ Help improve the models     true', '', '  Enter/Tab/Space to toggle · Esc to cancel'].join('\n');
  assert.equal(parseGenericList(screen), null);
});

test('a model or usage-limit switch belongs to its own card wherever this is called from', () => {
  const { fixture } = require('../support/model-switch-fixtures.js');
  for (const kind of ['usage', 'paused']) {
    const screen = fixture(kind, 120, 1);
    assert.ok(parseMenu(screen), `${kind} is a recognized shape`);
    assert.equal(parseGenericList(screen), null, kind);
  }
});

test('a row is found by its label, and same-named rows by their order', () => {
  const screen = ['  Pick', '  ❯ ✔ alpha', '    ✔ beta', '    ✔ alpha', '  ↑/↓ to navigate · Enter to confirm · Esc to cancel'].join('\n');
  const list = parseGenericList(screen);
  assert.deepEqual(locateRow(list, { label: 'alpha', occurrence: 1 }), { target: 2, current: 0 });
  assert.equal(locateRow(list, { label: 'gamma' }), null);
});

// ---- the click: a verified walk through the real session-send ----------

function rig(render, { skip = new Set() } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-generic-list-'));
  const state = { at: 1, closed: false, sent: [] };
  const rows = parseGenericList(render(0))?.rows.length || 0;
  const step = (dir1) => {
    let next = state.at + dir1;
    while (skip.has(next)) next += dir1;
    if (next >= 0 && next < rows) state.at = next;
  };
  const deps = {
    snapshot: async () => ({ panes: [{ pane_id: 'p1', workspace_id: 'ws-1' }], workspaces: [{ workspace_id: 'ws-1', label: 'demo' }] }),
    readPane: async () => (state.closed ? `conversation\n${'─'.repeat(40)}\n❯ \n${'─'.repeat(40)}` : render(state.at)),
    terminalBridge: {
      getState: () => ({ controlledPaneId: 'p1' }),
      requestFocusPane: async () => ({ ok: true }),
      ensureDialogSize: async () => ({ ok: true }),
      sendInput: (_pane, text) => {
        state.sent.push(text);
        if (text === '\x1b[B') step(1);
        else if (text === '\x1b[A') step(-1);
        else if (text === '\r') { state.enterAt = state.at; state.closed = true; }
        return { ok: true };
      },
    },
    links: createLinkRegistry(),
    projectLabelForCwd: () => 'demo',
    getSessionMeta: async () => ({ cwd: dir }),
    sleep: async () => {},
    captureDir: path.join(dir, 'captures'),
    sendLogFile: path.join(dir, 'send-log.jsonl'),
  };
  return { send: createSessionSend(deps), state, dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('the window gets the whole list as the fallback panel, and the screen is not filed as unrecognized', async () => {
  const r = rig((at) => withPointer(MCP, at));
  try {
    const menu = await r.send.getMenu({ pane: { paneId: 'p1', workspaceId: 'ws-1' } });
    assert.equal(menu.fallback, true, 'still the fallback panel, so every waiting-on-you signal still fires');
    assert.equal(menu.list.rows.length, 20);
    assert.equal(menu.list.selectedIndex, 1);
    assert.equal(fs.existsSync(path.join(r.dir, 'captures')) && fs.readdirSync(path.join(r.dir, 'captures')).length, false);
  } finally { r.cleanup(); }
});

test('a click deep in the list walks the pointer there and presses Enter once, on that row', async () => {
  const r = rig((at) => withPointer(MCP, at));
  try {
    const res = await r.send.answerMenu({ pane: { paneId: 'p1', workspaceId: 'ws-1' }, action: { type: 'list-pick', label: 'claude.ai Surveys' } });
    assert.equal(res.ok, true, res.reason);
    const target = parseGenericList(MCP).rows.findIndex((row) => row.label === 'claude.ai Surveys');
    assert.equal(r.state.enterAt, target);
    assert.equal(r.state.sent.filter((k) => k === '\r').length, 1);
    assert.equal(r.state.sent.filter((k) => k === '\x1b[B').length, target - 1);
    assert.ok(!r.state.sent.includes('\x1b[A'));
  } finally { r.cleanup(); }
});

test('/theme: a click walks past the current-value mark to the row clicked', async () => {
  const r = rig(themeAt);
  try {
    const res = await r.send.answerMenu({ pane: { paneId: 'p1', workspaceId: 'ws-1' }, action: { type: 'list-pick', label: 'Light mode (ANSI colors only)' } });
    assert.equal(res.ok, true, res.reason);
    assert.equal(r.state.enterAt, 6);
    assert.equal(r.state.sent.filter((k) => k === '\r').length, 1);
  } finally { r.cleanup(); }
});

test('a click above the highlight walks up', async () => {
  const r = rig((at) => withPointer(MCP, at));
  r.state.at = 18;
  try {
    const res = await r.send.answerMenu({ pane: { paneId: 'p1', workspaceId: 'ws-1' }, action: { type: 'list-pick', label: 'sandbox-api' } });
    assert.equal(res.ok, true, res.reason);
    assert.equal(r.state.enterAt, 0);
    assert.equal(r.state.sent.filter((k) => k === '\x1b[A').length, 18);
  } finally { r.cleanup(); }
});

test('a row the CLI will not stop on is never confirmed: the walk stops without Enter', async () => {
  const r = rig((at) => withPointer(MCP, at), { skip: new Set([5]) });
  try {
    const label = parseGenericList(MCP).rows[5].label;
    const res = await r.send.answerMenu({ pane: { paneId: 'p1', workspaceId: 'ws-1' }, action: { type: 'list-pick', label } });
    assert.equal(res.ok, false);
    assert.match(res.reason, /cannot be selected/);
    assert.ok(!r.state.sent.includes('\r'), 'no Enter on whatever row it overshot onto');
  } finally { r.cleanup(); }
});

test('a row that is not in the list, or a list that is gone, sends no keys', async () => {
  const r = rig((at) => withPointer(MCP, at));
  try {
    const res = await r.send.answerMenu({ pane: { paneId: 'p1', workspaceId: 'ws-1' }, action: { type: 'list-pick', label: 'no such server' } });
    assert.equal(res.ok, false);
    assert.deepEqual(r.state.sent, []);
    r.state.closed = true;
    const gone = await r.send.answerMenu({ pane: { paneId: 'p1', workspaceId: 'ws-1' }, action: { type: 'list-pick', label: 'browser' } });
    assert.equal(gone.ok, false);
    assert.deepEqual(r.state.sent, []);
  } finally { r.cleanup(); }
});

// ---- dialogs the window used to show NOTHING for (measured on 2.1.303) ----

const PLUGIN_LIKE = ['  Plugins  Discover   Installed   Marketplaces   Errors', '  Discover plugins (1/40)', '',
  '  ❯ ◯ deploy-kit · Directory · 2K installs', '      Build and deploy apps from the session',
  '    ◯ docs-kit · Directory · 1K installs', '      Search and cite documentation', '   ↓ more below',
  '  Type to search · Space to toggle · Enter to view · Esc to go back'].join('\n');
const SKILLS_LIKE = ['  Skills', '  40 skills · enter/space to cycle, / to search, t to sort, Esc to close', '',
  '  ❯ ✔ alpha-skill              user · ~30 tok', '    ✔ beta-skill               user · ~20 tok', '    ↓ 38 more',
  '  Plugin skills are managed via /plugin'].join('\n');
const COMPOSER = `${'─'.repeat(80)}\n❯ \n${'─'.repeat(80)}\n  ⏵⏵ auto mode on (shift+tab to cycle)`;

test('a list whose footer says "Esc to go back" (/plugin) is a dialog, and gets the list card', async () => {
  const r = rig(() => PLUGIN_LIKE);
  try {
    const menu = await r.send.getMenu({ pane: { paneId: 'p1', workspaceId: 'ws-1' }, observe: true });
    assert.equal(menu?.fallback, true, 'before 2026-10-24 this was null: no card at all');
    assert.equal(menu.list.rows.length, 2);
    assert.deepEqual(menu.list.rows[0].more, ['Build and deploy apps from the session']);
  } finally { r.cleanup(); }
});

test('a dialog whose only way out is an "Esc to close" above its rows (/skills) still gets the answer panel', async () => {
  const r = rig(() => SKILLS_LIKE);
  try {
    const menu = await r.send.getMenu({ pane: { paneId: 'p1', workspaceId: 'ws-1' }, observe: true });
    assert.equal(menu?.fallback, true);
  } finally { r.cleanup(); }
});

test('the same hints above a live prompt raise nothing: the session has moved on', async () => {
  for (const screen of [`${PLUGIN_LIKE}\n${COMPOSER}`, `${SKILLS_LIKE}\n${COMPOSER}`]) {
    const r = rig(() => screen);
    try {
      assert.equal(await r.send.getMenu({ pane: { paneId: 'p1', workspaceId: 'ws-1' }, observe: true }), null);
    } finally { r.cleanup(); }
  }
});

// /plugin while you type: the search field holds the highlight and no row
// shows a "❯" (measured on 2.1.303). Rows here are three plugins.
function pluginsAt(at) {
  const names = ['deploy-kit', 'docs-kit', 'design-kit'];
  return ['  Plugins  Discover   Installed   Marketplaces   Errors', '  Discover plugins (3/40)', '  ╭──────────╮', '  │ ⌕ kit    │', '  ╰──────────╯',
    ...names.flatMap((n, i) => [`  ${i === at ? '❯ ' : '  '}◯ ${n} · Directory · ${i + 1}K installs`, `      About ${n}`]),
    '  Type to search · Space to toggle · Enter to view · Esc to go back'].join('\n');
}

test('a searchable list with the highlight in its search field is still the list, with nothing highlighted', () => {
  const list = parseGenericList(pluginsAt(-1));
  assert.equal(list.rows.length, 3);
  assert.equal(list.selectedIndex, null);
  assert.equal(list.searchable, true);
  assert.deepEqual(list.rows[1].more, ['About docs-kit']);
  assert.ok(!list.title.some((t) => /[╭│╰]/.test(t)), 'the search box frame is not a title line');
  assert.equal(list.search, 'kit', 'what is typed in the search box');
  assert.equal(parseGenericList(pluginsAt(0).replace('⌕ kit   ', '⌕ Search…')).search, '');
  const plain = pluginsAt(-1).replace('Type to search · ', '');
  assert.equal(parseGenericList(plain), null, 'a list that does not take typing needs its highlight');
});

test('a click from the search field steps down into the list, then walks to the row', async () => {
  const r = rig(pluginsAt);
  r.state.at = -1;
  try {
    const res = await r.send.answerMenu({ pane: { paneId: 'p1', workspaceId: 'ws-1' }, action: { type: 'list-pick', label: 'design-kit · Directory · 3K installs' } });
    assert.equal(res.ok, true, res.reason);
    assert.equal(r.state.enterAt, 2);
    assert.deepEqual(r.state.sent, ['\x1b[B', '\x1b[B', '\x1b[B', '\r']);
  } finally { r.cleanup(); }
});

test('the list card types its search key by key: the dialog drops a chunk', async () => {
  const r = rig(pluginsAt);
  try {
    const res = await r.send.answerMenu({ pane: { paneId: 'p1', workspaceId: 'ws-1' }, action: { type: 'raw', text: 'kit', perKey: true } });
    assert.equal(res.ok, true);
    assert.deepEqual(r.state.sent, ['k', 'i', 't']);
  } finally { r.cleanup(); }
});

test('a details page: bullets and a sentence wrapped at the pane edge are notes, the actions are the rows', () => {
  const list = parseGenericList(read('plugin-details-2.1.303.txt'));
  assert.deepEqual(list.rows.map((r) => r.label), ['Install for you (user scope)', 'Install for all collaborators on this repository (project scope)',
    'Install for you, in this repo only (local scope)', 'Open homepage', 'Back to plugin list']);
  assert.equal(list.selectedIndex, 0);
  const warning = list.items.find((i) => /Make sure you trust/.test(i.text));
  assert.equal(warning.type, 'note');
  assert.equal(warning.more.length, 2, 'its two wrapped lines belong to it');
  assert.ok(list.items.filter((i) => i.type === 'note' && /^·/.test(i.text)).length >= 2, 'the bullets are notes');
});
