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

async function poll(screen) {
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
  const menu = await send.getMenu({ pane: { paneId: 'p', workspaceId: 'w' } });
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
