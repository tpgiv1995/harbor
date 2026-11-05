'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { execFile } = require('node:child_process');

// EVERY LIVE CLAUDE SESSION'S STATUS, NOT ONLY HARBOR'S.
// `claude agents --json` (CLI 2.1.29x+) prints the live sessions of one config
// home, interactive and background, each with a status. Measured on 2.1.301:
// `{pid, cwd, kind: 'interactive'|'background', startedAt, sessionId, name,
// status: 'idle'|'busy'|'waiting', waitingFor?: 'permission prompt'}` in about
// 0.12 s. Harbor's own panes report through OSC 7501 (daemon/screen.js); this
// list is the status for everything else: a session in a terminal or in the
// desktop app, a background session, or a Harbor pane whose keeper or CLI
// predates OSC 7501. It is read-only: nothing here attaches to or signals a
// session.
const STATUS = { busy: 'working', waiting: 'blocked', idle: 'idle' };

// WHEN TO ASK. Each call is a full CLI start: 0.13 s wall, 0.16 CPU-s and
// about 157 MB peak RSS on CLI 2.1.301. A fixed 20 s timer over two homes is
// 8,640 of those a day while the window is merely visible, almost all of them
// answering "nothing changed". The CLI already says when something changed:
// every live session keeps `<home>/sessions/<pid>.json` and rewrites it on
// each status change (`status`, `statusUpdatedAt`), creates it on start and
// removes it on a clean exit. So a home is listed again only after its
// sessions/ directory changed:
// - SETTLE_MS after the change, so one write burst is one call;
// - at most once per FOCUSED_GAP_MS per home while Harbor has focus, and once
//   per UNFOCUSED_GAP_MS while it is visible but not focused;
// - never while the window is hidden or minimized; the focus handler calls
//   nudge() and the homes that changed meanwhile are listed then.
// A rewrite of a Harbor pane's own file is skipped (isOwnPaneFile): that pane
// reports through OSC 7501 and never needs the list. Its removal still counts
// (the pane's CLI exited), whether the platform reports a rewrite as 'change'
// or, for a write-and-rename, as 'rename'. A home that lists
// anything is listed again every FALLBACK_MS whatever the directory did,
// because a CLI that crashed leaves its file behind. A home whose directory
// cannot be watched (no sessions/ yet, or a CLI without one) falls back to the
// gap cadence.
const SETTLE_MS = 500;
const FOCUSED_GAP_MS = 20_000;
const UNFOCUSED_GAP_MS = 60_000;
const FALLBACK_MS = 5 * 60_000;
// How often the cheap scheduler looks at the homes. It spawns nothing itself.
const TICK_MS = 2_000;
// The focus catch-up never lists a home twice within this.
const MIN_NUDGE_INTERVAL_MS = 5_000;
// After a failed call, a resolved command is resolved again no sooner than
// this: on win32 a resolve is a PATH walk, and a CLI too old for `agents`
// fails every call.
const RERESOLVE_MS = FALLBACK_MS;
const TIMEOUT_MS = 4_000;

function parseAgents(stdout, home) {
  let rows;
  try { rows = JSON.parse(stdout); } catch { return null; }
  if (!Array.isArray(rows)) return null;
  const out = new Map();
  for (const row of rows) {
    if (!row || typeof row.sessionId !== 'string' || !row.sessionId) continue;
    const status = STATUS[row.status];
    if (!status) continue;
    out.set(row.sessionId, {
      status,
      waitingFor: typeof row.waitingFor === 'string' ? row.waitingFor.slice(0, 200) : null,
      kind: row.kind === 'background' ? 'background' : 'interactive',
      name: typeof row.name === 'string' ? row.name.slice(0, 120) : null,
      pid: Number.parseInt(row.pid, 10) || null,
      cwd: typeof row.cwd === 'string' ? row.cwd : null,
      home,
    });
  }
  return out;
}

// WINDOWS (simulated on macOS, not yet run on a Windows box). A bare `claude`
// is usually npm's claude.cmd, which execFile neither finds (libuv's PATH
// search tries .com/.exe only) nor may start without a shell.
// - An extensionless name resolves with pathextOnly: npm's cmd-shim puts an sh
//   script named `claude` next to claude.cmd, and setup's bare-name-first
//   lookup returns that script, which execFile cannot run. Only the PATHEXT
//   entries execFile can start (.com/.exe directly, .bat/.cmd through cmd.exe)
//   are searched, in the user's PATHEXT order.
// - A .cmd/.bat runs as `cmd /d /s /c ""<found>" agents --json"` with verbatim
//   arguments, the line Node's own `shell: true` builds. With /s, cmd strips
//   the first and last quote of the line, so the single-quoted form
//   `"<found>" agents --json` would lose the quotes around a path with a space
//   (%APPDATA%\npm under C:\Users\John Smith).
const RUNNABLE_EXTENSIONS = ['.com', '.exe', '.bat', '.cmd'];

function runnablePathext(env) {
  const listed = String(env.PATHEXT ?? '').split(';').map((ext) => ext.trim().toLowerCase())
    .filter((ext) => RUNNABLE_EXTENSIONS.includes(ext));
  return [...new Set(listed.length ? listed : RUNNABLE_EXTENSIONS)].join(';');
}

async function resolveCommand(bin, { env = process.env, platform = process.platform, resolvePath } = {}) {
  if (platform !== 'win32') return { file: bin, args: ['agents', '--json'] };
  const resolve = resolvePath || ((name) => require('../setup/executables.js')
    .executablePath(name, { env: { ...env, PATHEXT: runnablePathext(env) }, platform, pathextOnly: true }));
  const found = await Promise.resolve(resolve(bin)).catch(() => null);
  if (!found) return null;
  if (/\.(cmd|bat)$/i.test(found)) {
    return { file: env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `""${found}" agents --json"`], verbatim: true };
  }
  return { file: found, args: ['agents', '--json'] };
}

// Resolves to { rows, failed }: rows is the parsed list or null; failed is
// true when the command itself did not run cleanly (spawn error, non-zero
// exit, timeout) or there was none to run.
function listAgents({ command, home, env, execFileImpl = execFile }) {
  return new Promise((resolve) => {
    // No runnable command (not found, or waiting to resolve again) is a failure.
    if (!command) { resolve({ rows: null, failed: true }); return; }
    try {
      execFileImpl(command.file, command.args, {
        env: { ...env, CLAUDE_CONFIG_DIR: home },
        timeout: TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
        ...(command.verbatim ? { windowsVerbatimArguments: true } : {}),
      }, (error, stdout) => resolve(error
        ? { rows: null, failed: true }
        : { rows: parseAgents(String(stdout || ''), home), failed: false }));
    } catch {
      // execFile throws synchronously for some bad arguments: a failed spawn.
      resolve({ rows: null, failed: true });
    }
  });
}

function sameStatuses(a, b) {
  if (a.size !== b.size) return false;
  for (const [id, value] of a) {
    const other = b.get(id);
    if (!other || other.status !== value.status || other.waitingFor !== value.waitingFor
      || other.kind !== value.kind || other.pid !== value.pid) return false;
  }
  return true;
}

// onChange(eventType, filename) for every change in dir. Returns { close } while
// watching, or { missing } when the directory cannot be watched: missing is
// true when it does not exist (no session ever ran in that home).
function watchDirectory(dir, onChange, onError) {
  try {
    const watcher = fs.watch(dir, { persistent: false }, (eventType, filename) => onChange(eventType, filename ? String(filename) : null));
    watcher.on('error', (error) => { try { watcher.close(); } catch { /* already closed */ } onError(error); });
    return { close: () => { try { watcher.close(); } catch { /* already closed */ } } };
  } catch (error) {
    return { missing: error?.code === 'ENOENT' };
  }
}

// homes: { profileId: configHome } for Claude profiles only.
// windowState: () => 'focused' | 'visible' | 'hidden' (hidden includes
// minimized).
// isOwnPaneFile(pid): true for the CLI pid of a Harbor pane that reports its
// own status through OSC 7501; a rewrite of its sessions/ file is skipped.
function createCliAgentsWatcher({
  homes = {}, bin = 'claude', env = process.env, execFileImpl, platform = process.platform, resolvePath,
  windowState = () => 'focused', isOwnPaneFile = null, watchDir = watchDirectory, fileExists = fs.existsSync, now = Date.now,
  settleMs = SETTLE_MS, focusedGapMs = FOCUSED_GAP_MS, unfocusedGapMs = UNFOCUSED_GAP_MS,
  fallbackMs = FALLBACK_MS, tickMs = TICK_MS, minNudgeIntervalMs = MIN_NUDGE_INTERVAL_MS, reresolveMs = RERESOLVE_MS,
} = {}) {
  const emitter = new EventEmitter();
  let statuses = new Map();
  let timer = null;
  let started = false;
  let stopped = false;
  let polling = null;
  let ownPaneFile = isOwnPaneFile;
  // Resolved once. After a failed call it is resolved again, but no sooner
  // than reresolveMs after the last resolve, so a broken install does not walk
  // PATH on every listing.
  let command = null;
  let resolvedAt = -Infinity;
  const state = new Map();
  for (const home of new Set(Object.values(homes).filter(Boolean))) {
    state.set(home, {
      home, close: null, missing: false, dirty: true, dirtyAt: -Infinity, lastPollAt: -Infinity, queued: false,
      // The last good answer, kept through one failed call: one slow call
      // must not flash every session to "no status".
      rows: null, misses: 0, failures: 0,
    });
  }

  const markDirty = (entry) => {
    if (!entry.dirty) { entry.dirty = true; entry.dirtyAt = now(); }
  };

  function watch(entry) {
    if (entry.close || stopped) return;
    const dir = path.join(entry.home, 'sessions');
    const result = watchDir(dir, (eventType, filename) => {
      if (filename && !/\.json$/i.test(filename)) return;
      const pid = filename ? Number.parseInt(path.basename(filename, '.json'), 10) : NaN;
      if (Number.isInteger(pid) && ownPaneFile?.(pid)
        && (eventType === 'change' || fileExists(path.join(dir, filename)))) return;
      markDirty(entry);
    }, () => { entry.close = null; markDirty(entry); });
    const wasMissing = entry.missing;
    entry.close = result?.close || null;
    entry.missing = !entry.close && Boolean(result?.missing);
    // The directory appeared: its first session may already be in it.
    if (entry.close && wasMissing) markDirty(entry);
  }

  function due(entry, windowNow, at) {
    if (windowNow === 'hidden' || entry.queued) return false;
    // A home whose last calls failed waits longer each time, up to fallbackMs.
    const base = windowNow === 'focused' ? focusedGapMs : unfocusedGapMs;
    const gap = entry.failures ? Math.min(base * 2 ** entry.failures, fallbackMs) : base;
    const since = at - entry.lastPollAt;
    if (since < gap) return false;
    if (entry.dirty && at - entry.dirtyAt >= settleMs) return true;
    // No sessions/ directory: no session has registered in this home, so
    // there is nothing to list beyond clearing what an earlier call found.
    if (entry.missing) return Boolean(entry.rows?.size);
    // A directory that exists but cannot be watched: the gap cadence.
    if (!entry.close) return true;
    return Boolean(entry.rows?.size) && since >= fallbackMs;
  }

  async function listHome(entry) {
    entry.lastPollAt = now();
    entry.dirty = false;
    if (!command && now() - resolvedAt >= reresolveMs) {
      resolvedAt = now();
      command = await resolveCommand(bin, { env, platform, resolvePath });
    }
    const used = command;
    const { rows, failed } = await listAgents({ command: used, home: entry.home, env, execFileImpl });
    if (failed && command === used) command = null;
    entry.failures = failed ? entry.failures + 1 : 0;
    if (rows) { entry.rows = rows; entry.misses = 0; }
    else if (entry.rows && entry.misses < 1) entry.misses += 1;
    else entry.rows = null;
  }

  function publish() {
    const next = new Map();
    for (const entry of state.values()) for (const [id, value] of entry.rows || []) next.set(id, value);
    if (sameStatuses(statuses, next)) return;
    statuses = next;
    if (!stopped) emitter.emit('change', statuses);
  }

  // List the given homes (all by default), one call at a time.
  function poll(entries = [...state.values()]) {
    if (stopped) return Promise.resolve();
    for (const entry of entries) entry.queued = true;
    const run = (polling || Promise.resolve()).then(async () => {
      try {
        for (const entry of entries) {
          if (stopped) return;
          await listHome(entry);
        }
        publish();
      } finally {
        for (const entry of entries) entry.queued = false;
      }
    });
    const tail = run.catch(() => {});
    polling = tail;
    tail.then(() => { if (polling === tail) polling = null; });
    return run;
  }

  function tick() {
    if (!started || stopped) return Promise.resolve();
    for (const entry of state.values()) watch(entry);
    const windowNow = windowState();
    const at = now();
    const ready = [...state.values()].filter((entry) => due(entry, windowNow, at));
    return ready.length ? poll(ready).catch(() => {}) : Promise.resolve();
  }

  return {
    on: (...args) => emitter.on(...args),
    off: (...args) => emitter.off(...args),
    get: (sessionId) => statuses.get(sessionId) || null,
    snapshot: () => statuses,
    poll: () => poll(),
    tick,
    // The window came back: list the homes that changed while nobody looked.
    // Nothing when the watcher never started (the Claude provider is off).
    nudge() {
      if (!started || stopped) return Promise.resolve();
      const at = now();
      const ready = [...state.values()].filter((entry) => !entry.queued
        && (entry.dirty || (!entry.close && !entry.missing))
        && at - entry.lastPollAt >= minNudgeIntervalMs);
      return ready.length ? poll(ready).catch(() => {}) : Promise.resolve();
    },
    setOwnPaneFileTest(test) { ownPaneFile = typeof test === 'function' ? test : null; },
    start() {
      if (started || stopped) return;
      started = true;
      for (const entry of state.values()) watch(entry);
      poll().catch(() => {});
      timer = setInterval(() => { tick(); }, tickMs);
      timer.unref?.();
    },
    stop() {
      stopped = true;
      clearInterval(timer);
      timer = null;
      for (const entry of state.values()) { entry.close?.(); entry.close = null; }
    },
  };
}

module.exports = {
  createCliAgentsWatcher, parseAgents, resolveCommand, STATUS,
  SETTLE_MS, FOCUSED_GAP_MS, UNFOCUSED_GAP_MS, FALLBACK_MS, MIN_NUDGE_INTERVAL_MS,
};
