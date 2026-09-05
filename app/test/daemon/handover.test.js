'use strict';

// ZERO-DROP DAEMON HANDOVER, BOTH LANES (2026-08-30, r2-selfheal item 3).
//
// Keepers are detached, independently listening pipe servers holding the ptys;
// the daemon is only the control plane. These specs prove that replacing the
// daemon, through the WEDGE lane (daemon-watch kills its unresponsive child
// and respawns) and through the DELIBERATE lane (harbor-sessiond handover asks
// the incumbent to yield), keeps every keeper pid and pty pid alive and the
// session drivable through the successor. The two-sided half proves the wedge
// itself: with no supervisor watching, a wedged daemon accepts connections and
// answers nothing, forever, and nothing at the daemon layer recovers.
//
// The wedge is induced deterministically via the daemon's test-wedge seam
// (HARBOR_SESSIOND_TEST_WEDGE=1 plus the verb): connections still accept,
// requests never answer, which is a real wedge's observable shape from every
// prober's seat.

const { afterEach, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const {
  DAEMON, CLI, guiNodeExec,
  sleep, alive, waitUntil, waitGone, canConnect, healthPid,
  freshStore, readLog, waitForLog, chainEnv, startChain, spawnShellSession, driveMarker, requestVerb,
} = require('../support/selfheal-harness.js');

const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

test('zero-drop wedge handover: the supervisor kills a wedged daemon and its successor serves the same keeper and pty pids', { timeout: 120000 }, async () => {
  const fixture = freshStore('hbr-handover-wedge-');
  const env = chainEnv(fixture);
  const { watcher, daemonPid: oldPid } = await startChain(fixture, env, cleanups);
  cleanups.push(async () => { try { process.kill(oldPid, 'SIGKILL'); } catch {} });

  const session = await spawnShellSession(fixture, cleanups, fixture.store);
  assert.ok(alive(session.keeperPid), 'keeper must be running before the wedge');
  assert.ok(alive(session.pid), 'pty child must be running before the wedge');
  await driveMarker(fixture, session.id, 'MARKER_BEFORE_WEDGE');

  // Wedge the daemon: it acknowledges, then drops every record on the floor.
  assert.deepEqual(await requestVerb(fixture, 'test-wedge'), { wedging: true });

  // The supervisor trips on consecutive failed real requests, SIGKILLs its
  // child, waits for the pipe to release, and respawns. The successor's
  // startup reconcile asks every keeper a real question and touches none that
  // answer: same keeper, same pty.
  const newPid = await waitUntil(async () => {
    const pid = await healthPid(fixture.socket, 1500);
    return pid && pid !== oldPid ? pid : null;
  }, 'a successor daemon never became healthy', 45000);
  cleanups.push(async () => { try { process.kill(newPid, 'SIGKILL'); } catch {} });
  assert.notEqual(newPid, oldPid, 'the successor is a new process');
  assert.ok(!alive(oldPid), 'the wedged daemon is dead');

  const state = JSON.parse(fs.readFileSync(path.join(fixture.store, 'sessions', `${session.id}.json`), 'utf8'));
  assert.equal(state.keeper_pid, session.keeperPid, 'keeper pid unchanged across the heal');
  assert.equal(state.pid, session.pid, 'pty pid unchanged across the heal');
  assert.equal(state.exit, null, 'the successor reconcile left the live session untouched');
  assert.ok(alive(session.keeperPid) && alive(session.pid), 'keeper and pty survived the heal');

  // Drivable THROUGH the successor: input in, marker back on the screen.
  await driveMarker(fixture, session.id, 'MARKER_AFTER_HEAL');

  // The successor reacquired the session's Windows job on its reconcile path
  // (openSessionJob by name; the store names its own job namespace).
  const health = await requestVerb(fixture, 'health');
  if (process.platform === 'win32') {
    assert.equal(health.jobs?.enabled, true, 'jobs are on for the namespaced test store');
    assert.equal(health.jobs.sessions, 1, 'successor reacquired the session job on reconcile');
  }

  // Honest lines: the trip, the third exit kind, the successor confirmation
  // (which lands on the watcher's next probe tick, so it is awaited).
  const log = await waitForLog(fixture, /successor pid=\d+ healthy after \d+ms/);
  assert.match(log, /wedge: daemon pid=\d+ failed 2 consecutive health probes; killing it/);
  assert.match(log, new RegExp(`daemon exit pid=${oldPid} .*kind=wedge`));

  // Orderly teardown (also proves the never-respawn-on-clean contract end to
  // end): terminate the session through the daemon, stop the daemon with the
  // shutdown VERB, and the watcher retires on kind=clean.
  await requestVerb(fixture, 'terminate', { id: session.id, signal: 'SIGKILL' }, 8000);
  await waitUntil(async () => {
    try { return !(await requestVerb(fixture, 'process', { id: session.id }, 5000)).running; }
    catch { return true; }
  }, 'session never terminated', 10000);
  await requestVerb(fixture, 'shutdown');
  assert.ok(await waitGone(watcher.pid, 10000), 'the watcher exits after a clean daemon stop');
});

test('two-sided: with no supervisor, the wedge persists and nothing at the daemon layer recovers', { timeout: 60000 }, async () => {
  const fixture = freshStore('hbr-handover-nowatch-');
  const env = chainEnv(fixture);
  // The daemon is spawned DIRECTLY: no daemon-watch, no healer.
  const daemon = spawn(guiNodeExec, [DAEMON], { windowsHide: true, env, stdio: 'ignore' });
  cleanups.push(async () => {
    try { daemon.kill('SIGKILL'); } catch {}
    fs.rmSync(fixture.store, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  const pid = await waitUntil(() => healthPid(fixture.socket), 'daemon never became healthy', 20000);

  assert.deepEqual(await requestVerb(fixture, 'test-wedge'), { wedging: true });

  // Longer than the supervised trip-plus-heal took in the flagship spec:
  // probes keep completing and failing, connections keep accepting, the same
  // process keeps holding the pipe. Nothing recovers.
  const observedUntil = Date.now() + 4000;
  let failedProbes = 0;
  while (Date.now() < observedUntil) {
    assert.equal(await healthPid(fixture.socket, 700), null, 'a wedged daemon must not answer health');
    failedProbes += 1;
    assert.equal(await canConnect(fixture.socket), true, 'a wedged daemon still accepts connections');
  }
  assert.ok(failedProbes >= 3, `expected several completed-and-failed probes, saw ${failedProbes}`);
  assert.ok(alive(daemon.pid), 'the wedged daemon is still the pipe owner: no healer, no recovery');
  assert.equal(daemon.pid, pid, 'no successor ever took over');
});

test('deliberate handover: the incumbent yields, the successor serves the same sessions with zero pid churn', { timeout: 120000 }, async () => {
  const fixture = freshStore('hbr-handover-yield-');
  const env = chainEnv(fixture);
  const { watcher, daemonPid: oldPid } = await startChain(fixture, env, cleanups);
  cleanups.push(async () => {
    // The successor daemon is stopped through the CLI so ITS watcher retires
    // on kind=clean too; direct pid kills below are the fallback.
    spawnSync(guiNodeExec, [CLI, 'stop', '--json'], { env, encoding: 'utf8', timeout: 30000 });
    try { process.kill(oldPid, 'SIGKILL'); } catch {}
  });

  const session = await spawnShellSession(fixture, cleanups, fixture.store);
  await driveMarker(fixture, session.id, 'MARKER_BEFORE_YIELD');

  const result = spawnSync(guiNodeExec, [CLI, 'handover', '--json'], { env, encoding: 'utf8', timeout: 90000 });
  assert.equal(result.status, 0, `handover must succeed: ${result.stdout} ${result.stderr}`);
  const verdict = JSON.parse(result.stdout.trim().split('\n').pop());
  cleanups.push(async () => { if (verdict.newPid) { try { process.kill(verdict.newPid, 'SIGKILL'); } catch {} } });

  assert.equal(verdict.handover, true);
  assert.equal(verdict.identical, true, `pid maps must match: ${JSON.stringify(verdict.mismatches)}`);
  assert.equal(verdict.healthy, true);
  assert.equal(verdict.yielded, true, 'a modern incumbent yields; the shutdown fallback is only for legacy code');
  assert.equal(verdict.oldPid, oldPid);
  assert.ok(verdict.newPid && verdict.newPid !== oldPid, 'the successor is a new daemon process');
  assert.equal(verdict.sessions, 1);

  const state = JSON.parse(fs.readFileSync(path.join(fixture.store, 'sessions', `${session.id}.json`), 'utf8'));
  assert.equal(state.keeper_pid, session.keeperPid, 'keeper pid unchanged across the handover');
  assert.equal(state.pid, session.pid, 'pty pid unchanged across the handover');
  assert.ok(alive(session.keeperPid) && alive(session.pid), 'keeper and pty survived the handover');
  assert.ok(!alive(oldPid), 'the incumbent exited after yielding');
  assert.ok(await waitGone(watcher.pid, 10000), 'the incumbent watcher retired on kind=clean instead of respawning');

  await driveMarker(fixture, session.id, 'MARKER_AFTER_YIELD');
  const health = await requestVerb(fixture, 'health');
  assert.equal(health.pid, verdict.newPid, 'the successor answers the store');
  if (process.platform === 'win32') {
    assert.equal(health.jobs?.enabled, true, 'the CLI forwards the job namespace to the successor');
    assert.equal(health.jobs.sessions, 1, 'successor reacquired the session job on reconcile');
  }

  const log = readLog(fixture.log);
  assert.match(log, /yield: releasing .* and draining in-flight requests/);
  assert.match(log, new RegExp(`daemon exit pid=${oldPid} .*kind=clean`));
  assert.ok((log.match(/daemon listening /g) || []).length >= 2, 'the successor bound and logged it');
  assert.ok(!log.includes('reconciled'), 'a clean handover reconciles zero sessions');

  // Terminate the session through the successor BEFORE teardown deletes the
  // store (the ConPTY-cwd EPERM rule).
  await requestVerb(fixture, 'terminate', { id: session.id, signal: 'SIGKILL' }, 8000);
  await waitUntil(async () => {
    try { return !(await requestVerb(fixture, 'process', { id: session.id }, 5000)).running; }
    catch { return true; }
  }, 'session never terminated', 10000);
});
