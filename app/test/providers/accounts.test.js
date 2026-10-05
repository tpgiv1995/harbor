'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAccountsProvider } = require('../../src/main/providers/accounts.js');

test('resolveSession maps indexer home labels to config homes', async () => {
  const accounts = createAccountsProvider({
    history: { sessionMeta: async () => ({ id: 's1', home: 'team' }) },
    homes: { personal: '/p', team: '/t' },
  });
  assert.deepEqual(await accounts.resolveSession('s1'), {
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
  assert.deepEqual(r, { account: 'max', home: '/m', meta: { id: 'pane:abc', home: null } });
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
