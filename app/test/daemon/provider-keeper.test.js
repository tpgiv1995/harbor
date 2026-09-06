'use strict';
const { execPath: guiNodeExec } = require('../support/gui-node.js');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { SessionClient } = require('../../src/daemon/client.js');
const {
  codexTranscriptFresh, cursorTranscriptFresh, providerTranscriptFresh, awaitingAnswer,
} = require('../../src/daemon/dormancy.js');
const { mergeProviderKeeperRows } = require('../../src/main/providers/provider-history.js');
const { mergeSidebarModel } = require('../../src/shared/sidebar-model.cjs');
const { SessionSubscription } = require('../../src/main/session-daemon/client.js');

const KEEPER = path.resolve(__dirname, '../../src/daemon/keeper.js');
const CODEX_ID = '019f8250-89cc-73d3-9c1a-30007bced9ff';
const CODEX_ID_2 = '019f8250-89cc-73d3-9c1a-30007bced900';
const CURSOR_ID = '4692b1ae-1af9-4147-879c-65c0b0b48ca2';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(probe, message, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const result = await probe(); if (result) return result; } catch {}
    await sleep(50);
  }
  throw new Error(message);
}

test('keeper annotate persists only provider identity, supports rebind, and survives later state writes', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-keeper-'));
  const statePath = path.join(root, 'state.json');
  const socketPath = path.join(root, 'keeper.sock');
  const configPath = path.join(root, 'keeper.config.json');
  const shell = process.platform === 'win32'
    ? [process.env.ComSpec || 'cmd.exe', '/Q']
    : ['/bin/sh'];
  fs.writeFileSync(configPath, JSON.stringify({
    id: 'keeper-provider-test', argv: shell, cwd: root, env: { ...process.env },
    cols: 80, rows: 24, agent: 'codex', agent_session: null,
    created_at: new Date().toISOString(), state_path: statePath, keeper_socket: socketPath,
  }));
  const keeper = spawn(guiNodeExec, [KEEPER, configPath], {
    env: process.env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  keeper.stderr.on('data', (chunk) => { stderr += chunk; });
  const client = new SessionClient({ socketPath, requestTimeoutMs: 5000 });
  t.after(async () => {
    try { await client.request('terminate', { id: 'keeper-provider-test', signal: 'SIGKILL' }); } catch {}
    client.close();
    if (keeper.exitCode === null) keeper.kill();
    await Promise.race([new Promise((resolve) => keeper.once('exit', resolve)), sleep(2000)]);
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  });
  await waitUntil(() => fs.existsSync(statePath), `keeper did not start: ${stderr}`);

  assert.deepEqual(await client.request('annotate', {
    id: 'keeper-provider-test', agent: 'codex', agent_session: CODEX_ID,
  }), { agent: 'codex', agent_session: CODEX_ID });
  await assert.rejects(client.request('annotate', {
    id: 'keeper-provider-test', agent: 'codex', agent_session: CODEX_ID, cwd: 'foreign',
  }), /accepts only agent and agent_session/);
  await assert.rejects(client.request('annotate', {
    id: 'keeper-provider-test', agent: 'cursor', agent_session: CURSOR_ID,
  }), /conflicts with keeper agent codex/);
  await client.request('annotate', {
    id: 'keeper-provider-test', agent: 'codex', agent_session: CODEX_ID_2,
  });
  await client.request('resize', { id: 'keeper-provider-test', cols: 91, rows: 31 });
  const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(persisted.agent, 'codex');
  assert.equal(persisted.agent_session, CODEX_ID_2);
  assert.equal(persisted.cwd, root, 'a refused foreign field never landed');
  assert.equal(persisted.cols, 91, 'a later persist retained the annotation');

  await client.request('terminate', {
    id: 'keeper-provider-test', signal: 'SIGTERM', dormant: true, reason: 'provider dormancy test',
  });
  const exited = await waitUntil(() => {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    return state.exit ? state : null;
  }, 'keeper never persisted its provider exit');
  assert.equal(exited.agent_session, CODEX_ID_2);
  assert.equal(exited.exit.dormant, true);
});

test('codex freshness follows newest JSON record timestamps and never mtime', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'provider-freshness-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const day = path.join(root, '2026', '08', '30');
  await fsp.mkdir(day, { recursive: true });
  const file = path.join(day, `rollout-stamp-${CODEX_ID}.jsonl`);
  const now = Date.parse('2026-08-30T18:00:00.000Z');
  await fsp.writeFile(file, `${JSON.stringify({ timestamp: '2026-08-30T12:00:00.000Z', type: 'event_msg' })}\n`);
  const freshMtime = new Date(now);
  await fsp.utimes(file, freshMtime, freshMtime);
  assert.equal(await codexTranscriptFresh({ sessionId: CODEX_ID, roots: [root], now, freshMs: 60_000 }), false,
    'fresh mtime with stale records must not veto sleep');

  await fsp.appendFile(file, `${JSON.stringify({ timestamp: '2026-08-30T17:59:30.000Z', type: 'item_completed' })}\n`);
  const staleMtime = new Date(now - 24 * 60 * 60 * 1000);
  await fsp.utimes(file, staleMtime, staleMtime);
  assert.equal(await providerTranscriptFresh({ agent: 'codex', agent_session: CODEX_ID }, {
    codexRoots: [root], now, freshMs: 60_000,
  }), true, 'fresh record with stale mtime must veto sleep');
  await assert.rejects(providerTranscriptFresh({ agent: 'codex', agent_session: null }, {
    codexRoots: [root], now, freshMs: 60_000,
  }), /identity is unresolved/);
});

test('cursor freshness observes record progress, not mtime', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'cursor-freshness-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const dir = path.join(root, 'project', 'agent-transcripts', CURSOR_ID);
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${CURSOR_ID}.jsonl`);
  await fsp.writeFile(file, `${JSON.stringify({ role: 'assistant', type: 'turn_ended' })}\n`);
  const observation = new Map();
  assert.equal(await cursorTranscriptFresh({ sessionId: CURSOR_ID, roots: [root], now: 1000, freshMs: 500, observation }), true);
  assert.equal(await cursorTranscriptFresh({ sessionId: CURSOR_ID, roots: [root], now: 1600, freshMs: 500, observation }), false);
  await fsp.appendFile(file, `${JSON.stringify({ role: 'assistant', type: 'new_record' })}\n`);
  assert.equal(await cursorTranscriptFresh({ sessionId: CURSOR_ID, roots: [root], now: 1700, freshMs: 500, observation }), true);
});

test('captured Cursor trust screen vetoes dormancy while a plain composer does not', () => {
  const capture = fs.readFileSync(path.join(__dirname, '../fixtures/provider-dialogs/cursor-workspace-trust-120x60.txt'), 'utf8');
  assert.equal(awaitingAnswer(capture, 'cursor'), true);
  assert.equal(awaitingAnswer('Cursor Agent\n────────────────\n❯ type a message', 'cursor'), false);
});

test('captured Codex trust screen vetoes dormancy while a plain composer does not', () => {
  const capture = fs.readFileSync(path.join(__dirname, '../fixtures/provider-dialogs/codex-workspace-trust-120x60.txt'), 'utf8');
  assert.equal(awaitingAnswer(capture, 'codex'), true);
  assert.equal(awaitingAnswer('OpenAI Codex\n────────────────\n› Ask Codex to do anything', 'codex'), false);
});

test('live annotated keeper identity and provider history resolve to one rail row', () => {
  const history = [{
    id: CODEX_ID, provider: 'codex', cwd: null, project: 'widget', title: 'Review widget',
    firstPrompt: 'Review widget', lastActive: '2026-08-30 12:00',
  }];
  const live = [{
    pane_id: 'keeper-1', workspace_id: 'keeper-1', cwd: 'C:\\dev\\widget', agent: 'codex',
    agent_session: { kind: 'id', value: CODEX_ID },
  }];
  const mergedHistory = mergeProviderKeeperRows(history, live);
  const model = mergeSidebarModel({
    historySessions: mergedHistory,
    livePanes: live,
    workspaces: [{ workspace_id: 'keeper-1', label: 'widget', cwd: 'C:\\dev\\widget' }],
    now: new Date('2026-08-30T18:00:00Z'),
  });
  const rows = model.projects.flatMap((project) => project.sessions).filter((row) => row.id === CODEX_ID);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].isLive, true);
  assert.equal(rows[0].paneId, 'keeper-1');
  assert.equal(rows[0].cwd, 'C:\\dev\\widget');
});

test('a subscription emits pane.updated when an existing keeper gains provider identity', async () => {
  const snapshots = [
    { snapshot: { panes: [{ pane_id: 'keeper-1', agent: 'codex', agent_session: null }], workspaces: [], tabs: [], layouts: [] } },
    { snapshot: { panes: [{ pane_id: 'keeper-1', agent: 'codex', agent_session: { kind: 'id', value: CODEX_ID } }], workspaces: [], tabs: [], layouts: [] } },
  ];
  const owner = { snapshot: async () => snapshots.shift() };
  const subscription = new SessionSubscription(owner, { pollIntervalMs: 60_000 });
  subscription.seedFromSnapshot((await owner.snapshot()).snapshot);
  const events = [];
  subscription.on('event', (event) => events.push(event));
  await subscription._poll();
  subscription.close();
  assert.deepEqual(events, [{
    event: 'pane.updated',
    data: { pane: { pane_id: 'keeper-1', agent: 'codex', agent_session: { kind: 'id', value: CODEX_ID } } },
  }]);
});
