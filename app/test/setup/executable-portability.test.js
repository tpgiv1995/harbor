'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { realTmpDir } = require('../support/real-tmpdir.js');
const { executablePath, validateProviderExecutables } = require('../../src/main/setup/executables.js');
const wizard = require('../../src/renderer/setup/wizard-model.cjs');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(realTmpDir(), 'harbor-executable-portability-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, options: { platform: 'win32', env: { PATH: dir, PATHEXT: '.CMD;.PS1;.CUSTOM' } } };
}

for (const name of ['npm-shim', 'wrapper.ps1', 'wrapper.custom']) {
  test(`Windows accepts an explicitly chosen ${name} file without executing it`, async (t) => {
    const { dir, options } = fixture(t);
    const file = path.join(dir, name);
    fs.writeFileSync(file, 'fixture must never run');
    assert.equal(await executablePath(file, options), file);
  });
}
test('Windows bare-name lookup follows PATHEXT and tries the bare file first', async (t) => {
  const { dir, options } = fixture(t);
  const file = path.join(dir, 'wrapper.custom');
  fs.writeFileSync(file, 'fixture must never run');
  assert.equal(await executablePath('wrapper', options), file);
  const bare = path.join(dir, 'wrapper');
  fs.writeFileSync(bare, 'fixture must never run');
  assert.equal(await executablePath('wrapper', options), bare);
});
test('an unverified nonempty path requires an exact, explicit approval; changing it invalidates approval', async (t) => {
  const { dir, options } = fixture(t);
  const bin = path.join(dir, 'unconfirmed.ps1');
  const config = { providers: { claude: { enabled: true, bin } } };
  await assert.rejects(validateProviderExecutables(config, options), /claude executable not found/);
  config.setup = { executableApprovals: { claude: bin } };
  await assert.doesNotReject(validateProviderExecutables(config, options));
  config.providers.claude.bin = path.join(dir, 'different.ps1');
  await assert.rejects(validateProviderExecutables(config, options), /claude executable not found/);
  config.providers.claude.bin = '';
  config.setup.executableApprovals.claude = '';
  await assert.rejects(validateProviderExecutables(config, options), /empty/);
});
test('wizard carries only current path approvals and never revives a saved approval on reopen', () => {
  const state = wizard.initialState({ os: 'win32', homedir: 'C:/fixture', shell: 'pwsh', claudeHomes: [{ id: 'account', path: 'C:/fixture/claude', exists: true }] });
  state.claude.bin = 'claude-custom';
  state.executableApprovals = { claude: state.claude.bin, cursor: 'old-path' };
  const config = wizard.configFromWizard(state);
  assert.deepEqual(config.setup.executableApprovals, { claude: state.claude.bin });
  state.claude.bin = 'different-path';
  assert.deepEqual(wizard.configFromWizard(state).setup.executableApprovals, {});
  const reopened = wizard.initialState({}, config);
  assert.deepEqual(wizard.configFromWizard(reopened).setup.executableApprovals || {}, {});
});
