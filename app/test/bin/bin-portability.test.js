'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { cleanDaemonEnv } = require('../../../bin/harbor-bin.cjs');
const { createHistoryIndex } = require('../../src/main/providers/history-index.js');

const ROOT = path.resolve(__dirname, '../../..');

test('Node index paths derive from the configured home and Windows cwd labels round-trip', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-home-'));
  const config = path.join(home, 'config.json');
  const projectsDir = path.join(home, 'Claude Data', 'projects');
  const cacheDir = path.join(home, 'Harbor Cache');
  fs.writeFileSync(config, JSON.stringify({
    paths: { projectsDir, cacheDir },
    profiles: [],
  }));
  const index = createHistoryIndex({ home, projectsDir, cacheDir });
  // A username with a SPACE in it is the point of this fixture, not whose it is.
  assert.equal(index.projectLabel('C:\\Users\\Ada Lovelace\\dev\\harbor'), 'win: dev/harbor');
  assert.equal(index.run(['emit', '--all']), '');
});

test('ai dry-run is shell independent and does not leak HERDR_PANE_ID into its child environment', () => {
  // A config file of its own, so this measures bin/ai rather than whatever the
  // developer running the suite happens to have configured.
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-portability-config-'));
  fs.writeFileSync(path.join(configDir, 'config.json'), '{}');
  const result = spawnSync(path.join(ROOT, 'bin/ai'), ['--model', 'opus'], {
    env: {
      ...process.env,
      HARBOR_AI_DRY_RUN: '1',
      HERDR_PANE_ID: 'live-pane',
      HARBOR_CONFIG_FILE: path.join(configDir, 'config.json'),
    },
    encoding: 'utf8',
  });
  fs.rmSync(configDir, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'claude --dangerously-skip-permissions --model opus');
});

test('portable health check probes a timed real snapshot, never status', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-health-'));
  const log = path.join(dir, 'argv.json');
  const stub = path.join(dir, 'herdr-stub.js');
  fs.writeFileSync(stub, `
require('node:fs').writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)));
`);
  const herdr = path.join(dir, process.platform === 'win32' ? 'herdr.cmd' : 'herdr');
  fs.writeFileSync(
    herdr,
    process.platform === 'win32'
      ? `@echo off\r\n"${process.execPath}" "${stub}" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "${stub}" "$@"\n`,
    { mode: 0o755 },
  );
  const result = spawnSync(path.join(ROOT, 'bin/herdr-health.sh'), [], {
    env: { ...process.env, HARBOR_HERDR_BIN: herdr },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(log, 'utf8')), ['api', 'snapshot']);
});

test('daemon environment is an explicit allowlist, equivalent to env -i', () => {
  const prior = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CLAUDE_CODE_SESSION_ID = 'must-not-leak';
  try {
    const env = cleanDaemonEnv();
    assert.equal(env.CLAUDE_CODE_SESSION_ID, undefined);
    assert.equal(env.HERDR_PANE_ID, undefined);
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.ok(env.HOME);
    assert.ok(env.PATH);
  } finally {
    if (prior === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = prior;
  }
});
