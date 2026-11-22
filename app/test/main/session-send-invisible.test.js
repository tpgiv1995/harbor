'use strict';

// Claude 2.1.321 strips invisible characters from a prompt before it submits
// and records the cleaned text (2026-11-21: three Vox sends copied out of Teams
// read "could not confirm the message reached the session" although each
// arrived in a third of a second). Harbor types the cleaned text, and its
// delivery check drops invisible characters from both sides.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createSessionSend, createLinkRegistry } = require('../../src/main/session-send.js');

const RULE = '─'.repeat(60);
const dirs = [];
test.after(() => { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }); });

function harness({ provider = 'claude' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-send-invisible-'));
  dirs.push(dir);
  const transcript = path.join(dir, 't.jsonl');
  fs.writeFileSync(transcript, '');
  const sent = [];
  const state = { controlledPaneId: 'pane-1' };
  let draft = '';
  const deps = {
    snapshot: async () => ({ panes: [{ pane_id: 'pane-1', workspace_id: 'ws-1' }], workspaces: [{ workspace_id: 'ws-1', label: 'harbor' }] }),
    terminalBridge: {
      getState: () => ({ controlledPaneId: state.controlledPaneId }),
      requestFocusPane: async ({ paneId }) => { state.controlledPaneId = paneId; return { ok: true }; },
      sendInput: (paneId, text) => {
        sent.push(text);
        if (text === '\r') draft = '';
        else if (!/^[\x00-\x1f\x7f]/.test(text) || text.startsWith('\x1b[200~')) draft += text.replace(/\x1b\[20[01]~/g, '');
        return { ok: true };
      },
      ensureDialogSize: async () => ({ ok: true }),
    },
    launchActions: { resumeSession: async () => {} },
    getSessionMeta: async () => ({ cwd: '/x', path: transcript, provider }),
    links: createLinkRegistry(),
    projectLabelForCwd: () => 'harbor',
    sleep: async () => {},
    imageFileReady: async () => true,
    captureDir: path.join(dir, 'captures'),
    sendLogFile: path.join(dir, 'send-log.jsonl'),
    // Claude's prompt box, drawing whatever has been typed into it; Enter
    // empties it, as a taken send does.
    readPane: async () => `conversation\n${RULE}\n❯ ${draft}\n${RULE}`,
  };
  return { deps, sent, transcript, dir };
}

async function sendAndRecord(h, text, record, { timeoutMs = 400, wait = 600 } = {}) {
  process.env.HARBOR_CONFIRM_TIMEOUT_MS = String(timeoutMs);
  try {
    const send = createSessionSend(h.deps);
    const statuses = [];
    send.emitter.on('status', (value) => statuses.push(value));
    const result = await send.send({ sessionId: 's-1', text, pane: { paneId: 'pane-1' } });
    if (record) await fsp.appendFile(h.transcript, `${JSON.stringify(record(h.sent))}\n`);
    await new Promise((resolve) => setTimeout(resolve, wait));
    return { result, statuses };
  } finally {
    delete process.env.HARBOR_CONFIRM_TIMEOUT_MS;
  }
}

const typedText = (sent) => sent.filter((t) => t !== '\r').map((t) => t.replace(/\x1b\[20[01]~/g, '')).join('');

// The real shape: a Teams copy with zero-width spaces and a soft hyphen, sent
// as a paste, recorded by Claude cleaned and wrapped in its paste pair.
const TEAMS = 'Backup retention.\u200B Deleted client data can be re\u00ADstored for 37 days.\n  - keep at 37\u200B';
const CLEAN = 'Backup retention. Deleted client data can be restored for 37 days.\n  - keep at 37';

test('a Claude send copied out of Teams is typed without its invisible characters', async () => {
  const h = harness();
  await sendAndRecord(h, TEAMS, null, { wait: 0 });
  assert.equal(typedText(h.sent), CLEAN);
  let log = '';
  for (let i = 0; i < 100 && !/claude-invisible-removed/.test(log); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    try { log = fs.readFileSync(h.deps.sendLogFile, 'utf8'); } catch { /* not written yet */ }
  }
  assert.match(log, /"phase":"claude-invisible-removed","removed":3/);
});

test('the cleaned record Claude writes confirms the send: no "could not confirm" error', async () => {
  const h = harness();
  const { statuses } = await sendAndRecord(h, TEAMS, () => ({
    type: 'user',
    origin: { kind: 'human' },
    message: { role: 'user', content: `\n\n<pasted_content id="f46e">\n${CLEAN}\n</pasted_content id="f46e">\n` },
  }));
  assert.equal(statuses.at(-1).phase, 'sent', JSON.stringify(statuses.at(-1)));
});

test('a joiner Claude drops outside an emoji still confirms (both sides compared without invisibles)', async () => {
  const h = harness();
  // Harbor keeps U+200D (it is part of emoji sequences); Claude drops it here,
  // between two letters. The record without it must still confirm.
  const { statuses } = await sendAndRecord(h, 'ab\u200Dcd', () => ({
    type: 'user', origin: { kind: 'human' }, message: { role: 'user', content: 'abcd' },
  }));
  assert.equal(typedText(h.sent), 'ab\u200Dcd');
  assert.equal(statuses.at(-1).phase, 'sent', JSON.stringify(statuses.at(-1)));
});

test('a direction mark in English text is removed before typing, so Claude never holds it for review', async () => {
  const h = harness();
  await sendAndRecord(h, '\u200Eplease check the report', null, { wait: 0 });
  assert.equal(typedText(h.sent), 'please check the report');
});

test('emoji sequences and their variation selectors are typed intact', async () => {
  const h = harness();
  const family = 'family \u{1F468}\u200D\u{1F469}\u200D\u{1F467} and \u2764\uFE0F';
  await sendAndRecord(h, family, null, { wait: 0 });
  assert.equal(typedText(h.sent), family);
});

test('a message that was nothing but invisible characters sends nothing', async () => {
  const h = harness();
  const send = createSessionSend(h.deps);
  await assert.rejects(send.send({ sessionId: 's-1', text: '\u200B\u2060\uFEFF', pane: { paneId: 'pane-1' } }), /nothing to send/);
  assert.deepEqual(h.sent, []);
});
