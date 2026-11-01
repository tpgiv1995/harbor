'use strict';

// Read-only pool lookups for launch paths (Astra review, 2026-11-01). Standalone on purpose: it
// loads no other lane module, so a launch that only needs to ask "is this folder a slot, and whose
// session is this?" never depends on the mutable pool implementation, its locks or its CLI.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PROVIDERS = ['claude', 'codex', 'cursor'];
// Every pool root is a folder named `pool` (init-repo insists), so a slot is recognisable by its
// shape when the registry snapshot cannot be read: ...\pool\<repo id>\slot-NN.
const SLOT_SHAPE = /[\\/]pool[\\/][a-z0-9][a-z0-9_-]{0,63}[\\/]slot-\d{2}(?:[\\/]|$)/i;

// The REAL profile, not USERPROFILE: Cursor workers run with USERPROFILE pointed at a shadow
// home, and pool state must never follow it there.
function realHome() {
  try { return os.userInfo().homedir || os.homedir(); } catch { return os.homedir(); }
}

function defaultStateDir(env = process.env) {
  return env.HARBOR_LANES_DIR || path.join(realHome(), '.harbor', 'lanes');
}

function pathKey(p) {
  let resolved = path.resolve(p);
  try { resolved = fs.realpathSync.native(resolved); } catch { /* a missing folder keeps its resolved spelling */ }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

// The pool's durable session key: provider, the config home's real path (case-folded on Windows)
// and the session id. Null when the inputs cannot form a key.
function sessionKey({ provider, configHome, session }) {
  if (!PROVIDERS.includes(provider) || typeof configHome !== 'string' || !path.isAbsolute(configHome) || !session) return null;
  const resolved = fs.existsSync(configHome) ? fs.realpathSync.native(configHome) : path.resolve(configHome);
  const home = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  return crypto.createHash('sha256').update(JSON.stringify([provider, home, session])).digest('hex');
}

function poolStateExists(dir) {
  try { return fs.readdirSync(dir).some((name) => name === 'segments.json' || name === 'events.jsonl' || /^journal(?:-[\w-]+)?\.jsonl$/.test(name)); }
  catch { return false; }
}

// { status: 'absent' } when this machine has no pool, { status: 'ok', state } for a readable
// snapshot, { status: 'unreadable', reason } when a pool exists but its snapshot cannot be used.
function readRegistry(env = process.env) {
  const dir = defaultStateDir(env);
  let text;
  try { text = fs.readFileSync(path.join(dir, 'registry.json'), 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT' && !poolStateExists(dir)) return { status: 'absent', dir };
    return { status: 'unreadable', dir, reason: error.code === 'ENOENT' ? 'registry.json is missing beside an existing journal' : error.message };
  }
  try {
    const state = JSON.parse(text);
    if (!state || typeof state.repos !== 'object' || typeof state.lanes !== 'object' || typeof state.sessions !== 'object') throw new Error('unexpected shape');
    return { status: 'ok', dir, state };
  } catch (error) {
    return { status: 'unreadable', dir, reason: `registry.json is not usable (${error.message})` };
  }
}

// The registered slot holding `cwd`, or null.
function slotFor(state, cwd) {
  const target = pathKey(cwd);
  for (const repo of Object.values(state?.repos || {})) {
    for (const slot of repo.slots || []) {
      const p = pathKey(slot.path);
      if (target === p || target.startsWith(p + path.sep)) return { repo, slot };
    }
  }
  return null;
}

function looksLikeSlot(cwd) {
  return SLOT_SHAPE.test(path.resolve(cwd));
}

module.exports = { PROVIDERS, SLOT_SHAPE, realHome, defaultStateDir, pathKey, sessionKey, readRegistry, slotFor, looksLikeSlot, poolStateExists };
