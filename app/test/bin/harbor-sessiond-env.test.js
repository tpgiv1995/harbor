'use strict';

// The CLI start path forwards the job policy settings (2026-10-11). Keepers
// inherit the daemon's environment, so a setting `bin/harbor-sessiond start`
// drops is a setting that silently does nothing: Astra's review found the
// documented per-process ceiling override (and the older job memory and
// no-job switches) never reached a session.

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const NAMES = ['HARBOR_SESSIOND_PROCESS_MEMORY_MAX', 'HARBOR_SESSIOND_SESSION_JOB_MEMORY_MAX', 'HARBOR_SESSIOND_NO_JOB'];

test('job policy settings survive the CLI env filter, and session ids still do not', (t) => {
  const saved = Object.fromEntries([...NAMES, 'CLAUDE_SESSION_ID_SAMPLE'].map((n) => [n, process.env[n]]));
  t.after(() => { for (const [n, v] of Object.entries(saved)) { if (v === undefined) delete process.env[n]; else process.env[n] = v; } });
  process.env.HARBOR_SESSIOND_PROCESS_MEMORY_MAX = 'off';
  process.env.HARBOR_SESSIOND_SESSION_JOB_MEMORY_MAX = '40G';
  process.env.HARBOR_SESSIOND_NO_JOB = '1';
  process.env.CLAUDE_SESSION_ID_SAMPLE = 'should-not-leak';
  const { cleanDaemonEnv } = require(path.resolve(__dirname, '../../../bin/harbor-sessiond'));
  const env = cleanDaemonEnv();
  assert.equal(env.HARBOR_SESSIOND_PROCESS_MEMORY_MAX, 'off');
  assert.equal(env.HARBOR_SESSIOND_SESSION_JOB_MEMORY_MAX, '40G');
  assert.equal(env.HARBOR_SESSIOND_NO_JOB, '1');
  assert.equal(env.CLAUDE_SESSION_ID_SAMPLE, undefined, 'the allowlist still keeps a session\'s own variables out');
});

test('dormancy settings and the config location survive the CLI env filter', (t) => {
  const names = ['HARBOR_SESSIOND_DORMANT_AFTER_MS', 'HARBOR_SESSIOND_MAX_LIVE_SESSIONS', 'HARBOR_CONFIG_FILE', 'XDG_CONFIG_HOME'];
  const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  t.after(() => { for (const [n, v] of Object.entries(saved)) { if (v === undefined) delete process.env[n]; else process.env[n] = v; } });
  process.env.HARBOR_SESSIOND_DORMANT_AFTER_MS = '14400000';
  process.env.HARBOR_SESSIOND_MAX_LIVE_SESSIONS = '32';
  process.env.HARBOR_CONFIG_FILE = '/tmp/harbor-config.json';
  process.env.XDG_CONFIG_HOME = '/tmp/xdg';
  const { cleanDaemonEnv } = require(path.resolve(__dirname, '../../../bin/harbor-sessiond'));
  const env = cleanDaemonEnv();
  assert.equal(env.HARBOR_SESSIOND_DORMANT_AFTER_MS, '14400000');
  assert.equal(env.HARBOR_SESSIOND_MAX_LIVE_SESSIONS, '32');
  assert.equal(env.HARBOR_CONFIG_FILE, '/tmp/harbor-config.json');
  assert.equal(env.XDG_CONFIG_HOME, '/tmp/xdg');
});
