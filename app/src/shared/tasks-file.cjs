'use strict';

const path = require('node:path');

// WHERE the task document lives, as one rule shared by everything that touches
// it: the Electron main process, and bin/harbor-tasks (the CLI a Claude session
// drives). Two copies of this logic would eventually disagree, and the failure
// mode is the worst kind: an agent confidently editing a different file from the
// one the app is showing.
//
// Precedence, highest first:
//   1. HARBOR_TASKS_FILE          env, so a harness can be pointed at a
//                                 throwaway file and outrank everything else
//                                 (the 2026-07-28 lesson).
//   2. paths.tasksFile            from Harbor's own config.json.
//   3. <userData>/tasks.json      the default.
//
// userData is Electron's directory. Main passes the real one (app.getPath), so
// a relocated profile relocates the file with it. The CLI has no Electron, so it
// DERIVES the same path per platform; the two agree in the only case that
// matters, which is Pat's actual installation.

const APP_NAME = 'harbor';

function defaultUserDataDir({ env = process.env, homedir, platform = process.platform } = {}) {
  const home = homedir || require('node:os').homedir();
  if (platform === 'win32') {
    return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), APP_NAME);
  }
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', APP_NAME);
  }
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), APP_NAME);
}

// ON WINDOWS, SHARED STATE LIVES OUTSIDE %APPDATA% (2026-08-13). AppData is a
// virtualized known folder: a process inside an MSIX AppContainer (the Claude
// desktop app, and therefore every Claude session and every child it spawns)
// reads and writes a PRIVATE copy-on-write mirror under
// AppData\Local\Packages\<pkg>\LocalCache\Roaming, while an Explorer-launched
// Harbor reads the real directory. That split is not hypothetical: Pat's
// profile order was "fixed" in the mirror at least five separate times while
// his real app kept rendering the stale real file, and 52 of his 64 project
// icons existed only in the mirror. The user-profile ROOT is not virtualized,
// so `~/.harbor` is one file for every reader, whoever launched it. POSIX
// keeps the proven userData default; a relocated harness profile keeps its
// own file either way (the caller only reaches this default when its userData
// IS the default installation's).
function sharedDataDir({ homedir, platform = process.platform } = {}) {
  const home = homedir || require('node:os').homedir();
  return path.join(home, '.harbor');
}

function defaultConfigFile(options = {}) {
  const env = options.env || process.env;
  if (env.HARBOR_CONFIG_FILE) return path.resolve(env.HARBOR_CONFIG_FILE);
  const platform = options.platform || process.platform;
  if (platform === 'win32' && !options.userDataPath) {
    return path.join(sharedDataDir(options), 'config.json');
  }
  return path.join(options.userDataPath || defaultUserDataDir(options), 'config.json');
}

/**
 * @param {object}  options
 * @param {object}  [options.env]            defaults to process.env
 * @param {string}  [options.configuredFile] paths.tasksFile from Harbor's config
 * @param {string}  [options.userDataPath]   Electron's userData, when there is one
 */
function resolveTasksFile(options = {}) {
  const env = options.env || process.env;
  if (env.HARBOR_TASKS_FILE) return path.resolve(env.HARBOR_TASKS_FILE);
  if (options.configuredFile) return path.resolve(options.configuredFile);
  return path.join(options.userDataPath || defaultUserDataDir(options), 'tasks.json');
}

function resolveNotesFile(options = {}) {
  const env = options.env || process.env;
  if (env.HARBOR_NOTES_FILE) return path.resolve(env.HARBOR_NOTES_FILE);
  if (options.configuredFile) return path.resolve(options.configuredFile);
  return path.join(options.userDataPath || defaultUserDataDir(options), 'notes.json');
}

module.exports = {
  APP_NAME,
  defaultConfigFile,
  defaultUserDataDir,
  resolveNotesFile,
  resolveTasksFile,
  sharedDataDir,
};
