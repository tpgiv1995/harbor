'use strict';
const { execPath: guiNodeExec } = require('../support/gui-node.js');

// Gemini (Google's Antigravity CLI, agy) as a first-class daemon provider (2026-11-23): its identity, the keeper's
// annotate verb and recorded home, and the dormancy veto, which must THROW on anything it cannot resolve so a Gemini
// pane that cannot be resumed is never put to sleep. Every id, path and screen is synthetic or a measured agy 1.5.14
// capture; the daemon and keeper here are isolated, windowless, and die with this test.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { SessionClient } = require('../../src/daemon/client.js');
const { realTmpDir } = require('../support/real-tmpdir.js');
const {
  providerTranscriptFresh, geminiTranscriptFresh, awaitingAnswer, sweepDormancy, findGeminiTranscript,
} = require('../../src/daemon/dormancy.js');
const { raiseLaunchedCli } = require('../../src/daemon/interactive-priority.js');

const ROOT = path.resolve(__dirname, '../..');
const DAEMON = path.join(ROOT, 'src/daemon/daemon.js');
const KEEPER = path.join(ROOT, 'src/daemon/keeper.js');
const CONV = '32fe68ca-b177-4dba-86f4-6272f59c04b9';
const CONV_2 = '48552996-52ce-4950-804b-2fe907e7df28';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(probe, message, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const result = await probe(); if (result) return result; } catch { /* keep waiting */ }
    await sleep(50);
  }
  throw new Error(message);
}

// ---- identity: the daemon names an `agy` process 'gemini' -------------------------------------------------------

test('a session spawned with an agy executable is named gemini, the way cursor-agent is named cursor', async (t) => {
  if (process.platform !== 'win32') return t.skip('the stand-in executable is a copy of cmd.exe');
  const dir = fs.mkdtempSync(path.join(realTmpDir(), 'harbor-gemini-identity-'));
  const socketPath = path.join(dir, 'daemon.sock');
  const stand = path.join(dir, 'agy.exe');
  fs.copyFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe'), stand);
  const daemon = spawn(guiNodeExec, [DAEMON], {
    windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, HARBOR_SESSIOND_DIR: dir, HARBOR_SESSIOND_SOCKET: socketPath, HARBOR_NO_DAEMON_START: '1' },
  });
  let stderr = '';
  daemon.stderr.on('data', (chunk) => { stderr += chunk; });
  const client = new SessionClient({ socketPath });
  t.after(async () => {
    try { for (const s of (await client.request('list')).sessions) await client.request('terminate', { id: s.id, signal: 'SIGKILL' }).catch(() => {}); } catch { /* going away */ }
    client.close();
    if (daemon.exitCode === null) { daemon.kill('SIGTERM'); await Promise.race([new Promise((r) => daemon.once('exit', r)), sleep(3000)]); }
    await sleep(500);
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* best effort */ }
  });
  await waitUntil(async () => (await client.request('health')).ok, `daemon did not answer: ${stderr}`);
  const bare = await client.request('spawn', { argv: [stand, '/Q', '/K'], cwd: dir, env: {}, cols: 80, rows: 24 });
  const listed = (await client.request('list')).sessions.find((s) => s.id === bare.id);
  assert.equal(listed.agent, 'gemini', 'an agy process was a nameless pane before');
  // A launcher that names the agent explicitly (bin/ai does) is not second-guessed.
  const named = await client.request('spawn', { argv: [stand, '/Q', '/K'], cwd: dir, env: {}, cols: 80, rows: 24, agent: 'gemini', agent_session: CONV });
  assert.equal((await client.request('list')).sessions.find((s) => s.id === named.id).agent_session, CONV);
});

// ---- the keeper: annotate and the recorded home ----------------------------------------------------------------

test('a Gemini keeper accepts an identity annotation, records its USERPROFILE as the provider home, and refuses a foreign agent', async (t) => {
  const root = fs.mkdtempSync(path.join(realTmpDir(), 'gemini-keeper-'));
  const statePath = path.join(root, 'state.json');
  const socketPath = path.join(root, 'keeper.sock');
  const configPath = path.join(root, 'keeper.config.json');
  const profile = path.join(root, 'profile');
  const shell = process.platform === 'win32' ? [process.env.ComSpec || 'cmd.exe', '/Q'] : ['/bin/sh'];
  fs.writeFileSync(configPath, JSON.stringify({
    id: 'keeper-gemini-test', argv: shell, cwd: root, env: { ...process.env, USERPROFILE: profile },
    cols: 80, rows: 24, agent: 'gemini', agent_session: null,
    created_at: new Date().toISOString(), state_path: statePath, keeper_socket: socketPath,
  }));
  const keeper = spawn(guiNodeExec, [KEEPER, configPath], { env: process.env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  keeper.stderr.on('data', (chunk) => { stderr += chunk; });
  const client = new SessionClient({ socketPath, requestTimeoutMs: 5000 });
  t.after(async () => {
    try { await client.request('terminate', { id: 'keeper-gemini-test', signal: 'SIGKILL' }); } catch { /* gone */ }
    client.close();
    if (keeper.exitCode === null) keeper.kill();
    await Promise.race([new Promise((resolve) => keeper.once('exit', resolve)), sleep(2000)]);
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  });
  await waitUntil(() => fs.existsSync(statePath), `keeper did not start: ${stderr}`);
  assert.deepEqual(await client.request('annotate', { id: 'keeper-gemini-test', agent: 'gemini', agent_session: CONV }), { agent: 'gemini', agent_session: CONV });
  await assert.rejects(client.request('annotate', { id: 'keeper-gemini-test', agent: 'codex', agent_session: CONV_2 }), /conflicts with keeper agent gemini/);
  await assert.rejects(client.request('annotate', { id: 'keeper-gemini-test', agent: 'gemini', agent_session: 'not-a-uuid' }), /must be a UUID/);
  await assert.rejects(client.request('annotate', { id: 'keeper-gemini-test', agent: 'gemini', agent_session: CONV, cwd: 'foreign' }), /accepts only agent and agent_session/);
  await client.request('resize', { id: 'keeper-gemini-test', cols: 91, rows: 31 });
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(state.agent, 'gemini');
  assert.equal(state.agent_session, CONV);
  assert.equal(state.provider_home, profile, 'agy\'s state follows USERPROFILE, so that is the pane\'s home');
});

// ---- the dormancy veto -----------------------------------------------------------------------------------------

async function brain(root, id, records) {
  const dir = path.join(root, 'brain', id, '.system_generated', 'logs');
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'transcript_full.jsonl'), `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);
}
const NOW = Date.parse('2026-11-24T02:30:00Z');
const FRESH_MS = 60_000;
const rec = (secondsAgo, extra = {}) => ({ step_index: 0, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: new Date(NOW - secondsAgo * 1000).toISOString().replace(/\.\d+Z$/, 'Z'), ...extra });

test('a Gemini pane is busy while its newest record is fresh, judged by created_at and never by file time', async (t) => {
  const root = await fsp.mkdtemp(path.join(realTmpDir(), 'gemini-fresh-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await brain(root, CONV, [rec(3600), rec(10)]);
  const old = new Date(NOW - 24 * 3600 * 1000);
  await fsp.utimes(path.join(root, 'brain', CONV, '.system_generated', 'logs', 'transcript_full.jsonl'), old, old);
  assert.equal(await geminiTranscriptFresh({ sessionId: CONV, roots: [root], now: NOW, freshMs: FRESH_MS }), true, 'a stale mtime does not hide a fresh record');
  await brain(root, CONV_2, [rec(3600), rec(1800)]);
  const fresh = new Date(NOW);
  await fsp.utimes(path.join(root, 'brain', CONV_2, '.system_generated', 'logs', 'transcript_full.jsonl'), fresh, fresh);
  assert.equal(await geminiTranscriptFresh({ sessionId: CONV_2, roots: [root], now: NOW, freshMs: FRESH_MS }), false, 'a fresh mtime does not veto sleep when the records are old');
});

test('the status tee vetoes sleep while agy works or holds a permission menu, which writes no record at all', async (t) => {
  const root = await fsp.mkdtemp(path.join(realTmpDir(), 'gemini-tee-veto-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const context = path.join(root, 'context');
  await fsp.mkdir(context, { recursive: true });
  await brain(root, CONV, [rec(7200)]);
  const tee = (over) => fsp.writeFile(path.join(context, `gemini-${CONV}.json`), JSON.stringify({ conversation_id: CONV, ...over }));
  const ask = () => geminiTranscriptFresh({ sessionId: CONV, roots: [root], now: NOW, freshMs: FRESH_MS, contextDir: context });
  assert.equal(await ask(), false, 'no tee, old records: sleep may proceed');
  await tee({ agent_state: 'idle' });
  assert.equal(await ask(), false);
  await tee({ agent_state: 'working' });
  assert.equal(await ask(), true);
  await tee({ agent_state: 'tool_use', tool_confirmation_pending: true });
  assert.equal(await ask(), true, 'a pending permission menu is work');
  await tee({ agent_state: 'idle', tool_confirmation_pending: true });
  assert.equal(await ask(), true, 'a pending confirmation alone is enough');
  await fsp.writeFile(path.join(context, `gemini-${CONV}.json`), '{torn');
  assert.equal(await ask(), false, 'an unreadable tee is an absent one, not a veto and not a crash');
});

test('an unresolved identity or an unlocatable transcript THROWS, so the sweep leaves the pane awake', async (t) => {
  const root = await fsp.mkdtemp(path.join(realTmpDir(), 'gemini-throws-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await brain(root, CONV, [rec(7200)]);
  const options = { geminiRoots: [root], now: NOW, freshMs: FRESH_MS };
  await assert.rejects(providerTranscriptFresh({ agent: 'gemini', agent_session: null }, options), /identity is unresolved/);
  await assert.rejects(providerTranscriptFresh({ agent: 'gemini', agent_session: 'pane:abc' }, options), /identity is unresolved/);
  await assert.rejects(providerTranscriptFresh({ agent: 'gemini', agent_session: CONV_2 }, options), /transcript not found/);
  await assert.rejects(geminiTranscriptFresh({ sessionId: CONV, roots: [], now: NOW, freshMs: FRESH_MS }), /transcript not found/);
  await fsp.mkdir(path.join(root, 'brain', CONV_2, '.system_generated', 'logs'), { recursive: true });
  await fsp.writeFile(path.join(root, 'brain', CONV_2, '.system_generated', 'logs', 'transcript_full.jsonl'), '');
  await assert.rejects(providerTranscriptFresh({ agent: 'gemini', agent_session: CONV_2 }, options), /no timestamped JSON record/);
  assert.equal(await providerTranscriptFresh({ agent: 'gemini', agent_session: CONV }, options), false, 'a resolved, old conversation may sleep');
  assert.equal(await providerTranscriptFresh({ agent: 'someone-else', agent_session: CONV }, options), false);
});

test('a pane run under another USERPROFILE is found through the home its keeper recorded', async (t) => {
  const own = await fsp.mkdtemp(path.join(realTmpDir(), 'gemini-own-'));
  const other = await fsp.mkdtemp(path.join(realTmpDir(), 'gemini-other-'));
  t.after(() => Promise.all([fsp.rm(own, { recursive: true, force: true }), fsp.rm(other, { recursive: true, force: true })]));
  await brain(path.join(other, '.gemini', 'antigravity-cli'), CONV, [rec(5)]);
  const state = { agent: 'gemini', agent_session: CONV, provider_home: other };
  assert.equal(await providerTranscriptFresh(state, { geminiRoots: [path.join(own, '.gemini', 'antigravity-cli')], now: NOW, freshMs: FRESH_MS }), true);
  await assert.rejects(providerTranscriptFresh({ ...state, provider_home: undefined }, { geminiRoots: [path.join(own, '.gemini', 'antigravity-cli')], now: NOW, freshMs: FRESH_MS }), /not found/);
  assert.equal((await findGeminiTranscript(CONV, [path.join(other, '.gemini', 'antigravity-cli')])).endsWith('transcript_full.jsonl'), true);
});

// ---- the screen: a menu that writes nothing to disk ---------------------------------------------------------------

const PERMISSION = `
> Use the shell to run exactly: echo hi   Then reply with only the output.

● Ran (echo hi) (ctrl+o to expand)

Command
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

Requesting permission for:
   echo hi

Run this command?
> 1. Yes, run command
  2. Yes, and always allow in this conversation for commands that start with 'echo hi'
  3. Yes, and always allow for commands that start with 'echo hi' (Persist to settings.json)
  4. No, cancel

  ↑/↓ Navigate · tab Amend · ctrl+g edit/expand command`;
const TRUST = `
Accessing workspace:

C:\\work\\demo

Do you trust the contents of this project?

Antigravity CLI requires permission to read, edit, and execute files here.

> Yes, I trust this folder
  No, exit

  ↑/↓ Navigate · enter Confirm`;
const IDLE = `
> Use the shell to run exactly: echo hi   Then reply with only the output.
● Ran (echo hi) (ctrl+o to expand)
  hi
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
>
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
? for shortcuts                                                                           auto · Gemini 4 Hydrogen · low`;

test('the real Gemini permission menu, trust dialog and terms screen need an answer; the idle prompt does not', () => {
  assert.equal(awaitingAnswer(PERMISSION, 'gemini'), true);
  assert.equal(awaitingAnswer(TRUST, 'gemini'), true);
  assert.equal(awaitingAnswer('Terms of Service & Data Use\n> [x] Yes, I agree to help improve Antigravity CLI\n[Previous] [Done]', 'gemini'), true);
  assert.equal(awaitingAnswer('Accept this file edit?\n1. Yes\n', 'gemini'), true);
  assert.equal(awaitingAnswer(IDLE, 'gemini'), false);
});

test('the trust dialog is a Gemini marker, not a generic one: without the provider it is invisible', () => {
  assert.equal(awaitingAnswer(TRUST, 'gemini'), true);
  assert.equal(awaitingAnswer(TRUST, 'claude'), false, 'the generic markers never saw this dialog; only the provider list does');
  assert.equal(awaitingAnswer(TRUST, null), false);
});

// ---- the sweep: the two sides of the safety property ----------------------------------------------------------

test('the sweep never sleeps a Gemini pane it cannot resolve or that is working, and sleeps one it can prove idle', async (t) => {
  const { resolveDormancyPolicy, HOUR_MS } = require('../../src/daemon/dormancy.js');
  const root = await fsp.mkdtemp(path.join(realTmpDir(), 'gemini-sweep-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const now = Date.now();
  const context = path.join(root, 'context');
  await fsp.mkdir(context, { recursive: true });
  const old = (id) => brain(root, id, [{ step_index: 0, type: 'PLANNER_RESPONSE', created_at: new Date(now - 3 * HOUR_MS).toISOString() }]);
  const IDLE_ID = CONV, WORKING_ID = CONV_2, GONE_ID = '11111111-2222-4333-8444-555555555555';
  await old(IDLE_ID);
  await old(WORKING_ID);
  await fsp.writeFile(path.join(context, `gemini-${WORKING_ID}.json`), JSON.stringify({ agent_state: 'tool_use', tool_confirmation_pending: true }));
  // Every cheap signal (cpu, the activity stamp, the screen) says "idle for two hours" for all four panes; only the
  // Gemini veto tells them apart.
  const stamp = new Date(now - 2 * HOUR_MS).toISOString();
  const states = [
    { id: 'idle-resolved', agent_session: IDLE_ID },
    { id: 'permission-menu', agent_session: WORKING_ID },
    { id: 'unresolved', agent_session: null },
    { id: 'conversation-gone', agent_session: GONE_ID },
  ].map((state) => ({ ...state, agent: 'gemini', keeper_pid: 1, exit: null, last_activity_at: stamp }));
  const ended = [];
  const logs = [];
  const watch = new Map();
  for (let i = 0; i < 4; i += 1) {
    await sweepDormancy({
      states, now: now + i * 60_000, policy: resolveDormancyPolicy({}), watch, readCpu: () => 1_000_000,
      readScreen: async () => IDLE, terminate: async (state) => { ended.push(state.id); }, log: (m) => logs.push(m),
      workFresh: (state) => providerTranscriptFresh(state, { geminiRoots: [root], contextDir: context, now: now + i * 60_000, freshMs: HOUR_MS }),
    });
  }
  assert.deepEqual(ended, ['idle-resolved'], 'only the pane whose idleness is proven sleeps');
  const text = logs.join('\n');
  assert.match(text, /unresolved's transcript freshness; leaving it alone/);
  assert.match(text, /conversation-gone's transcript freshness; leaving it alone/);
  assert.match(text, /permission-menu is pty-idle but its transcript or subagents are fresh/);
});

// ---- priority ------------------------------------------------------------------------------------------------

test('the priority raise reaches a launcher\'s direct agy.exe child, and only that', () => {
  const raised = [];
  const os = { constants: { priority: { PRIORITY_ABOVE_NORMAL: -7 } }, setPriority: (pid) => { raised.push(pid); } };
  const table = new Map([
    [10, { pid: 10, ppid: 1, name: 'node.exe', created: 100 }],
    [11, { pid: 11, ppid: 10, name: 'agy.exe', created: 200 }],
    [12, { pid: 12, ppid: 11, name: 'agy.exe', created: 300 }],
    [13, { pid: 13, ppid: 10, name: 'cmd.exe', created: 200 }],
  ]);
  assert.deepEqual(raiseLaunchedCli(10, { table, platform: 'win32', os }), [11]);
  assert.deepEqual(raised, [11]);
});
