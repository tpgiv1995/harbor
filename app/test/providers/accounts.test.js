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
