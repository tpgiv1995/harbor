'use strict';

// Gemini panes get their real conversation id from evidence, the way codex and cursor panes do (2026-11-23): the
// resume argv names it outright; a NEW conversation has no id until its first prompt, so the status tee's record
// (conversation_id + cwd) and the brain folder's birth time are the candidates, and two panes in one folder are told
// apart by the screen. Everything here is synthetic: invented folders, invented ids, invented prompts.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createProviderSessionLinker, listGeminiSessions, readGeminiPrompts, sessionIdFromArgv,
} = require('../../src/main/providers/provider-session-link.js');

const A = '32fe68ca-b177-4dba-86f4-6272f59c04b9';
const B = '48552996-52ce-4950-804b-2fe907e7df28';
const C = '99999999-8888-4777-8666-555555555555';
const tmp = (t) => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'gemini-link-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

// One scratch world: a profile (USERPROFILE), its agy state folder, and Harbor's context dir.
function world(t) {
  const root = tmp(t);
  const profile = path.join(root, 'profile');
  const stateDir = path.join(profile, '.gemini', 'antigravity-cli');
  const contextDir = path.join(root, 'context');
  fs.mkdirSync(contextDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  return { root, profile, stateDir, contextDir };
}
function conversation(w, id, { prompts = [], tee = null, last = null } = {}) {
  const logs = path.join(w.stateDir, 'brain', id, '.system_generated', 'logs');
  fs.mkdirSync(logs, { recursive: true });
  fs.writeFileSync(path.join(logs, 'transcript_full.jsonl'), `${prompts.map((p, i) => JSON.stringify({
    step_index: i, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: `<USER_REQUEST>\n${p}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nthe time\n</ADDITIONAL_METADATA>`,
  })).join('\n')}\n`);
  if (tee) {
    fs.writeFileSync(path.join(w.contextDir, `gemini-${id}.json`), JSON.stringify({
      provider: 'gemini', conversation_id: id, cwd: tee.cwd, home: w.profile, stateDir: w.stateDir, agent_state: 'idle',
    }));
  }
  if (last) {
    fs.mkdirSync(path.join(w.stateDir, 'cache'), { recursive: true });
    fs.writeFileSync(path.join(w.stateDir, 'cache', 'last_conversations.json'), JSON.stringify(last));
  }
}

test('prompts come from the head of the uncut transcript, unwrapped from <USER_REQUEST>', async (t) => {
  const w = world(t);
  conversation(w, A, { prompts: ['first thing I asked', 'second thing'] });
  assert.deepEqual(await readGeminiPrompts(w.stateDir, A), ['first thing I asked', 'second thing']);
  assert.deepEqual(await readGeminiPrompts(w.stateDir, B), [], 'no transcript yet');
});

test('candidates come from the tee, spelled the way the pane spells its folder, and skip folders no pane is in', async (t) => {
  const w = world(t);
  conversation(w, A, { prompts: ['alpha'], tee: { cwd: 'C:\\Work\\Demo' } });
  conversation(w, B, { prompts: ['beta'], tee: { cwd: 'C:\\somewhere\\else' } });
  fs.writeFileSync(path.join(w.contextDir, '11111111-2222-4333-8444-555555555555.json'), JSON.stringify({ cwd: 'C:\\Work\\Demo', session_id: 'x' }));
  const panes = [{ paneId: 'p1', cwd: 'c:/work/demo/', providerHome: w.profile }];
  const found = await listGeminiSessions(panes, { contextDir: w.contextDir, home: w.profile });
  assert.equal(found.length, 1, 'a claude tee file and a conversation in another folder are not candidates');
  assert.equal(found[0].id, A);
  assert.equal(found[0].cwd, 'c:/work/demo/', 'the cwd is the pane\'s own spelling so the exact match downstream holds');
  assert.deepEqual(found[0].texts, ['alpha']);
  assert.ok(found[0].startedMs > 0 && found[0].startedMs <= Date.now());
});

test('without a tee the home\'s cwd -> latest conversation map is the weaker fallback; facts are read once', async (t) => {
  const w = world(t);
  conversation(w, C, { prompts: ['gamma'], last: { 'C:\\work\\demo': C, 'C:\\other': 'not-an-id' } });
  const cache = new Map();
  const panes = [{ paneId: 'p1', cwd: 'C:\\work\\demo', providerHome: w.profile }];
  const first = await listGeminiSessions(panes, { contextDir: w.contextDir, home: w.profile, cache });
  assert.deepEqual(first.map((s) => s.id), [C]);
  fs.rmSync(path.join(w.stateDir, 'brain', C, '.system_generated', 'logs', 'transcript_full.jsonl'));
  const again = await listGeminiSessions(panes, { contextDir: w.contextDir, home: w.profile, cache });
  assert.deepEqual(again[0].texts, ['gamma'], 'a conversation seen once is not re-read every tick');
});

function linkerFor(w, { panes, info, screens = {}, annotate, remember }) {
  const annotated = [];
  const linker = createProviderSessionLinker({
    home: w.profile, profiles: [], contextDir: w.contextDir,
    listPanes: () => panes,
    paneAgentProcess: async (paneId) => info[paneId] || null,
    readPaneText: async (paneId) => screens[paneId] || '',
    annotateSessionIdentity: async (paneId, identity) => { annotated.push([paneId, identity]); if (annotate) await annotate(paneId, identity); },
    rememberLink: remember || (async () => {}),
    lookupSessionMeta: () => null,
  });
  return { linker, annotated };
}
const pane = (id, over = {}) => ({ pane_id: id, agent: 'gemini', agent_session: null, cwd: 'C:\\work\\demo', provider_home: null, exited: false, workspace_id: `ws-${id}`, ...over });

test('a new Gemini pane is linked to the conversation its own status tee reports, and the keeper is annotated', async (t) => {
  const w = world(t);
  const events = [];
  const startedMs = Date.now() - 30_000;
  conversation(w, A, { prompts: ['hello there'], tee: { cwd: 'C:\\work\\demo' } });
  const panes = [pane('p1', { provider_home: w.profile })];
  const { linker, annotated } = linkerFor(w, { panes, info: { p1: { startedMs, cwd: 'C:\\work\\demo', argv: ['agy.exe', '--settings', 'x.json'] } } });
  linker.emitter.on('link', (e) => events.push(e));
  await linker.resolveNow();
  linker.close();
  assert.equal(linker.get('p1'), A);
  assert.deepEqual(annotated, [['p1', { agent: 'gemini', agentSession: A }]], 'the keeper learns the identity (it would refuse gemini before)');
  assert.equal(events[0].sessionId, A);
  assert.equal(events[0].provider, 'gemini');
  assert.equal(linker.apply(panes)[0].agent_session.value, A);
});

test('a conversation older than the pane\'s process cannot be the pane\'s', async (t) => {
  const w = world(t);
  conversation(w, A, { prompts: ['older'], tee: { cwd: 'C:\\work\\demo' } });
  const { linker } = linkerFor(w, { panes: [pane('p1')], info: { p1: { startedMs: Date.now() + 60_000, cwd: 'C:\\work\\demo', argv: [] } } });
  await linker.resolveNow();
  linker.close();
  assert.equal(linker.get('p1'), null);
});

test('two panes in one folder are told apart by the prompt on their screen; a tie that cannot be broken stays unlinked', async (t) => {
  const w = world(t);
  const startedMs = Date.now() - 60_000;
  conversation(w, A, { prompts: ['summarise the quarterly numbers please'], tee: { cwd: 'C:\\work\\demo' } });
  const panes = [pane('p1'), pane('p2')];
  const info = { p1: { startedMs, cwd: 'C:\\work\\demo', argv: [] }, p2: { startedMs: startedMs + 1000, cwd: 'C:\\work\\demo', argv: [] } };
  const withScreen = linkerFor(w, { panes, info, screens: { p1: '> summarise the quarterly numbers please\n  working', p2: '> something else entirely' } });
  await withScreen.linker.resolveNow();
  withScreen.linker.close();
  assert.equal(withScreen.linker.get('p1'), A);
  assert.equal(withScreen.linker.get('p2'), null, 'the other pane is never handed this conversation');
  const blind = linkerFor(w, { panes, info, screens: { p1: '> ?', p2: '> ?' } });
  await blind.linker.resolveNow();
  blind.linker.close();
  assert.equal(blind.linker.get('p1'), null);
  assert.equal(blind.linker.get('p2'), null, 'rendering another conversation in this window would be worse than none');
});

test('a resume names its conversation in argv, so no inference and no tee is needed', async (t) => {
  const w = world(t);
  const argv = ['C:\\tools\\agy.exe', '--dangerously-skip-permissions', '--settings', 'C:\\cache\\gemini\\settings-abc.json', '--conversation', B, '--model', 'gemini-4-neon-high'];
  assert.equal(sessionIdFromArgv(argv), B);
  assert.equal(sessionIdFromArgv(['agy.exe', '--settings', `C:\\cache\\settings-${B}.json`]), null, 'a uuid inside a path is not the argument');
  const { linker, annotated } = linkerFor(w, { panes: [pane('p1')], info: { p1: { startedMs: Date.now(), cwd: 'C:\\work\\demo', argv } } });
  await linker.resolveNow();
  linker.close();
  assert.equal(linker.get('p1'), B);
  assert.equal(annotated[0][1].agent, 'gemini');
});

test('a pane the daemon already named needs no evidence at all, and a failed annotation publishes nothing', async (t) => {
  const w = world(t);
  const named = pane('p1', { agent_session: A });
  const ok = linkerFor(w, { panes: [named], info: {} });
  await ok.linker.resolveNow();
  ok.linker.close();
  assert.equal(ok.linker.get('p1'), A);
  const failing = linkerFor(w, { panes: [pane('p2')], info: { p2: { startedMs: Date.now(), cwd: 'C:\\work\\demo', argv: ['agy', '--conversation', B] } }, annotate: async () => { throw new Error('keeper refused'); } });
  failing.linker.emitter.on('error', () => {});
  await failing.linker.resolveNow();
  failing.linker.close();
  assert.equal(failing.linker.get('p2'), null, 'the overlay is not published before the keeper acknowledges');
});

test('a Gemini pane that has exited is dropped from the links; codex and cursor panes are unaffected by the new source', async (t) => {
  const w = world(t);
  const panes = [pane('p1', { agent_session: A })];
  const { linker } = linkerFor(w, { panes, info: {} });
  await linker.resolveNow();
  assert.equal(linker.get('p1'), A);
  panes[0] = { ...panes[0], exited: true };
  await linker.resolveNow();
  linker.close();
  assert.equal(linker.get('p1'), null);
});

test('a Gemini pane\'s own start time and argv are used, because the process walk would answer with agy\'s short-lived status-line child', async (t) => {
  const w = world(t);
  conversation(w, A, { prompts: ['hello there'], tee: { cwd: 'C:\\work\\demo' } });
  const created = new Date(Date.now() - 30_000).toISOString();
  // The newest child of agy is the cmd.exe running the status line: started just now, argv of a cmd, no conversation.
  const transient = { startedMs: Date.now() + 60_000, cwd: 'C:\\work\\demo', argv: ['cmd.exe', '/c', 'C:\\cache\\gemini\\statusline.cmd'] };
  const panes = [pane('p1', { created_at: created, argv: ['agy.exe', '--settings', 'x.json'] })];
  const walked = [];
  const { linker } = linkerFor(w, { panes, info: new Proxy({}, { get: (_o, paneId) => { walked.push(paneId); return transient; } }) });
  await linker.resolveNow();
  linker.close();
  assert.equal(linker.get('p1'), A, 'linked from the pane\'s own created_at');
  assert.deepEqual(walked, [], 'the process tree was never asked');
  // An older pane record with no created_at still falls back to the walk (and, with this transient answer, is not linked).
  const old = linkerFor(w, { panes: [pane('p2')], info: { p2: transient } });
  await old.linker.resolveNow();
  old.linker.close();
  assert.equal(old.linker.get('p2'), null);
});

test('a resume names its conversation in the pane\'s own argv, with no process walk', async (t) => {
  const w = world(t);
  const panes = [pane('p1', { created_at: new Date().toISOString(), argv: ['agy.exe', '--conversation', B, '--model', 'gemini-4-neon-high'] })];
  const { linker } = linkerFor(w, { panes, info: new Proxy({}, { get: () => assert.fail('no walk') }) });
  await linker.resolveNow();
  linker.close();
  assert.equal(linker.get('p1'), B);
});
