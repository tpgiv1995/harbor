'use strict';

// THE DEATH RATTLE IS NOT A HEARTBEAT (live-caught 2026-08-03).
//
// bin/claude-sessions refuses to resume a session whose transcript was written
// in the last 90 seconds, on the reasoning that a hot transcript means a live
// writer. A claude WRITES ITS TRANSCRIPT ON THE WAY OUT (an away_summary and a
// last-prompt marker), so a fleet of sessions killed together is un-resumable
// for 90 seconds precisely BECAUSE it just died. That day the herdr daemon
// restarted at 20:14:13.665Z, Harbor's in-flight send found its pane gone 78ms
// later, and the send log then shows two sessions refusing four times over four
// minutes at 21s, 34s, 68s and 78s, with Pat's typed messages stranded in their
// composers: "i get that error all the time and youve never fixed it".
//
// The guard is a PROXY. Harbor answers the real question instead (the tee names
// the owning pid, /proc says whether it lives, a scan says whether anything
// else holds the id) and passes --live-ok on proof; see actions/launch.js and
// createSessionOwnerProbe. These specs pin the CONTRACT that fix depends on,
// against the real bin/claude-sessions rather than a description of it:
// --live-ok must actually get a hot transcript past the guard, and its absence
// must actually still stop one, or the fix means nothing.
//
// Nothing real is touched: the Node index reads an isolated cache, and
// HARBOR_HERDR_BIN points at a stub, which (resolveUnitPolicy,
// 2026-07-29) also makes the default systemd unit not this run's to stop. The
// resume therefore dies at herdr, which is exactly the observation we want:
// reaching herdr at all means it got past the guard.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '../../..');
const CLAUDE_SESSIONS = path.join(ROOT, 'bin', 'claude-sessions');
const SESSION_ID = 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb';

// A herdr that is simply not there. Every liveness question answers "no
// daemon" fast, so the resume fails at the daemon instead of hanging.
//
// Its filename deliberately contains NO "herdr": startClean detaches this stub,
// and test/herdr/harness.js detects leaked daemons with `pgrep -a herdr`, which
// matches on the process NAME. A stub called herdr-stub makes this file fail
// the herdr suite's after-hook from another worker, intermittently.
const HERDR_STUB = `#!/usr/bin/env bash
exit 1
`;

function fixture({ transcriptAgeSeconds }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-live-guard-'));
  const cwd = path.join(dir, 'project');
  fs.mkdirSync(cwd);
  const transcript = path.join(dir, `${SESSION_ID}.jsonl`);
  // The death rattle itself: the last thing a dying claude appends.
  fs.writeFileSync(transcript, `${JSON.stringify({
    type: 'last-prompt', lastPrompt: 'anything', sessionId: SESSION_ID,
  })}\n`);
  const when = new Date(Date.now() - transcriptAgeSeconds * 1000);
  fs.utimesSync(transcript, when, when);

  const cacheDir = path.join(dir, 'cache');
  fs.mkdirSync(cacheDir);
  fs.writeFileSync(path.join(cacheDir, 'index.json'), JSON.stringify({
    v: 2,
    files: {
      [transcript]: {
        id: SESSION_ID, cwd, title: 'a session', mt: fs.statSync(transcript).mtimeMs,
        sz: fs.statSync(transcript).size, last: when.toISOString(),
      },
    },
  }));
  const configFile = path.join(dir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ paths: { cacheDir, projectsDir: path.join(dir, 'projects') } }));
  const daemonStub = path.join(dir, 'daemon-stub');
  fs.writeFileSync(daemonStub, HERDR_STUB, { mode: 0o755 });

  return { dir, transcript, configFile, daemonStub };
}

function resume({ configFile, daemonStub, dir }, extraArgs) {
  return spawnSync(CLAUDE_SESSIONS, ['--resume-id', SESSION_ID, ...extraArgs], {
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      // Drives the herdr CLI through a stub, so it declares the herdr backend
      // rather than inheriting a default that is now sessiond.
      HARBOR_SESSION_BACKEND: 'herdr',
      HARBOR_CONFIG_FILE: configFile,
      HARBOR_HERDR_BIN: daemonStub,
      HARBOR_HERDR_DIR: path.join(dir, 'herdr-home'),
      HARBOR_HERDR_DAEMON_LOG: path.join(dir, 'daemon.log'),
      HARBOR_HERDR_READY_TIMEOUT: '1',
      HARBOR_HERDR_SNAPSHOT_TIMEOUT: '2',
      HARBOR_HERDR_CALL_TIMEOUT: '2',
    },
  });
}

// Two-sided ON PURPOSE. A spec that only proved the refusal would pass just as
// well if --live-ok were ignored outright, and a spec that only proved the
// override would pass if the guard had been deleted; either alone would let
// Harbor ship believing it had fixed this.
test('a hot transcript still stops a plain resume, and --live-ok still gets past it', () => {
  const hot = fixture({ transcriptAgeSeconds: 5 });
  try {
    const refused = resume(hot, []);
    assert.notEqual(refused.status, 0, 'a 5s-old transcript must still refuse without proof');
    assert.match(refused.stderr, /looks LIVE right now/);
    assert.match(refused.stderr, /transcript was written \d+s ago/);

    const overridden = resume(hot, ['--live-ok']);
    assert.doesNotMatch(
      overridden.stderr,
      /looks LIVE right now/,
      '--live-ok must clear the guard, not merely be accepted as an argument',
    );
    // Past the guard it reaches the daemon, which is the observable proof it
    // got there: this stub herdr is never up.
    assert.match(overridden.stderr, /could not start the herdr server/);
  } finally {
    fs.rmSync(hot.dir, { recursive: true, force: true });
  }
});

test('a cold transcript needs no override at all', () => {
  const cold = fixture({ transcriptAgeSeconds: 600 });
  try {
    const result = resume(cold, []);
    assert.doesNotMatch(result.stderr, /looks LIVE right now/);
    assert.match(result.stderr, /could not start the herdr server/);
  } finally {
    fs.rmSync(cold.dir, { recursive: true, force: true });
  }
});
