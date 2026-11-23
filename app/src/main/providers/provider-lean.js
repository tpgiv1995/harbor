'use strict';

// Reads and writes the "Heavy lifting" setting (shared/provider-lean.cjs owns
// the modes and the verdict). The default instance keeps it at
// ~/.harbor/provider-lean.json, the shared win32 home every Claude session can
// read, never %APPDATA% (CLAUDE.md, machine and shared state). A relocated
// userData keeps its OWN file, the same rule the config file follows, so a
// harness instance can never change what Pat's real sessions are allowed to
// do. HARBOR_PROVIDER_LEAN_FILE pins the path outright.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { sharedDataDir } = require('../../shared/tasks-file.cjs');
const { normalizeLean, normalizeProjects, DEFAULT_LEAN } = require('../../shared/provider-lean.cjs');

const FILE_NAME = 'provider-lean.json';

function samePath(a, b, platform) {
  if (!a || !b) return false;
  const left = path.resolve(a);
  const right = path.resolve(b);
  return platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function resolveLeanFile({
  env = process.env,
  homedir = os.homedir(),
  userDataPath = null,
  defaultUserDataPath = null,
  platform = process.platform,
} = {}) {
  if (env.HARBOR_PROVIDER_LEAN_FILE) return path.resolve(env.HARBOR_PROVIDER_LEAN_FILE);
  if (userDataPath && !samePath(userDataPath, defaultUserDataPath, platform)) {
    return path.join(userDataPath, FILE_NAME);
  }
  return path.join(sharedDataDir({ homedir }), FILE_NAME);
}

// A missing or unreadable file is the default, reported as not saved; it is
// never an error, because every reader (the menu, the guard, bin/harbor-lean)
// must still get an answer. `projects` is the per-project override list
// (shared/provider-lean.cjs normalizeProjects), read even when the setting is
// unset, because the two are independent.
function readRaw(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readLean(file) {
  const parsed = readRaw(file);
  if (!parsed) return { mode: DEFAULT_LEAN, updatedAt: null, saved: false, projects: [] };
  const valid = normalizeLean(parsed.mode) === parsed.mode;
  return {
    mode: normalizeLean(parsed.mode),
    updatedAt: valid && typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
    saved: valid,
    projects: normalizeProjects(parsed.projects),
  };
}

function writeRaw(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

// Saving the setting keeps every other field, the projects list above all
// (Pat, 2026-11-23: changing Heavy lifting must never drop a project override).
function writeLean(file, mode, now = new Date()) {
  if (normalizeLean(mode) !== mode) throw new Error(`Unknown heavy-lifting setting: ${String(mode)}`);
  const previous = readRaw(file) || {};
  writeRaw(file, { ...previous, mode, updatedAt: now.toISOString() });
  return readLean(file);
}

// The plans menu's switch for one project override: sets its `enabled` and
// stamps its own updatedAt, leaving the setting, its time and every other
// project exactly as they were. Only a listed project can be switched.
function writeLeanProject(file, id, enabled, now = new Date()) {
  if (typeof enabled !== 'boolean') throw new Error('A project override is switched on or off (true or false).');
  const previous = readRaw(file);
  const listed = previous && Array.isArray(previous.projects) ? previous.projects : [];
  const known = normalizeProjects(listed).some((p) => p.id === id);
  const at = listed.findIndex((p) => p && typeof p.id === 'string' && p.id.trim() === id);
  if (!known || at < 0) throw new Error(`Unknown project override: ${String(id)}`);
  const projects = listed.slice();
  projects[at] = { ...listed[at], enabled, updatedAt: now.toISOString() };
  writeRaw(file, { ...previous, projects });
  return readLean(file);
}

module.exports = { FILE_NAME, resolveLeanFile, readLean, writeLean, writeLeanProject };
