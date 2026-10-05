'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { composeServer } = require('../../src/server/compose.js');
const { createLaunchActions } = require('../../src/main/actions/launch.js');
const { createSessionSend } = require('../../src/main/session-send.js');

async function harness(t, { status = 'idle', screen, survives = false, shared = true, provider = 'claude' } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'phone-plan-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const profiles = ['oak', 'maple', 'birch'].map((id, i) => ({ id, label: id, letter: id[0], color: '#437ffe', provider: i === 2 ? 'codex' : 'claude', configHome: path.join(root, id), email: null, isDefault: i !== 1 }));
  for (const p of profiles) await fs.mkdir(p.configHome);
  const projects = path.join(profiles[0].configHome, 'projects');
  await fs.mkdir(path.join(projects, 'toy'), { recursive: true });
  const transcript = path.join(projects, 'toy', 'toy.jsonl'); await fs.writeFile(transcript, '{}\n');
  if (shared) await fs.symlink(projects, path.join(profiles[1].configHome, 'projects'), process.platform === 'win32' ? 'junction' : 'dir');
  const configFile = path.join(root, 'config.json'); await fs.writeFile(configFile, JSON.stringify({ profiles }));
  const row = { id: 'toy', provider, home: 'oak', paneId: 'old', workspaceId: 'w', isLive: true, agentStatus: status, cwd: root };
  const events = []; let exited = false;
  const sidebar = { emitter: new EventEmitter(), start: async () => {}, close() {}, getState: () => ({ model: { projects: [{ sessions: [row] }] } }),
    getSessionMeta: async () => ({ ...row, path: transcript }), noteLaunchedHome: (id, home) => { row.home = home; events.push(['home', id, home]); } };
  const edge = '─'.repeat(80);
  const bridge = { emitter: new EventEmitter(), start: async () => {}, close() {}, getState: () => ({ controlledPaneId: 'old' }),
    sendInput: (_pane, text) => { events.push(['key', text]); if (text === '\r') exited = !survives; return { ok: true }; } };
  const sessionSend = createSessionSend({ terminalBridge: bridge, readPane: async () => screen ?? `${edge}\n❯ \n${edge}`, sleep: async () => {},
    captureDir: path.join(root, 'captures'), sendLogFile: path.join(root, 'send.jsonl') });
  sessionSend.paneIdSet = async () => new Set(['old']);
  sessionSend.findFreshPane = async args => { events.push(['discover', args.sessionId]); return { paneId: 'fresh', workspaceId: 'w' }; };
  sessionSend.waitForResumedClaudeReady = async () => true;
  const launchActions = createLaunchActions({ profiles, execFile: (...args) => { events.push(['launch', args[1]]); args.at(-1)(null, '', ''); } });
  const env = { ...process.env, HARBOR_NO_DAEMON_START: '1', HARBOR_NO_USAGE_FETCH: '1', HARBOR_CONTEXT_DIR: path.join(root, 'context'), HARBOR_SESSIOND_DIR: path.join(root, 'daemon'), HARBOR_ASK_DIR: path.join(root, 'asks'), HARBOR_TAILNET_LOGINS: 'none' };
  const server = await composeServer({ env, configFile, userDataDir: path.join(root, 'data'), sidebar, terminalBridge: bridge, sessionSend, launchActions,
    sessionOwnerProbe: async () => ({ pid: 123, ownerGone: exited }),
    artifacts: { list: async () => ({ artifacts: [] }), isServable: () => false },
    icons: { list: async () => ({ icons: {} }), watch() {}, filePathFor: async () => null, mimeFor: () => null },
    tasks: { read: async () => ({}), mutate: async () => ({}), subscribe() {}, close() {} },
    links: { all: () => ({}), set: (id, pane) => events.push(['link', id, pane.paneId]) } });
  t.after(() => server.close());
  const payload = { id: 'toy', detectedHome: 'maple', movePlan: { confirmed: true, fromHome: 'oak', paneId: 'old' } };
  return { events, row, payload, sessionSend, profiles, root, call: p => server.router.call('resume-session', p || payload), server };
}

test('phone plan change exits cleanly then resumes the SAME id with chosen --home and proven --live-ok', async t => {
  const h = await harness(t); const result = await h.call();
  assert.equal(result.ok, true); assert.equal(result.sessionId, 'toy'); assert.equal(result.home, 'maple');
  assert.deepEqual(result.argv, ['--resume-id', 'toy', '--home', 'maple', '--live-ok']);
  assert.deepEqual(h.events.filter(e => e[0] === 'key'), [['key', '/exit '], ['key', '\r']]);
  assert.ok(h.events.findIndex(e => e[0] === 'key') < h.events.findIndex(e => e[0] === 'launch'));
  assert.ok(h.events.some(e => e.join() === 'link,toy,fresh')); assert.ok(h.events.some(e => e.join() === 'discover,toy'));
});
for (const status of ['working', 'blocked', 'unknown']) test(`server refuses ${status} plan changes before any exit or resume`, async t => {
  const h = await harness(t, { status }); await assert.rejects(h.call(), /idle/); assert.deepEqual(h.events, []);
});
test('server requires confirmation and rejects stale pane/home confirmations', async t => {
  const h = await harness(t);
  for (const movePlan of [{ confirmed: false }, { confirmed: true, fromHome: 'birch', paneId: 'old' }, { confirmed: true, fromHome: 'oak', paneId: 'different' }]) {
    await assert.rejects(h.call({ ...h.payload, movePlan }), /Confirm|changed/);
  }
  assert.deepEqual(h.events, []);
});
test('server refuses a foreign provider and an unshared transcript before exit', async t => {
  const h = await harness(t); await assert.rejects(h.call({ ...h.payload, detectedHome: 'birch' }), /Claude plan/); assert.deepEqual(h.events, []);
  const separate = await harness(t, { shared: false }); await assert.rejects(separate.call(), /do not share/); assert.deepEqual(separate.events, []);
  const codex = await harness(t, { provider: 'codex' }); await assert.rejects(codex.call(), /Claude only/); assert.deepEqual(codex.events, []);
});
for (const screen of ['', 'PS C:\\Toy>', '─'.repeat(80) + '\n❯ draft text\n' + '─'.repeat(80), '─'.repeat(80) + '\n❯ \n' + '─'.repeat(80) + '\n✻ Working… (esc to interrupt)']) {
  test(`fresh screen refuses unsafe exit: ${screen.slice(-28) || 'unreadable'}`, async t => {
    const h = await harness(t, { screen }); await assert.rejects(h.call(), /idle composer|terminal draft/); assert.deepEqual(h.events, []);
  });
}
test('headless new-session passes the chosen provider plan home into the real launch argv', async t => {
  const h = await harness(t);
  const result = await h.server.router.call('new-session', { folder: h.root, account: 'birch', provider: 'codex', model: 'default' });
  assert.deepEqual(result.argv, ['--home', h.profiles[2].configHome, '--provider', 'codex']);
});
test('ordinary resume still preserves the existing live guard when no owner proof is available', async t => {
  const h = await harness(t); const result = await h.call({ id: 'toy', detectedHome: 'maple' });
  assert.deepEqual(result.argv, ['--resume-id', 'toy', '--home', 'maple']);
  assert.ok(!h.events.some(e => e[0] === 'key'));
});
test('a CLI that survives clean exit is never resumed or force-killed', async t => {
  const h = await harness(t, { survives: true });
  await assert.rejects(h.call(), /did not exit cleanly/);
  assert.equal(h.events.filter(e => e[0] === 'key').length, 2);
  assert.ok(!h.events.some(e => ['launch', 'link', 'home', 'kill'].includes(e[0])));
});
test('plan moves exclude concurrent sends and release the exclusion on failure', async t => {
  const h = await harness(t); let release;
  const move = h.sessionSend.moveIdleSession({ sessionId: 'toy', pane: { paneId: 'old' } }, () => new Promise(resolve => { release = resolve; }));
  await new Promise(r => setImmediate(r));
  await assert.rejects(h.sessionSend.send({ sessionId: 'toy', text: 'Keep this draft' }), /draft is kept/);
  await assert.rejects(h.sessionSend.moveIdleSession({ sessionId: 'toy', pane: { paneId: 'old' } }, () => {}), /pending messages/);
  release(); await move;
  await assert.rejects(h.sessionSend.moveIdleSession({ sessionId: 'toy', pane: { paneId: 'old' } }, () => { throw Error('probe failure'); }), /probe failure/);
  assert.equal(await h.sessionSend.moveIdleSession({ sessionId: 'toy', pane: { paneId: 'old' } }, () => 'released'), 'released');
  assert.deepEqual(h.events, []);
});
test('fresh-pane discovery ignores another conversation launched in the same folder', async () => {
  const sends = createSessionSend({ sleep: async () => {}, snapshot: async () => ({ workspaces: [{ workspace_id: 'w' }], panes: [
    { pane_id: 'wrong', workspace_id: 'w', agent_session: 'another' },
    { pane_id: 'right', workspace_id: 'w', agent_session: { value: 'toy' } },
  ] }) });
  assert.deepEqual(await sends.findFreshPane({ preIds: new Set(), sessionId: 'toy' }), { paneId: 'right', workspaceId: 'w' });
});
