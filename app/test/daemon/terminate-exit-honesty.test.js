'use strict';
const { execPath: guiNodeExec } = require('../support/gui-node.js');

// A TERMINATE IS NOT DONE UNTIL AN EXIT IS RECORDED (2026-08-14).
//
// closePane resolves when the keeper has SIGNALLED its child, but the session
// only leaves the daemon's list when an exit lands in its state file, and on
// Windows that record hinged entirely on node-pty's ConPTY onExit event. Under
// load a pseudoconsole can tear down without ever firing it (live-caught in
// session-daemon-live.test.js twice in one day: closePane returned, the child
// died, and the pane stayed listed past a 30 second wait). The keeper now
// VERIFIES a win32 terminate: when the child is provably gone and onExit has
// stayed silent, it records the exit itself with the reason named.
//
// Two-sided by construction. Spec 1 swallows onExit registration inside the
// keeper (a require hook hands back a terminal whose onExit never fires),
// which under the old keeper leaves the session listed live forever; the
// asserted exit REASON can only come from the synthesis path, never from a
// working onExit. Spec 2 proves the guard defers: with onExit intact, the
// recorded exit is the pty's own and carries no synthesis reason.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { SessionClient } = require('../../src/daemon/client.js');

const DAEMON = path.resolve(__dirname, '../../src/daemon/daemon.js');
const IS_WIN32 = process.platform === 'win32';
const SHELL_ARGV = IS_WIN32 ? [process.env.ComSpec || 'cmd.exe', '/Q'] : ['/bin/sh'];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(probe, message, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(message);
    await sleep(100);
  }
}

function sessionState(dir, id) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'sessions', `${id}.json`), 'utf8')); }
  catch { return null; }
}

// Keeper-only require hook: the real node-pty spawns the real child, but the
// returned terminal's onExit registration is dropped on the floor, which is
// exactly what a wedged pseudoconsole does to the exit event.
const SWALLOW_HOOK = `'use strict';
if ((process.argv[1] || '').endsWith('keeper.js')) {
  const Module = require('module');
  const realLoad = Module._load;
  Module._load = function (request) {
    const loaded = realLoad.apply(this, arguments);
    if (request === 'node-pty') {
      return {
        ...loaded,
        spawn(...args) {
          const terminal = loaded.spawn(...args);
          return new Proxy(terminal, {
            get(target, prop) {
              if (prop === 'onExit') return () => ({ dispose() {} });
              const value = target[prop];
              return typeof value === 'function' ? value.bind(target) : value;
            },
          });
        },
      };
    }
    return loaded;
  };
}
`;

async function harness(t, { swallowExit }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-exit-honesty-'));
  const socketPath = path.join(dir, 'daemon.sock');
  const env = {
    ...process.env,
    HARBOR_SESSIOND_DIR: dir,
    HARBOR_SESSIOND_SOCKET: socketPath,
    HARBOR_NO_DAEMON_START: '1',
  };
  if (swallowExit) {
    const hookPath = path.join(dir, 'swallow-exit.js');
    fs.writeFileSync(hookPath, SWALLOW_HOOK);
    env.NODE_OPTIONS = `--require ${JSON.stringify(hookPath)}`;
  }
  const daemon = spawn(guiNodeExec, [DAEMON], { windowsHide: true, env, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  daemon.stderr.on('data', (chunk) => { stderr += chunk; });
  const client = new SessionClient({ socketPath });
  await waitUntil(async () => {
    try { return (await client.request('health')).ok; } catch { return false; }
  }, `isolated sessiond never answered health, stderr=${stderr}`);
  t.after(async () => {
    // Roll call from the store's own state files: the red side of spec 1
    // leaves a keeper holding a dead pty, and it must not leak whatever the
    // verdict was.
    const pids = [];
    try {
      for (const name of fs.readdirSync(path.join(dir, 'sessions'))) {
        if (!name.endsWith('.json') || name.endsWith('.config.json')) continue;
        try {
          const state = JSON.parse(fs.readFileSync(path.join(dir, 'sessions', name), 'utf8'));
          pids.push(state.keeper_pid, state.pid);
        } catch {}
      }
    } catch {}
    client.close();
    if (daemon.exitCode === null) { daemon.kill(); await new Promise((r) => daemon.once('exit', r)); }
    for (const pid of pids.filter(Boolean)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { client, dir };
}

test('1. a terminate whose pty exit event never fires still records an honest exit',
  { skip: !IS_WIN32 && 'the verified-gone synthesis is the win32 ConPTY guard' }, async (t) => {
    const { client, dir } = await harness(t, { swallowExit: true });
    const { id } = await client.request('spawn', { argv: SHELL_ARGV, cwd: dir, env: {}, cols: 80, rows: 24 });
    assert.ok(sessionState(dir, id) && !sessionState(dir, id).exit, 'the session starts live');

    await client.request('terminate', { id, signal: 'SIGTERM' });
    const state = await waitUntil(() => {
      const value = sessionState(dir, id);
      return value?.exit ? value : null;
    }, 'terminate never produced an exit record while onExit was swallowed');

    // The reason is the proof: a working onExit writes a code and no reason,
    // so this record can only have come from the verified-gone synthesis.
    assert.match(state.exit.reason || '', /exit event never fired/);
    assert.equal(state.exit.code, null);
  });

test('2. a working pty exit event wins: no synthesis on an ordinary terminate',
  { skip: !IS_WIN32 && 'the verified-gone synthesis is the win32 ConPTY guard' }, async (t) => {
    const { client, dir } = await harness(t, { swallowExit: false });
    const { id } = await client.request('spawn', { argv: SHELL_ARGV, cwd: dir, env: {}, cols: 80, rows: 24 });

    await client.request('terminate', { id, signal: 'SIGTERM' });
    const state = await waitUntil(() => {
      const value = sessionState(dir, id);
      return value?.exit ? value : null;
    }, 'an ordinary terminate never produced an exit record');

    // Wait past the synthesis grace, then assert the record is still the
    // pty's own: no synthesis reason. ConPTY may hand a real code or
    // undefined (normalized to null); either is an onExit landing, not a
    // verified-gone rewrite.
    await sleep(1200);
    const settled = sessionState(dir, id);
    const exit = (settled || state).exit;
    assert.equal(exit.reason, undefined, 'a landed onExit is never overwritten by the synthesis');
    assert.ok(Object.hasOwn(exit, 'code'), 'onExit records an explicit code key');
    assert.equal(typeof exit.code === 'number' || exit.code === null, true,
      `onExit code is a number or null, got ${String(exit.code)}`);
  });
