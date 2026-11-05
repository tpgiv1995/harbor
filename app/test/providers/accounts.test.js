'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createAccountsProvider } = require('../../src/main/providers/accounts.js');

test('resolveSession maps indexer home labels to config homes', async () => {
  const accounts = createAccountsProvider({
    history: { sessionMeta: async () => ({ id: 's1', home: 'team' }) },
    homes: { personal: '/p', team: '/t' },
  });
  assert.deepEqual(await accounts.resolveSession('s1'), {
    provider: 'claude',
    account: 'team',
    home: '/t',
    meta: { id: 's1', home: 'team' },
  });
});

test('resolveSession keeps unknown attribution explicit', async () => {
  const accounts = createAccountsProvider({
    history: { sessionMeta: async () => ({ id: 's2', home: null }) },
  });
  assert.deepEqual(await accounts.resolveSession('s2'), {
    provider: 'claude',
    account: null,
    home: null,
    meta: { id: 's2', home: null },
  });
});

test('a session the index has not seen yet uses the launched profile', async () => {
  const accounts = createAccountsProvider({
    history: { sessionMeta: async () => { throw new Error('harbor-index: session s3 not found'); } },
    homes: { max: '/m', personal: '/p' },
    defaultAccount: 'max',
    launchedHome: (id) => (id === 's3' ? 'personal' : null),
  });
  const r = await accounts.resolveSession('s3');
  assert.equal(r.account, 'personal');
  assert.equal(r.home, '/p');
});

test('a brand-new session with no launch record falls back to the default profile', async () => {
  const accounts = createAccountsProvider({
    history: { sessionMeta: async () => { throw new Error('not found'); } },
    profiles: [{ id: 'max', configHome: '/m', isDefault: true }, { id: 'personal', configHome: '/p' }],
  });
  const r = await accounts.resolveSession('pane:abc');
  assert.deepEqual(r, { provider: 'claude', account: 'max', home: '/m', meta: { id: 'pane:abc', home: null } });
});

test('an indexed but unattributed session uses the launch record, never the default', async () => {
  const history = { sessionMeta: async (id) => ({ id, home: null }) };
  const homes = { max: '/m', personal: '/p' };
  const withLaunch = createAccountsProvider({ history, homes, defaultAccount: 'max', launchedHome: () => 'personal' });
  assert.equal((await withLaunch.resolveSession('s4')).account, 'personal');
  const without = createAccountsProvider({ history, homes, defaultAccount: 'max' });
  assert.equal((await without.resolveSession('s4')).account, null);
});

test('an unknown or throwing launch lookup is ignored', async () => {
  const accounts = createAccountsProvider({
    history: { sessionMeta: async () => { throw new Error('not found'); } },
    homes: { max: '/m' },
    defaultAccount: 'max',
    launchedHome: () => { throw new Error('bridge gone'); },
  });
  assert.equal((await accounts.resolveSession('s5')).account, 'max');
});

// Codex resolution is PROVIDER-SCOPED (2026-10-15): a fresh Codex window used
// to fall back to the default (Claude) profile, and an indexed Codex session,
// whose metadata carries profileId/configHome but no `home`, to nothing.
const MIXED = [
  { id: 'max', provider: 'claude', configHome: '/m', isDefault: true },
  { id: 'cx-plus', provider: 'codex', configHome: '/cx/plus' },
  { id: 'cx-pro', provider: 'codex', configHome: '/cx/pro' },
];
const notIndexed = { sessionMeta: async () => { throw new Error('not found'); } };

test('a provisional Codex window resolves its launch profile, never a Claude home', async () => {
  const accounts = createAccountsProvider({ history: notIndexed, profiles: MIXED });
  assert.deepEqual(await accounts.resolveSession('pane:7', { provider: 'codex', profileId: 'cx-pro' }), {
    provider: 'codex', account: 'cx-pro', home: '/cx/pro', meta: { id: 'pane:7', home: null },
  });
  // No launch profile: the FIRST codex profile is the codex default, as in
  // resolveProviderProfile. The Claude default is never borrowed.
  const fallback = await accounts.resolveSession('pane:8', { provider: 'codex' });
  assert.equal(fallback.account, 'cx-plus');
  assert.equal(fallback.home, '/cx/plus');
  // A Claude profile id handed in as a Codex hint is refused.
  assert.equal((await accounts.resolveSession('pane:9', { provider: 'codex', profileId: 'max' })).account, 'cx-plus');
});

test('an indexed Codex session resolves from its own scan metadata', async () => {
  const meta = { provider: 'codex', cwd: '/w', path: '/cx/pro/sessions/r.jsonl', profileId: 'cx-pro', configHome: '/cx/pro' };
  const accounts = createAccountsProvider({ history: { sessionMeta: async () => meta }, profiles: MIXED });
  const r = await accounts.resolveSession('019a-codex');
  assert.equal(r.provider, 'codex');
  assert.equal(r.account, 'cx-pro');
  assert.equal(r.home, '/cx/pro');
  assert.equal(r.meta.cwd, '/w');
  // The scan's own home wins even with no profile id on the row.
  const unlabelled = createAccountsProvider({
    history: { sessionMeta: async () => ({ provider: 'codex', configHome: '/cx/plus' }) }, profiles: MIXED,
  });
  assert.deepEqual(
    (({ account, home }) => ({ account, home }))(await unlabelled.resolveSession('x')),
    { account: 'cx-plus', home: '/cx/plus' },
  );
});

test('with no Codex profile a Codex session runs against CODEX_HOME, else ~/.codex', async () => {
  const profiles = [{ id: 'max', provider: 'claude', configHome: '/m', isDefault: true }];
  const withEnv = createAccountsProvider({ history: notIndexed, profiles, env: { CODEX_HOME: '/inherited' }, homedir: () => '/u' });
  assert.deepEqual(
    (({ account, home }) => ({ account, home }))(await withEnv.resolveSession('pane:1', { provider: 'codex' })),
    { account: null, home: '/inherited' },
  );
  const bare = createAccountsProvider({ history: notIndexed, profiles, env: {}, homedir: () => '/u' });
  assert.equal((await bare.resolveSession('pane:1', { provider: 'codex' })).home, path.join('/u', '.codex'));
});

test('a Cursor window resolves to no home at all', async () => {
  const accounts = createAccountsProvider({ history: notIndexed, profiles: MIXED });
  assert.deepEqual(await accounts.resolveSession('pane:c', { provider: 'cursor' }), {
    provider: 'cursor', account: null, home: null, meta: { id: 'pane:c', home: null },
  });
});
