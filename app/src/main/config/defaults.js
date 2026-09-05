'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SCHEMA, mergeConfig, validateConfig } = require('./schema.js');

function findBinary(name, env = process.env) {
  if (path.isAbsolute(name)) return name;
  for (const directory of String(env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch { /* keep looking */ }
  }
  return name;
}

function runtimeValues(overrides = {}) {
  const env = overrides.env || process.env;
  const homedir = overrides.homedir || os.homedir();
  const platform = overrides.platform || os.platform();
  return {
    env,
    homedir,
    platform,
    findBinary: overrides.findBinary || ((name) => findBinary(name, env)),
  };
}

function deriveDefaults(supplied = {}, overrides = {}) {
  const runtime = runtimeValues(overrides);
  const config = mergeConfig(SCHEMA, supplied);
  // Retired backend keys from an existing config must not survive the schema
  // merge, which intentionally preserves otherwise unknown user settings.
  delete config.platform.herdrBin;
  delete config.platform.herdrSocket;
  const claudeHome = path.join(runtime.homedir, '.claude');
  config.platform.os ??= runtime.platform;
  config.platform.shell ??= runtime.env.SHELL || runtime.env.ComSpec || '/bin/sh';
  config.paths.projectsDir ??= path.join(claudeHome, 'projects');
  config.paths.cacheDir ??= path.join(runtime.homedir, '.cache', 'harbor');
  config.paths.delegateStateDir ??= path.join(runtime.homedir, '.local', 'state', 'claude-delegate');
  config.paths.binDir ??= path.join(runtime.homedir, '.local', 'bin');
  // The launcher is the one Harbor SHIPS. This used to default to
  // `<binDir>/claude-go`, a wrapper on one machine's PATH that no clone
  // contains, so the Orch view's Research and Execute buttons pointed at a
  // binary a new user does not have. `bin/ai` is in the repository, takes the
  // same `--home <configHome>`, and now takes the prompt positionally, which is
  // the only thing the wrapper was doing that it did not.
  // An EMPTY STRING is a missing value here, not a choice. `??=` only fills
  // null and undefined, so a hand-edited `"launcher": ""` survived derivation
  // and then threw out of `createOrchestrationActions` during app startup,
  // taking the whole window with it over an optional view.
  if (!config.orchestration.launcher) {
    config.orchestration.launcher = path.resolve(__dirname, '../../../../bin/ai');
  }
  config.orchestration.stateDir ??= config.paths.delegateStateDir;
  config.profiles = config.profiles.map((profile) => ({
    ...profile,
    configHome: profile.configHome ?? claudeHome,
  }));
  for (const [id, provider] of Object.entries(config.providers)) {
    if (provider.bin === null) {
      provider.bin = runtime.findBinary(id === 'cursor' ? 'cursor-agent' : id);
    }
  }
  return validateConfig(config);
}

module.exports = { deriveDefaults, findBinary, runtimeValues };
