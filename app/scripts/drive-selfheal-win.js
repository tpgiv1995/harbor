'use strict';

// LIVE ISOLATED DRIVE of both self-heal lanes (2026-08-30, r2-selfheal item 3),
// against a throwaway relocated store: never the real daemon. Prints a
// human-readable record of pids before and after each lane, which is the
// dress-rehearsal evidence the rollout runbook (docs/SESSIOND-ROLLOUT.md)
// requires before the real daemon is ever handed over.
//
//   Lane B (wedge):      real session -> test-wedge -> supervisor kills and
//                        respawns -> same keeper pid, same pty pid, drivable.
//   Lane A (deliberate): harbor-sessiond handover --json -> yield -> successor
//                        -> identical pid map, drivable.
//
// Run: node scripts/drive-selfheal-win.js   (from app/)

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const {
  DAEMON, WATCHER, CLI, guiNodeExec,
  sleep, alive, waitUntil, waitGone, healthPid,
  freshStore, readLog, waitForLog, chainEnv, requestVerb,
} = require('../test/support/selfheal-harness.js');

const SHELL_ARGV = process.platform === 'win32'
  ? [process.env.ComSpec || 'cmd.exe', '/Q']
  : ['/bin/bash', '--noprofile', '--norc'];

const say = (line) => process.stdout.write(`${line}\n`);

// A throwaway store is deleted only once nothing writes into it any more. A
// stopped successor's keeper still writes its exit files for about a second
// (finishExit runs after the exit-delay), and rmSync's own retries cover
// EBUSY and EPERM but not the ENOTEMPTY that a file appearing mid-delete
// produces: the deliberate lane failed exactly there on 2026-09-03, after its
// verdict had already passed. So: retry the whole delete, patiently.
async function removeStore(store) {
  let last = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      fs.rmSync(store, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      return;
    } catch (error) {
      last = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw last;
}

async function spawnSession(fixture) {
  const spawned = await requestVerb(fixture, 'spawn', {
    argv: SHELL_ARGV, cwd: fixture.store, env: {}, cols: 100, rows: 30,
  }, 20000);
  const state = JSON.parse(fs.readFileSync(path.join(fixture.store, 'sessions', `${spawned.id}.json`), 'utf8'));
  return { id: spawned.id, pid: state.pid, keeperPid: state.keeper_pid };
}

async function drive(fixture, id, marker) {
  await requestVerb(fixture, 'input', { id, text: process.platform === 'win32' ? `echo ${marker}\r` : `printf '${marker}\\n'\n` }, 10000);
  await waitUntil(async () => ((await requestVerb(fixture, 'screen', { id, scrollback: 200 }, 10000)).text || '').includes(marker),
    `marker ${marker} never echoed`, 15000);
  say(`  input -> screen round trip OK (${marker})`);
}

function pidsLine(fixture, session, label) {
  const state = JSON.parse(fs.readFileSync(path.join(fixture.store, 'sessions', `${session.id}.json`), 'utf8'));
  say(`  ${label}: keeper_pid=${state.keeper_pid} pty_pid=${state.pid} exit=${JSON.stringify(state.exit)}`);
  return state;
}

async function laneWedge() {
  say('=== Lane B: wedge-heal (supervisor) ===');
  const fixture = freshStore('hbr-drive-wedge-');
  const env = chainEnv(fixture);
  const watcher = spawn(guiNodeExec, [WATCHER, DAEMON], { windowsHide: true, env, stdio: 'ignore' });
  try {
    const oldPid = await waitUntil(() => healthPid(fixture.socket), 'daemon never healthy', 20000);
    say(`  store=${fixture.store}`);
    say(`  daemon pid=${oldPid} watcher pid=${watcher.pid}`);
    const session = await spawnSession(fixture);
    say(`  session=${session.id}`);
    pidsLine(fixture, session, 'BEFORE wedge');
    await drive(fixture, session.id, 'DRIVE_BEFORE_WEDGE');
    say(`  wedging: ${JSON.stringify(await requestVerb(fixture, 'test-wedge'))}`);
    const newPid = await waitUntil(async () => {
      const pid = await healthPid(fixture.socket, 1500);
      return pid && pid !== oldPid ? pid : null;
    }, 'no successor', 45000);
    say(`  healed: old daemon pid=${oldPid} dead=${!alive(oldPid)}; successor pid=${newPid}`);
    const state = pidsLine(fixture, session, 'AFTER heal');
    if (state.keeper_pid !== session.keeperPid || state.pid !== session.pid) throw new Error('PID CHURN: zero-drop violated');
    await drive(fixture, session.id, 'DRIVE_AFTER_HEAL');
    await waitForLog(fixture, /successor pid=\d+ healthy after \d+ms/);
    const lines = readLog(fixture.log).split('\n').filter((l) => /wedge|successor|daemon exit/.test(l));
    for (const line of lines) say(`  log: ${line}`);
    await requestVerb(fixture, 'terminate', { id: session.id, signal: 'SIGKILL' }, 8000);
    await waitUntil(async () => { try { return !(await requestVerb(fixture, 'process', { id: session.id }, 5000)).running; } catch { return true; } }, 'terminate', 10000);
    await requestVerb(fixture, 'shutdown');
    await waitGone(watcher.pid, 10000);
    say('  teardown clean (watcher retired on kind=clean)');
  } finally {
    const pid = await healthPid(fixture.socket, 500);
    try { watcher.kill('SIGKILL'); } catch {}
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    await removeStore(fixture.store);
  }
}

async function laneDeliberate() {
  say('=== Lane A: deliberate handover (harbor-sessiond handover) ===');
  const fixture = freshStore('hbr-drive-yield-');
  const env = chainEnv(fixture);
  const watcher = spawn(guiNodeExec, [WATCHER, DAEMON], { windowsHide: true, env, stdio: 'ignore' });
  try {
    const oldPid = await waitUntil(() => healthPid(fixture.socket), 'daemon never healthy', 20000);
    say(`  store=${fixture.store}`);
    say(`  incumbent pid=${oldPid} watcher pid=${watcher.pid}`);
    const session = await spawnSession(fixture);
    say(`  session=${session.id}`);
    pidsLine(fixture, session, 'BEFORE handover');
    await drive(fixture, session.id, 'DRIVE_BEFORE_YIELD');
    const result = spawnSync(guiNodeExec, [CLI, 'handover', '--json'], { env, encoding: 'utf8', timeout: 90000, windowsHide: true });
    if (result.status !== 0) throw new Error(`handover failed: ${result.stdout} ${result.stderr}`);
    const verdict = JSON.parse(result.stdout.trim().split('\n').pop());
    say(`  verdict: ${JSON.stringify(verdict)}`);
    if (!verdict.identical || !verdict.healthy) throw new Error('handover verdict is not identical+healthy');
    const state = pidsLine(fixture, session, 'AFTER handover');
    if (state.keeper_pid !== session.keeperPid || state.pid !== session.pid) throw new Error('PID CHURN: zero-drop violated');
    await drive(fixture, session.id, 'DRIVE_AFTER_YIELD');
    const lines = readLog(fixture.log).split('\n').filter((l) => /yield|daemon exit|daemon listening/.test(l));
    for (const line of lines) say(`  log: ${line}`);
    await requestVerb(fixture, 'terminate', { id: session.id, signal: 'SIGKILL' }, 8000);
    await waitUntil(async () => { try { return !(await requestVerb(fixture, 'process', { id: session.id }, 5000)).running; } catch { return true; } }, 'terminate', 10000);
    spawnSync(guiNodeExec, [CLI, 'stop', '--json'], { env, encoding: 'utf8', timeout: 30000, windowsHide: true });
    say('  teardown clean (successor stopped through the CLI)');
  } finally {
    const pid = await healthPid(fixture.socket, 500);
    try { watcher.kill('SIGKILL'); } catch {}
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    await removeStore(fixture.store);
  }
}

(async () => {
  await laneWedge();
  await laneDeliberate();
  say('BOTH LANES OK');
  process.exit(0);
})().catch((error) => {
  say(`DRIVE FAILED: ${error.stack || error.message}`);
  process.exit(1);
});
