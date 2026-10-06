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
const { normalizeLean, DEFAULT_LEAN } = require('../../shared/provider-lean.cjs');

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
// must still get an answer.
function readLean(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const valid = normalizeLean(parsed && parsed.mode) === (parsed && parsed.mode);
    return {
      mode: normalizeLean(parsed && parsed.mode),
      updatedAt: valid && typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
      saved: valid,
    };
  } catch {
    return { mode: DEFAULT_LEAN, updatedAt: null, saved: false };
  }
}

function writeLean(file, mode, now = new Date()) {
  if (normalizeLean(mode) !== mode) throw new Error(`Unknown heavy-lifting setting: ${String(mode)}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify({ mode, updatedAt: now.toISOString() }, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return readLean(file);
}

module.exports = { FILE_NAME, resolveLeanFile, readLean, writeLean };
