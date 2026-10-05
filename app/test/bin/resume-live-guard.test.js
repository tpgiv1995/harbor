'use strict';

// THE DEATH RATTLE IS NOT A HEARTBEAT (live-caught 2026-08-03).
//
// bin/claude-sessions refuses to resume a session whose transcript was written
// in the last 90 seconds, on the reasoning that a hot transcript means a live
// writer. A claude WRITES ITS TRANSCRIPT ON THE WAY OUT (an away_summary and a
// last-prompt marker), so a fleet of sessions killed together is un-resumable
// for 90 seconds precisely BECAUSE it just died. That day the session daemon
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
// Nothing real is touched: the Node index reads an isolated cache, daemon
// autostart is disabled, and the client points at an isolated missing socket.
// Reaching that socket error proves the resume passed the guard.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '../../..');
const CLAUDE_SESSIONS = path.join(ROOT, 'bin', 'claude-sessions');
const SESSION_ID = 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb';

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
  return { dir, transcript, configFile };
}

function resume({ configFile, dir }, extraArgs) {
  return spawnSync(process.execPath, [CLAUDE_SESSIONS, '--resume-id', SESSION_ID, ...extraArgs], {
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      HARBOR_SESSION_BACKEND: 'sessiond',
      HARBOR_CONFIG_FILE: configFile,
      HARBOR_NO_DAEMON_START: '1',
      HARBOR_SESSIOND_SOCKET: path.join(dir, 'missing-sessiond.sock'),
      HARBOR_SESSIOND_REQUEST_TIMEOUT_MS: '1000',
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
    assert.match(overridden.stderr, /sessiond|ENOENT|connect/i);
  } finally {
    fs.rmSync(hot.dir, { recursive: true, force: true });
  }
});

test('a cold transcript needs no override at all', () => {
  const cold = fixture({ transcriptAgeSeconds: 600 });
  try {
    const result = resume(cold, []);
    assert.doesNotMatch(result.stderr, /looks LIVE right now/);
    assert.match(result.stderr, /sessiond|ENOENT|connect/i);
  } finally {
    fs.rmSync(cold.dir, { recursive: true, force: true });
  }
});
