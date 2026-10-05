'use strict';
const { execPath: guiNodeExec } = require('../support/gui-node.js');

// EXIT RECORDS MUST NEVER CARRY JS undefined (2026-08-30).
//
// Live sessiond.log on the Legion showed dormant exits as:
//   exit <id> pid=N code=undefined signal=undefined ... dormant=true reason="idle for 62m..."
// The keeper's onExit path wrote whatever ConPTY handed it. On a win32
// terminal.kill() that is often { exitCode: undefined, signal: undefined }.
// JSON.stringify drops those keys, so the state file has no code/signal, and
// noteExitObserved's template string prints the word "undefined". Every other
// exit path already writes null. Two-sided: the hook forces the leak shape
// ConPTY delivers, and the assertions refuse both the missing-key form and the
// log spelling.

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

// Keeper-only require hook: real pty, but onExit always delivers the
// undefined/undefined shape ConPTY has been writing into dormant exits.
const UNDEFINED_EXIT_HOOK = `'use strict';
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
          let exitCb = null;
          let fired = false;
          const fireUndefined = () => {
            if (fired || !exitCb) return;
            fired = true;
            exitCb({ exitCode: undefined, signal: undefined });
          };
          return new Proxy(terminal, {
            get(target, prop) {
              if (prop === 'onExit') {
                return (cb) => {
                  exitCb = cb;
                  target.onExit(() => { /* real event ignored; we force the leak shape */ });
                  return { dispose() {} };
                };
              }
              if (prop === 'kill') {
                return (...killArgs) => {
                  const result = target.kill(...killArgs);
                  setImmediate(fireUndefined);
                  return result;
                };
              }
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

test('a ConPTY onExit that delivers undefined still records null code and null signal',
  { skip: !IS_WIN32 && 'the undefined leak is the win32 ConPTY dormant-exit shape' }, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-exit-undef-'));
    const socketPath = path.join(dir, 'daemon.sock');
    const hookPath = path.join(dir, 'undefined-exit.js');
    fs.writeFileSync(hookPath, UNDEFINED_EXIT_HOOK);
    const env = {
      ...process.env,
      HARBOR_SESSIOND_DIR: dir,
      HARBOR_SESSIOND_SOCKET: socketPath,
      HARBOR_NO_DAEMON_START: '1',
      NODE_OPTIONS: `--require ${JSON.stringify(hookPath)}`,
    };
    const daemon = spawn(guiNodeExec, [DAEMON], { windowsHide: true, env, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    daemon.stderr.on('data', (chunk) => { stderr += chunk; });
    const client = new SessionClient({ socketPath });
    await waitUntil(async () => {
      try { return (await client.request('health')).ok; } catch { return false; }
    }, `isolated sessiond never answered health, stderr=${stderr}`);
    t.after(async () => {
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

    const { id } = await client.request('spawn', { argv: SHELL_ARGV, cwd: dir, env: {}, cols: 80, rows: 24 });

    // Dormancy's terminate shape: annotated deliberate end, win32 kill, onExit.
    await client.request('terminate', {
      id, signal: 'SIGTERM', dormant: true,
      reason: 'idle for 62m with no cpu; put to sleep to free memory. Resume it from the rail.',
    });
    const state = await waitUntil(() => {
      const value = sessionState(dir, id);
      return value?.exit ? value : null;
    }, 'terminate never produced an exit record under the undefined-onExit hook');

    assert.equal(state.exit.dormant, true);
    assert.ok(Object.hasOwn(state.exit, 'code'),
      'code must be an explicit key; JSON dropping undefined is the leak that printed code=undefined');
    assert.ok(Object.hasOwn(state.exit, 'signal'),
      'signal must be an explicit key; absent means the undefined leak');
    assert.equal(state.exit.code, null, 'undefined from ConPTY becomes null, never a missing key');
    assert.equal(state.exit.signal, null, 'undefined from ConPTY becomes null, never a missing key');

    // Drive the same observation path the RSS heartbeat uses so the log line
    // is the production one, not a hand-rolled formatter.
    await client.request('list');
    const logText = fs.readFileSync(path.join(dir, 'sessiond.log'), 'utf8');
    const exitLine = logText.split('\n').find((line) => line.includes(`exit ${id}`));
    assert.ok(exitLine, `sessiond.log must carry the exit line; log=${logText}`);
    assert.match(exitLine, /code=null/, 'the log must spell null, not the word undefined');
    assert.match(exitLine, /signal=null/, 'the log must spell null, not the word undefined');
    assert.equal(exitLine.includes('undefined'), false,
      `sessiond.log must never print the JS undefined leak: ${exitLine}`);
  });

test('sessiond.log spells null for a legacy exit whose state file omitted code/signal', async (t) => {
  // Defense in depth for records already on disk from before the keeper fix:
  // JSON dropped the undefined keys, so observation must still refuse to print
  // the word undefined.
  const { currentBootId } = require('../../src/daemon/boot-id.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-exit-legacy-'));
  const socketPath = path.join(dir, 'daemon.sock');
  const sessionsDir = path.join(dir, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const id = '00000000-0000-4000-8000-000000000001';
  const at = new Date().toISOString();
  fs.writeFileSync(path.join(sessionsDir, `${id}.json`), JSON.stringify({
    id,
    pid: 23752,
    keeper_pid: 1,
    keeper_socket: path.join(dir, 'dead.sock'),
    boot_id: currentBootId(),
    created_at: at,
    argv: ['cmd.exe'],
    cwd: dir,
    exit: {
      at,
      dormant: true,
      reason: 'idle for 62m with no cpu; put to sleep to free memory. Resume it from the rail.',
    },
  }));
  const env = {
    ...process.env,
    HARBOR_SESSIOND_DIR: dir,
    HARBOR_SESSIOND_SOCKET: socketPath,
    HARBOR_NO_DAEMON_START: '1',
    // Keep the planted exit visible for the assertion window.
    HARBOR_SESSIOND_EXIT_RETENTION_MS: '600000',
  };
  const daemon = spawn(guiNodeExec, [DAEMON], { windowsHide: true, env, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  daemon.stderr.on('data', (chunk) => { stderr += chunk; });
  const client = new SessionClient({ socketPath });
  await waitUntil(async () => {
    try { return (await client.request('health')).ok; } catch { return false; }
  }, `isolated sessiond never answered health, stderr=${stderr}`);
  t.after(async () => {
    client.close();
    if (daemon.exitCode === null) { daemon.kill(); await new Promise((r) => daemon.once('exit', r)); }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await client.request('list');
  const logText = fs.readFileSync(path.join(dir, 'sessiond.log'), 'utf8');
  const exitLine = logText.split('\n').find((line) => line.includes(`exit ${id}`));
  assert.ok(exitLine, `sessiond.log must observe the legacy exit; log=${logText}`);
  assert.match(exitLine, /code=null/);
  assert.match(exitLine, /signal=null/);
  assert.equal(exitLine.includes('undefined'), false, `legacy observation must not print undefined: ${exitLine}`);
});
