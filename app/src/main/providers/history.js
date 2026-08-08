'use strict';

const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const { deriveDefaults } = require('../config/defaults.js');
const { createHistoryIndexWorker } = require('./history-index.js');

const defaultIndex = createHistoryIndexWorker();
async function runIndexer(args) { return defaultIndex.run(args); }

function parseEmitTsv(text) {
  return String(text).split(/\r?\n/).filter(Boolean).map((line) => {
    const parts = line.split('\t');
    const [id, lastActive, project, title, firstPrompt, cwd] = parts;
    return {
      id,
      lastActive,
      project: (project || '').trim(),
      title: title || '',
      firstPrompt: firstPrompt || null,
      cwd: cwd || null,
    };
  });
}

const TREE_TYPES = { P: 'project', S: 'session', N: 'new-session', M: 'more', F: 'folder' };

function parseTreeTsv(text) {
  return String(text).split(/\r?\n/).filter(Boolean).map((line) => {
    const [key, ...display] = line.split('\t');
    const [prefix, ...value] = key.split(':');
    return {
      key,
      type: TREE_TYPES[prefix] || 'unknown',
      value: value.join(':'),
      display: display.join('\t'),
    };
  });
}

function createHistoryProvider(options = {}) {
  const defaults = deriveDefaults();
  const historyIndex = options.historyIndex || createHistoryIndexWorker({
    projectsDir: options.projectsPath || defaults.paths.projectsDir,
    cacheDir: options.cacheDir || defaults.paths.cacheDir,
    profiles: options.profiles,
  });
  const execute = options.runIndexer || ((args) => historyIndex.run(args));
  const watchFactory = options.watchFactory || ((target, cb) => fs.watch(target, { recursive: true }, cb));
  const debounceMs = options.debounceMs ?? 5000;
  const projectsPath = options.projectsPath || defaults.paths.projectsDir;
  const provider = new EventEmitter();
  let timer = null;
  let watcher = null;

  const changed = () => {
    clearTimeout(timer);
    timer = setTimeout(() => provider.emit('history-changed'), debounceMs);
  };
  // HB-001, the launch blocker. fs.watch throws ENOENT SYNCHRONOUSLY when the
  // directory does not exist, and this constructor runs inside the
  // app.whenReady() chain, so on a machine where no Claude session has ever run
  // there is no ~/.claude/projects, the rejection escapes, and Harbor exits
  // before it draws a window. That is not an edge case: it is the first minute
  // of anybody else's first run, which is exactly who this repo is being handed
  // to. Nothing about a missing history directory should be fatal; it means the
  // rail is empty until the first session exists.
  //
  // The rest of the repo already got this right and this was the one site that
  // missed it (swept 2026-07-29): provider-history.js:112, delegate.js:109 (which
  // also creates the dir and degrades to a poll), dist-watcher.js:43 and
  // transcript.js:1013 all wrap the same call. A watch we could not arm re-arms
  // on the next indexer pass, so the only cost of failing here is that live
  // refresh waits for the poll.
  try {
    watcher = watchFactory(projectsPath, changed);
    if (watcher && typeof watcher.on === 'function') {
      watcher.on('error', (error) => provider.emit('watch-error', error));
    }
  } catch (error) {
    watcher = null;
    // Deferred: a synchronous emit from inside the constructor reaches nobody,
    // because the caller has not attached its listener yet.
    setImmediate(() => provider.emit('watch-error', error));
  }

  provider.listSessions = async ({ since, project, query } = {}) => {
    const args = ['emit', '--all', '--with-first-prompt', '--with-cwd'];
    if (since) args.push('--since', String(since));
    if (project) args.push('--project', String(project));
    const sessions = parseEmitTsv(await execute(args));
    if (!query) return sessions;
    const needle = String(query).toLowerCase();
    return sessions.filter((row) => `${row.project}\n${row.title}\n${row.firstPrompt || ''}`.toLowerCase().includes(needle));
  };
  provider.projectTree = async () => parseTreeTsv(await execute(['tree', '--all']));
  provider.sessionMeta = async (id) => JSON.parse(await execute(['meta', String(id)]));
  provider.sessionHomes = async () => historyIndex.buildHomeMap();
  provider.sessionPreview = (id) => execute(['preview', String(id)]);
  provider.close = () => {
    clearTimeout(timer);
    timer = null;
    if (watcher) watcher.close();
    watcher = null;
    historyIndex.close?.();
  };
  return provider;
}

module.exports = {
  createHistoryProvider,
  parseEmitTsv,
  parseTreeTsv,
  runIndexer,
};
