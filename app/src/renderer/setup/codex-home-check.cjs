'use strict';

// THE SETUP WIZARD'S CODEX ACCOUNT CHECK.
//
// A naive read-back per keystroke, with no guard on which answer lands and
// written by array index, mislabels rows: typing `/Users/x/.codex2` passes
// through `/Users/x/.codex` (a real signed-in home), and when that read
// resolves last the `.codex2` row says "Signed in as A" and keeps that email.
// Removing an account while a read is pending writes its answer onto
// whichever row slid into that index.
//
// So a read waits until typing pauses (DEFAULT_DELAY_MS), each read is tagged
// with the row's account id, the path it read and a sequence number, and an
// answer is dropped when a newer read for that row superseded it, when the row
// is gone, or when its home is no longer the path that was read. CommonJS only,
// imported straight from JSX like wizard-model.cjs, so node tests drive it.

const DEFAULT_DELAY_MS = 300;

// The account fields an answer sets, or `prev` untouched when the answer no
// longer belongs to any row (row removed, or its home changed since).
function applyCodexHomeResult(prev, accountId, home, fields) {
  const accounts = prev?.codex?.accounts || [];
  const at = accounts.findIndex((account) => account?.id === accountId);
  if (at < 0 || accounts[at].configHome !== home) return prev;
  return {
    ...prev,
    codex: {
      ...prev.codex,
      accounts: accounts.map((account, i) => (i === at ? { ...account, ...fields } : account)),
    },
  };
}

function createCodexHomeChecker({
  readHome,                 // async ({ home, provider }) => { ok, home: { email, reason } }
  apply,                    // (accountId, home, { email, emailReason }) => void; must itself drop a stale answer (applyCodexHomeResult)
  onChecking = () => {},    // (accountId, boolean) => void
  delayMs = DEFAULT_DELAY_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (typeof readHome !== 'function' || typeof apply !== 'function') {
    throw new TypeError('createCodexHomeChecker requires readHome and apply');
  }
  const timers = new Map();
  const latest = new Map();
  let sequence = 0;
  let disposed = false;

  const stopTimer = (accountId) => {
    if (timers.has(accountId)) clearTimer(timers.get(accountId));
    timers.delete(accountId);
  };

  async function run(accountId, home, token) {
    timers.delete(accountId);
    let result = null;
    try {
      result = await readHome({ home, provider: 'codex' });
    } catch {
      result = null;
    }
    if (disposed || latest.get(accountId) !== token) return;
    latest.delete(accountId);
    onChecking(accountId, false);
    if (result?.ok) apply(accountId, home, { email: result.home?.email ?? null, emailReason: result.home?.reason ?? null });
  }

  // Ask for `home` on row `accountId`. Debounced unless `immediate` (the
  // "Check again" button); any earlier pending or in-flight read for the row
  // is superseded and its answer dropped.
  function check(accountId, home, { immediate = false } = {}) {
    if (disposed || !accountId) return;
    stopTimer(accountId);
    sequence += 1;
    const token = sequence;
    if (!home) {
      latest.delete(accountId);
      onChecking(accountId, false);
      return;
    }
    latest.set(accountId, token);
    onChecking(accountId, true);
    if (immediate) {
      run(accountId, home, token);
      return;
    }
    timers.set(accountId, setTimer(() => { run(accountId, home, token); }, delayMs));
  }

  // The row is going away: nothing pending or in flight may land.
  function cancel(accountId) {
    stopTimer(accountId);
    latest.delete(accountId);
    onChecking(accountId, false);
  }

  function dispose() {
    disposed = true;
    for (const accountId of [...timers.keys()]) stopTimer(accountId);
    latest.clear();
  }

  return { check, cancel, dispose };
}

module.exports = { DEFAULT_DELAY_MS, applyCodexHomeResult, createCodexHomeChecker };
