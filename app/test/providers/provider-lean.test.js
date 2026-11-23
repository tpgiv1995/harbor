'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveLeanFile, readLean, writeLean, writeLeanProject } = require('../../src/main/providers/provider-lean.js');

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
  assert.deepEqual(readLean(file), { mode: 'balanced', updatedAt: null, saved: false, projects: [] });
  fs.writeFileSync(file, '{broken');
  assert.deepEqual(readLean(file), { mode: 'balanced', updatedAt: null, saved: false, projects: [] });
  fs.writeFileSync(file, JSON.stringify({ mode: 'gpt-everything', updatedAt: '2026-10-05T00:00:00.000Z' }));
  assert.deepEqual(readLean(file), { mode: 'balanced', updatedAt: null, saved: false, projects: [] });
});

test('a choice saves atomically and reads back, and an unknown choice is refused', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'nested', 'provider-lean.json');
  const when = new Date('2026-10-05T21:00:00.000Z');
  assert.deepEqual(writeLean(file, 'claude-only', when), { mode: 'claude-only', updatedAt: when.toISOString(), saved: true, projects: [] });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { mode: 'claude-only', updatedAt: when.toISOString() });
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['provider-lean.json']);
  assert.throws(() => writeLean(file, 'everything'), /Unknown heavy-lifting setting/);
  assert.equal(readLean(file).mode, 'claude-only');
  assert.equal(writeLean(file, 'lean-openai', when).mode, 'lean-openai');
});

// Project overrides live in the same file (Pat, 2026-11-23). Changing the
// Heavy lifting setting must never drop them, and the menu's switch changes one
// project's `enabled` and nothing else.
const PROJECT = { id: 'acme', label: 'Acme App', build: 'cursor', enabled: true, folders: ['C:\\work\\acme', 'C:\\work\\.orch\\acme\\slot-*'] };

test('the projects list reads back normalized, and a file without one reads as none', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'provider-lean.json');
  fs.writeFileSync(file, JSON.stringify({ mode: 'balanced', updatedAt: '2026-11-23T01:00:00.000Z' }));
  assert.deepEqual(readLean(file).projects, []);
  fs.writeFileSync(file, JSON.stringify({ mode: 'balanced', updatedAt: '2026-11-23T01:00:00.000Z', projects: [PROJECT, { id: 'broken' }] }));
  const read = readLean(file);
  assert.equal(read.mode, 'balanced');
  assert.deepEqual(read.projects.map((p) => [p.id, p.enabled, p.folders]), [['acme', true, PROJECT.folders]]);
  assert.deepEqual(readLean(path.join(dir, 'missing.json')).projects, []);
});

test('changing the setting keeps the projects list', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'provider-lean.json');
  fs.writeFileSync(file, JSON.stringify({ mode: 'balanced', updatedAt: '2026-11-23T01:00:00.000Z', projects: [PROJECT] }));
  const saved = writeLean(file, 'lean-claude', new Date('2026-11-23T02:00:00.000Z'));
  assert.equal(saved.mode, 'lean-claude');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).projects, [PROJECT]);
  assert.deepEqual(fs.readdirSync(dir), ['provider-lean.json']);
});

test('the menu switch turns one project off and on, keeping the setting; an unknown project is refused', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'provider-lean.json');
  const other = { ...PROJECT, id: 'other', label: 'Other', folders: ['C:\\work\\other'] };
  fs.writeFileSync(file, JSON.stringify({ mode: 'lean-openai', updatedAt: '2026-11-23T01:00:00.000Z', projects: [PROJECT, other] }));
  const when = new Date('2026-11-23T03:00:00.000Z');
  const off = writeLeanProject(file, 'acme', false, when);
  assert.equal(off.mode, 'lean-openai');
  assert.deepEqual(off.projects.map((p) => [p.id, p.enabled]), [['acme', false], ['other', true]]);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(raw.mode, 'lean-openai');
  assert.equal(raw.updatedAt, '2026-11-23T01:00:00.000Z', "the setting's own time is unchanged");
  assert.deepEqual(raw.projects[0], { ...PROJECT, enabled: false, updatedAt: when.toISOString() });
  assert.deepEqual(raw.projects[1], other);
  assert.equal(writeLeanProject(file, 'acme', true, when).projects[0].enabled, true);
  assert.throws(() => writeLeanProject(file, 'nope', false), /Unknown project override: nope/);
  assert.throws(() => writeLeanProject(file, 'acme', 'off'), /on or off/);
  assert.throws(() => writeLeanProject(path.join(dir, 'missing.json'), 'acme', false), /Unknown project override: acme/);
});
