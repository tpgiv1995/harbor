'use strict';
// CUSTOM SESSION NAMES (2026-11-15, Pat: "can you add a feature that lets me
// rename session/chat names in harbor? like a little pencil icon where i could
// type in a custom title"). The name is Harbor's own record beside config.json,
// never typed into the session (that would wake a sleeping one and bill a
// turn). These specs pin the store, and the bridge both rails are built from:
// a rename shows at once in the bridge that made it AND in a second bridge on
// the same file (the phone server), and clearing it brings the automatic
// title back.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const {
  NAME_MAX, cleanSessionName, parseSessionNames, readSessionNames, setSessionName, applySessionNames,
} = require('../../src/main/session-names.js');
const { createSidebarBridge } = require('../../src/main/sidebar-bridge.js');

function tempFile(t) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'hb-session-names-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'session-names.json');
}

test('a name is cleaned, capped, saved, replaced and cleared, and the file survives garbage', (t) => {
  const file = tempFile(t);
  assert.equal(cleanSessionName('  Vox \n on   work  '), 'Vox on work');
  assert.equal(cleanSessionName('x'.repeat(500)).length, NAME_MAX);
  assert.deepEqual(readSessionNames(file), {}, 'no file is no names');

  setSessionName(file, 'aaa', 'First name', { now: () => new Date('2026-11-15T22:00:00Z') });
  setSessionName(file, 'bbb', 'Other');
  assert.deepEqual(readSessionNames(file).aaa, { title: 'First name', at: '2026-11-15T22:00:00.000Z' });
  assert.equal(setSessionName(file, 'aaa', '  Second  name ').title, 'Second name');
  assert.equal(readSessionNames(file).aaa.title, 'Second name');
  assert.equal(setSessionName(file, 'aaa', '   ').title, null, 'an empty name clears it');
  assert.deepEqual(Object.keys(readSessionNames(file)), ['bbb'], 'and only it');

  assert.throws(() => setSessionName(file, 'pane:123', 'x'), /no lasting id/);
  assert.throws(() => setSessionName(file, 'live:123', 'x'), /no lasting id/);
  assert.throws(() => setSessionName(null, 'aaa', 'x'), /not available/);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['session-names.json'], 'no temp file is left behind');

  fs.writeFileSync(file, '{not json');
  assert.deepEqual(readSessionNames(file), {});
  assert.deepEqual(parseSessionNames(JSON.stringify({ names: { a: { title: '  ' }, b: 'Bare string', c: { title: 'Ok' } } })),
    { b: { title: 'Bare string', at: null }, c: { title: 'Ok', at: null } });
});

test('only renamed rows are copied, and orchestration child tasks keep their title', () => {
  const plain = { id: 'p', title: 'automatic' };
  const named = { id: 'n', title: 'automatic two' };
  const child = { id: 'c', title: 'BATCH TITLE: worker 3' };
  const rows = [plain, named, child];
  assert.equal(applySessionNames(rows, {}), rows, 'no names, the same array');
  const out = applySessionNames(rows, { n: { title: 'Mine' }, c: { title: 'Nope' } });
  assert.equal(out[0], plain, 'an unnamed row keeps its identity');
  assert.deepEqual(out[1], { id: 'n', title: 'Mine', autoTitle: 'automatic two' });
  assert.equal(out[2], child);
});

function fakeHistory() {
  const history = new EventEmitter();
  history.listSessions = async () => [
    { id: 'vox', lastActive: '2026-11-15 15:00', project: 'carrier-bridge', title: 'Harbor release status and server cost', cwd: 'C:\\dev\\carrier-bridge' },
    { id: 'other', lastActive: '2026-11-15 14:00', project: 'carrier-bridge', title: 'Something else', cwd: 'C:\\dev\\carrier-bridge' },
  ];
  history.sessionHomes = async () => ({});
  history.sessionMeta = async () => ({});
  history.sessionPreview = async () => '';
  history.close = () => {};
  return history;
}

function fakeClient() {
  const subscription = new EventEmitter();
  subscription.close = () => {};
  return {
    bootstrap: async () => ({ snapshot: { workspaces: [], panes: [] }, subscription }),
    dormantSessions: async () => ({}),
  };
}

const bridgeOn = (sessionNamesFile) => createSidebarBridge({
  history: fakeHistory(), providerHistory: null, providerSessionLinker: null, createControlClient: () => fakeClient(), sessionNamesFile,
});
const titleIn = (bridge, id) => bridge.getState().model.projects.flatMap((p) => p.sessions).find((s) => s.id === id)?.title;
async function eventually(read, expected, label) {
  for (let i = 0; i < 100; i += 1) {
    if (read() === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(read(), expected, label);
}

test('a rename shows at once where it was made and in a second rail on the same file, and clearing it restores the automatic title', async (t) => {
  const file = tempFile(t);
  const app = bridgeOn(file);
  const phone = bridgeOn(file);
  t.after(() => { app.close(); phone.close(); });
  await app.start();
  await phone.start();
  await eventually(() => titleIn(app, 'vox'), 'Harbor release status and server cost', 'the automatic title first');

  const updates = [];
  app.emitter.on('update', (update) => updates.push(update));
  assert.deepEqual(app.setSessionName('vox', 'Vox (Carrier Bridge contact)'), { ok: true, title: 'Vox (Carrier Bridge contact)' });
  assert.equal(titleIn(app, 'vox'), 'Vox (Carrier Bridge contact)', 'the rail that made it, synchronously');
  assert.ok(updates.length >= 1, 'and the renderer was sent the change');
  assert.equal(titleIn(app, 'other'), 'Something else', 'nothing else moved');
  assert.equal(app.getSessionLabel('vox').title, 'Vox (Carrier Bridge contact)', 'notifications and labels read the name too');
  await eventually(() => titleIn(phone, 'vox'), 'Vox (Carrier Bridge contact)', 'the other rail, through the file watch');

  await app.refreshHistory();
  assert.equal(titleIn(app, 'vox'), 'Vox (Carrier Bridge contact)', 'a history refresh keeps the name');

  assert.deepEqual(app.setSessionName('vox', ''), { ok: true, title: null });
  assert.equal(titleIn(app, 'vox'), 'Harbor release status and server cost', 'cleared: the automatic title is back');
  await eventually(() => titleIn(phone, 'vox'), 'Harbor release status and server cost', 'on the other rail too');
});

test('a rail with no names file shows automatic titles and refuses a rename plainly', async (t) => {
  const bridge = bridgeOn(undefined);
  t.after(() => bridge.close());
  await bridge.start();
  await eventually(() => titleIn(bridge, 'vox'), 'Harbor release status and server cost');
  const result = bridge.setSessionName('vox', 'x');
  assert.equal(result.ok, false);
  assert.match(result.reason, /not available/);
  assert.equal(titleIn(bridge, 'vox'), 'Harbor release status and server cost');
});
