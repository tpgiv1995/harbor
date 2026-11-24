'use strict';

// Gemini ships OFF in the config schema and turns on only where the CLI resolves (2026-11-23), and never overrides
// what the config already chose. The three older providers' defaults are untouched.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { deriveDefaults } = require('../../src/main/config/defaults.js');
const { SCHEMA } = require('../../src/main/config/schema.js');

function home(t, { agy = true } = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'gemini-defaults-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'tools', 'agy.exe');
  if (agy) { fs.mkdirSync(path.dirname(bin), { recursive: true }); fs.writeFileSync(bin, ''); }
  fs.mkdirSync(path.join(root, '.harbor'), { recursive: true });
  fs.writeFileSync(path.join(root, '.harbor', 'gemini.json'), JSON.stringify({ bin }));
  return { root, bin, runtime: { env: {}, homedir: root, platform: 'win32', findBinary: (name) => `/bin/${name}` } };
}

test('the schema ships Gemini undecided (never a persisted false) with no binary named, and the three others on', () => {
  assert.deepEqual(SCHEMA.providers.gemini, { enabled: null, bin: null });
  for (const id of ['claude', 'codex', 'cursor']) assert.equal(SCHEMA.providers[id].enabled, true);
});

test('derived defaults turn Gemini on, with the resolved path, only when the CLI is there', (t) => {
  const present = home(t);
  const on = deriveDefaults({}, present.runtime).providers.gemini;
  assert.deepEqual(on, { enabled: true, bin: present.bin }, 'the resolved path is copied (the wizard validates enabled bins); gemini.json still outranks it at read time');
  const absent = home(t, { agy: false });
  const off = deriveDefaults({}, absent.runtime).providers.gemini;
  assert.equal(off.enabled, null, 'no CLI: undecided, so installing agy later turns it on at the next load');
  assert.equal(off.bin, 'agy');
  assert.equal(deriveDefaults(JSON.parse(JSON.stringify(off ? { providers: { gemini: off } } : {})), present.runtime).providers.gemini.enabled, true, 'a persisted null is recomputed, not kept');
});

test('a config that already chose is never overridden, either way', (t) => {
  const present = home(t);
  assert.equal(deriveDefaults({ providers: { gemini: { enabled: false } } }, present.runtime).providers.gemini.enabled, false, 'turned off stays off');
  const absent = home(t, { agy: false });
  assert.equal(deriveDefaults({ providers: { gemini: { enabled: true } } }, absent.runtime).providers.gemini.enabled, true, 'turned on stays on');
  assert.equal(deriveDefaults({ providers: { gemini: { bin: 'D:\\mine\\agy.exe' } } }, present.runtime).providers.gemini.bin, 'D:\\mine\\agy.exe');
});

test('the other providers\' defaults are unchanged, and a null bin still comes from the PATH lookup', (t) => {
  const { runtime } = home(t);
  const providers = deriveDefaults({ providers: { codex: { bin: null } } }, runtime).providers;
  assert.equal(providers.cursor.bin, 'cursor-agent');
  assert.equal(providers.codex.bin, '/bin/codex');
});
