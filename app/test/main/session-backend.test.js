'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const {
  createControlClient,
  createStreamSupervisor,
  resolveSessionBackend,
} = require('../../src/main/session-daemon/factory.js');
const { SessionDaemonClient } = require('../../src/main/session-daemon/client.js');

class HerdrStandIn { constructor(options) { this.options = options; this.backend = 'herdr'; } }
class SessionStandIn { constructor(options) { this.options = options; this.backend = 'sessiond'; } }
class StreamStandIn extends EventEmitter { constructor(options) { super(); this.options = options; this.backend = 'herdr'; } }
class SessionStreamStandIn extends EventEmitter { constructor(options) { super(); this.options = options; this.backend = 'sessiond'; } }

// The default is sessiond now: Harbor's own daemon, not the pinned third-party
// one. The rollback is still exactly one variable, so this stays two-sided --
// the default must reach sessiond AND an explicit herdr must still reach herdr,
// or the escape hatch is decoration.
test('the same selector drive reaches sessiond by default and herdr only when asked', () => {
  const deps = {
    HerdrClient: HerdrStandIn,
    SessionDaemonClient: SessionStandIn,
    PaneStreamSupervisor: StreamStandIn,
    SessionStreamSupervisor: SessionStreamStandIn,
  };
  const byDefault = createControlClient({
    env: { HARBOR_SESSIOND_DIR: '/tmp/isolated-sessiond' },
    sessionSocketPath: '/isolated/sessiond.sock',
    sessionStorePolicy: { allowed: true },
    ...deps,
  });
  assert.equal(byDefault.backend, 'sessiond');
  assert.equal(byDefault.options.socketPath, '/isolated/sessiond.sock');

  const herdr = createControlClient({
    env: { HARBOR_SESSION_BACKEND: 'herdr' }, socketPath: '/isolated/herdr.sock', ...deps,
  });
  assert.equal(herdr.backend, 'herdr');
  assert.equal(herdr.options.socketPath, '/isolated/herdr.sock');
});

test('the byte bridge follows the same selector and default', () => {
  const deps = {
    PaneStreamSupervisor: StreamStandIn,
    SessionStreamSupervisor: SessionStreamStandIn,
  };
  assert.equal(createStreamSupervisor({
    env: {}, sessionStorePolicy: { allowed: true }, ...deps,
  }).backend, 'sessiond');
  assert.equal(createStreamSupervisor({ env: { HARBOR_SESSION_BACKEND: 'herdr' }, ...deps }).backend, 'herdr');
});

test('sessiond selection refuses before connecting when the isolation policy blocks it', () => {
  assert.throws(() => createControlClient({
    env: { HARBOR_SESSION_BACKEND: 'sessiond' },
    sessionStorePolicy: { allowed: false, reason: 'real store blocked' },
    SessionDaemonClient: SessionStandIn,
  }), /real store blocked/);
  assert.equal(resolveSessionBackend({}), 'sessiond');
  assert.equal(resolveSessionBackend({ HARBOR_SESSION_BACKEND: 'herdr' }), 'herdr');
  assert.equal(resolveSessionBackend({ HARBOR_SESSION_BACKEND: 'sessiond' }), 'sessiond');
  assert.throws(() => resolveSessionBackend({ HARBOR_SESSION_BACKEND: 'other' }), /HARBOR_SESSION_BACKEND/);
});

// A pid that is verifiably NOT running, checked rather than assumed. This spec
// used to hardcode 44, which is dead on an ordinary desktop and ALIVE inside a
// CI container, where the container's own processes hold the low pids. The
// adapter then correctly reported one foreground process and the deep-equal
// below failed, on CI only, for a reason that had nothing to do with the
// adapter. Only ESRCH means gone: EPERM means it exists and is not ours.
function deadPid() {
  for (let pid = 0x40000; pid > 1000; pid -= 7) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return pid; }
  }
  throw new Error('no dead pid available to test against');
}

test('the daemon adapter preserves the existing spawn, input, read, resize, process, and close drive', async () => {
  const calls = [];
  const gone = deadPid();
  const raw = {
    request: async (verb, params) => {
      calls.push([verb, params]);
      if (verb === 'list') return { sessions: [{ id: 'p1', cwd: '/tmp', argv: ['/bin/bash'], pid: gone, exit: null }] };
      if (verb === 'spawn') return { id: 'p2' };
      if (verb === 'screen') return { cols: 90, rows: 30, text: 'DRIVEN', visible: 'DRIVEN', scrollback_lines: 0 };
      if (verb === 'process') return { pid: gone, running: true, exit: null };
      return { ok: true };
    },
    close() {},
  };
  const client = new SessionDaemonClient({ client: raw, env: { SHELL: '/bin/bash' } });
  assert.equal((await client.snapshot()).snapshot.panes[0].pane_id, 'p1');
  assert.equal((await client.createWorkspace({ cwd: '/tmp', cols: 90, rows: 30 })).pane_id, 'p2');
  await client.sendInput('p1', { bytes: Buffer.from('x') });
  assert.equal((await client.readPane('p1', { lines: 12 })).read.text, 'DRIVEN');
  // Shaped like herdr's, because closePaneTab and signalPane read shell_pid and
  // foreground_process_group_id off it: reporting only { pid, running, exit }
  // made worker force-close refuse outright with "no shell pid or process group
  // found for pane". The pid is verifiably dead (see deadPid above), so the
  // foreground list is honestly empty rather than a hollow placeholder entry.
  assert.deepEqual((await client.processInfo('p1')).process_info, {
    pid: gone,
    running: true,
    exit: null,
    shell_pid: gone,
    foreground_process_group_id: gone,
    foreground_processes: [],
  });
  await client.closePane('p1');
  assert.deepEqual(calls.find(([verb]) => verb === 'input'), ['input', { id: 'p1', bytes: 'eA==' }]);
  assert.deepEqual(calls.at(-1), ['terminate', { id: 'p1', signal: 'SIGTERM' }]);
});
