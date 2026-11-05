'use strict';

// Send now types the CLI's own chat:sendNow chord (Ctrl+X, a gap, Ctrl+S) into
// a pane whose Claude is holding a queued message. The chord only goes in when
// that is still true under the pane mutex: Harbor's own send is not typing, and
// the CLI's "ctrl+x ctrl+s to send now" hint is on the visible screen. The
// queued screen is a real 2.1.280 capture.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createSessionSend, createLinkRegistry } = require('../../src/main/session-send.js');
const { sendNowChord, CHORD_GAP_MS } = require('../../src/main/send-now.js');

// Every write the send engine can make (send log, unrecognized-screen
// captures) lands in this one directory, removed at the end.
const stateDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'harbor-send-now-test-'));
test.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));

const QUEUED = fs.readFileSync(path.join(__dirname, '../fixtures/composer-enter/queued-above-box-2.1.280.txt'), 'utf8');
const IDLE = 'Claude is working\n' + '─'.repeat(60) + '\n❯ \n' + '─'.repeat(60);

function makeSend({ screen = QUEUED, controlled = 'pane-1', meta = async () => ({ cwd: '/work/toy' }) } = {}) {
  const keys = [];
  const reads = [];
  const sleeps = [];
  const state = { controlledPaneId: controlled, screen };
  const send = createSessionSend({
    snapshot: async () => ({ panes: [{ pane_id: 'pane-1', workspace_id: 'ws-1' }], workspaces: [{ workspace_id: 'ws-1', label: 'toy' }] }),
    readPane: async (paneId, lines, source) => { reads.push(source); return state.screen; },
    terminalBridge: {
      getState: () => ({ controlledPaneId: state.controlledPaneId }),
      requestFocusPane: async ({ paneId }) => { state.controlledPaneId = paneId; return { ok: true }; },
      sendInput: (paneId, text) => {
        if (state.controlledPaneId !== paneId) return { ok: false, reason: 'pane is not focused for control' };
        keys.push(text);
        return { ok: true };
      },
    },
    launchActions: {},
    getSessionMeta: meta,
    links: createLinkRegistry(),
    projectLabelForCwd: () => 'toy',
    sleep: async (ms) => { sleeps.push(ms); },
    sendLogFile: path.join(stateDir, 'send-log.jsonl'),
    captureDir: path.join(stateDir, 'unrecognized-dialogs'),
  });
  return { send, keys, reads, sleeps, state };
}

const pane = { paneId: 'pane-1', workspaceId: 'ws-1' };

test('the chord goes in as two keys with a gap when Claude shows a queued message', async () => {
  const h = makeSend();
  assert.deepEqual(await h.send.sendNow({ sessionId: 's1', pane }), { ok: true });
  assert.deepEqual(h.keys, ['\x18', '\x13']);
  assert.deepEqual(h.sleeps, [CHORD_GAP_MS]);
  assert.deepEqual(h.reads, ['visible'], 'the hint is read off the visible screen, never scrollback');
});

test('no hint on screen: nothing is pressed (queue already drained, or a count left by a dead CLI)', async () => {
  const h = makeSend({ screen: IDLE });
  const result = await h.send.sendNow({ sessionId: 's1', pane });
  assert.equal(result.ok, false);
  assert.match(result.reason, /nothing to send now/);
  assert.deepEqual(h.keys, []);
});

test('an unfocused pane is taken under control before the first key', async () => {
  const h = makeSend({ controlled: null });
  assert.deepEqual(await h.send.sendNow({ sessionId: 's1', pane }), { ok: true });
  assert.deepEqual(h.keys, ['\x18', '\x13']);
});

test('Send now refuses while Harbor is still typing a message into the same session', async () => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  // The send parks on its first await, which is exactly "Harbor's send is in
  // flight" for the session.
  const h = makeSend({ meta: () => held });
  const inFlight = h.send.send({ sessionId: 's1', text: 'typed by Harbor', pane }).catch(() => {});
  const result = await h.send.sendNow({ sessionId: 's1', pane });
  assert.equal(result.ok, false);
  assert.match(result.reason, /still sending/);
  assert.equal(h.keys.includes('\x18'), false, 'no chord while the send is typing');
  h.state.screen = IDLE;
  release({ cwd: '/work/toy' });
  await inFlight;
});

test('no pane, no keys', async () => {
  const h = makeSend();
  assert.equal((await h.send.sendNow({ sessionId: 's1', pane: null })).ok, false);
  assert.deepEqual(h.keys, []);
});

test('the chord stops after a refused first key: a bare Ctrl+S is a different binding', async () => {
  const typed = [];
  const refused = { ok: false, reason: 'pane is not focused for control' };
  const result = await sendNowChord(async (key) => { typed.push(key); return refused; }, async () => {});
  assert.deepEqual(result, refused);
  assert.deepEqual(typed, ['\x18']);
});
