'use strict';

// Gemini through the GUI's launch and resume actions and its new-session window (2026-11-23): `--home` is the profile's
// USERPROFILE root, a resume rides bin/ai, and a new session opens on a provisional pane window because agy cannot take
// a caller-chosen id (its conversation exists only after the first prompt).
const os = require('node:os');
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { buildNewArgv, buildProviderResumeArgv, createLaunchActions } = require('../../src/main/actions/launch.js');
const { revealNewSessionWindow } = require('../../src/main/new-session-window.cjs');

const ROOT_A = path.resolve('/profiles/a');
const PROFILES = [
  { id: 'personal', provider: 'claude', configHome: '/c', isDefault: true },
  { id: 'gem', provider: 'gemini', configHome: ROOT_A, isDefault: false },
];
const CONV = '32fe68ca-b177-4dba-86f4-6272f59c04b9';

test('a new Gemini session carries its profile root, the provider, the model family and the effort', () => {
  assert.deepEqual(buildNewArgv({ account: 'gem', profiles: PROFILES, provider: 'gemini', model: 'gemini-4-hydrogen', effort: 'low' }),
    ['--home', ROOT_A, '--provider', 'gemini', '--model', 'gemini-4-hydrogen', '--effort', 'low']);
  assert.deepEqual(buildNewArgv({ account: 'gem', profiles: PROFILES, provider: 'gemini', model: 'default', effort: 'default' }),
    ['--home', ROOT_A, '--provider', 'gemini'], 'Default sends neither flag');
});

test('with no Gemini profile the session carries no --home: it runs under the user\'s own profile', () => {
  assert.deepEqual(buildNewArgv({ account: 'personal', profiles: [PROFILES[0]], provider: 'gemini', model: 'gemini-4-neon', effort: 'high', prompt: 'hi' }),
    ['--provider', 'gemini', '--model', 'gemini-4-neon', '--effort', 'high', 'hi']);
});

test('a Gemini resume carries its profile\'s root, or a root path as given, and never a Claude or Codex home', () => {
  assert.deepEqual(buildProviderResumeArgv({ provider: 'gemini', id: CONV, detectedHome: 'gem', profiles: PROFILES }), ['--provider', 'gemini', '--resume-id', CONV, '--home', ROOT_A]);
  assert.deepEqual(buildProviderResumeArgv({ provider: 'gemini', id: CONV, detectedHome: ROOT_A, profiles: [] }), ['--provider', 'gemini', '--resume-id', CONV, '--home', ROOT_A]);
  assert.deepEqual(buildProviderResumeArgv({ provider: 'gemini', id: CONV, detectedHome: 'personal', profiles: PROFILES }), ['--provider', 'gemini', '--resume-id', CONV],
    'a Claude profile id is not a Gemini home');
  assert.deepEqual(buildProviderResumeArgv({ provider: 'gemini', id: CONV }), ['--provider', 'gemini', '--resume-id', CONV]);
});

test('resumeProviderSession runs bin/ai for gemini in the session\'s own folder and remembers the identity', async () => {
  const calls = [];
  const remembered = [];
  const launch = createLaunchActions({
    execFile: (command, args, options, cb) => { calls.push({ args, options }); cb(null, '', ''); },
    rememberProviderIdentity: async (fact) => remembered.push(fact), profiles: PROFILES,
  });
  const cwd = os.tmpdir();
  const result = await launch.resumeProviderSession({ provider: 'gemini', cwd, id: CONV, configHome: ROOT_A });
  assert.deepEqual(result.argv, ['--provider', 'gemini', '--resume-id', CONV, '--home', ROOT_A]);
  assert.equal(calls[0].options.cwd, cwd);
  assert.equal(remembered[0].provider, 'gemini');
  await assert.rejects(() => launch.resumeProviderSession({ provider: 'claude', cwd, id: 'x' }), /codex\/cursor\/gemini only/);
  await assert.rejects(() => launch.resumeProviderSession({ provider: 'gemini', cwd: '/nonexistent/deleted', id: CONV }), /no longer exists/);
});

function reveal(provider) {
  const emitted = [];
  const links = [];
  const transcriptCalls = [];
  return {
    emitted, links, transcriptCalls,
    run: () => revealNewSessionWindow({
      result: {}, provider, cwd: 'C:\\work\\demo', account: 'gem', model: 'gemini-4-hydrogen', effort: 'low', stageSlot: 1,
      preIds: new Set(), knownIds: new Set(['old']), sinceMs: 99,
      findFreshPane: async () => ({ paneId: 'fresh-pane' }),
      findFreshTranscript: async (args) => { transcriptCalls.push(args); return CONV; },
      setLink: (id, pane) => links.push([id, pane]), focusPane: () => {}, emitLaunched: (p) => emitted.push(p),
      onPaneReady: async () => {}, refreshHistory: async () => {},
    }),
  };
}

test('a new Gemini session opens provisional on its pane and upgrades to the conversation when it appears', async () => {
  const fx = reveal('gemini');
  await fx.run();
  assert.equal(fx.emitted.length, 2);
  assert.equal(fx.emitted[0].sessionId, 'pane:fresh-pane');
  assert.equal(fx.emitted[0].provisional, true);
  assert.equal(fx.emitted[0].provider, 'gemini');
  assert.equal(fx.emitted[1].sessionId, CONV);
  assert.equal(fx.emitted[1].replacesKey, 'pane:fresh-pane');
  assert.deepEqual(fx.transcriptCalls, [{ cwd: 'C:\\work\\demo', provider: 'gemini', sinceMs: 99, knownIds: new Set(['old']), timeoutMs: 600000 }]);
  assert.deepEqual(fx.links.map(([id]) => id), ['pane:fresh-pane', CONV]);
});

test('a Gemini launch never asks for a minted id: only Claude has one', async () => {
  const fx = reveal('gemini');
  await assert.doesNotReject(fx.run());
  const claude = reveal('claude');
  await assert.rejects(claude.run(), /claude launch returned no session id/);
});

test('a Gemini profile that names its own root is where the new conversation is looked for', async () => {
  const transcriptCalls = [];
  await revealNewSessionWindow({
    result: {}, provider: 'gemini', providerHome: 'C:\\profiles\\second', cwd: 'C:\\work\\demo', account: 'gem2', model: 'gemini-4-hydrogen', effort: 'low', stageSlot: 1,
    preIds: new Set(), knownIds: new Set(), sinceMs: 5,
    findFreshPane: async () => ({ paneId: 'fresh-pane' }),
    findFreshTranscript: async (args) => { transcriptCalls.push(args); return CONV; },
    setLink: () => {}, focusPane: () => {}, emitLaunched: () => {}, onPaneReady: async () => {}, refreshHistory: async () => {},
  });
  assert.equal(transcriptCalls[0].home, 'C:\\profiles\\second');
});
