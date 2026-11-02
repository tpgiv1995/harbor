'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { realTmpDir } = require('../support/real-tmpdir.js');
const { createAccountsProvider, readAccountEmails, readCodexAccountEmail } = require('../../src/main/providers/accounts.js');

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

// A synthetic, unsigned token shaped like the ChatGPT login's id_token.
function fakeIdToken(claims) {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'none' })}.${part(claims)}.sig`;
}

test('a Codex account email is read from auth.json id_token claims, and only the email', async (t) => {
  const root = await fsp.mkdtemp(path.join(realTmpDir(), 'harbor-codex-email-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const chatgpt = path.join(root, '.codex');
  const apiKey = path.join(root, '.codex-api');
  const claude = path.join(root, '.claude');
  await fsp.mkdir(chatgpt, { recursive: true });
  await fsp.mkdir(apiKey, { recursive: true });
  await fsp.mkdir(claude, { recursive: true });
  await fsp.writeFile(path.join(chatgpt, 'auth.json'), JSON.stringify({
    tokens: { id_token: fakeIdToken({ email: 'plus@example.com', sub: 'synthetic' }), access_token: 'synthetic-access' },
  }));
  await fsp.writeFile(path.join(apiKey, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'synthetic-key' }));
  await fsp.writeFile(path.join(claude, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'claude@example.com' } }));
  assert.equal(await readCodexAccountEmail(chatgpt), 'plus@example.com');
  assert.equal(await readCodexAccountEmail(apiKey), null);
  assert.equal(await readCodexAccountEmail(path.join(root, 'missing')), null);
  const emails = await readAccountEmails({ profiles: [
    { id: 'p', provider: 'claude', configHome: claude },
    { id: 'c', provider: 'codex', configHome: chatgpt },
    { id: 'k', provider: 'codex', configHome: apiKey },
    { id: 'u', provider: 'cursor', configHome: null },
  ] });
  assert.deepEqual(emails, { p: 'claude@example.com', c: 'plus@example.com', k: null, u: null });
  assert.doesNotMatch(JSON.stringify(emails), /synthetic/);
});
