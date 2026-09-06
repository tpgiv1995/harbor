'use strict';

// THE SUPERVISOR'S LANES (2026-08-30, r2-selfheal item 3): respawn-on-crash,
// never-respawn-on-clean (shutdown AND yield), stand-down before a legitimate
// owner, the respawn give-up cap, and the double gate on the test-wedge seam.
// The flagship zero-drop wedge proof lives in handover.test.js; these specs
// pin every other edge of the daemon-watch state machine.

const { afterEach, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const {
  DAEMON, WATCHER, guiNodeExec,
  sleep, alive, waitUntil, waitGone, canConnect, healthPid,
  freshStore, readLog, waitForLog, chainEnv, startChain, spawnShellSession, driveMarker, requestVerb,
} = require('../support/selfheal-harness.js');

const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

const exitCodeOf = (child) => new Promise((resolve) => child.once('exit', (code) => resolve(code)));

test('a crashed daemon respawns in seconds and its sessions keep their pids', { timeout: 120000 }, async () => {
  const fixture = freshStore('hbr-selfheal-crash-');
  const { watcher, daemonPid: oldPid } = await startChain(fixture, chainEnv(fixture), cleanups);
  const session = await spawnShellSession(fixture, cleanups, fixture.store);
  await driveMarker(fixture, session.id, 'MARKER_BEFORE_CRASH');

  // The 2026-08-14 class: an unrequested daemon death, induced from outside.
  process.kill(oldPid, 'SIGKILL');

  const newPid = await waitUntil(async () => {
    const pid = await healthPid(fixture.socket, 1500);
    return pid && pid !== oldPid ? pid : null;
  }, 'no successor after a daemon crash', 30000);
  cleanups.push(async () => { try { process.kill(newPid, 'SIGKILL'); } catch {} });

  const state = JSON.parse(fs.readFileSync(path.join(fixture.store, 'sessions', `${session.id}.json`), 'utf8'));
  assert.equal(state.keeper_pid, session.keeperPid, 'keeper pid unchanged across the crash heal');
  assert.equal(state.pid, session.pid, 'pty pid unchanged across the crash heal');
  await driveMarker(fixture, session.id, 'MARKER_AFTER_CRASH');

  const log = await waitForLog(fixture, /successor pid=\d+ healthy after \d+ms/);
  assert.match(log, new RegExp(`daemon exit pid=${oldPid} .*kind=crash`));

  await requestVerb(fixture, 'terminate', { id: session.id, signal: 'SIGKILL' }, 8000);
  await waitUntil(async () => {
    try { return !(await requestVerb(fixture, 'process', { id: session.id }, 5000)).running; }
    catch { return true; }
  }, 'session never terminated', 10000);
  await requestVerb(fixture, 'shutdown');
  assert.ok(await waitGone(watcher.pid, 10000), 'watcher retires after the clean stop');
});

test('a clean stop is never respawned: shutdown retires the watcher and nothing rebinds', { timeout: 60000 }, async () => {
  const fixture = freshStore('hbr-selfheal-clean-');
  const { watcher, daemonPid } = await startChain(fixture, chainEnv(fixture), cleanups);
  const watcherExit = exitCodeOf(watcher);

  await requestVerb(fixture, 'shutdown');
  assert.ok(await waitGone(daemonPid, 10000), 'daemon exits on shutdown');
  assert.equal(await watcherExit, 0, 'watcher exits 0 on kind=clean');
  // Three watch intervals of silence: no successor ever binds.
  await sleep(800);
  assert.equal(await canConnect(fixture.socket), false, 'nothing rebound after a clean stop');
  const log = readLog(fixture.log);
  assert.match(log, new RegExp(`daemon exit pid=${daemonPid} .*kind=clean`));
  assert.doesNotMatch(log, /successor pid=/);
});

test('yield drains, releases the pipe, removes owner.json, and retires the watcher as clean', { timeout: 60000 }, async () => {
  const fixture = freshStore('hbr-selfheal-yield-');
  const { watcher, daemonPid } = await startChain(fixture, chainEnv(fixture), cleanups);
  const watcherExit = exitCodeOf(watcher);
  const ownerPath = path.join(fixture.store, 'owner.json');
  const owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
  assert.equal(owner.not_liveness, true, 'owner.json states it is not a liveness record');
  assert.equal(owner.pid, daemonPid);
  assert.equal(owner.watcher_pid, watcher.pid, 'a supervised daemon records its watcher');

  assert.deepEqual(await requestVerb(fixture, 'yield'), { yielding: true });
  assert.ok(await waitGone(daemonPid, 10000), 'daemon exits after yielding');
  assert.equal(await watcherExit, 0, 'the yield travels as kind=clean: the watcher retires');
  await sleep(800);
  assert.equal(await canConnect(fixture.socket), false, 'nothing rebound after a yield');
  assert.equal(fs.existsSync(ownerPath), false, 'owner.json is removed on yield');
  const log = readLog(fixture.log);
  assert.match(log, /yield: releasing .* and draining in-flight requests/);
  assert.match(log, /yield complete: exiting cleanly/);
  assert.match(log, new RegExp(`daemon exit pid=${daemonPid} .*kind=clean`));
  assert.doesNotMatch(log, /successor pid=/);
});

test('the watcher stands down when a legitimate daemon owns the store before its successor', { timeout: 60000 }, async () => {
  const fixture = freshStore('hbr-selfheal-standdown-');
  // A require hook that stalls any daemon booted AFTER the flag file appears:
  // the watcher's successor is slowed so the manually started daemon wins the
  // bind race deterministically. Atomics.wait is a true sleep, not a spin.
  const flagFile = path.join(fixture.store, 'slow-boot.flag');
  const hookFile = path.join(fixture.store, 'slow-boot.js');
  fs.writeFileSync(hookFile, `
    const fs = require('node:fs');
    if (process.env.HARBOR_TEST_SLOW_FLAG && fs.existsSync(process.env.HARBOR_TEST_SLOW_FLAG)) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
    }
  `);
  const env = chainEnv(fixture, {
    NODE_OPTIONS: `--require ${JSON.stringify(hookFile)}`,
    HARBOR_TEST_SLOW_FLAG: flagFile,
  });
  const { watcher, daemonPid: oldPid } = await startChain(fixture, env, cleanups);
  const watcherExit = exitCodeOf(watcher);

  assert.deepEqual(await requestVerb(fixture, 'test-wedge'), { wedging: true });
  fs.writeFileSync(flagFile, '1');
  assert.ok(await waitGone(oldPid, 20000), 'the watcher kills the wedged daemon');

  // The legitimate owner: started by hand (no slow hook), it binds while the
  // watcher's slowed successor is still waking up.
  const manualEnv = chainEnv(fixture);
  delete manualEnv.NODE_OPTIONS;
  delete manualEnv.HARBOR_TEST_SLOW_FLAG;
  const manual = spawn(guiNodeExec, [DAEMON], { windowsHide: true, env: manualEnv, stdio: 'ignore' });
  cleanups.push(async () => {
    try { manual.kill('SIGKILL'); } catch {}
    fs.rmSync(fixture.store, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  await waitUntil(async () => (await healthPid(fixture.socket)) === manual.pid, 'the manual daemon never bound', 15000);

  assert.equal(await watcherExit, 0, 'the watcher stands down instead of fighting the legitimate owner');
  assert.match(readLog(fixture.log), /standing down: another daemon serves /);
  assert.ok(alive(manual.pid), 'the legitimate owner survives');
  assert.equal(await healthPid(fixture.socket), manual.pid, 'the legitimate owner still serves the store');
});

test('the respawn give-up cap: a crash loop stops after RESPAWN_MAX respawns with an honest line', { timeout: 60000 }, async () => {
  const fixture = freshStore('hbr-selfheal-giveup-');
  const crashPath = path.join(fixture.store, 'exit1.js');
  fs.writeFileSync(crashPath, 'process.exit(1);\n');
  const env = chainEnv(fixture, { HARBOR_SESSIOND_RESPAWN_MAX: '2', HARBOR_SESSIOND_PIPE_RELEASE_TIMEOUT_MS: '500' });
  const watcher = spawn(guiNodeExec, [WATCHER, crashPath], { windowsHide: true, env, stdio: 'ignore' });
  cleanups.push(async () => {
    try { watcher.kill('SIGKILL'); } catch {}
    fs.rmSync(fixture.store, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  const code = await new Promise((resolve) => watcher.once('exit', resolve));
  assert.equal(code, 1, 'the watcher gives up with exit 1');
  const log = readLog(fixture.log);
  assert.equal((log.match(/kind=crash/g) || []).length, 3, 'initial attempt plus exactly RESPAWN_MAX respawns');
  assert.match(log, /respawn give-up: 2 respawn\(s\) within 15 minutes/);
});

test('the test-wedge seam is double-gated: without the env it refuses and the daemon stays healthy', { timeout: 60000 }, async () => {
  const fixture = freshStore('hbr-selfheal-gate-');
  const env = chainEnv(fixture);
  delete env.HARBOR_SESSIOND_TEST_WEDGE;
  const daemon = spawn(guiNodeExec, [DAEMON], { windowsHide: true, env, stdio: 'ignore' });
  cleanups.push(async () => {
    try { daemon.kill('SIGKILL'); } catch {}
    fs.rmSync(fixture.store, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  await waitUntil(() => healthPid(fixture.socket), 'daemon never became healthy', 20000);
  await assert.rejects(requestVerb(fixture, 'test-wedge'), /test-wedge refused: HARBOR_SESSIOND_TEST_WEDGE=1 is not set/);
  assert.ok(await healthPid(fixture.socket), 'the refused seam left the daemon answering');
});
