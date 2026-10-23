'use strict';
// Notification controls (off switch, per-window mute), what a "needs you"
// toast says and opens, back-to-back prompts, and answers given in Harbor.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createNotifier } = require('../../src/main/notify.js');
const { createNotifyPrefs, MAX_MUTED } = require('../../src/main/notify-prefs.js');

function makeNotifier({ suppressed = () => false, paneState = () => ({ alive: true, title: 'Toy session' }) } = {}) {
  const toasts = [];
  const badges = [];
  const notifier = createNotifier({
    isSuppressed: suppressed,
    getPaneState: paneState,
    notify: (title, body, meta) => toasts.push({ title, body, meta }),
    setBadgeCount: (count) => badges.push(count),
  });
  const status = (pane_id, agent_status, extra = {}) => notifier.onAgentStatusChanged({
    event: 'pane.agent_status_changed', data: { pane_id, workspace_id: 'w', agent_status, ...extra },
  });
  return { notifier, toasts, badges, status };
}
const prompt = (msg, seq) => ({ agent_status_kind: 'permission', agent_status_msg: msg, agent_status_seq: seq });

test('notifications off, or this window muted: no toast and no badge', () => {
  for (const suppressed of [() => true, (paneId) => paneId === 'p1']) {
    const { notifier, toasts, badges, status } = makeNotifier({ suppressed });
    status('p1', 'working');
    status('p1', 'blocked', prompt('approve Write: /work/toy.txt', 2));
    status('p1', 'working');
    status('p1', 'idle');
    notifier._flushNow();
    assert.equal(toasts.length, 0);
    assert.ok(badges.every((count) => count === 0));
  }
});

test('a "needs you" toast quotes the CLI and names the session; a click opens the window that needs you', () => {
  const { notifier, toasts, status } = makeNotifier();
  status('p1', 'working');
  status('p1', 'blocked', prompt('approve Write: /work/toy.txt', 2));
  notifier._flushNow();
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].body, 'Toy session needs you: approve Write: /work/toy.txt');
  assert.equal(toasts[0].meta.paneId, 'p1');

  const two = makeNotifier();
  two.status('done-pane', 'working');
  two.status('done-pane', 'idle');
  two.status('ask-pane', 'working');
  two.status('ask-pane', 'blocked', prompt('approve Bash: node blue.js', 4));
  two.notifier._flushNow();
  assert.equal(two.toasts[0].body, '1 session finished · 1 needs you');
  assert.equal(two.toasts[0].meta.paneId, 'ask-pane', 'the click goes to the window that needs you');
});

test('a prompt is never held back by background work', () => {
  const { notifier, toasts, status } = makeNotifier({ paneState: () => ({ alive: true, title: 'Toy', background: true }) });
  status('p1', 'working');
  status('p1', 'blocked', prompt('approve Write: /work/toy.txt', 2));
  notifier._flushNow();
  assert.equal(toasts.length, 1);
});

test('a new prompt straight after a prompt toasts; the same one reported again does not', () => {
  const { notifier, toasts, status } = makeNotifier();
  status('p1', 'working');
  status('p1', 'blocked', prompt('approve Write: …/work/toy.txt', 2));
  notifier._flushNow();
  assert.equal(toasts.length, 1);
  // The same prompt again (a repeat report): quiet.
  status('p1', 'blocked', prompt('approve Write: …/work/toy.txt', 2));
  notifier._flushNow();
  assert.equal(toasts.length, 1);
  // Allowed; the CLI worked under the 1 s poll and raised a SAME-TEXT prompt.
  status('p1', 'blocked', prompt('approve Write: …/work/toy.txt', 4));
  notifier._flushNow();
  assert.equal(toasts.length, 2, 'a new seq is a new prompt');
  // A keeper without seq: new words are a new prompt.
  const old = makeNotifier();
  old.status('p2', 'working');
  old.status('p2', 'blocked', prompt('approve Write: /a', null));
  old.status('p2', 'blocked', prompt('approve Write: /a', null));
  old.status('p2', 'blocked', prompt('approve Bash: node blue.js', null));
  old.notifier._flushNow();
  assert.equal(old.toasts.length, 1);
  assert.match(old.toasts[0].body, /approve Bash/);
});

test('the flush announces only the prompt the pane is still on', () => {
  // Prompt 2 replaced prompt 1 while this pane was focused (so 2 was never
  // queued): "needs you" for prompt 1 would describe a request that is gone.
  let focused = false;
  const toasts = [];
  const notifier = createNotifier({
    getPaneState: () => ({ alive: true, title: 'Toy' }),
    getFocusedPaneId: () => (focused ? 'p1' : null),
    isWindowFocused: () => focused,
    notify: (title, body) => toasts.push(body),
  });
  const status = (agent_status, extra) => notifier.onAgentStatusChanged({ data: { pane_id: 'p1', agent_status, ...extra } });
  status('working');
  status('blocked', prompt('approve Write: /a', 2));
  focused = true;
  status('blocked', prompt('approve Write: /b', 3));
  notifier._flushNow();
  assert.deepEqual(toasts, []);
});

test('an answer given in Harbor clears the badge and drops the queued "needs you"', () => {
  const { notifier, toasts, badges, status } = makeNotifier();
  status('p1', 'working');
  status('p1', 'blocked', prompt('approve Write: /work/toy.txt', 2));
  assert.equal(badges.at(-1), 1);
  notifier.answered('p1');
  assert.equal(badges.at(-1), 0);
  notifier._flushNow();
  assert.equal(toasts.length, 0);
  notifier.answered(null); // a payload without a pane is a no-op
});

test('prefs persist, survive a bad file, and cap the mute list', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-notify-prefs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'cache', 'notify-prefs.json');
  const prefs = createNotifyPrefs({ file });
  assert.deepEqual(prefs.get(), { enabled: true, muted: [] });
  prefs.set({ enabled: false });
  prefs.set({ sessionId: 's1', muted: true });
  assert.equal(prefs.isMuted('s1'), true);
  const again = createNotifyPrefs({ file });
  assert.deepEqual(again.get(), { enabled: false, muted: ['s1'] });
  again.set({ sessionId: 's1', muted: false });
  assert.equal(createNotifyPrefs({ file }).isMuted('s1'), false);
  for (let i = 0; i < MAX_MUTED + 5; i += 1) again.set({ sessionId: `s${i}`, muted: true });
  assert.equal(again.get().muted.length, MAX_MUTED);
  fs.writeFileSync(file, '{not json');
  assert.deepEqual(createNotifyPrefs({ file }).get(), { enabled: true, muted: [] });
  assert.equal(prefs.isMuted(''), false);
});

test('main wires the controls, the click and every answer given in Harbor', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/main/index.js'), 'utf8');
  assert.match(source, /isSuppressed: \(paneId\) => !notifyPrefs\.enabled\(\)\s*\|\| notifyPrefs\.isMuted\(sidebarBridge\.notificationState\(paneId\)\?\.sessionId\)/);
  assert.match(source, /notify: \(title, body, meta = \{\}\) => platform\.notify\(title, body, \{ onClick: \(\) => revealPane\(meta\.paneId\) \}\)/);
  const menuAnswer = source.slice(source.indexOf("ipcMain.handle('session:menu-answer'"), source.indexOf("ipcMain.handle('session:send-queue'"));
  assert.match(menuAnswer, /if \(result\?\.ok\) notifier\?\.answered\(payload\?\.pane\?\.paneId\)/, 'a one-click answer and the card both');
  const send = source.slice(source.indexOf("ipcMain.handle('session:send'"), source.indexOf("ipcMain.handle('session:menu-state'"));
  assert.match(send, /notifier\?\.answered\(/, 'a message sent into the pane');
  assert.match(source, /if \(payload\.enabled === false\) notifier\?\.acknowledgeAll\(\)/);
});
