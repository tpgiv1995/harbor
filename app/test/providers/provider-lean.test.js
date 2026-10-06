'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveLeanFile, readLean, writeLean } = require('../../src/main/providers/provider-lean.js');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'harbor-lean-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('the default profile shares ~/.harbor/provider-lean.json with every session', () => {
  const home = path.resolve('/synthetic/home');
  const appData = path.resolve('/synthetic/appdata/Harbor');
  assert.equal(resolveLeanFile({ env: {}, homedir: home, userDataPath: appData, defaultUserDataPath: appData }),
    path.join(home, '.harbor', 'provider-lean.json'));
  assert.equal(resolveLeanFile({ env: {}, homedir: home }), path.join(home, '.harbor', 'provider-lean.json'));
});

test('a relocated profile keeps its own file, so a harness cannot change real sessions', () => {
  const home = path.resolve('/synthetic/home');
  const relocated = path.resolve('/synthetic/harness/userData');
  assert.equal(resolveLeanFile({ env: {}, homedir: home, userDataPath: relocated, defaultUserDataPath: path.resolve('/synthetic/appdata/Harbor') }),
    path.join(relocated, 'provider-lean.json'));
  // Windows paths compare without case, as the OS does.
  const upper = path.resolve('/synthetic/AppData/Harbor');
  assert.equal(resolveLeanFile({ env: {}, homedir: home, userDataPath: upper, defaultUserDataPath: upper.toLowerCase(), platform: 'win32' }),
    path.join(home, '.harbor', 'provider-lean.json'));
});

test('HARBOR_PROVIDER_LEAN_FILE pins the path outright', () => {
  const pinned = path.resolve('/synthetic/pinned/lean.json');
  assert.equal(resolveLeanFile({ env: { HARBOR_PROVIDER_LEAN_FILE: pinned }, homedir: '/x', userDataPath: '/y', defaultUserDataPath: '/z' }), pinned);
});

test('a missing, broken or unknown file reads as the unsaved default', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'provider-lean.json');
  assert.deepEqual(readLean(file), { mode: 'balanced', updatedAt: null, saved: false });
  fs.writeFileSync(file, '{broken');
  assert.deepEqual(readLean(file), { mode: 'balanced', updatedAt: null, saved: false });
  fs.writeFileSync(file, JSON.stringify({ mode: 'gpt-everything', updatedAt: '2026-10-05T00:00:00.000Z' }));
  assert.deepEqual(readLean(file), { mode: 'balanced', updatedAt: null, saved: false });
});

test('a choice saves atomically and reads back, and an unknown choice is refused', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'nested', 'provider-lean.json');
  const when = new Date('2026-10-05T21:00:00.000Z');
  assert.deepEqual(writeLean(file, 'claude-only', when), { mode: 'claude-only', updatedAt: when.toISOString(), saved: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { mode: 'claude-only', updatedAt: when.toISOString() });
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['provider-lean.json']);
  assert.throws(() => writeLean(file, 'everything'), /Unknown heavy-lifting setting/);
  assert.equal(readLean(file).mode, 'claude-only');
  assert.equal(writeLean(file, 'lean-openai', when).mode, 'lean-openai');
});
