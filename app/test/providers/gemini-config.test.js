'use strict';

// ONE resolver for where Gemini's CLI (agy) is and which home it runs under (2026-11-23): the plans dropdown, the
// new-session registry, bin/ai and the model catalog all read it, so these specs pin its precedence once. Every path
// here is invented; nothing touches the real ~/.harbor or a real agy.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  geminiConfigFrom, resolveGeminiConfigSync, resolveGeminiConfig, geminiStateDir, geminiChildEnv, AGY_NO_UPDATE_ENV,
} = require('../../src/main/providers/gemini-config.js');

function fixture(t, { saved = null, bin = true } = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'gemini-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const agy = path.join(root, 'tools', 'agy.exe');
  if (bin) { fs.mkdirSync(path.dirname(agy), { recursive: true }); fs.writeFileSync(agy, ''); }
  if (saved) {
    fs.mkdirSync(path.join(root, '.harbor'), { recursive: true });
    fs.writeFileSync(path.join(root, '.harbor', 'gemini.json'), JSON.stringify(saved(agy)));
  }
  return { root, agy };
}

test('the binary resolves env first, then gemini.json, then the config path, then the installer default', () => {
  const local = 'C:\\Users\\someone\\AppData\\Local';
  const base = { home: 'C:\\Users\\someone', platform: 'win32', env: { LOCALAPPDATA: local } };
  assert.equal(geminiConfigFrom(base).bin, path.join(local, 'agy', 'bin', 'agy.exe'), 'the installer default');
  assert.equal(geminiConfigFrom({ ...base, saved: { bin: 'C:\\pinned\\agy.exe' } }).bin, 'C:\\pinned\\agy.exe');
  assert.equal(geminiConfigFrom({ ...base, saved: { bin: 'C:\\pinned\\agy.exe' }, configuredBin: 'C:\\cfg\\agy.exe' }).bin, 'C:\\pinned\\agy.exe', 'a re-pin in gemini.json outranks a path the config copied earlier');
  assert.equal(geminiConfigFrom({ ...base, configuredBin: 'C:\\cfg\\agy.exe' }).bin, 'C:\\cfg\\agy.exe');
  assert.equal(geminiConfigFrom({ ...base, env: { ...base.env, HARBOR_GEMINI_BIN: 'C:\\gen\\agy.exe' }, saved: { bin: 'C:\\pinned\\agy.exe' } }).bin, 'C:\\gen\\agy.exe');
  assert.equal(geminiConfigFrom({ ...base, env: { ...base.env, HARBOR_AGY_BIN: 'C:\\env\\agy.exe', HARBOR_GEMINI_BIN: 'C:\\gen\\agy.exe' } }).bin, 'C:\\env\\agy.exe');
  assert.equal(geminiConfigFrom({ env: {}, home: '/home/x', platform: 'linux' }).bin, path.join('/home/x', '.local', 'bin', 'agy'));
});

test('a bare name in the config is the schema placeholder, not a choice', () => {
  const resolved = geminiConfigFrom({ env: {}, home: '/home/x', platform: 'linux', configuredBin: 'agy', saved: { bin: '/pin/agy' } });
  assert.equal(resolved.bin, '/pin/agy');
});

test('the home is only ever a USERPROFILE override from env or gemini.json, never a default', () => {
  assert.equal(geminiConfigFrom({ env: {}, home: '/h', platform: 'linux' }).agyHome, null);
  assert.equal(geminiConfigFrom({ env: {}, home: '/h', platform: 'linux', saved: { home: '/s' } }).agyHome, '/s');
  assert.equal(geminiConfigFrom({ env: { HARBOR_AGY_HOME: '/e' }, home: '/h', platform: 'linux', saved: { home: '/s' } }).agyHome, '/e');
});

test('sync and async readers agree, and both answer null when the CLI is not installed', async (t) => {
  const present = fixture(t, { saved: (agy) => ({ bin: agy, home: '/somewhere' }) });
  const opts = { env: {}, home: present.root, platform: 'win32' };
  assert.deepEqual(resolveGeminiConfigSync(opts), { bin: present.agy, agyHome: '/somewhere' });
  assert.deepEqual(await resolveGeminiConfig(opts), { bin: present.agy, agyHome: '/somewhere' });
  const absent = fixture(t, { saved: (agy) => ({ bin: agy }), bin: false });
  assert.equal(resolveGeminiConfigSync({ env: {}, home: absent.root, platform: 'win32' }), null);
  assert.equal(await resolveGeminiConfig({ env: {}, home: absent.root, platform: 'win32' }), null);
});

test('a broken gemini.json is ignored rather than throwing', (t) => {
  const { root } = fixture(t);
  fs.mkdirSync(path.join(root, '.harbor'), { recursive: true });
  fs.writeFileSync(path.join(root, '.harbor', 'gemini.json'), '{not json');
  assert.equal(resolveGeminiConfigSync({ env: { HARBOR_AGY_BIN: path.join(root, 'tools', 'agy.exe') }, home: root, platform: 'win32' }).bin, path.join(root, 'tools', 'agy.exe'));
});

test('the state folder follows USERPROFILE, and the child env never self-updates or touches HOME', () => {
  assert.equal(geminiStateDir('/profile'), path.join('/profile', '.gemini', 'antigravity-cli'));
  assert.equal(geminiStateDir(null, '/me'), path.join('/me', '.gemini', 'antigravity-cli'));
  assert.deepEqual(AGY_NO_UPDATE_ENV, { AGY_CLI_DISABLE_AUTO_UPDATE: 'true' });
  const plain = geminiChildEnv({ A: '1' });
  assert.equal(plain.AGY_CLI_DISABLE_AUTO_UPDATE, 'true');
  assert.equal(plain.USERPROFILE, undefined, 'USERPROFILE unchanged by default');
  const moved = geminiChildEnv({}, { root: 'D:\\other' });
  assert.equal(moved.USERPROFILE, 'D:\\other');
  assert.equal(moved.HOME, undefined, 'agy ignores HOME, so it is not set');
});
