'use strict';

// A RESUME THAT NAMES NO PLAN RUNS ON THE SESSION'S OWN PLAN (2026-11-15).
//
// Vox ran on work, Harbor put it to sleep, and Pat woke it from the phone,
// whose composer sends no plan. Harbor's resume builder turned "no plan" into
// an explicit `--home <default>`, which outranks claude-sessions' own
// `--home auto` lookup, so the session came back on Pat's personal plan and
// billed it for five hours under an S badge. These specs drive the whole chain
// for real: Harbor's own buildResumeArgv feeds the real bin/claude-sessions,
// and the plan it chose is read back from the folder-trust marker it writes
// into THAT plan's `.claude.json` just before the launch.
//
// Nothing real is touched: both plans are temp folders named in an isolated
// config, the index reads an isolated cache, daemon autostart is off, and the
// client points at a missing socket, so the launch itself fails harmlessly
// after the plan has been chosen.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildResumeArgv } = require('../../src/main/actions/launch.js');

const ROOT = path.resolve(__dirname, '../../..');
const CLAUDE_SESSIONS = path.join(ROOT, 'bin', 'claude-sessions');
const SESSION_ID = 'cccccccc-1111-2222-3333-dddddddddddd';
const HOUR = 3_600_000;

function fixture(t, prompts) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'harbor-resume-home-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cwd = path.join(dir, 'project');
  fs.mkdirSync(cwd);
  // plan-a is FIRST, so it is the default a missing plan used to become.
  const profiles = ['plan-a', 'plan-b'].map((id) => ({ id, label: id, configHome: path.join(dir, `.claude-${id}`) }));
  for (const profile of profiles) fs.mkdirSync(path.join(profile.configHome, 'session-env'), { recursive: true });
  for (const [index, at] of prompts) {
    fs.appendFileSync(path.join(profiles[index].configHome, 'history.jsonl'),
      `${JSON.stringify({ display: 'a prompt', timestamp: at, project: cwd, sessionId: SESSION_ID })}\n`);
  }
  const transcript = path.join(dir, `${SESSION_ID}.jsonl`);
  fs.writeFileSync(transcript, `${JSON.stringify({ type: 'last-prompt', lastPrompt: 'anything', sessionId: SESSION_ID })}\n`);
  const cold = new Date(Date.now() - 600_000);
  fs.utimesSync(transcript, cold, cold);
  const cacheDir = path.join(dir, 'cache');
  fs.mkdirSync(cacheDir);
  fs.writeFileSync(path.join(cacheDir, 'index.json'), JSON.stringify({
    v: 2,
    files: {
      [transcript]: {
        id: SESSION_ID, cwd, title: 'a session', mt: fs.statSync(transcript).mtimeMs,
        sz: fs.statSync(transcript).size, last: cold.toISOString(),
      },
    },
  }));
  const configFile = path.join(dir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ profiles, paths: { cacheDir, projectsDir: path.join(dir, 'projects') } }));
  return { dir, profiles, configFile };
}

function resumeChoosesPlan({ dir, profiles, configFile }, argv) {
  const result = spawnSync(process.execPath, [CLAUDE_SESSIONS, ...argv], {
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      HARBOR_SESSION_BACKEND: 'sessiond',
      HARBOR_CONFIG_FILE: configFile,
      HARBOR_NO_DAEMON_START: '1',
      HARBOR_SESSIOND_SOCKET: path.join(dir, 'missing-sessiond.sock'),
      HARBOR_SESSIOND_REQUEST_TIMEOUT_MS: '1000',
      HARBOR_NO_TRUST_PREACCEPT: '',
      HARBOR_E2E: '',
    },
  });
  // The plan was chosen and the launch reached the (missing) daemon.
  assert.match(result.stderr, /sessiond|ENOENT|connect/i, result.stderr);
  const chosen = profiles.filter((profile) => fs.existsSync(path.join(profile.configHome, '.claude.json')));
  assert.equal(chosen.length, 1, `exactly one plan must be prepared, got ${chosen.map((p) => p.id).join(', ') || 'none'}`);
  return chosen[0].id;
}

test('a resume that names no plan runs on the plan the session last ran on, not the default', (t) => {
  // Many older prompts on plan-a, then a relaunch on plan-b: plan-b is where it runs.
  const moved = fixture(t, [[0, Date.now() - 5 * HOUR], [0, Date.now() - 4 * HOUR], [0, Date.now() - 3 * HOUR], [1, Date.now() - HOUR]]);
  const argv = buildResumeArgv({ id: SESSION_ID, detectedHome: undefined, profiles: moved.profiles });
  assert.deepEqual(argv, ['--resume-id', SESSION_ID], 'no plan given, so none is sent');
  assert.equal(resumeChoosesPlan(moved, argv), 'plan-b');
});

test('the observation is real: a named plan still wins, and a session of the default plan stays there', (t) => {
  const onB = fixture(t, [[1, Date.now() - HOUR]]);
  assert.equal(resumeChoosesPlan(onB, buildResumeArgv({ id: SESSION_ID, detectedHome: 'plan-a', profiles: onB.profiles })), 'plan-a');
  const onA = fixture(t, [[0, Date.now() - HOUR]]);
  assert.equal(resumeChoosesPlan(onA, buildResumeArgv({ id: SESSION_ID, detectedHome: undefined, profiles: onA.profiles })), 'plan-a');
});
