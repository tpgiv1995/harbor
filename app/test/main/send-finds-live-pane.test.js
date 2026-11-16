'use strict';

// A SEND THAT NAMES ONLY A SESSION FINDS THAT SESSION'S LIVE PANE (2026-11-15,
// Pat: "what caused a second vox session?").
//
// Vox (5894c81a) was idle in pane e08b9799. A peer session sent it a note
// through the phone server naming only the session id; that process had no
// pane link of its own, so session-send went straight to resume and Harbor
// opened a second claude on the same conversation in pane 19c7be11. These specs
// drive the real createSessionSend against a stand-in daemon snapshot. Each
// "goes to the live pane" spec has a twin with no live pane, which must still
// resume, so the fix cannot pass by never resuming at all.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSessionSend, createLinkRegistry } = require('../../src/main/session-send.js');

const VOX = '5894c81a-0e56-4092-aac9-aeccceaf287e';
const RULE = '─'.repeat(60);
const tempDirs = [];
test.after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// The stand-in pane draws what is typed into its prompt and clears it on Enter,
// like a real Claude (a send presses Enter only once the prompt shows the text).
function harness(panes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-send-live-pane-'));
  tempDirs.push(dir);
  const state = { panes: [...panes], controlledPaneId: null, draft: '' };
  const h = {
    state,
    sent: [],
    resumeCalls: [],
    deps: {
      snapshot: async () => ({ panes: state.panes, workspaces: [{ workspace_id: 'ws-1', label: 'project' }] }),
      terminalBridge: {
        getState: () => ({ controlledPaneId: state.controlledPaneId }),
        requestFocusPane: async ({ paneId }) => { state.controlledPaneId = paneId; return { ok: true }; },
        sendInput: (paneId, text) => {
          h.sent.push({ paneId, text });
          if (text === '\r') state.draft = '';
          else if (!/^[\x00-\x1f\x7f]/.test(text) || text.startsWith('\x1b[200~')) state.draft += text.replace(/\x1b\[20[01]~/g, '');
          return { ok: true };
        },
        ensureDialogSize: async () => ({ ok: true }),
      },
      readPane: async () => `conversation\n${RULE}\n❯ ${state.draft}\n${RULE}`,
      launchActions: {
        resumeSession: async (args) => {
          h.resumeCalls.push(args);
          state.panes.push({ pane_id: 'pane-fresh', workspace_id: 'ws-1', agent_session: { kind: 'id', value: args.id } });
        },
      },
      getSessionMeta: async () => ({ cwd: 'C:\\dev\\project' }),
      links: createLinkRegistry(),
      projectLabelForCwd: () => 'project',
      sleep: async () => {},
      captureDir: path.join(dir, 'unrecognized-dialogs'),
      sendLogFile: path.join(dir, 'send-log.jsonl'),
    },
  };
  return h;
}

const pane = (id, sessionId, extra = {}) => ({
  pane_id: id,
  workspace_id: 'ws-1',
  agent: 'claude',
  agent_session: sessionId ? { kind: 'id', value: sessionId } : null,
  created_at: '2026-11-15T21:37:00.912Z',
  ...extra,
});

test('a send by session id alone goes into the pane already running that session, and never resumes', async () => {
  const h = harness([pane('pane-peer', '3156e3c0-abf1-4a9b-afe0-b9b3357f3b4e'), pane('pane-vox', VOX)]);
  const send = createSessionSend(h.deps);
  const result = await send.send({ sessionId: VOX, text: 'the archive moved to the other machine', images: [], resumeOnly: false });
  assert.equal(result.ok, true);
  assert.equal(result.paneId, 'pane-vox');
  assert.notEqual(result.resumed, true);
  assert.equal(h.resumeCalls.length, 0, 'a live session must never be resumed into a second pane');
  assert.deepEqual(h.sent.map((s) => [s.paneId, s.text]), [['pane-vox', 'the archive moved to the other machine'], ['pane-vox', '\r']]);
  // And the link is recorded, so the next send skips the lookup.
  assert.equal(h.deps.links.get(VOX).paneId, 'pane-vox');
});

test('twin: with no live pane for the session, the same send still resumes and delivers', async () => {
  const h = harness([pane('pane-peer', '3156e3c0-abf1-4a9b-afe0-b9b3357f3b4e')]);
  const send = createSessionSend(h.deps);
  const result = await send.send({ sessionId: VOX, text: 'the archive moved to the other machine', images: [], resumeOnly: false });
  assert.equal(result.ok, true);
  assert.equal(result.resumed, true);
  assert.equal(result.paneId, 'pane-fresh');
  assert.equal(h.resumeCalls.length, 1);
  assert.ok(h.sent.every((s) => s.paneId !== 'pane-peer'), 'another session\'s pane is never typed into');
});

test('a dead offered pane or stale link falls back to the live pane before any resume', async () => {
  const h = harness([pane('pane-vox', VOX)]);
  h.deps.links.set(VOX, { paneId: 'pane-closed-hours-ago', workspaceId: 'ws-1' });
  const send = createSessionSend(h.deps);
  const result = await send.send({ sessionId: VOX, text: 'status?', pane: { paneId: 'pane-also-gone', workspaceId: 'ws-1' } });
  assert.equal(result.paneId, 'pane-vox');
  assert.equal(h.resumeCalls.length, 0);
});

test('an offered pane now owned by another session falls back to this session\'s live pane, never into the other one', async () => {
  const other = 'cccccccc-1111-2222-3333-dddddddddddd';
  const h = harness([pane('pane-reused', other), pane('pane-vox', VOX)]);
  const send = createSessionSend(h.deps);
  const result = await send.send({ sessionId: VOX, text: 'hello', pane: { paneId: 'pane-reused', workspaceId: 'ws-1' } });
  assert.equal(result.paneId, 'pane-vox');
  assert.equal(h.resumeCalls.length, 0);
  assert.ok(h.sent.every((s) => s.paneId !== 'pane-reused'));
});

test('a pane whose title shows another codex thread is not taken as this session\'s pane', async () => {
  const h = harness([pane('pane-codex', VOX, { agent: 'codex', codex_title: { prefix: 'ffffffff' } })]);
  const send = createSessionSend(h.deps);
  const result = await send.send({ sessionId: VOX, text: 'hello' });
  assert.equal(result.resumed, true);
  assert.ok(h.sent.every((s) => s.paneId !== 'pane-codex'));
});
