'use strict';

const { afterEach, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { SessionClient } = require('../../src/daemon/client.js');

const ROOT = path.resolve(__dirname, '../..');
const DAEMON = path.join(ROOT, 'src/daemon/daemon.js');
const cleanups = [];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(fn, message, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await sleep(50);
  }
  throw new Error(message);
}

async function harness(extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-sessiond-test-'));
  const socketPath = path.join(dir, 'daemon.sock');
  const env = {
    ...process.env,
    HARBOR_SESSIOND_DIR: dir,
    HARBOR_SESSIOND_SOCKET: socketPath,
    HARBOR_NO_DAEMON_START: '1',
    HERDR_SOCKET_PATH: path.join(dir, 'never-real-herdr.sock'),
    ...extraEnv,
  };
  let daemon;
  const start = async () => {
    daemon = spawn(process.execPath, [DAEMON], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    daemon.stderr.on('data', (chunk) => { stderr += chunk; });
    await waitUntil(async () => {
      try {
        const client = new SessionClient({ socketPath });
        const result = await client.request('health');
        client.close();
        return result.ok;
      } catch { return false; }
    }, `daemon did not answer a real health request: ${stderr}`);
    return daemon;
  };
  const stop = async () => {
    if (!daemon || daemon.exitCode !== null) return;
    daemon.kill('SIGTERM');
    await new Promise((resolve) => daemon.once('exit', resolve));
  };
  await start();
  const client = new SessionClient({ socketPath });
  const cleanup = async () => {
    try {
      const listed = await client.request('list');
      for (const session of listed.sessions) {
        await client.request('terminate', { id: session.id, signal: 'SIGKILL' }).catch(() => {});
      }
    } catch {}
    client.close();
    await stop();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  cleanups.push(cleanup);
  return { dir, socketPath, env, client, start, stop };
}

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

test('seven session verbs drive a real pty and preserve its screen across resize', async () => {
  const h = await harness();
  const spawned = await h.client.request('spawn', {
    argv: ['/bin/bash', '--noprofile', '--norc'], cwd: h.dir,
    env: { PS1: 'HARBOR_TEST> ' }, cols: 54, rows: 23,
  });
  assert.match(spawned.id, /^[a-f0-9-]+$/);

  const second = new SessionClient({ socketPath: h.socketPath });
  const framesA = [];
  const framesB = [];
  h.client.onEvent((event) => framesA.push(event));
  second.onEvent((event) => framesB.push(event));
  await h.client.request('observe', { id: spawned.id });
  await second.request('observe', { id: spawned.id });

  await h.client.request('input', { id: spawned.id, text: "printf 'FRAME_TO_BOTH\\n'; printf 'SCROLLBACK_MARK\\n'\n" });
  await waitUntil(() => framesA.some((e) => e.type === 'frame' && e.text.includes('FRAME_TO_BOTH')), 'first observer missed frame');
  await waitUntil(() => framesB.some((e) => e.type === 'frame' && e.text.includes('FRAME_TO_BOTH')), 'second observer missed frame');

  const resized = await h.client.request('resize', { id: spawned.id, cols: 120, rows: 60 });
  assert.deepEqual(resized, { cols: 120, rows: 60 });
  await h.client.request('input', { id: spawned.id, text: "stty size; printf 'VISIBLE_AFTER_RESIZE\\n'\n" });
  await waitUntil(async () => /60 120[\s\S]*VISIBLE_AFTER_RESIZE/.test((await h.client.request('screen', { id: spawned.id, scrollback: 200 })).text), 'resized pty output never settled');
  const screen = await h.client.request('screen', { id: spawned.id, scrollback: 200 });
  assert.equal(screen.cols, 120);
  assert.equal(screen.rows, 60);
  assert.match(screen.text, /60 120/);
  assert.match(screen.text, /SCROLLBACK_MARK/);
  assert.match(screen.visible, /VISIBLE_AFTER_RESIZE/);

  const processInfo = await h.client.request('process', { id: spawned.id });
  assert.equal(processInfo.running, true);
  assert.ok(processInfo.pid > 1);
  assert.equal(processInfo.exit, null);

  const terminated = await h.client.request('terminate', { id: spawned.id, signal: 'SIGTERM' });
  assert.equal(terminated.signaled, true);
  await waitUntil(async () => !(await h.client.request('process', { id: spawned.id })).running, 'exit was not recorded');
  const exited = await h.client.request('process', { id: spawned.id });
  assert.equal(exited.running, false);
  assert.ok(exited.exit.signal > 0, 'records that the pty exited by signal');
  await waitUntil(() => framesA.some((e) => e.type === 'exit'), 'observer missed exit event');
  second.close();
});

test('daemon restart reconnects to the keeper without resuming or killing the pty', async () => {
  const h = await harness();
  const spawned = await h.client.request('spawn', {
    argv: ['/bin/bash', '--noprofile', '--norc'], cwd: h.dir,
    env: { PS1: 'HARBOR_RESTART> ' }, cols: 80, rows: 40,
  });
  const before = await h.client.request('process', { id: spawned.id });
  h.client.close();
  await h.stop();
  assert.doesNotThrow(() => process.kill(before.pid, 0), 'daemon stop killed the pty');

  await h.start();
  const reconnected = new SessionClient({ socketPath: h.socketPath });
  const after = await reconnected.request('process', { id: spawned.id });
  assert.equal(after.pid, before.pid, 'daemon restarted the process instead of reconnecting');
  assert.equal(after.running, true);
  await reconnected.request('input', { id: spawned.id, text: "printf 'ALIVE_AFTER_DAEMON_RESTART\\n'\n" });
  await waitUntil(async () => (await reconnected.request('screen', { id: spawned.id })).text.includes('ALIVE_AFTER_DAEMON_RESTART'), 'reconnected keeper did not accept input');
  reconnected.close();
});

test('invalid requests refuse honestly and the same connection reaches allowed work', async () => {
  const h = await harness();
  await assert.rejects(h.client.request('spawn', { argv: [], cwd: h.dir }), /argv/);
  const spawned = await h.client.request('spawn', {
    argv: ['/bin/bash', '--noprofile', '--norc'], cwd: h.dir, env: {}, cols: 80, rows: 40,
  });
  await assert.rejects(h.client.request('resize', { id: spawned.id, cols: 0, rows: 40 }), /cols/);
  assert.deepEqual(await h.client.request('resize', { id: spawned.id, cols: 100, rows: 50 }), { cols: 100, rows: 50 });
  await assert.rejects(h.client.request('input', { id: 'missing', text: 'no' }), /not found/);
  assert.deepEqual(await h.client.request('input', { id: spawned.id, text: "printf 'ALLOWED'\n" }), { accepted: true });
});

// A REBOOT IS NOT AN EXIT (2026-08-07). Pat restarted his machine at work and
// Harbor came back showing "13 live" over thirteen sessions whose processes had
// died with the boot, marked one "ready", and accepted a send into a pane with
// nothing behind it. A keeper writes `exit` from onExit; a SIGKILLed keeper never
// reaches that line, so every state file survived saying `exit: null`.
//
// The stale session is reproduced as the reboot actually leaves one: keeper
// killed outright so it cannot write an exit, and a boot stamp from a boot that
// has ended. Which of the two guards fired is then readable in the exit REASON,
// because the boot rule is consulted before the keeper is, so this still isolates
// it rather than passing on the probe alone.
//
// Two-sided ON PURPOSE. The control session proves the rule does not simply
// condemn everything: it must still be listed, still be drivable, and keep its
// pid across the restart. A guard that reaped both would pass a one-sided test.
test('a session that did not survive its boot is not live, and one from this boot still is', async () => {
  // A boot-dated exit is by definition as old as this boot, so retention has to
  // clear the machine's own uptime for the record to still be READABLE here.
  // Left at the default it is reaped before the assertion, which is the right
  // production behaviour (a session that died in the last reboot should not
  // linger) and useless for proving what was written.
  const h = await harness({ HARBOR_SESSIOND_EXIT_RETENTION_MS: String(Math.ceil(os.uptime() + 3600) * 1000) });
  const spawn2 = (ps1) => h.client.request('spawn', {
    argv: ['/bin/bash', '--noprofile', '--norc'], cwd: h.dir, env: { PS1: ps1 }, cols: 80, rows: 40,
  });
  const stale = await spawn2('HARBOR_STALE> ');
  const control = await spawn2('HARBOR_CONTROL> ');
  const controlBefore = await h.client.request('process', { id: control.id });

  const statePath = (id) => path.join(h.dir, 'sessions', `${id}.json`);
  const staleBefore = await h.client.request('process', { id: stale.id });
  const written = JSON.parse(fs.readFileSync(statePath(stale.id), 'utf8'));
  assert.ok(written.boot_id, 'the keeper must stamp the boot it started in');
  assert.equal(written.exit, null);
  process.kill(written.keeper_pid, 'SIGKILL');
  await waitUntil(() => { try { process.kill(written.keeper_pid, 0); return false; } catch { return true; } }, 'keeper never died');
  fs.writeFileSync(statePath(stale.id), `${JSON.stringify({
    ...written, boot_id: 'boot:00000000-0000-4000-8000-000000000000',
  })}\n`);
  assert.equal(
    JSON.parse(fs.readFileSync(statePath(stale.id), 'utf8')).exit,
    null,
    'the premise: a killed keeper leaves the state saying it is still running',
  );

  // The cheap half, with no restart: a foreign boot stamp is filtered out of a
  // live daemon's answer immediately, so a stale session can never be reported
  // live even before anything reconciles it.
  const listedLive = await h.client.request('list');
  const ids = listedLive.sessions.map((s) => s.id);
  assert.ok(!ids.includes(stale.id), 'a session from a dead boot was still reported live');
  assert.ok(ids.includes(control.id), 'the filter condemned a session from this boot');

  // The durable half: a restart reconciles it to an honest exit rather than
  // leaving it to be filtered forever, so `process` can answer about it.
  h.client.close();
  await h.stop();
  await h.start();
  const after = new SessionClient({ socketPath: h.socketPath });

  const staleProcess = await after.request('process', { id: stale.id });
  assert.equal(staleProcess.running, false, 'a session from a dead boot still reported running');
  assert.match(staleProcess.exit.reason, /the boot it was spawned in has ended/, 'the boot rule must outrank the keeper probe, or this proves only the probe');
  assert.equal(staleProcess.exit.code, null, 'nobody watched it die, so there is no code to report');
  assert.equal(staleProcess.exit.signal, null);

  const controlAfter = await after.request('process', { id: control.id });
  assert.equal(controlAfter.running, true, 'reconciliation killed a live session');
  assert.equal(controlAfter.pid, controlBefore.pid, 'reconciliation restarted a live session');
  await after.request('input', { id: control.id, text: "printf 'CONTROL_STILL_DRIVABLE\\n'\n" });
  await waitUntil(async () => (await after.request('screen', { id: control.id })).text.includes('CONTROL_STILL_DRIVABLE'), 'the surviving session stopped accepting input');
  after.close();
  try { process.kill(staleBefore.pid, 'SIGKILL'); } catch { /* already gone */ }
});

// The same wreckage without a reboot: a keeper killed outright (an OOM kill, a
// SIGKILL) also never writes an exit. The boot stamp cannot see this one, so the
// keeper socket is asked directly, which is the rule this daemon already applies
// to its own socket. Two-sided for the same reason as above.
test('a keeper killed without writing an exit is reconciled, and a live keeper is left alone', async () => {
  const h = await harness({ HARBOR_SESSIOND_EXIT_RETENTION_MS: String(10 * 60 * 1000) });
  const spawn2 = (ps1) => h.client.request('spawn', {
    argv: ['/bin/bash', '--noprofile', '--norc'], cwd: h.dir, env: { PS1: ps1 }, cols: 80, rows: 40,
  });
  const orphaned = await spawn2('HARBOR_ORPHAN> ');
  const control = await spawn2('HARBOR_LIVE> ');
  const controlBefore = await h.client.request('process', { id: control.id });
  const orphanedBefore = await h.client.request('process', { id: orphaned.id });

  const state = JSON.parse(fs.readFileSync(path.join(h.dir, 'sessions', `${orphaned.id}.json`), 'utf8'));
  assert.ok(state.keeper_pid > 1);
  process.kill(state.keeper_pid, 'SIGKILL');
  await waitUntil(() => { try { process.kill(state.keeper_pid, 0); return false; } catch { return true; } }, 'keeper never died');
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(h.dir, 'sessions', `${orphaned.id}.json`), 'utf8')).exit,
    null,
    'a killed keeper cannot write an exit, which is the whole premise',
  );

  h.client.close();
  await h.stop();
  await h.start();
  const after = new SessionClient({ socketPath: h.socketPath });

  const orphanedProcess = await after.request('process', { id: orphaned.id });
  assert.equal(orphanedProcess.running, false, 'a session whose keeper is gone still reported running');
  assert.match(orphanedProcess.exit.reason, /keeper is not answering/);

  const controlAfter = await after.request('process', { id: control.id });
  assert.equal(controlAfter.running, true, 'reconciliation condemned a session with a live keeper');
  assert.equal(controlAfter.pid, controlBefore.pid);
  after.close();
  try { process.kill(orphanedBefore.pid, 'SIGKILL'); } catch { /* already gone */ }
});
