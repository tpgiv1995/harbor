'use strict';

const { watchPath } = require('../watch-path.js');

const { EventEmitter } = require('node:events');
const { deriveDefaults } = require('../config/defaults.js');
const { createHistoryIndexWorker } = require('./history-index.js');

const defaultIndex = createHistoryIndexWorker();
async function runIndexer(args) { return defaultIndex.run(args); }

function parseEmitTsv(text) {
  return String(text).split(/\r?\n/).filter(Boolean).map((line) => {
    const columns = line.split('\t');
    const parts = columns.length < 11 ? columns : columns.map((value) => value.replace(/\\([\\tnr])/g, (_, char) => ({ t: '\t', n: '\n', r: '\r', '\\': '\\' })[char]));
    const [id, lastActive, project, title, firstPrompt, cwd, file, entrypoint, start, mt, hasTitle] = parts;
    return {
      id,
      lastActive,
      project: (project || '').trim(),
      title: title || (parts.length >= 11 ? '(no user messages)' : ''),
      firstPrompt: firstPrompt ? [...firstPrompt.replace(/[\t\n]/g, ' ')].slice(0, 300).join('') : null,
      cwd: cwd || null,
      ...(file ? { path: file } : {}),
      ...(entrypoint ? { entrypoint } : {}),
      ...(parts.length >= 11 ? { meta: { id, cwd: cwd || null, project: (project || '').trim(), title: hasTitle === '0' ? null : title,
        firstPrompt: firstPrompt || null, path: file, entrypoint: entrypoint || null, start: start || null, mt: Number(mt) || null } } : {}),
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
  const provider = new EventEmitter();
  const historyIndex = options.historyIndex || createHistoryIndexWorker({
    projectsDir: options.projectsPath || defaults.paths.projectsDir,
    cacheDir: options.cacheDir || defaults.paths.cacheDir,
    profiles: options.profiles,
    // The worker's own warnings (a cache write that would not land) surface
    // as 'log' events so the app can put them in its durable lifecycle log.
    onLog: (line) => provider.emit('log', line),
  });
  const execute = options.runIndexer || ((args) => historyIndex.run(args));
  const watchFactory = options.watchFactory || ((target, cb) => watchPath(target, { recursive: true }, cb));
  const debounceMs = options.debounceMs ?? 5000;
  const maxWaitMs = options.maxWaitMs ?? 30_000;
  const now = options.now || Date.now;
  const projectsPath = options.projectsPath || defaults.paths.projectsDir;
  let timer = null;
  let firstChangeAt = null;
  let watcher = null;
  let migrationTimer = null; let migrationClosed = false;
  provider.startBackgroundMigration = () => {
    if (migrationTimer || migrationClosed || !historyIndex.migrateEntries) return;
    let changed = false;
    const step = async () => {
      try {
        const result = await historyIndex.migrateEntries(32);
        changed ||= result.changed > 0;
        if (migrationClosed) return;
        if (result.remaining && result.changed) migrationTimer = setTimeout(step, 100);
        else { migrationTimer = null; if (changed) provider.emit('history-changed'); }
      } catch { migrationTimer = null; }
    };
    migrationTimer = setTimeout(step, 0);
  };

  // A TRAILING DEBOUNCE WITH A CEILING (2026-10-21 audit). Every write under
  // ~/.claude/projects reset a 5 s timer, and a busy session writes every
  // second or so, so on a Claude-only busy stream the refresh never fired:
  // titles, membership and recency froze for as long as the work went on (60 s
  // of one-second writes produced zero events). Quiet still settles after
  // debounceMs; a stream that never pauses refreshes at least every maxWaitMs.
  // The consumer's refresh stays single-flight (sidebar-bridge.js), so this
  // can never start overlapping scans.
  // The names the watcher reported since the last refresh go to the index in
  // one message just before the refresh it triggers, so a pass re-checks only
  // those transcripts (history-index.js noteChanged, 2026-11-01). A nameless
  // event or a watcher error sends null: the next pass walks everything.
  const reported = new Set();
  const sendReported = () => {
    if (!reported.size || typeof historyIndex.noteChanged !== 'function') { reported.clear(); return; }
    const names = [...reported];
    reported.clear();
    Promise.resolve(historyIndex.noteChanged(names)).catch(() => {});
  };
  const changed = (eventType, filename) => {
    reported.add(filename ?? null);
    const at = now();
    if (firstChangeAt === null) firstChangeAt = at;
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      firstChangeAt = null;
      sendReported();
      provider.emit('history-changed');
    }, Math.max(0, Math.min(debounceMs, firstChangeAt + maxWaitMs - at)));
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
      watcher.on('error', (error) => { reported.add(null); provider.emit('watch-error', error); });
    }
  } catch (error) {
    watcher = null;
    // Deferred: a synchronous emit from inside the constructor reaches nobody,
    // because the caller has not attached its listener yet.
    setImmediate(() => provider.emit('watch-error', error));
  }

  provider.listSessions = async ({ since, project, query } = {}) => {
    const args = ['emit', '--all', '--with-first-prompt', '--with-cwd', '--with-path', '--with-entrypoint', '--with-meta'];
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
    migrationClosed = true; clearTimeout(migrationTimer);
    clearTimeout(timer);
    timer = null;
    firstChangeAt = null;
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
