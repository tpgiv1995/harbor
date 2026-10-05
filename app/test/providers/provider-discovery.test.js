'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { realTmpDir } = require('../support/real-tmpdir.js');
const { newSessionOptions } = require('../../src/main/providers/capabilities.js');

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(realTmpDir(), 'harbor-models-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  return home;
}

test('profile-less Codex reads launch home fresh, filters hidden models and keeps efforts per model', async (t) => {
  const home = await fixture(t);
  const deps = { homedir: () => home, env: {} };
  const config = { profiles: [{ id: 'personal', provider: 'claude' }], paths: { cacheDir: home } };
  const read = () => newSessionOptions(config, deps).providers.codex;
  assert.deepEqual(read().models.map((m) => m.value), ['default', 'gpt-6-sol']);
  const codexHome = path.join(home, '.codex');
  await fs.mkdir(codexHome);
  const levels = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
  const models = ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5'].map((slug, priority) => ({
    slug, visibility: 'list', priority,
    supported_reasoning_levels: levels.slice(0, priority === 4 ? 4 : priority === 3 ? 5 : 6).map((effort) => ({ effort })),
  }));
  await fs.writeFile(path.join(codexHome, 'models_cache.json'), JSON.stringify({ models: [...models, { slug: 'hidden', visibility: 'hide' }] }));
  assert.deepEqual(read().models.map((m) => m.value), ['default', ...models.map((m) => m.slug)]);
  assert.deepEqual(read().effortsByModel['gpt-6-astra'], levels);
  assert.deepEqual(read().effortsByModel['gpt-5.5'], levels.slice(0, 4));
  assert.deepEqual(read().effortsByModel['gpt-5.6-luna'], levels.slice(0, 5));
  assert.deepEqual(newSessionOptions(config, { ...deps, env: { CODEX_HOME: path.join(home, 'absent') } }).providers.codex.models.map((m) => m.value), ['default', 'gpt-6-sol']);
});

test('a codex 0.159-shaped catalog offers GPT-6.1 Sol by its own label and lets it supply the Default efforts', async (t) => {
  // Shape of codex 0.159.1+'s bundled catalog (synthetic subset): gpt-6.1-sol is
  // listed at priority 1 ahead of gpt-6-astra, so it is codex's own default.
  const home = await fixture(t);
  const codexHome = path.join(home, '.codex');
  await fs.mkdir(codexHome);
  const all = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map((effort) => ({ effort }));
  await fs.writeFile(path.join(codexHome, 'models_cache.json'), JSON.stringify({ models: [
    { slug: 'gpt-6-astra', display_name: 'GPT-6-Astra', visibility: 'list', priority: 2, supported_reasoning_levels: all },
    { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1-Sol', visibility: 'list', priority: 1, supported_reasoning_levels: all },
    { slug: 'gpt-6-luna', display_name: 'GPT-6-Luna', visibility: 'list', priority: 4, supported_reasoning_levels: all.slice(0, 5) },
  ] }));
  const codex = newSessionOptions({ profiles: [{ id: 'personal', provider: 'claude' }], paths: { cacheDir: home } }, { homedir: () => home, env: {} }).providers.codex;
  assert.ok(codex.models.some((m) => m.value === 'gpt-6.1-sol' && m.label === 'GPT-6.1-Sol'));
  assert.deepEqual(codex.effortsByModel['gpt-6.1-sol'], all.map((l) => l.effort));
  assert.deepEqual(codex.efforts, all.map((l) => l.effort));
  assert.deepEqual(codex.effortsByModel['gpt-6-luna'], all.slice(0, 5).map((l) => l.effort));
});

test('Cursor captured catalog is cached, served synchronously, and chosen model reaches both launch layers', async (t) => {
  const { createCursorModelCatalog } = require('../../src/main/providers/cursor-model-catalog.js');
  const { buildNewArgv } = require('../../src/main/actions/launch.js');
  const { parseAi } = require('../../../bin/harbor-bin.cjs');
  const home = await fixture(t);
  const cacheFile = path.join(home, 'cursor-models.json');
  const stdout = await fs.readFile(path.join(__dirname, '../fixtures/cursor-models-2026-09-20.txt'), 'utf8');
  const calls = [];
  const catalog = createCursorModelCatalog({ cacheFile, env: {}, platform: 'win32', bin: 'cursor-agent.cmd',
    execFile: async (...args) => { calls.push(args); return { stdout }; } });
  assert.equal(catalog.models().length, 1);
  assert.equal((await catalog.refresh()).ok, true);
  assert.ok(catalog.models().length > 80);
  assert.deepEqual(catalog.models()[0], { value: 'default', label: 'Default' });
  assert.deepEqual(catalog.models()[1], { value: 'auto', label: 'Auto' });
  assert.equal(calls[0][0], 'cmd.exe');
  assert.equal(calls[0][2].windowsHide, true);
  assert.ok(calls[0][2].timeout > 0 && calls[0][2].timeout <= 30000);
  const cached = createCursorModelCatalog({ cacheFile, env: {}, execFile: async () => { throw Error('offline'); } });
  assert.deepEqual(cached.models(), catalog.models());
  assert.equal((await cached.refresh()).ok, false);
  assert.deepEqual(cached.models(), catalog.models());
  const options = newSessionOptions({ profiles: [], paths: { cacheDir: home } }, { homedir: () => home, env: {} });
  const model = options.providers.cursor.models.find((m) => m.value === 'composer-2.5').value;
  const argv = buildNewArgv({ profiles: [], provider: 'cursor', model });
  assert.ok(argv.includes(model));
  const priorBin = process.env.HARBOR_CURSOR_BIN;
  process.env.HARBOR_CURSOR_BIN = 'fixture-cursor';
  try { assert.ok(parseAi(argv).argv.includes(model)); }
  finally {
    if (priorBin === undefined) delete process.env.HARBOR_CURSOR_BIN;
    else process.env.HARBOR_CURSOR_BIN = priorBin;
  }
});

test('Windows discovery launcher runs a .cmd fixture under a path with spaces', { skip: process.platform !== 'win32' }, async (t) => {
  const { cliCommand } = require('../../src/main/providers/cli-command.js');
  const home = await fixture(t);
  const dir = path.join(home, 'space (models)');
  await fs.mkdir(dir);
  const bin = path.join(dir, 'fixture.cmd');
  await fs.writeFile(bin, '@echo off\r\necho %1\r\n');
  const command = cliCommand(bin, ['models']);
  const { stdout } = await require('node:util').promisify(require('node:child_process').execFile)(command.file, command.args, { windowsHide: true, timeout: 3000 });
  assert.equal(stdout.trim(), 'models');
});

test('Cursor discovery is disabled under both isolation flags and rejects empty output without poisoning cache', async (t) => {
  const { createCursorModelCatalog } = require('../../src/main/providers/cursor-model-catalog.js');
  const home = await fixture(t);
  const cacheFile = path.join(home, 'cursor-models.json');
  for (const env of [{ HARBOR_E2E: '1' }, { HARBOR_NO_MODEL_DISCOVERY: '1' }]) {
    const catalog = createCursorModelCatalog({ cacheFile, env, execFile: async () => assert.fail('disabled spawn') });
    assert.equal((await catalog.refresh()).ok, false);
    assert.equal(catalog.models().length, 1);
  }
  const catalog = createCursorModelCatalog({ cacheFile, env: {}, execFile: async () => ({ stdout: 'Login required' }) });
  assert.equal((await catalog.refresh()).ok, false);
  assert.equal(catalog.models().length, 1);
});

test('Codex debug models refresh is bounded, home-specific and skipped for matching client version', async (t) => {
  const { createCodexModelDiscovery } = require('../../src/main/providers/codex-model-catalog.js');
  const home = await fixture(t);
  const codexHome = path.join(home, '.codex');
  await fs.mkdir(codexHome);
  const file = path.join(codexHome, 'models_cache.json');
  await fs.writeFile(file, JSON.stringify({ client_version: '0.154.0', models: [] }));
  const calls = [];
  const catalog = createCodexModelDiscovery({ profiles: [], homedir: () => home, env: {},
    execFile: async (...args) => {
      calls.push(args);
      await fs.writeFile(file, JSON.stringify({ client_version: '0.155.1', models: [{ slug: 'synthetic-model' }] }));
      return { stdout: '{}' };
    } });
  assert.equal((await catalog.refresh({ version: '0.155.1' })).ok, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][1].slice(-2), ['debug', 'models']);
  assert.equal(calls[0][2].env.CODEX_HOME, codexHome);
  assert.equal(calls[0][2].windowsHide, true);
  await catalog.refresh({ version: '0.155.1' });
  assert.equal(calls.length, 1);
  for (const env of [{ HARBOR_E2E: '1' }, { HARBOR_NO_MODEL_DISCOVERY: '1' }]) {
    const disabled = createCodexModelDiscovery({ profiles: [], homedir: () => home, env,
      execFile: async () => assert.fail('disabled discovery spawned') });
    await disabled.refresh({ version: 'future', force: true });
  }
});
