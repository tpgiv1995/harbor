'use strict';

// Gemini in the new-session registry and in a running session's capability menu (2026-11-23). The registry offers
// Gemini only where its CLI resolves (the shared resolver), with agy's own families, each with its own levels; a
// running Gemini session's menu is never Claude's. Every path is a scratch folder.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCapabilitiesProvider, newSessionOptions } = require('../../src/main/providers/capabilities.js');

const tmp = (t) => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'gemini-caps-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const PROFILES = [{ id: 'personal', label: 'Personal', letter: 'P', color: '#437FFE', provider: 'claude', configHome: '/h', isDefault: true }];

function machine(t, { installed = true, models = true } = {}) {
  const root = tmp(t);
  const agy = path.join(root, 'agy.exe');
  if (installed) fs.writeFileSync(agy, '');
  const cacheDir = path.join(root, 'cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  if (models) {
    fs.writeFileSync(path.join(cacheDir, 'gemini-models.json'), JSON.stringify({ rows: [
      { id: 'gemini-4-neon-high', label: 'Gemini 4 Neon (High)' }, { id: 'gemini-4-neon-low', label: 'Gemini 4 Neon (Low)' },
      { id: 'gemini-4-hydrogen-low', label: 'Gemini 4 Hydrogen (Low)' },
    ] }));
  }
  const deps = { env: { HARBOR_AGY_BIN: agy }, homedir: () => root, platform: 'win32' };
  return { root, agy, cacheDir, deps, config: { profiles: PROFILES, paths: { cacheDir }, providers: {} } };
}

test('the registry offers Gemini when the CLI resolves, with its families, per-family levels and agy\'s own defaults', (t) => {
  const m = machine(t);
  const options = newSessionOptions(m.config, m.deps);
  const gemini = options.providers.gemini;
  assert.ok(gemini, 'a Gemini tab');
  assert.equal(gemini.bin, m.agy);
  assert.equal(gemini.defaultModel, 'default');
  assert.deepEqual(gemini.models.map((x) => x.value), ['default', 'gemini-4-neon', 'gemini-4-hydrogen']);
  assert.deepEqual(gemini.effortsByModel['gemini-4-neon'], ['low', 'high']);
  assert.deepEqual(gemini.effortsByModel['gemini-4-hydrogen'], ['low']);
  assert.equal(gemini.defaultEffort, 'high');
  assert.deepEqual(gemini.profiles, []);
  assert.equal(gemini.defaultProfile, null, 'no Gemini profile: the pane runs under the user\'s own profile');
  // The other three are exactly as before.
  assert.deepEqual(Object.keys(options.providers).filter((id) => id !== 'gemini').sort(), ['claude', 'codex', 'cursor']);
});

test('no CLI, no Gemini tab: a launch button that would die is never offered', (t) => {
  const m = machine(t, { installed: false });
  assert.equal(newSessionOptions(m.config, m.deps).providers.gemini, undefined);
});

test('turned off in config stays off even where the CLI resolves; on with a bare model cache still offers Default', (t) => {
  const m = machine(t, { models: false });
  assert.equal(newSessionOptions({ ...m.config, providers: { gemini: { enabled: false } } }, m.deps).providers.gemini, undefined);
  const gemini = newSessionOptions({ ...m.config, providers: { gemini: { enabled: true } } }, m.deps).providers.gemini;
  assert.deepEqual(gemini.models, [{ value: 'default', label: 'Gemini default' }]);
  assert.deepEqual(gemini.efforts, ['low', 'medium', 'high', 'xhigh']);
});

test('a Gemini profile (a USERPROFILE root) travels with the tab', (t) => {
  const m = machine(t);
  const profiles = [...PROFILES, { id: 'gem', label: 'Gemini', letter: 'G', color: '#4285f4', provider: 'gemini', configHome: path.join(m.root, 'root'), isDefault: false }];
  const gemini = newSessionOptions({ ...m.config, profiles }, m.deps).providers.gemini;
  assert.deepEqual(gemini.profiles.map((p) => p.id), ['gem']);
  assert.equal(gemini.defaultProfile, 'gem');
});

test('the configured path counts only when it names a real file; a bare name falls through to the shared resolver', (t) => {
  const m = machine(t);
  const other = path.join(m.root, 'other-agy.exe');
  fs.writeFileSync(other, '');
  const deps = { ...m.deps, env: {} };
  assert.equal(newSessionOptions({ ...m.config, providers: { gemini: { enabled: true, bin: other } } }, deps).providers.gemini.bin, other);
  assert.equal(newSessionOptions({ ...m.config, providers: { gemini: { enabled: true, bin: 'agy' } } }, deps).providers.gemini, undefined, 'a placeholder is not an install');
});

test('a running Gemini session\'s capability menu is not Claude\'s: no slash list, plugins, MCP, efforts or fast mode', async () => {
  const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-caps-home-'));
  try {
    const accounts = { resolveSession: async (id) => ({ account: 'personal', home: claudeHome, meta: { id, cwd: 'C:\\work', provider: id.startsWith('g') ? 'gemini' : undefined } }) };
    const caps = createCapabilitiesProvider({ accounts });
    const gemini = await caps.get('gem-1');
    assert.equal(gemini.provider, 'gemini');
    assert.equal(gemini.cwd, 'C:\\work');
    assert.deepEqual(gemini.commands, []);
    assert.deepEqual(gemini.effort.levels, []);
    assert.deepEqual(gemini.plugins, []);
    assert.deepEqual(gemini.mcpServers, []);
    assert.equal(gemini.fastMode.available, false);
    assert.equal(gemini.account, null);
    assert.equal(gemini.home, null);
    assert.equal(typeof gemini.dynamicWorkflow.keyword, 'string', 'the field shape consumers read is intact');
    const claude = await caps.get('claude-1');
    assert.ok(claude.commands.length > 10, 'a Claude session keeps its menu (two-sided: the Claude shell is untouched)');
    assert.deepEqual(claude.effort.levels.slice(0, 2), ['low', 'medium']);
    assert.equal(claude.provider, undefined);
  } finally {
    fs.rmSync(claudeHome, { recursive: true, force: true });
  }
});
