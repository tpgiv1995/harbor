'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { realTmpDir } = require('../support/real-tmpdir.js');
const wizard = require('../../src/renderer/setup/wizard-model.cjs');
const { buildNewArgv, AI_BIN } = require('../../src/main/actions/launch.js');

for (const provider of ['claude', 'codex', 'cursor']) {
  test(`wizard ${provider} launch is accepted by the real CLI`, (t) => {
    const dir = fs.mkdtempSync(path.join(realTmpDir(), 'harbor-launch-contract-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const homes = Object.fromEntries(['claude', 'codex', 'cursor'].map((name) => [name, path.join(dir, `.${name}`)]));
    for (const home of Object.values(homes)) fs.mkdirSync(home);
    const detected = {
      os: process.platform, homedir: dir, shell: process.execPath,
      claudeHomes: [{ id: 'account', path: homes.claude, exists: true }],
      providers: Object.fromEntries(Object.entries(homes).map(([name, home]) => [name, { found: true, path: process.execPath, home }])),
    };
    const config = wizard.configFromWizard(wizard.initialState(detected));
    const profile = config.profiles.find((item) => item.provider === provider);
    assert.equal(profile.configHome, homes[provider], 'history keeps the wizard-selected home');
    const argv = buildNewArgv({ account: profile.id, profiles: config.profiles, provider });
    const configFile = path.join(dir, 'config.json');
    fs.writeFileSync(configFile, JSON.stringify(config));
    // The home restriction is validated AFTER parseAi, before this dry-run
    // boundary. Running the CLI catches the contract a builder-only test missed.
    const result = spawnSync(process.execPath, [AI_BIN, ...argv], {
      cwd: dir, encoding: 'utf8', windowsHide: true, timeout: 10000,
      env: {
        ...process.env, HOME: dir, USERPROFILE: dir, APPDATA: dir, LOCALAPPDATA: dir,
        HARBOR_CONFIG_FILE: configFile, HARBOR_AI_DRY_RUN: '1',
        HARBOR_SESSION_BACKEND: 'sessiond', HARBOR_NO_DAEMON_START: '1',
        HARBOR_USER_DATA_DIR: dir, HARBOR_SESSIOND_DIR: path.join(dir, 'sessiond'),
        HARBOR_SESSIOND_SOCKET: path.join(dir, 'sessiond.sock'), HARBOR_CONTEXT_DIR: path.join(dir, 'context'),
      },
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, provider === 'cursor' ? /--force/ : /--dangerously-/);
    assert.equal(argv.includes('--home'), provider !== 'cursor');
  });
}
