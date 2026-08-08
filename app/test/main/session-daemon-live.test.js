'use strict';

const { afterEach, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');

const { SessionDaemonClient } = require('../../src/main/session-daemon/client.js');
const { SessionStreamSupervisor } = require('../../src/main/session-daemon/streams.js');
const { extractLiveState } = require('../../src/main/sidebar-bridge.js');
const { mergeSidebarModel } = require('../../src/shared/sidebar-model.cjs');

const ROOT = path.resolve(__dirname, '../..');
const DAEMON = path.join(ROOT, 'src/daemon/daemon.js');
const cleanups = [];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(probe, message, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(50);
  }
  throw new Error(`${message}${lastError ? `: ${lastError.message}` : ''}`);
}

async function startIsolatedSessiond(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `harbor-${label}-`));
  const socketPath = path.join(dir, 'sessiond.sock');
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), `harbor-${label}-profile-`));
  const contextDir = fs.mkdtempSync(path.join(os.tmpdir(), `harbor-${label}-context-`));
  const env = {
    ...process.env,
    HARBOR_SESSION_BACKEND: 'sessiond',
    HARBOR_SESSIOND_DIR: dir,
    HARBOR_SESSIOND_SOCKET: socketPath,
    HARBOR_E2E_USER_DATA: userData,
    HARBOR_CONTEXT_DIR: contextDir,
    HARBOR_NO_DAEMON_START: '1',
    HERDR_SOCKET_PATH: path.join(dir, 'never-real-herdr.sock'),
  };
  const daemon = spawn(process.execPath, [DAEMON], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  daemon.stderr.on('data', (chunk) => { stderr += chunk; });
  const probe = new SessionDaemonClient({ socketPath, env });
  await waitUntil(async () => {
    try { return (await probe.ping()).ok; } catch { return false; }
  }, `isolated sessiond did not answer health, stderr=${stderr}`);
  probe.close();

  const cleanup = async () => {
    const client = new SessionDaemonClient({ socketPath, env });
    try {
      for (const pane of await client.listPanes()) {
        await client.closePane(pane.pane_id).catch(() => {});
      }
    } catch {}
    client.close();
    if (daemon.exitCode === null) {
      daemon.kill('SIGTERM');
      await Promise.race([
        new Promise((resolve) => daemon.once('exit', resolve)),
        sleep(3000),
      ]);
    }
    if (daemon.exitCode === null) daemon.kill('SIGKILL');
    // A KEEPER OUTLIVES ITS DAEMON BY DESIGN, so killing the daemon does not end
    // the session and this teardown leaked one process per spawn. They
    // accumulated across gate runs into the dozens on a live machine, which then
    // failed the herdr control-latency spec's leak check and looked like a flake
    // in an unrelated suite. Read the state files while they are still on disk,
    // then verify the pids are actually gone rather than trusting the close.
    const sessionsDir = path.join(dir, 'sessions');
    let states = [];
    try {
      states = fs.readdirSync(sessionsDir)
        .filter((name) => name.endsWith('.json') && !name.endsWith('.config.json'))
        .map((name) => {
          try { return JSON.parse(fs.readFileSync(path.join(sessionsDir, name), 'utf8')); } catch { return null; }
        })
        .filter(Boolean);
    } catch {}
    for (const state of states) {
      for (const pid of [state.pid, state.keeper_pid].filter(Boolean)) {
        for (const signal of ['SIGTERM', 'SIGKILL']) {
          try { process.kill(pid, 0); } catch { break; } // already gone
          try { process.kill(pid, signal); } catch {}
          await sleep(250);
        }
      }
    }
    for (const target of [dir, userData, contextDir]) fs.rmSync(target, { recursive: true, force: true });
  };
  cleanups.push(cleanup);
  return { dir, socketPath, env };
}

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

test('control adapter drives snapshot, spawn, input, screen, process, and close against a real sessiond pty', async () => {
  const harness = await startIsolatedSessiond('sessiond-control-live');
  const client = new SessionDaemonClient({ socketPath: harness.socketPath, env: harness.env });

  const initial = await client.snapshot();
  assert.deepEqual(initial.snapshot.panes, [], 'snapshot must read the isolated daemon, not another backend');

  const created = await client.createWorkspace({
    argv: ['/bin/bash', '--noprofile', '--norc'],
    cwd: harness.dir,
    env: { PS1: 'SESSIOND_CONTROL> ' },
    cols: 73,
    rows: 29,
  });
  assert.match(created.pane_id, /^[a-f0-9-]+$/, 'createWorkspace must return the real spawned pane id');
  assert.equal((await client.snapshot()).snapshot.panes[0].pane_id, created.pane_id);

  await client.sendInput(created.pane_id, { bytes: Buffer.from("printf 'CONTROL_BYTES_REACHED_PTY\\n'\n") });
  const read = await waitUntil(async () => {
    const value = await client.readPane(created.pane_id, { lines: 200 });
    return value.read.text.includes('CONTROL_BYTES_REACHED_PTY') ? value : null;
  }, 'sendInput bytes did not reach the real pty through the control adapter');
  assert.match(read.read.text, /CONTROL_BYTES_REACHED_PTY/);
  assert.equal(read.screen.cols, 73);
  assert.equal(read.screen.rows, 29);

  const processInfo = await client.processInfo(created.pane_id);
  assert.equal(processInfo.process_info.running, true);
  assert.ok(processInfo.process_info.pid > 1);

  const closed = await client.closePane(created.pane_id);
  assert.equal(closed.signaled, true);
  await waitUntil(async () => !(await client.processInfo(created.pane_id)).process_info.running,
    'closePane did not stop the real pty process');
  assert.deepEqual((await client.snapshot()).snapshot.panes, [], 'closed panes must disappear from the Harbor snapshot');
  client.close();
});

test('spawn persists declared identity, derives known agents, and leaves a plain shell unidentified', async () => {
  const harness = await startIsolatedSessiond('sessiond-identity-live');
  const client = new SessionDaemonClient({ socketPath: harness.socketPath, env: harness.env });
  const declaredSession = randomUUID();
  const ignoredDerivedSession = randomUUID();
  const derivedClaudeSession = randomUUID();
  const fakeClaude = path.join(harness.dir, 'claude');
  const fakeCodex = path.join(harness.dir, 'codex');
  const fakeCursor = path.join(harness.dir, 'cursor-agent');
  for (const executable of [fakeClaude, fakeCodex, fakeCursor]) {
    fs.writeFileSync(executable, '#!/bin/sh\nexec /bin/bash --noprofile --norc\n', { mode: 0o700 });
  }

  const declared = await client.createWorkspace({
    argv: [fakeClaude, '--session-id', ignoredDerivedSession],
    cwd: harness.dir, env: {}, cols: 80, rows: 30,
    agent: 'codex', agent_session: declaredSession,
  });
  const derivedClaude = await client.createWorkspace({
    argv: [fakeClaude, '--session-id', derivedClaudeSession, '--noprofile', '--norc'],
    cwd: harness.dir, env: {}, cols: 80, rows: 30,
  });
  const derivedCodex = await client.createWorkspace({
    argv: [fakeCodex, '--noprofile', '--norc'], cwd: harness.dir, env: {}, cols: 80, rows: 30,
  });
  const derivedCursor = await client.createWorkspace({
    argv: [fakeCursor, '--noprofile', '--norc'], cwd: harness.dir, env: {}, cols: 80, rows: 30,
  });
  const shell = await client.createWorkspace({
    argv: ['/bin/bash', '--noprofile', '--norc'], cwd: harness.dir, env: {}, cols: 80, rows: 30,
  });

  const records = (await client.request('list')).sessions;
  const recordFor = (created) => records.find((record) => record.id === created.pane_id);
  assert.equal(recordFor(declared).agent, 'codex', 'an explicit provider must override the claude binary name');
  assert.equal(recordFor(declared).agent_session, declaredSession);
  assert.equal(recordFor(derivedClaude).agent, 'claude');
  assert.equal(recordFor(derivedClaude).agent_session, derivedClaudeSession);
  assert.equal(recordFor(derivedCodex).agent, 'codex');
  assert.equal(recordFor(derivedCodex).agent_session, null);
  assert.equal(recordFor(derivedCursor).agent, 'cursor');
  assert.equal(recordFor(derivedCursor).agent_session, null);
  assert.equal(recordFor(shell).agent, null, 'a bare shell must never be invented as an agent');
  assert.equal(recordFor(shell).agent_session, null);

  const panes = (await client.snapshot()).snapshot.panes;
  const paneFor = (created) => panes.find((pane) => pane.pane_id === created.pane_id);
  assert.equal(paneFor(declared).agent, 'codex');
  assert.deepEqual(paneFor(declared).agent_session, { kind: 'id', value: declaredSession });
  assert.equal(paneFor(derivedClaude).agent, 'claude');
  assert.deepEqual(paneFor(derivedClaude).agent_session, { kind: 'id', value: derivedClaudeSession });
  assert.equal(paneFor(shell).agent, null);
  assert.equal(paneFor(shell).agent_session, null);

  const snapshot = await client.snapshot();
  const live = extractLiveState(snapshot);
  assert.equal(live.panes.some((pane) => pane.pane_id === shell.pane_id), false,
    'a pty with no agent identity must be excluded from the rail input');
  const model = mergeSidebarModel({ livePanes: live.panes, workspaces: live.workspaces });
  const rows = model.projects.flatMap((project) => project.sessions);
  assert.ok(rows.some((row) => row.id === declaredSession && row.paneId === declared.pane_id),
    'declared identity must reach the rail under the minted session id');
  assert.ok(rows.some((row) => row.id === derivedClaudeSession && row.paneId === derivedClaude.pane_id),
    'derived Claude identity must reach the rail under the argv session id');
  client.close();
});

test('byte bridge observes real frames, sends bytes, resizes, sizes dialogs, and fully detaches', async () => {
  const harness = await startIsolatedSessiond('sessiond-stream-live');
  const control = new SessionDaemonClient({ socketPath: harness.socketPath, env: harness.env });
  const created = await control.createWorkspace({
    argv: ['/bin/bash', '--noprofile', '--norc'],
    cwd: harness.dir,
    env: { PS1: 'SESSIOND_STREAM> ' },
    cols: 61,
    rows: 27,
  });
  const paneId = created.pane_id;
  const streams = new SessionStreamSupervisor({ socketPath: harness.socketPath, env: harness.env });
  const frames = [];
  streams.on('frame', (frame) => frames.push(frame));
  streams.attachObserver(paneId);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('attachObserver did not attach to the real daemon')), 10000);
    streams.once('observer-attached', () => { clearTimeout(timer); resolve(); });
    streams.once('error', (error) => { clearTimeout(timer); reject(error); });
  });

  streams.acquireControl(paneId);
  streams.sendInput(paneId, { bytes: Buffer.from("printf 'STREAM_BYTES_REACHED_PTY\\n'\n") });
  await waitUntil(() => Buffer.concat(frames
    .filter((frame) => frame.paneId === paneId)
    .map((frame) => frame.bytes)).toString('utf8').includes('STREAM_BYTES_REACHED_PTY'),
  'attachObserver did not receive a real frame containing echoed sendInput bytes');

  streams.resize(paneId, { cols: 91, rows: 37 });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('resize did not complete against the real daemon')), 10000);
    streams.once('pane-sized', (size) => {
      if (size.paneId !== paneId) return;
      clearTimeout(timer);
      resolve();
    });
    streams.once('error', (error) => { clearTimeout(timer); reject(error); });
  });
  streams.sendInput(paneId, "stty size; printf 'STREAM_RESIZE_VISIBLE\\n'\n");
  const resized = await waitUntil(async () => {
    const value = await control.readPane(paneId, { lines: 200 });
    return /37 91[\s\S]*STREAM_RESIZE_VISIBLE/.test(value.read.text) ? value : null;
  }, 'resize did not change the child view reported by stty size');
  assert.equal(resized.screen.cols, 91);
  assert.equal(resized.screen.rows, 37);

  assert.deepEqual(await streams.ensureDialogSize(paneId, { cols: 123, rows: 57 }),
    { ok: true, via: 'sessiond', cols: 123, rows: 57 });
  streams.sendInput(paneId, "stty size; printf 'DIALOG_SIZE_VISIBLE\\n'\n");
  await waitUntil(async () => {
    const value = await control.readPane(paneId, { lines: 200 });
    return /57 123[\s\S]*DIALOG_SIZE_VISIBLE/.test(value.read.text);
  }, 'ensureDialogSize did not change the real pty dimensions');

  streams.releaseControl(paneId);
  assert.equal(streams.controllerReady(paneId), false, 'releaseControl must drop exclusive input authority');
  assert.throws(() => streams.sendInput(paneId, 'must not land'), /acquireControl/);
  streams.detach();
  assert.equal(streams.observers.size, 0);
  assert.equal(streams.controller, null);
  assert.deepEqual(streams.childPids(), []);

  await control.closePane(paneId);
  await waitUntil(async () => !(await control.processInfo(paneId)).process_info.running,
    'test cleanup closePane did not stop the real pty');
  assert.deepEqual((await control.snapshot()).snapshot.panes, [], 'detach test must leave no live sessions behind');
  control.close();
});

// A subscription that nobody listens to is the shape of the 2026-08-05 bug: the
// adapter built one, polled it every second, emitted `pane.created` into an
// EventEmitter with no listeners, and returned. The herdr client has always
// wired `opts.onEvent`; the adapter merely resembled it. The consequence was
// not subtle: on sessiond the rail only ever showed what existed at boot, so
// every session Harbor launched was invisible until a restart.
test('bootstrap delivers live session events to its caller and labels the project the way history does', async () => {
  const harness = await startIsolatedSessiond('sessiond-bootstrap-events');
  const client = new SessionDaemonClient({ socketPath: harness.socketPath, env: harness.env });

  const events = [];
  const boot = await client.bootstrap({
    onEvent: (event) => events.push(event),
    subscriptionOptions: { pollIntervalMs: 50 },
  });
  assert.deepEqual(boot.snapshot.panes, [], 'the isolated daemon starts empty');

  const created = await client.createWorkspace({
    argv: ['/bin/bash', '--noprofile', '--norc'],
    cwd: harness.dir,
    env: {},
    cols: 80,
    rows: 24,
    agent: 'claude',
    agent_session: randomUUID(),
  });

  const paneCreated = await waitUntil(
    () => events.find((event) => event.event === 'pane.created' && event.data?.pane?.pane_id === created.pane_id),
    'bootstrap never delivered pane.created to its caller',
    5000,
  );
  assert.equal(paneCreated.data.pane.agent, 'claude');

  // The workspace label is what the rail groups by. Reporting the raw cwd here
  // splits one folder into two rail groups (live sessions under an absolute
  // path, their history under the real project name), which is a defect the
  // pane assertion above cannot see.
  const workspaceCreated = events.find((event) => event.event === 'workspace.created');
  assert.ok(workspaceCreated, 'a new session announces its workspace');
  assert.notEqual(
    workspaceCreated.data.workspace.label,
    harness.dir,
    'a workspace label is a project label, never the raw cwd',
  );
  assert.equal(workspaceCreated.data.workspace.cwd, harness.dir, 'the cwd is still reported verbatim');

  boot.subscription.close();
  await client.closePane(created.pane_id).catch(() => {});
  client.close();
});

// Worker close captures a pane's process BEFORE closing, because a clean close
// orphans a `claude --resume` and its MCP children, and pane-absence alone must
// never read as "worker killed". It reads shell_pid and
// foreground_process_group_id, and the provider linker reads the DEEPEST
// foreground process to learn which codex/cursor session a pane holds. sessiond
// reported only { pid, running, exit }, so on that backend force-close refused
// outright with "no shell pid or process group found for pane".
test('processInfo reports a pane process the way its consumers read it, deepest child last', async () => {
  const harness = await startIsolatedSessiond('sessiond-process-info');
  const client = new SessionDaemonClient({ socketPath: harness.socketPath, env: harness.env });

  const created = await client.createWorkspace({
    argv: ['/bin/bash', '--noprofile', '--norc'],
    cwd: harness.dir,
    env: { PS1: '$ ', PATH: process.env.PATH },
    cols: 80,
    rows: 24,
  });

  const shell = await waitUntil(
    async () => {
      const info = (await client.processInfo(created.pane_id)).process_info;
      return info?.shell_pid ? info : null;
    },
    'processInfo never reported a shell pid',
    5000,
  );
  // Both fields are what closePaneTab and signalPane actually read. Asserting
  // only `pid` would pass while force-close stayed broken.
  assert.equal(typeof shell.shell_pid, 'number', 'closePaneTab reads shell_pid');
  assert.equal(shell.foreground_process_group_id, shell.shell_pid, 'signalPane kills the process group');
  assert.equal(shell.running, true);

  // Start a distinguishable child so the chain has real depth, then require the
  // linker's own accessor (last element) to land on it.
  await client.sendText(created.pane_id, 'sleep 47\n');
  const deepest = await waitUntil(
    async () => {
      const info = (await client.processInfo(created.pane_id)).process_info;
      const procs = info?.foreground_processes || [];
      const last = procs[procs.length - 1];
      return last?.argv?.join(' ').includes('sleep 47') ? last : null;
    },
    'the deepest foreground process never became the child the pane is running',
    8000,
  );
  assert.notEqual(deepest.pid, shell.shell_pid, 'the deepest process is the child, not the shell');
  assert.equal(deepest.cwd, harness.dir, 'a foreground process reports a resolvable cwd');

  await client.closePane(created.pane_id).catch(() => {});
  client.close();
});

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

// The herdr backend proves this in test/herdr/worker-close.integration.test.js.
// The same guarantee has to hold on sessiond, and it is the one that kills
// processes, so it is proved the same way: against a REAL pty, by checking the
// pid, not by trusting the returned object. `verified: true` has to mean gone.
test('worker close verifies the real process died on sessiond, by tab close and by force signal', async () => {
  const harness = await startIsolatedSessiond('sessiond-worker-close');
  const { createTerminalBridge } = require('../../src/main/terminal-bridge.js');
  const bridge = createTerminalBridge({
    env: harness.env,
    sessionSocketPath: harness.socketPath,
    closePollIntervalMs: 100,
    closePollAttempts: 50,
  });
  await bridge.start();
  cleanups.push(async () => bridge.close());

  const client = new SessionDaemonClient({ socketPath: harness.socketPath, env: harness.env });

  const scratch = async () => {
    const created = await client.createWorkspace({
      argv: ['/bin/bash', '--noprofile', '--norc'],
      cwd: harness.dir,
      env: { PS1: '$ ', PATH: process.env.PATH },
      cols: 80,
      rows: 24,
    });
    const info = await waitUntil(
      async () => {
        const seen = (await client.processInfo(created.pane_id)).process_info;
        return seen?.shell_pid ? seen : null;
      },
      'scratch pane never reported a shell pid',
      5000,
    );
    // The bridge acts on its own subscription state, so give it the pane.
    await waitUntil(
      async () => (await client.getPane(created.pane_id)) != null,
      'scratch pane never reached the snapshot',
      5000,
    );
    return { paneId: created.pane_id, pid: info.shell_pid };
  };

  const closed = await scratch();
  assert.ok(pidAlive(closed.pid), `scratch shell ${closed.pid} starts alive`);
  const tabResult = await bridge.closePaneTab(closed.paneId);
  assert.equal(tabResult.ok, true, `tab close failed: ${tabResult.reason}`);
  assert.equal(tabResult.verified, true, 'a close that cannot verify must not report verified');
  await waitUntil(() => !pidAlive(closed.pid), `shell ${closed.pid} survived a verified close`, 8000);

  const forced = await scratch();
  assert.ok(pidAlive(forced.pid), `scratch shell ${forced.pid} starts alive`);
  const forceResult = await bridge.closePaneTab(forced.paneId, { force: true });
  assert.equal(forceResult.ok, true, `force close failed: ${forceResult.reason}`);
  assert.equal(forceResult.method, 'signal', 'force close takes the signal path');
  assert.equal(forceResult.verified, true);
  await waitUntil(() => !pidAlive(forced.pid), `shell ${forced.pid} survived a verified SIGTERM`, 8000);

  client.close();
});

// The seam nothing covered. test/main/session-send.test.js proves the guards
// against SYNTHETIC screens (it stubs readPane), and the daemon suite proves the
// pty without ever running a guard. So whether the bytes a real sessiond read
// returns are the shape those guards expect was assumed, never checked, on both
// sides of the boundary.
//
// It matters because the two backends model different things. herdr's `recent`
// is a scrollback RING and returns CONTENT; sessiond models a real screen, so a
// 60 row pane showing five lines returns 55 trailing blank rows and 60 lines for
// a 16 line request. The dead-shell and blocked guards each strip trailing
// blanks themselves, so they survived that; the read now also honours `lines`,
// so a guard cannot silently judge a different window on one backend than the
// other (the 2026-08-02 lockout was exactly two windows disagreeing).
test('the real send guards refuse a real sessiond pane sitting at a shell prompt', async () => {
  const harness = await startIsolatedSessiond('sessiond-send-guard');
  const { createSessionSend, createLinkRegistry } = require('../../src/main/session-send.js');
  const client = new SessionDaemonClient({ socketPath: harness.socketPath, env: harness.env });

  const created = await client.createWorkspace({
    argv: ['/bin/bash', '--noprofile', '--norc'],
    cwd: harness.dir,
    env: { PS1: 'harbor-test$ ', PATH: process.env.PATH },
    cols: 120,
    rows: 60,
  });
  await waitUntil(
    async () => (await client.readPane(created.pane_id, { lines: 16 })).read.text.includes('harbor-test$'),
    'the scratch pane never reached a shell prompt',
    8000,
  );

  // A 16 line request must come back as at most 16 lines with content, the way
  // herdr's ring does. Before this, the same call returned the whole 60 row grid.
  const read = await client.readPane(created.pane_id, { source: 'recent', lines: 16, strip_ansi: true });
  const readLines = read.read.text.split('\n');
  assert.ok(readLines.length <= 16, `a 16 line read returned ${readLines.length} lines`);
  assert.ok(readLines.at(-1).trim().endsWith('$'), 'the read ends at the live prompt, not in blank rows');

  const sent = [];
  const send = createSessionSend({
    snapshot: async () => {
      const snap = (await client.snapshot()).snapshot;
      return { panes: snap.panes, workspaces: snap.workspaces };
    },
    // The production wiring from main/index.js, verbatim.
    readPane: async (paneId, lines = 16, source = 'recent') => {
      const res = await client.readPane(paneId, { source, lines, strip_ansi: true });
      return res?.read?.text || '';
    },
    terminalBridge: {
      getState: () => ({ controlledPaneId: created.pane_id }),
      requestFocusPane: async () => ({ ok: true }),
      sendInput: (paneId, text) => { sent.push({ paneId, text }); return { ok: true }; },
      ensureDialogSize: async () => ({ ok: true }),
    },
    launchActions: { resumeSession: async () => {} },
    getSessionMeta: async () => ({ cwd: harness.dir }),
    links: createLinkRegistry(),
    projectLabelForCwd: () => 'harbor',
    sleep: async () => {},
    captureDir: path.join(harness.dir, 'unrecognized-dialogs'),
    sendLogFile: path.join(harness.dir, 'send-log.jsonl'),
  });

  // A PANE-keyed send has no resumable identity, so the documented behaviour is
  // an honest refusal rather than a fall-through to resume.
  await assert.rejects(
    send.send({
      sessionId: `pane:${created.pane_id}`,
      text: 'rm -rf everything-important',
      pane: { paneId: created.pane_id },
    }),
    (error) => {
      assert.equal(error.code, 'DEAD_SHELL', 'the shell-prompt tail is what refused it');
      assert.match(error.message, /would not run in the shell/);
      return true;
    },
  );
  assert.deepEqual(sent, [], 'not one byte may reach the shell');

  await client.closePane(created.pane_id).catch(() => {});
  client.close();
});
