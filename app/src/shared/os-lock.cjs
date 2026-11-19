'use strict';

// A MUTEX THE OPERATING SYSTEM OWNS (2026-11-18, the adversarial review of
// the pane lock: "two waiters can both read a dead holder. One removes the file
// and acquires the lock. The other then removes the replacement it never
// inspected"). A lock FILE needs staleness rules, pid checks and takeover, and
// every one of those is a race. A listening socket needs none: only one process
// can listen on a name, and the OS tears the listener down the moment its
// process exits or crashes, so a lock can never outlive its holder and never be
// taken from a live one.
//   - win32: a named pipe, \\.\pipe\harbor-lock-<hash>. A second listen on the
//     same name fails with EADDRINUSE, in this process or any other.
//   - linux: the same in the abstract socket namespace (no file at all).
//   - elsewhere (macOS): a socket file in the temp dir. A crash leaves the file
//     behind, so EADDRINUSE is probed with a connect: refused means nobody is
//     listening, and the file is removed and the listen retried. Two waiters
//     can still race on that removal there; Harbor's supported platform is
//     Windows, so this is the honest best without native code.
// Re-entrant within one async call chain (AsyncLocalStorage), so code that
// already holds a lock and calls a helper taking the same lock does not wait on
// itself; concurrent callers in the same process still queue like any other.
// Only WHILE it is held: work started inside the lock that outlives it (a
// background check) carries the chain's context, and must queue again then.

const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');

const held = new AsyncLocalStorage();

function lockAddress(name, platform = process.platform) {
  const hash = crypto.createHash('sha256').update(String(name)).digest('hex').slice(0, 32);
  if (platform === 'win32') return `\\\\.\\pipe\\harbor-lock-${hash}`;
  if (platform === 'linux') return `\0harbor-lock-${hash}`;
  return path.join(os.tmpdir(), `harbor-lock-${hash}.sock`);
}

function listenOnce(address) {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => socket.destroy());
    server.once('error', (error) => resolve({ error }));
    server.listen(address, () => resolve({ server }));
  });
}

function nobodyListening(address) {
  return new Promise((resolve) => {
    const socket = net.connect(address);
    socket.once('connect', () => { socket.destroy(); resolve(false); });
    socket.once('error', (error) => resolve(error.code === 'ECONNREFUSED' || error.code === 'ENOENT'));
  });
}

async function tryAcquire(address, platform) {
  const first = await listenOnce(address);
  if (first.server) return first.server;
  if (first.error?.code !== 'EADDRINUSE') throw first.error;
  if (platform === 'win32' || platform === 'linux') return null;
  if (!(await nobodyListening(address))) return null;
  try { fs.unlinkSync(address); } catch { /* another waiter removed it */ }
  const second = await listenOnce(address);
  return second.server || null;
}

class LockTimeoutError extends Error {
  constructor(name, waitedMs) {
    super(`lock "${name}" is still held after ${Math.round(waitedMs / 1000)} s`);
    this.code = 'LOCK_TIMEOUT';
  }
}

// Runs fn while holding the named lock; fn gets { waited }, true when another
// holder had it first (a caller may then re-check what it decided before). waitMs bounds the wait (Infinity to
// wait forever); a wait that runs out throws LOCK_TIMEOUT and fn never runs.
// onWait fires once, after noticeMs of waiting, for a status line.
async function withLock(name, fn, { waitMs = Infinity, pollMs = 100, noticeMs = 1500, onWait = null, platform = process.platform } = {}) {
  const key = String(name);
  if (held.getStore()?.get(key)?.active) return fn();
  const address = lockAddress(key, platform);
  const started = Date.now();
  let noticed = false;
  let server = null;
  let attempts = 0;
  for (;;) {
    server = await tryAcquire(address, platform);
    if (server) break;
    attempts += 1;
    const waited = Date.now() - started;
    if (waited >= waitMs) throw new LockTimeoutError(key, waited);
    if (!noticed && onWait && waited >= noticeMs) {
      noticed = true;
      try { onWait(); } catch { /* status only */ }
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(1, waitMs - waited))));
  }
  const holding = { active: true };
  const keys = new Map(held.getStore() || []);
  keys.set(key, holding);
  try {
    return await held.run(keys, () => fn({ waited: attempts > 0 }));
  } finally {
    holding.active = false;
    await new Promise((resolve) => server.close(() => resolve()));
  }
}

module.exports = { withLock, lockAddress, LockTimeoutError };
