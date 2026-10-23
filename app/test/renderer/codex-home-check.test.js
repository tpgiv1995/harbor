'use strict';

// The setup wizard's Codex account check raced
// by keystroke and landed answers by array index.

const test = require('node:test');
const assert = require('node:assert/strict');

const { applyCodexHomeResult, createCodexHomeChecker, DEFAULT_DELAY_MS } = require('../../src/renderer/setup/codex-home-check.cjs');

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

// A wizard state, a fake clock, and a readHome whose answers resolve on demand.
function harness(accounts) {
  let state = { codex: { accounts } };
  const reads = [];
  const timers = new Map();
  let nextTimer = 0;
  const busy = {};
  const checker = createCodexHomeChecker({
    readHome: ({ home }) => {
      const d = deferred();
      reads.push({ home, resolve: d.resolve });
      return d.promise;
    },
    apply: (accountId, home, fields) => { state = applyCodexHomeResult(state, accountId, home, fields); },
    onChecking: (accountId, value) => { busy[accountId] = value; },
    setTimer: (fn) => { nextTimer += 1; timers.set(nextTimer, fn); return nextTimer; },
    clearTimer: (id) => { timers.delete(id); },
  });
  const flushTimers = () => { const due = [...timers.values()]; timers.clear(); due.forEach((fn) => fn()); };
  const settle = () => new Promise((r) => setImmediate(r));
  const edit = (id, configHome) => {
    state = { codex: { accounts: state.codex.accounts.map((a) => (a.id === id ? { ...a, configHome, email: null } : a)) } };
    checker.check(id, configHome);
  };
  const remove = (id) => {
    checker.cancel(id);
    state = { codex: { accounts: state.codex.accounts.filter((a) => a.id !== id) } };
  };
  return { checker, reads, busy, flushTimers, settle, edit, remove, get state() { return state; } };
}

const signedIn = (email) => ({ ok: true, home: { email, reason: null } });

test('keystrokes are debounced into one read of the final path', async () => {
  assert.equal(DEFAULT_DELAY_MS, 300);
  const h = harness([{ id: 'codex', configHome: '' }]);
  for (const typed of ['/Users/x/.c', '/Users/x/.codex', '/Users/x/.codex2']) h.edit('codex', typed);
  assert.equal(h.reads.length, 0, 'nothing read while typing');
  assert.equal(h.busy.codex, true);
  h.flushTimers();
  assert.deepEqual(h.reads.map((r) => r.home), ['/Users/x/.codex2']);
  h.reads[0].resolve(signedIn('b@example.com'));
  await h.settle();
  assert.equal(h.state.codex.accounts[0].email, 'b@example.com');
  assert.equal(h.busy.codex, false);
});

test('a read of an earlier path that resolves last never lands on the row', async () => {
  const h = harness([{ id: 'codex', configHome: '' }]);
  h.edit('codex', '/Users/x/.codex');
  h.flushTimers();
  h.edit('codex', '/Users/x/.codex2');
  h.flushTimers();
  assert.deepEqual(h.reads.map((r) => r.home), ['/Users/x/.codex', '/Users/x/.codex2']);
  h.reads[1].resolve({ ok: true, home: { email: null, reason: 'No Codex login in this home.' } });
  await h.settle();
  h.reads[0].resolve(signedIn('a@example.com'));
  await h.settle();
  const row = h.state.codex.accounts[0];
  assert.equal(row.configHome, '/Users/x/.codex2');
  assert.equal(row.email, null, 'the stale "signed in as A" answer was dropped');
  assert.equal(row.emailReason, 'No Codex login in this home.');
});

test('an answer is dropped when the row\'s home changed since, even without a newer read', async () => {
  const h = harness([{ id: 'codex', configHome: '/Users/x/.codex' }]);
  h.checker.check('codex', '/Users/x/.codex', { immediate: true });
  // The home is edited by something that does not ask again (e.g. cleared).
  const edited = { codex: { accounts: [{ id: 'codex', configHome: '/elsewhere', email: null }] } };
  assert.equal(applyCodexHomeResult(edited, 'codex', '/Users/x/.codex', { email: 'a@example.com' }), edited);
  h.reads[0].resolve(signedIn('a@example.com'));
  await h.settle();
  assert.equal(h.state.codex.accounts[0].email, 'a@example.com', 'unchanged home: the answer lands');
});

test('removing an account with a read pending writes nothing to the row that took its place', async () => {
  const h = harness([
    { id: 'codex', configHome: '/Users/x/.codex', email: 'a@example.com' },
    { id: 'codex-2', configHome: '' },
    { id: 'codex-3', configHome: '/Users/x/.codex3', email: 'c@example.com' },
  ]);
  h.edit('codex-2', '/Users/x/.codex2');
  h.flushTimers();
  h.remove('codex-2');
  assert.equal(h.busy['codex-2'], false);
  h.reads[0].resolve(signedIn('b@example.com'));
  await h.settle();
  assert.deepEqual(h.state.codex.accounts.map((a) => [a.id, a.email]), [['codex', 'a@example.com'], ['codex-3', 'c@example.com']]);
});

test('Check again reads at once, and a cleared home cancels a pending read', async () => {
  const h = harness([{ id: 'codex', configHome: '/Users/x/.codex' }]);
  h.checker.check('codex', '/Users/x/.codex', { immediate: true });
  assert.equal(h.reads.length, 1);
  h.edit('codex', '/Users/x/.codexz');
  h.edit('codex', '');
  h.flushTimers();
  assert.equal(h.reads.length, 1, 'no read for an empty home');
  assert.equal(h.busy.codex, false);
  h.reads[0].resolve(signedIn('a@example.com'));
  await h.settle();
  assert.equal(h.state.codex.accounts[0].email, null);
});

test('after dispose nothing lands', async () => {
  const h = harness([{ id: 'codex', configHome: '/Users/x/.codex' }]);
  h.checker.check('codex', '/Users/x/.codex', { immediate: true });
  h.checker.dispose();
  h.reads[0].resolve(signedIn('a@example.com'));
  await h.settle();
  assert.equal(h.state.codex.accounts[0].email, undefined);
});
