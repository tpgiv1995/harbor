'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { realTmpDir } = require('../support/real-tmpdir.js');
const { executablePath, validateProviderExecutables } = require('../../src/main/setup/executables.js');
const { registerSetupIpc } = require('../../src/main/setup/ipc.js');
const wizard = require('../../src/renderer/setup/wizard-model.cjs');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(realTmpDir(), 'harbor-executable-check-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, process.platform === 'win32' ? 'fixture.cmd' : 'fixture');
  fs.writeFileSync(bin, 'never execute this fixture', { mode: 0o755 });
  return { dir, bin };
}

test('executable lookup accepts files and PATH names, and rejects missing paths and directories', async (t) => {
  const { dir, bin } = fixture(t);
  const options = { env: { PATH: dir } };
  assert.equal(await executablePath(bin, options), bin);
  assert.equal(await executablePath('fixture', options), bin);
  assert.equal(await executablePath(path.basename(bin), options), bin);
  assert.equal(await executablePath(dir, options), null);
  assert.equal(await executablePath(path.join(dir, 'absent'), options), null);
  if (process.platform === 'win32') {
    const text = path.join(dir, 'ordinary.txt');
    fs.writeFileSync(text, 'not a command');
    assert.equal(await executablePath(text, options), text);
  } else {
    fs.chmodSync(bin, 0o644);
    assert.equal(await executablePath(bin, options), null);
  }
});

for (const provider of ['claude', 'codex', 'cursor']) {
  test(`${provider}: wizard preview and Finish recheck the selected file before saving`, async (t) => {
    const { dir, bin } = fixture(t);
    const detected = {
      os: process.platform, homedir: dir, shell: process.execPath,
      claudeHomes: [{ id: 'account', path: dir, exists: true }],
      providers: Object.fromEntries(['claude', 'codex', 'cursor'].map((name) => [name, { found: true, path: bin, home: dir }])),
    };
    const config = wizard.configFromWizard(wizard.initialState(detected));
    for (const name of Object.keys(config.providers)) config.providers[name].enabled = name === provider;
    const handlers = new Map();
    let saved = null, completed = 0;
    registerSetupIpc({
      ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
      getConfig: () => config,
      saveConfig: async (next) => { saved = next; return next; },
      onCompleted: () => { completed += 1; },
      validateProviderExecutables: (next) => validateProviderExecutables(next, { env: { PATH: dir } }),
    });
    const call = (name) => handlers.get(`setup:${name}`)({}, { config });
    assert.equal((await call('preview')).ok, true);
    fs.unlinkSync(bin);
    const refused = await call('save');
    assert.equal(refused.ok, false);
    assert.match(refused.reason, new RegExp(`${provider} executable not found`));
    assert.equal(saved, null);
    assert.equal(completed, 0);
    assert.equal((await call('preview')).ok, false);
    fs.writeFileSync(bin, 'never execute this fixture', { mode: 0o755 });
    assert.equal((await call('save')).ok, true);
    assert.equal(saved.setup.completed, true);
    assert.equal(completed, 1);
  });
}

test('disabled providers do not require an installed executable', async () => {
  await validateProviderExecutables({ providers: { cursor: { enabled: false, bin: 'absent-command' } } }, { env: { PATH: '' } });
});
