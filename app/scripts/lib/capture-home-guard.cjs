'use strict';

// Capture-only defense and evidence. Never load this in the shipped product.
// Environment redirection is not an OS sandbox: reject accidental JS filesystem
// access to the account home, even if a future resolver ignores those variables.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { fileURLToPath } = require('node:url');
const cp = require('node:child_process');
// Media converters and daemon descendants must not create console windows.
// All asynchronous child APIs reach this method, including promisified execFile.
const spawnChild = cp.ChildProcess.prototype.spawn;
cp.ChildProcess.prototype.spawn = function(options) {
  return spawnChild.call(this, { ...options, windowsHide: true });
};
for (const name of ['spawnSync', 'execFileSync']) {
  const original = cp[name];
  cp[name] = function(file, args, options) {
    if (!Array.isArray(args)) { options = args; args = []; }
    return original.call(this, file, args, { ...options, windowsHide: true });
  };
}
const execSync = cp.execSync;
cp.execSync = function(command, options) { return execSync.call(this, command, { ...options, windowsHide: true }); };
const { ownedRoot, APP_ROOT } = require('./capture-runtime.cjs');
const root = ownedRoot(process.env.HARBOR_SHOT_ROOT || '');
const accountHome = os.userInfo().homedir;
const toolDirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean).map(dir => path.resolve(dir).toLowerCase());
const within = (base, file) => {
  const rel = path.relative(base, file);
  return !rel || (!rel.startsWith('..') && !path.isAbsolute(rel));
};
const write = fs.writeFileSync.bind(fs);
const proofFile = path.join(root, `capture-proof-${process.pid}.json`);
const proof = {
  pid: process.pid, nodeHome: os.homedir(),
  env: Object.fromEntries(['HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME'].map(key => [key, process.env[key] || null])),
  configReads: [], blocked: [],
};
const save = () => write(proofFile, JSON.stringify(proof));
const seen = new Set();
function check(value, operation) {
  if (typeof value === 'number' || value == null) return;
  const file = path.resolve(value instanceof URL ? fileURLToPath(value) : String(value));
  const config = /[\\/]\.(?:claude[^\\/]*|codex[^\\/]*|cursor|harbor)(?:[\\/]|$)|[\\/]\.(?:cache|config)[\\/]harbor(?:[\\/]|$)/i.test(file);
  // PATH may contain an installed media converter below the account home.
  // Permit binary existence checks, never reading its neighboring user data.
  const toolLookup = /^(?:access|stat)(?:Sync)?$/.test(operation)
    && toolDirs.includes(path.dirname(file).toLowerCase());
  if (!within(root, file) && (config || (within(accountHome, file) && !within(APP_ROOT, file) && !toolLookup))) {
    proof.blocked.push({ operation, file });
    save();
    throw new Error(`Capture refused account-home access: ${operation} ${file}`);
  }
  if (config && !seen.has(file)) {
    seen.add(file);
    proof.configReads.push({ operation, file });
    save();
  }
}
for (const name of ['readFile', 'readdir', 'open', 'stat', 'lstat', 'access', 'exists', 'readlink', 'realpath', 'opendir', 'watch', 'watchFile', 'createReadStream', 'openAsBlob', 'writeFile', 'appendFile', 'mkdir', 'rm', 'unlink']) {
  for (const key of [name, `${name}Sync`]) {
    const original = fs[key];
    if (typeof original !== 'function') continue;
    const wrapped = function(value, ...args) { check(value, key); return original.call(this, value, ...args); };
    if (original.native) wrapped.native = function(value, ...args) { check(value, `${key}.native`); return original.native.call(this, value, ...args); };
    fs[key] = wrapped;
  }
  const original = fs.promises[name];
  if (typeof original === 'function') fs.promises[name] = async function(value, ...args) { check(value, `promises.${name}`); return original.call(this, value, ...args); };
}
save();
module.exports = { proof, save };
