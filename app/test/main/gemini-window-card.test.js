'use strict';

// What a Gemini window's answer card shows for every real Antigravity screen (agy 1.5.14 captures in
// test/fixtures/gemini-box and gemini-first-run). Gemini windows mount the card since 2026-11-24 (Pat: "you didn't
// even bother to build out a harbor screen for gemini"), so this pins that the card appears exactly where agy waits
// on the person, never over an idle, working or drafting pane, and that a poll never types anything.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSessionSend, createLinkRegistry } = require('../../src/main/session-send.js');

const tempDirs = [];
test.after(() => { for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true }); });

async function poll(screen, { blockedHint = false } = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-gemini-card-'));
  tempDirs.push(stateDir);
  const sent = [];
  const send = createSessionSend({
    snapshot: async () => ({ panes: [{ pane_id: 'p', workspace_id: 'w' }], workspaces: [{ workspace_id: 'w', label: 'x' }] }),
    readPane: async () => screen,
    terminalBridge: {
      getState: () => ({ controlledPaneId: 'p' }),
      requestFocusPane: async () => ({ ok: true }),
      sendInput: (_pane, text) => { sent.push(text); return { ok: true }; },
      ensureDialogSize: async () => ({ ok: true }),
    },
    launchActions: { resumeSession: async () => {} },
    getSessionMeta: async () => ({ cwd: 'C:/dev/x' }),
    links: createLinkRegistry(),
    projectLabelForCwd: () => 'x',
    sleep: async () => {},
    setXClipboardImage: async () => {},
    captureDir: path.join(stateDir, 'unrecognized-dialogs'),
    sendLogFile: path.join(stateDir, 'send-log.jsonl'),
  });
  const menu = await send.getMenu({ pane: { paneId: 'p', workspaceId: 'w' }, blockedHint });
  const shown = !menu ? 'none' : menu.kind === 'gemini-setup' ? `setup:${menu.page}` : menu.fallback ? 'panel' : 'menu';
  return { shown, sent };
}

const box = (name) => fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'gemini-box', `agy-1.5.14-${name}-120.txt`), 'utf8');
const firstRun = (name) => fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'gemini-first-run', `${name}.txt`), 'utf8');

test('the first-run pages are the Gemini setup card', async () => {
  for (const [screen, want] of [
    [box('first-run-colour-scheme'), 'setup:scheme'], [box('first-run-terms'), 'setup:terms'],
    [firstRun('scheme-start'), 'setup:scheme'], [firstRun('scheme-down3'), 'setup:scheme'], [firstRun('scheme-after-previous'), 'setup:scheme'],
    [firstRun('terms-start'), 'setup:terms'], [firstRun('terms-unchecked'), 'setup:terms'],
    [firstRun('terms-focus-previous'), 'setup:terms'], [firstRun('terms-focus-done'), 'setup:terms'],
  ]) {
    const { shown, sent } = await poll(screen);
    assert.equal(shown, want);
    assert.deepEqual(sent, [], 'a poll never answers a first-run page');
  }
});

test("agy's own questions (a permission, the folder trust) get the answer panel", async () => {
  for (const name of ['permission-prompt', 'trust-dialog']) {
    const { shown, sent } = await poll(box(name));
    assert.equal(shown, 'panel', name);
    assert.deepEqual(sent, [], name);
  }
});

test('an idle, working, drafting or completing pane shows no card', async () => {
  for (const name of ['idle-empty', 'idle-tee-status', 'working', 'working-tee-status', 'after-reply', 'after-reply-tee-status',
    'draft-alt-enter', 'draft-paste-chars', 'draft-paste-lines', 'draft-two-lines', 'interrupted', 'resumed-banner', 'slash-menu']) {
    const { shown, sent } = await poll(box(name));
    assert.equal(shown, 'none', name);
    assert.deepEqual(sent, [], name);
  }
});

// A NUMBERED LIST IN A REPLY IS NOT A QUESTION (Pat, 2026-11-25: "wtf? fix your shit for gemini"). While agy works,
// its status row reads "esc to cancel", which Claude's menu reader takes for a question's footer, and a reply that
// lists "1. Studio Command / 2. Liquid Slate / 3. Editorial Dock" became a card labelled "Claude is asking" with the
// list as its options and "needs your answer" on the window, while Gemini was still working. agy's own questions
// REPLACE its prompt box, so a drawn box means nothing is being asked. The fixture is agy's working screen (logo,
// rules, box and status row as captured) around a reply shaped like the one on Pat's screen.
test('a numbered list in a reply while agy works shows no card (old code: a "Claude is asking" card made of the list)', async () => {
  const { shown, sent } = await poll(box('working-numbered-reply'));
  assert.equal(shown, 'none');
  assert.deepEqual(sent, []);
});

// The answer panel is the floor for screens nothing recognises, and it is raised by a dialog's own words anywhere on
// the screen ("Esc to close", "Enter to select"). A Gemini reply can say those words; over agy's drawn box they are
// prose, never a dialog.
// GEMINI'S BACKGROUND AGENTS DID NOT HIDE THE BOX FROM HARBOR UNTIL 2026-11-25 (Pat: "still getting like q&a interface
// popping up", after the fix above was live). While subagents run, agy lists them UNDER its box ("  ● Agent(self: ...) ·
// Gemini 4 Neon  <activity> · 9m24s"), closed by a rule of its own, so the last two rules framed the agents and Harbor saw
// no box: Claude's reader made the reply's "1. Batch 1 ... 4. Batch 4" list a "Gemini is asking" card, and a window whose
// status read blocked showed the raw answer panel. The fixture is the working-numbered-reply screen with the agent panel
// laid out exactly as captured live (pane b2f7675d, four agents, status row "esc to cancel · Gemini 4 Neon (High)").
test('a numbered list in a reply while agy runs background agents shows no card or panel (old code: a card made of the list)', async () => {
  for (const blockedHint of [false, true]) {
    const { shown, sent } = await poll(box('agent-panel-numbered-reply'), { blockedHint });
    assert.equal(shown, 'none', `blockedHint=${blockedHint}`);
    assert.deepEqual(sent, []);
  }
  const idle = box('agent-panel-numbered-reply').replace(/^esc to cancel · Gemini 4 Neon \(High\)$/m, '? for shortcuts · Gemini 4 Neon (High)');
  assert.equal((await poll(idle)).shown, 'none', 'the same screen with agy idle and the agents still running');
});

// The other side: a real agy question still gets its panel with the agent panel drawn under it. This layout is
// CONSTRUCTED (the permission fixture over the captured panel): a question while subagents run was not measured.
test("agy's own question still gets the answer panel with background agents listed under it", async () => {
  const panel = box('agent-panel-numbered-reply').split('\n');
  const from = panel.findIndex((row) => /^\s*● Agent\(/u.test(row)) - 1;
  const rows = box('permission-prompt').split('\n');
  while (rows.length && !rows.at(-1).trim()) rows.pop();
  const screen = [...rows.slice(0, -1), ...panel.slice(from)].join('\n');
  const { shown, sent } = await poll(screen);
  assert.equal(shown, 'panel');
  assert.deepEqual(sent, []);
});

test("a dialog's words quoted in a reply over agy's box raise no answer panel", async () => {
  const rows = box('working').split('\n');
  const at = rows.findIndex((row) => row.startsWith('⢿'));
  rows.splice(at, 0, '  The drawer closes on Esc to close, and the list takes Enter to select a row.', '');
  const { shown, sent } = await poll(rows.join('\n'));
  assert.equal(shown, 'none');
  assert.deepEqual(sent, []);
});
