'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SCHEMA, mergeConfig, validateConfig } = require('./schema.js');
const { createPlatform } = require('../platform/index.js');

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

// Transport shape belongs to the platform layer, which is the ONLY place that
// knows a unix socket from a Windows named pipe. This delegates rather than
// keeping a second switch: the first version of this function had a `win32`
// branch that returned the identical unix path as the fallback, which would have
// silently seeded a socket the Windows daemon can never answer on.
//
// win32's herdrTransport() throws instead of guessing the real pipe name, which
// the portability audit flagged as UNVERIFIED. That is the honest answer, so the
// derived default stays null and the setup wizard asks for it.
// Derivation is HERMETIC on purpose: the adapter is handed a minimal env holding
// only HOME, never the ambient process.env. Inheriting the real environment made
// this return whatever HERDR_SOCKET_PATH the launching shell happened to export,
// so the stored default depended on how Harbor was started and the test for it
// passed or failed by shell. The runtime override still works and is applied a
// layer up, where ACTIVE_HERDR_SOCKET reads HERDR_SOCKET_PATH for harnesses.
function defaultHerdrSocket(platformName, homedir) {
  try {
    const adapter = createPlatform(platformName, { env: { HOME: homedir } });
    return adapter.herdrTransport() || null;
  } catch {
    return null;
  }
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
    herdrSocket: overrides.herdrSocket || (() => defaultHerdrSocket(platform, homedir)),
  };
}

function deriveDefaults(supplied = {}, overrides = {}) {
  const runtime = runtimeValues(overrides);
  const config = mergeConfig(SCHEMA, supplied);
  const claudeHome = path.join(runtime.homedir, '.claude');
  config.platform.os ??= runtime.platform;
  config.platform.herdrBin ??= runtime.findBinary('herdr');
  config.platform.herdrSocket ??= runtime.herdrSocket();
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

module.exports = { defaultHerdrSocket, deriveDefaults, findBinary, runtimeValues };
