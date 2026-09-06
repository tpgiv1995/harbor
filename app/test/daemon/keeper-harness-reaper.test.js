'use strict';
const { execPath: guiNodeExec } = require('../support/gui-node.js');

// THE KEEPER DIES WITH ITS HARNESS TOO (2026-09-03).
//
// harness-reaper.test.js proves a relocated daemon reaps its sessions when
// the pid it watches dies. Its stand-in harness is a SEPARATE process, so the
// daemon lives long enough to notice. A real harness is the daemon's own
// spawner, and on Windows libuv puts a non-detached child in a job object that
// kills it the instant the spawner exits: the daemon is gone in under a
// second with nothing logged, its two-second watch never fires, and the
// keepers, spawned detached, survive with their sessions. Three probe scripts
// that crashed mid-run left three keepers and three claude trees alive for an
// hour that evening, the same shape as the 28-daemon piles the daemon-side
// reaper was built for.
//
// So the daemon hands the harness pid to each keeper in its config, and the
// keeper watches it itself. Two-sided: this fails at pre-fix HEAD on exactly
// "the session should die with its crashed harness".

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const CRASHER = path.resolve(__dirname, '../support/crashing-harness.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitGone = async (pid, timeoutMs) => {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) { if (!alive(pid)) return true; await sleep(100); }
  return !alive(pid);
};

test('a session dies with a harness that took its daemon down before the daemon could reap', { timeout: 40000 }, async () => {
  const store = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'hbr-keeper-reaper-'));
  let pids = null;
  try {
    const crasher = spawn(guiNodeExec, [CRASHER, store], {
      windowsHide: true,
      env: { ...process.env, HARBOR_SESSIOND_PARENT_POLL_MS: '150' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    crasher.stderr.on('data', (chunk) => { stderr += chunk; });
    const code = await new Promise((resolve) => crasher.once('exit', resolve));
    assert.equal(code, 1, `the harness must have crashed on purpose, not failed to start: ${stderr}`);
    pids = JSON.parse(fs.readFileSync(path.join(store, 'pids.json'), 'utf8'));
    assert.ok(await waitGone(pids.daemon, 15000), 'the daemon dies with its spawner');
    assert.ok(await waitGone(pids.child, 10000), 'the session should die with its crashed harness');
    const state = JSON.parse(fs.readFileSync(path.join(store, 'sessions', `${pids.session}.json`), 'utf8'));
    assert.ok(state.exit, 'the keeper wrote an honest exit record before ending');
    assert.match(String(state.exit.reason || ''), /harness/i);
  } finally {
    if (pids) {
      for (const pid of [pids.child, pids.daemon]) {
        if (alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
      }
    }
    await sleep(300);
    fs.rmSync(store, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
  }
});
