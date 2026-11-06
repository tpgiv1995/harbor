'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
const { discoverProfiles } = require('../config/homes.js');
const { projectLabelForCwd } = require('../../shared/project-label.cjs');

const { readClaudeTitles } = require('./native-session-titles.cjs');

// Entry fields are additive. Keep the envelope readable by the older phone
// server sharing this cache; upgrade missing fields after the window opens.
const CACHE_VERSION = 2;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/;
const UUID_BARE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
const NOISE_PREFIXES = [
  '<command-name>', '<command-message>', '<local-command-stdout', '<system-reminder',
  '<task-notification', '[SYSTEM NOTIFICATION', 'Caveat: The messages below',
  '[Request interrupted',
];
const SETTINGS_COMMANDS = new Set([
  '/effort', '/model', '/fast', '/config', '/permissions', '/theme',
  '/statusline', '/compact', '/clear', '/resume',
]);
const HEAD_LINE_CAP = 400;
const HEAD_BYTE_CAP = 2_000_000;
const TAIL_BYTES = 65_536;
const PROJECT_LABEL_WIDTH = 26;
const TITLE_MAX = 110;
// Everything buildHomeMap reads under a config home, and therefore everything
// whose on-disk stamp invalidates its memo.
const HOME_MAP_INPUTS = ['history.jsonl', 'session-env', 'file-history'];

// The first `limit` code points, counted the way Array.from counts them (a
// surrogate pair is one, a lone surrogate is one), without building an array
// of one-character strings: the rail parses about 12,000 prompts of up to
// 1,200 characters on every history refresh, in two processes (2026-11-06).
function codePointSlice(value, limit) {
  if (value.length <= limit) return value;
  let end = 0;
  for (let count = 0; count < limit && end < value.length; count += 1) {
    const unit = value.charCodeAt(end);
    if (unit >= 0xd800 && unit <= 0xdbff && end + 1 < value.length) {
      const next = value.charCodeAt(end + 1);
      end += next >= 0xdc00 && next <= 0xdfff ? 2 : 1;
    } else {
      end += 1;
    }
  }
  return value.slice(0, end);
}

function codePointLength(value) {
  // No u flag: in unicode mode a surrogate PAIR is one code point and never
  // matches a lone-surrogate class, so every emoji took the fast path and
  // counted as two.
  if (!/[\uD800-\uDBFF]/.test(value)) return value.length;
  let length = 0;
  for (const unused of value) length += 1;
  return length;
}

function padCodePoints(value, width) {
  const length = Array.from(value).length;
  return length >= width ? value : `${value}${' '.repeat(width - length)}`;
}

function cleanText(value, limit) {
  let text = String(value).replace(/\s+/gu, ' ').trim();
  if (codePointLength(text) > limit) text = `${codePointSlice(text, limit - 1)}…`;
  return text;
}

function jsonObject(line) {
  try {
    const value = JSON.parse(line);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function extractUserText(obj) {
  if (obj.type !== 'user' || obj.isSidechain || obj.isMeta) return null;
  const message = obj.message && typeof obj.message === 'object' ? obj.message : {};
  const { content } = message;
  let text = null;
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    const item = content.find((candidate) => candidate && typeof candidate === 'object' && candidate.type === 'text');
    if (item) text = item.text;
  }
  if (typeof text !== 'string' || !text.trim()) return null;
  const leading = text.trimStart();
  return NOISE_PREFIXES.some((prefix) => leading.startsWith(prefix)) ? null : text;
}

function splitLines(text) {
  const lines = text.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/u);
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function scanHeadLines(file, visit) {
  const parts = [];
  const fd = fs.openSync(file, 'r');
  let characters = 0;
  let lineCount = 0;
  let stopped = false;
  try {
    while (!stopped) {
      const chunk = Buffer.allocUnsafe(256 * 1024);
      const count = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (!count) break;
      let start = 0;
      while (start < count) {
        const index = chunk.indexOf(0x0a, start);
        if (index < 0 || index >= count) break;
        parts.push(chunk.subarray(start, index + 1));
        const buffer = parts.length === 1 ? parts[0] : Buffer.concat(parts);
        let line = buffer.toString('utf8');
        if (line.endsWith('\r\n')) line = `${line.slice(0, -2)}\n`;
        lineCount += 1;
        characters += codePointLength(line);
        parts.length = 0;
        start = index + 1;
        if (visit(line) || lineCount >= HEAD_LINE_CAP || characters > HEAD_BYTE_CAP) {
          stopped = true;
          break;
        }
      }
      if (!stopped && start < count) parts.push(chunk.subarray(start, count));
    }
    if (!stopped && parts.length) {
      const buffer = parts.length === 1 ? parts[0] : Buffer.concat(parts);
      visit(buffer.toString('utf8'));
    }
  } finally {
    fs.closeSync(fd);
  }
}

function readTail(file, size, window) {
  const start = Math.max(0, size - window);
  const length = size - start;
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, buffer, 0, length, start);
  } finally {
    fs.closeSync(fd);
  }
  let slice = buffer;
  if (start > 0) {
    const newline = buffer.indexOf(0x0a);
    slice = newline < 0 ? Buffer.alloc(0) : buffer.subarray(newline + 1);
  }
  return splitLines(slice.toString('utf8'));
}

function parseTranscript(file, previous) {
  let entrypoint = null;
  let cwd = null;
  let start = null;
  let summary = null;
  let firstPrompt = null;
  let commandName = null;
  scanHeadLines(file, (line) => {
    const obj = jsonObject(line);
    if (!obj) return false;
    if (entrypoint === null && typeof obj.entrypoint === 'string') entrypoint = obj.entrypoint;
    if (cwd === null && obj.cwd) cwd = obj.cwd;
    if (start === null && obj.timestamp) start = obj.timestamp;
    if (summary === null && obj.type === 'summary' && obj.summary) summary = obj.summary;
    if (firstPrompt === null) {
      const candidate = extractUserText(obj);
      if (candidate) firstPrompt = candidate;
    }
    if (obj.type === 'user' && (commandName === null || SETTINGS_COMMANDS.has(commandName.split(/\s+/u)[0]))) {
      const message = obj.message && typeof obj.message === 'object' ? obj.message : {};
      let raw = '';
      if (typeof message.content === 'string') raw = message.content;
      else if (Array.isArray(message.content)) {
        raw = message.content
          .filter((item) => item && typeof item === 'object' && item.type === 'text')
          .map((item) => typeof item.text === 'string' ? item.text : '')
          .join(' ');
      }
      const command = raw.match(/<command-name>(\/[^<]+)<\/command-name>/u);
      if (command) {
        let candidate = command[1].trim();
        const args = raw.match(/<command-args>([^<]*)<\/command-args>/u);
        if (args && args[1].trim()) candidate = `${candidate} ${args[1].trim()}`;
        if (commandName === null || !SETTINGS_COMMANDS.has(candidate.split(/\s+/u)[0])) commandName = candidate;
      }
    }
    return Boolean(cwd && start && firstPrompt);
  });

  let last = null;
  const recent = [];
  const size = fs.statSync(file).size;
  for (const window of [TAIL_BYTES, 1_048_576]) {
    const tail = readTail(file, size, window);
    for (let index = tail.length - 1; index >= 0; index -= 1) {
      const obj = jsonObject(tail[index]);
      if (!obj) continue;
      if (last === null && obj.timestamp) last = obj.timestamp;
      if (summary === null && obj.type === 'summary' && obj.summary) summary = obj.summary;
      if (recent.length < 3) {
        const candidate = extractUserText(obj);
        if (candidate) recent.push(cleanText(candidate, 240));
      }
      if (last && summary && recent.length >= 3) break;
    }
    if (last || size <= window) break;
  }
  recent.reverse();
  const native = readClaudeTitles(file, previous);
  const title = native.native_title || native.native_summary || summary || firstPrompt || commandName;
  return {
    cwd,
    entrypoint,
    start,
    last,
    ...native,
    title: native.native_title || native.native_summary || (title ? cleanText(title, TITLE_MAX) : null),
    first_prompt: firstPrompt ? cleanText(firstPrompt, 1200) : null,
    command: commandName ? cleanText(commandName, TITLE_MAX) : null,
    recent,
  };
}

function parseTimestamp(value) {
  if (!value) return null;
  const ms = Date.parse(String(value));
  return Number.isNaN(ms) ? null : new Date(ms);
}

function formatNumber(value, width) {
  return String(value).padStart(width, '0');
}

function formatDate(date, includeDate = true) {
  const datePart = `${formatNumber(date.getFullYear(), 4)}-${formatNumber(date.getMonth() + 1, 2)}-${formatNumber(date.getDate(), 2)}`;
  const timePart = `${formatNumber(date.getHours(), 2)}:${formatNumber(date.getMinutes(), 2)}`;
  return includeDate ? `${datePart} ${timePart}` : timePart;
}

function createHistoryIndex(options = {}) {
  const home = path.resolve(options.home || os.homedir());
  const projectsDir = options.projectsDir || path.join(home, '.claude', 'projects');
  const cacheDir = options.cacheDir || path.join(home, '.cache', 'harbor');
  const cacheFile = options.cacheFile || path.join(cacheDir, 'index.json');
  const titlesFile = options.titlesFile || path.join(cacheDir, 'session-titles.json');
  const profiles = Array.isArray(options.profiles) ? options.profiles : null;
  // Refresh FLOOR + in-memory cache (2026-08-30): an agent fleet appending
  // transcripts every second or two kept this worker in back-to-back full
  // rescans forever, saturating a core inside Harbor's main process at ~90MB/s
  // of re-reads while every keystroke in the app lagged. A pass that completed
  // moments ago answers repeat callers from memory, and the parsed cache never
  // round-trips through its own disk file between passes. A rebuild bypasses.
  const refreshFloorMs = Number(options.refreshFloorMs ?? process.env.HARBOR_INDEX_REFRESH_FLOOR_MS ?? 10_000);
  const nowMs = options.now || Date.now;
  // Injectable fs (tests reproduce a directory that cannot be listed) and a
  // log seam, because this runs in a worker thread whose console is easy to
  // lose and a swallowed failure here is exactly what hid the 2026-09-04 one.
  const fsImpl = options.fs || fs;
  const log = typeof options.log === 'function' ? options.log : (line) => console.warn(line);
  let memFiles = null;
  let lastResult = null;
  let lastRefreshAt = -Infinity;
  let lastSaveFailure = null;
  // ONE WRITER, AND NOT ON EVERY PASS (2026-11-06). The cache is about 17 MB
  // for 12,000 transcripts, and it was stringified and rewritten whole on
  // every pass that saw one transcript grow: every 10 to 30 seconds while any
  // session worked, in the app AND again in the phone server, which also
  // re-parsed the other's write. The cache only saves re-parsing on a cold
  // start (every entry is re-checked against its file's size and mtime), so a
  // long-lived process keeps its passes in memory and writes at most once per
  // `saveIntervalMs` (the app passes 2 minutes; a one-shot CLI keeps 0, save
  // every pass), and a `readOnly` process never writes it.
  const readOnly = options.readOnly === true;
  const saveIntervalMs = Math.max(0, Number(options.saveIntervalMs) || 0);
  let lastSavedAt = -Infinity;
  let saveTimer = null;

  // Delegates to the ONE label rule (shared/project-label.cjs). This function
  // kept its own hand-copy for months, which is exactly the drift class the
  // shared module's test exists to catch; the copy died when the era rule
  // became host-aware and a third divergent version was one edit away.
  function projectLabel(cwd) {
    return projectLabelForCwd(cwd, home) || '(unknown)';
  }

  // `meta` is asked for on EVERY send (provider resolution, then delivery
  // confirmation) and once per candidate session per Orch summaries broadcast,
  // and the worker answering it is one thread that also serves the rail. It
  // used to re-read the titles file and rebuild the whole home map on each
  // call (~32ms: three history.jsonl parses plus session-env / file-history
  // listings, 12,871 entries in one of them), so 2,400 calls in 30 seconds
  // pinned the thread and every send waited minutes behind the queue
  // (live-caught 2026-09-09, "harbor is CRAWLING today"). Both are now
  // answered from memory until an input changes on disk: a file's size and
  // mtime, a directory's mtime (NTFS and POSIX both bump it on create/delete).
  function inputStamp(target) {
    try {
      // Identity too (bigint, exact): a file swapped in with the same size and
      // mtime is another input (Astra review round 3).
      const stat = fsImpl.statSync(target, { bigint: true });
      return `${stat.mtimeNs ?? stat.mtimeMs}:${stat.size}:${stat.dev}:${stat.ino}`;
    } catch {
      return '-';
    }
  }

  let titlesMemo = null;
  let homeMapMemo = null;
  // EACH HOME'S INPUTS ARE READ ONLY AS FAR AS THEY CHANGED (2026-11-06). Any
  // prompt in any session appends to its home's history.jsonl, which changed
  // the memo stamp below, and the rebuild re-parsed every home's history.jsonl
  // (4.2 MB across seven homes on Pat's machine) and re-listed every
  // session-env and file-history folder (about 19,000 names) on almost every
  // rail refresh, in the app and in the phone server. Per home now: the
  // history file's complete lines are counted once and a grown file is read
  // from where the last read stopped (the bytes after its last newline are
  // re-read each time, exactly as a full read sees them); a folder is listed
  // again only when its own stamp changed. Anything else (a shorter file, a
  // changed first line, a read error) reads that input whole, as before.
  const homeInputs = new Map(); // `${root}\n${name}` -> cached contribution
  let homeMapRetry = false; // an input failed to read: the built map must not be memoized
  function historyCounts(root) {
    const file = path.join(root, 'history.jsonl');
    const key = `${root}\nhistory.jsonl`;
    const countLines = (text, into) => {
      for (const line of splitLines(text)) {
        const obj = jsonObject(line);
        if (obj && obj.sessionId) into.set(obj.sessionId, (into.get(obj.sessionId) || 0) + 1);
      }
    };
    let fd = null;
    try {
      fd = fsImpl.openSync(file, 'r');
      const info = fsImpl.fstatSync(fd, { bigint: true });
      const size = Number(info.size);
      const identity = `${info.dev}:${info.ino}`; // exact: bigint (Astra review round 3)
      const mtime = String(info.mtimeNs ?? info.mtimeMs);
      let cached = homeInputs.get(key);
      const headLength = Math.min(256, size);
      const head = Buffer.alloc(headLength);
      fsImpl.readSync(fd, head, 0, headLength, 0);
      const headText = head.toString('latin1');
      // The same file, grown: no shorter than what was counted, and its first
      // bytes unchanged. Anything else is a new file and is read whole.
      // Also a new file: another identity, or the same size as last read with a
      // different mtime (rewritten in place; Astra review round 2).
      if (!cached || size < cached.completeTo || headText.length < cached.head.length || !headText.startsWith(cached.head)
        || cached.identity !== identity || (size === cached.size && mtime !== cached.mtime)) {
        cached = { head: headText, completeTo: 0, counts: new Map() };
      }
      const length = size - cached.completeTo;
      const buffer = Buffer.alloc(Math.max(0, length));
      if (length > 0) fsImpl.readSync(fd, buffer, 0, length, cached.completeTo);
      const lastNewline = buffer.lastIndexOf(0x0a);
      const complete = lastNewline >= 0 ? buffer.subarray(0, lastNewline + 1) : buffer.subarray(0, 0);
      const counts = new Map(cached.counts);
      if (complete.length) countLines(complete.toString('utf8'), counts);
      const next = { head: headText, completeTo: cached.completeTo + complete.length, counts, identity, size, mtime };
      homeInputs.set(key, next);
      // The unfinished last line counts exactly as a whole-file read counts it.
      const tail = buffer.subarray(complete.length);
      if (!tail.length) return counts;
      const withTail = new Map(counts);
      countLines(tail.toString('utf8'), withTail);
      return withTail;
    } catch (error) {
      // No history file is an empty contribution (a profile need not have
      // one). A file that would not read right now is not: keep the last good
      // counts and leave the map unmemoized so the next call reads it again
      // (Astra review round 3).
      if (error?.code === 'ENOENT') { homeInputs.delete(key); return new Map(); }
      homeMapRetry = true;
      return homeInputs.get(key)?.counts || new Map();
    } finally {
      if (fd !== null) try { fsImpl.closeSync(fd); } catch { /* already closed */ }
    }
  }
  function folderIds(root, directory) {
    const target = path.join(root, directory);
    const key = `${root}\n${directory}`;
    const stamp = inputStamp(target);
    const cached = homeInputs.get(key);
    if (cached && cached.stamp === stamp && stamp !== '-') return cached.ids;
    let ids = [];
    try {
      ids = fsImpl.readdirSync(target).filter((name) => UUID_BARE_RE.test(name)).map((name) => name.slice(0, 36));
    } catch (error) {
      // A folder that is not there is an empty contribution. One that would not
      // list right now is not: keep the last good answer and ask again next
      // time, never cache the failure as "empty" (Astra review round 2).
      if (error?.code !== 'ENOENT') {
        homeMapRetry = true;
        return cached ? cached.ids : [];
      }
    }
    homeInputs.set(key, { stamp, ids });
    return ids;
  }
  let titlesCheckedAt = -Infinity;
  let homesCheckedAt = -Infinity;
  function loadGeneratedTitles() {
    if (titlesMemo && nowMs() - titlesCheckedAt < refreshFloorMs) return titlesMemo.titles;
    titlesCheckedAt = nowMs();
    const stamp = inputStamp(titlesFile);
    if (titlesMemo && titlesMemo.stamp === stamp) return titlesMemo.titles;
    let titles = {};
    try {
      const data = JSON.parse(fsImpl.readFileSync(titlesFile, 'utf8'));
      if (data && typeof data === 'object' && data.titles && typeof data.titles === 'object' && !Array.isArray(data.titles)) {
        titles = data.titles;
      }
    } catch {
      titles = {};
    }
    titlesMemo = { stamp, titles };
    return titles;
  }

  // Applied once per (index pass, titles file): the loop walks every entry,
  // and a pass whose entries already carry these titles has nothing to do.
  let appliedTitles = null;
  function applyGeneratedTitles(files) {
    const titles = loadGeneratedTitles();
    if (appliedTitles && appliedTitles.files === files && appliedTitles.titles === titles) return files;
    for (const entry of Object.values(files)) {
      const generated = titles[entry.id];
      if (!generated || entry.native_title || entry.native_summary || String(entry.title || '').trimStart().startsWith('BATCH TITLE:')) continue;
      entry.title = cleanText(String(generated), TITLE_MAX);
    }
    appliedTitles = { files, titles };
    return files;
  }

  function loadCache() {
    if (memFiles) return memFiles;
    options.onDiskCacheRead?.();
    try {
      const data = JSON.parse(fsImpl.readFileSync(cacheFile, 'utf8'));
      if ([2, 3].includes(data.v) && data.files && typeof data.files === 'object') return (memFiles = data.files);
    } catch { /* an absent or invalid cache is empty */ }
    return {};
  }

  // A rename over an existing file fails on Windows while any other handle
  // holds the target open (EPERM/EBUSY/EACCES). This index has several writers
  // on this machine (the app, the Harbor Mobile server, the CLI picker: the
  // same worker, the same file), plus whatever scanner has the file for a
  // moment, so the replace is retried briefly before it is called a failure.
  // Synchronous on purpose: the worker thread is the only thing waiting.
  const RENAME_RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY', 'EEXIST']);
  const RENAME_RETRY_MS = [25, 50, 100, 200, 400];
  function sleepSync(ms) {
    try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* unavailable: skip the wait */ }
  }
  function renameWithRetry(from, to) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        fsImpl.renameSync(from, to);
        return;
      } catch (error) {
        if (attempt >= RENAME_RETRY_MS.length || !RENAME_RETRY_CODES.has(error?.code)) throw error;
        sleepSync(RENAME_RETRY_MS[attempt]);
      }
    }
  }

  // The pass is complete whether or not the cache lands. A write that fails
  // costs the NEXT pass a re-parse of what changed; it must never cost this
  // caller its rows (before: it threw here, after every transcript had
  // already been read, and at boot that rejection exited Harbor).
  function persist(files) {
    try {
      saveCache(files);
      lastSaveFailure = null;
      lastSavedAt = nowMs();
      return true;
    } catch (error) {
      const message = `harbor-index: could not write the cache ${cacheFile} (${error?.code || 'error'}: ${error?.message || error}); serving the pass from memory`;
      if (message !== lastSaveFailure) log(message);
      lastSaveFailure = message;
      return false;
    }
  }

  // Writes a pass that is still waiting for its interval (on close).
  function flush() {
    if (!saveTimer) return false;
    clearTimeout(saveTimer);
    saveTimer = null;
    if (memFiles && !readOnly) persist(memFiles);
    return true;
  }

  function saveCache(files) {
    fsImpl.mkdirSync(cacheDir, { recursive: true });
    const temporary = path.join(cacheDir, `.index-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    fsImpl.writeFileSync(temporary, JSON.stringify({ v: CACHE_VERSION, files }));
    try {
      renameWithRetry(temporary, cacheFile);
    } catch (error) {
      // Never orphan the temp file: 47 of them had piled up in the cache dir
      // before this, one per failed replace, and they were the only evidence.
      try { fsImpl.unlinkSync(temporary); } catch { /* best effort */ }
      throw error;
    }
  }

  // Lists the corpus. The ROOT failing to list is an error: an empty answer
  // there used to become zero rows in the rail and an EMPTY cache on disk
  // (live-caught 2026-09-04), which is a lie about the corpus, not a fact
  // about it. A single project directory failing to list is tolerated, and
  // reported in `unlisted` so the caller can keep what the cache already knew
  // about it rather than dropping those sessions for one bad readdir.
  function discover() {
    const found = [];
    const unlisted = [];
    let directories;
    try {
      directories = fsImpl.readdirSync(projectsDir);
    } catch (error) {
      const failure = new Error(`harbor-index: cannot list projects dir ${projectsDir}: ${error?.message || error}`);
      failure.code = error?.code;
      failure.cause = error;
      throw failure;
    }
    for (const directory of directories) {
      const directoryPath = path.join(projectsDir, directory);
      let directoryStat;
      try { directoryStat = fsImpl.statSync(directoryPath); } catch { unlisted.push(directoryPath); continue; }
      if (!directoryStat.isDirectory()) continue;
      let names;
      try { names = fsImpl.readdirSync(directoryPath); } catch { unlisted.push(directoryPath); continue; }
      for (const name of names) {
        if (!UUID_RE.test(name)) continue;
        const file = path.join(directoryPath, name);
        try {
          const stat = fsImpl.statSync(file);
          found.push([name.slice(0, -6), file, stat.mtimeMs / 1000, stat.size]);
        } catch { /* a file can disappear during discovery */ }
      }
    }
    return { found, unlisted };
  }

  function underAny(file, directories) {
    return directories.some((directory) => file.startsWith(directory + path.sep));
  }

  // RE-CHECK ONLY WHAT CHANGED (2026-11-01). discover() lists every project
  // folder and stats every transcript: 4,064 folders and 8,638 transcripts on
  // the Legion that night, every pass, in the desktop and again in the phone
  // server, while agents wrote a line a second. The app's watcher already knows
  // which file changed, so once it starts sending those names (noteChanged), a
  // pass re-checks only the reported transcripts, re-lists only a reported
  // project folder, and walks everything only on its first pass, after a
  // nameless event, or while a folder would not list. Without hints (the CLI
  // picker, tests, the oracle comparisons) every pass is discover(), unchanged.
  let hinting = false;
  let fullWalkNeeded = true;
  let lastFound = null; // file -> [id, file, mt, sz], in discover order
  const dirtyFiles = new Set();
  const dirtyDirs = new Set();

  function noteChanged(names) {
    hinting = true;
    for (const name of names || []) {
      if (name == null) { fullWalkNeeded = true; continue; }
      const parts = String(name).split(/[\\/]+/).filter(Boolean);
      if (parts.length === 2 && UUID_RE.test(parts[1])) dirtyFiles.add(path.join(projectsDir, parts[0], parts[1]));
      else if (parts.length === 1) dirtyDirs.add(path.join(projectsDir, parts[0]));
      // Deeper paths (subagent transcripts, tool results) are never listed.
    }
  }

  function entryFor(file) {
    try {
      const stat = fsImpl.statSync(file);
      return stat.isFile() ? [path.basename(file).slice(0, -6), file, stat.mtimeMs / 1000, stat.size] : null;
    } catch { return null; }
  }

  function discoverForPass() {
    if (!hinting || fullWalkNeeded || !lastFound) {
      const result = discover();
      lastFound = new Map(result.found.map((entry) => [entry[1], entry]));
      fullWalkNeeded = result.unlisted.length > 0;
      dirtyFiles.clear();
      dirtyDirs.clear();
      return result;
    }
    for (const directoryPath of dirtyDirs) {
      for (const file of [...lastFound.keys()]) if (file.startsWith(directoryPath + path.sep)) lastFound.delete(file);
      let names = [];
      try { if (fsImpl.statSync(directoryPath).isDirectory()) names = fsImpl.readdirSync(directoryPath); } catch { /* gone */ }
      for (const name of names) {
        if (!UUID_RE.test(name)) continue;
        const entry = entryFor(path.join(directoryPath, name));
        if (entry) lastFound.set(entry[1], entry);
      }
    }
    for (const file of dirtyFiles) {
      const entry = entryFor(file);
      if (entry) lastFound.set(file, entry); else lastFound.delete(file);
    }
    dirtyFiles.clear();
    dirtyDirs.clear();
    return { found: [...lastFound.values()], unlisted: [] };
  }

  function refreshIndex(rebuild = false, env = process.env) {
    if (!rebuild && lastResult && nowMs() - lastRefreshAt < refreshFloorMs) return lastResult;
    const cache = rebuild ? {} : loadCache();
    const fresh = {};
    const pending = [];
    if (rebuild) fullWalkNeeded = true;
    const { found, unlisted } = discoverForPass();
    for (const [id, file, mt, sz] of found) {
      const cached = cache[file];
      if (cached && cached.mt === mt && cached.sz === sz) fresh[file] = cached;
      else pending.push([id, file, mt, sz]);
    }
    if (unlisted.length) {
      // Carry the cached entries of a directory that would not list right now.
      // They may be a little stale; stale is a fact, absent is a wipe.
      for (const [file, entry] of Object.entries(cache)) {
        if (!fresh[file] && underAny(file, unlisted)) fresh[file] = entry;
      }
    }
    for (const [id, file, mt, sz] of pending) {
      try { fresh[file] = { ...parseTranscript(file, cache[file] && sz > cache[file].sz ? cache[file] : undefined), id, mt, sz }; } catch { /* unreadable transcripts are skipped */ }
    }
    if ((pending.length || Object.keys(fresh).length !== Object.keys(cache).length) && !readOnly && env.HARBOR_INDEX_READ_ONLY !== '1') {
      const wait = lastSavedAt + saveIntervalMs - nowMs();
      if (wait <= 0) {
        if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
        persist(fresh);
      } else if (!saveTimer) {
        // The newest pass lands when the interval is up, even if no pass runs
        // then, and says so: the titler reads this file from disk, and a session
        // that first appeared in memory must not wait for some later refresh to
        // be named (Astra review 2026-11-06).
        saveTimer = setTimeout(() => {
          saveTimer = null;
          if (memFiles && persist(memFiles)) options.onPersisted?.();
        }, wait);
        saveTimer.unref?.();
      }
    }
    memFiles = fresh;
    lastResult = applyGeneratedTitles(fresh);
    lastRefreshAt = nowMs();
    return lastResult;
  }

  function entryLastDate(entry) {
    return parseTimestamp(entry.last) || new Date(entry.mt * 1000);
  }

  function migrateEntries(limit = 32) {
    const files = loadCache(); let changed = 0; let remaining = 0;
    for (const [file, entry] of Object.entries(files)) {
      if (Object.hasOwn(entry, 'entrypoint')) continue;
      if (changed >= limit) { remaining++; continue; }
      let entrypoint = null; let cwd = null; let start = null; let prompt = null;
      try {
        scanHeadLines(file, (line) => {
          const row = jsonObject(line); if (!row) return false;
          entrypoint ||= typeof row.entrypoint === 'string' ? row.entrypoint : null;
          cwd ||= row.cwd; start ||= row.timestamp; prompt ||= extractUserText(row);
          return Boolean(entrypoint || cwd && start && prompt);
        });
        entry.entrypoint = entrypoint; changed++;
      } catch { entry.entrypoint = null; changed++; }
    }
    if (changed && !remaining && !readOnly) { try { saveCache(files); } catch (error) { log(String(error)); } }
    return { changed, remaining };
  }

  function flagValue(args, flag) {
    const index = args.indexOf(flag);
    if (index + 1 >= args.length || args[index + 1].startsWith('--')) throw new Error(`harbor-index: ${flag} requires a value`);
    return args[index + 1];
  }

  function parseSince(spec) {
    const now = new Date();
    if (spec === 'today') {
      const start = new Date(now);
      start.setHours(6, 0, 0, 0);
      if (now < start) start.setDate(start.getDate() - 1);
      return start;
    }
    const relative = String(spec).match(/^(\d+)([dhw])$/u);
    if (relative) {
      const scales = { d: 86_400_000, h: 3_600_000, w: 604_800_000 };
      return new Date(now.getTime() - Number(relative[1]) * scales[relative[2]]);
    }
    const absolute = String(spec).match(/^(\d{4})-(\d{2})-(\d{2})$/u);
    if (absolute) {
      const result = new Date(Number(absolute[1]), Number(absolute[2]) - 1, Number(absolute[3]));
      if (!Number.isNaN(result.getTime())) return result;
    }
    throw new Error(`harbor-index: bad --since value: '${spec}' (use today, 7d, 36h, 2w, or YYYY-MM-DD)`);
  }

  function newestById(index) {
    const best = new Map();
    for (const [file, entry] of Object.entries(index)) {
      const current = best.get(entry.id);
      if (!current || entry.mt > current[1].mt) best.set(entry.id, [file, entry]);
    }
    return [...best.values()];
  }

  function emitRows(args, env) {
    const index = refreshIndex(args.includes('--rebuild'), env);
    const since = args.includes('--since') ? parseSince(flagValue(args, '--since')) : null;
    const projectFilter = args.includes('--project') ? flagValue(args, '--project').toLowerCase() : null;
    const showAll = args.includes('--all');
    const rows = [];
    for (const [file, entry] of newestById(index)) {
      const label = projectLabel(entry.cwd);
      if (projectFilter && !label.toLowerCase().includes(projectFilter) && !String(entry.cwd || '').toLowerCase().includes(projectFilter)) continue;
      const last = entryLastDate(entry);
      if (since && last < since) continue;
      let title = entry.title;
      if (!title && !showAll) continue;
      if (!title) title = '(no user messages)';
      rows.push([last, entry.id, label, title, entry.first_prompt, entry.cwd, file, entry.entrypoint, entry]);
    }
    rows.sort((a, b) => b[0] - a[0]);
    const withFirstPrompt = args.includes('--with-first-prompt');
    const withCwd = args.includes('--with-cwd');
    const out = rows.map(([last, id, label, title, firstPrompt, cwd, file, entrypoint, entry]) => {
      if (args.includes('--with-meta')) {
        // Metadata uses the same columns, escaped losslessly. No second copy
        // of the prompt/title/path and no JSON parser per row on main.
        return [id, formatDate(last), label, entry.title || '', firstPrompt || '', cwd || '', file,
          entrypoint || '', entry.start || '', entry.mt ? entry.mt * 1000 : '', entry.title == null ? '0' : '1']
          .map((value) => String(value).replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/\r/g, '\\r')).join('\t');
      }
      const shownLabel = withFirstPrompt ? label : padCodePoints(codePointSlice(label, PROJECT_LABEL_WIDTH), PROJECT_LABEL_WIDTH);
      let line = `${id}\t${formatDate(last)}\t${shownLabel}\t${title}`;
      if (withFirstPrompt) line += `\t${codePointSlice(String(firstPrompt || '').replace(/[\t\n]/g, ' '), 300)}`;
      if (withCwd) line += `\t${String(cwd || '').replace(/[\t\n]/g, ' ')}`;
      if (args.includes('--with-path')) line += `\t${file}`;
      if (args.includes('--with-entrypoint')) line += `\t${entrypoint || ''}`;
      return line;
    });
    return { ids: rows.map((row) => row[1]), lines: out };
  }

  function emit(args, env) {
    const { lines } = emitRows(args, env);
    return lines.length ? `${lines.join('\n')}\n` : '';
  }

  // ONLY THE ROWS THAT CHANGED (2026-11-06). The rail asks for every session on
  // every history refresh: 12,000 rows, a 14.8 MB string copied across the
  // thread boundary and parsed on the main thread of the app and of the phone
  // server, about three times a minute while sessions work (measured: 61% of
  // the phone server's allocations). Between two refreshes a handful of rows
  // change. A caller that passes back the cursor of its last answer gets the
  // order of ids plus only the lines that differ from that answer; any other
  // cursor (first call, another caller, a restarted worker) gets every line.
  const deltaEpoch = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  let deltaSeq = 0;
  let deltaKey = null;
  let deltaLines = new Map();
  function emitDelta(args, cursor = null, env = process.env) {
    const { ids, lines } = emitRows(args, env);
    const key = args.join('\u0000');
    const full = !cursor || cursor.epoch !== deltaEpoch || cursor.seq !== deltaSeq || cursor.key !== key || deltaKey !== key;
    const next = new Map();
    const changed = [];
    for (let i = 0; i < ids.length; i += 1) {
      next.set(ids[i], lines[i]);
      if (full || deltaLines.get(ids[i]) !== lines[i]) changed.push(lines[i]);
    }
    deltaLines = next;
    deltaKey = key;
    deltaSeq += 1;
    return { cursor: { epoch: deltaEpoch, seq: deltaSeq, key }, full, ids, changed };
  }

  function tree(args, env) {
    const index = refreshIndex(false, env);
    const showAll = args.includes('--all');
    const expanded = new Set(String(env.HIST_EXPANDED || '').split('\n').filter(Boolean));
    const groups = new Map();
    for (const [, entry] of newestById(index)) {
      if (!entry.title && !showAll) continue;
      const label = projectLabel(entry.cwd);
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push([entryLastDate(entry), entry.id, entry.title || '(no user messages)', entry.cwd]);
    }
    const ordered = [...groups.entries()].sort((a, b) => Math.max(...b[1].map((row) => row[0])) - Math.max(...a[1].map((row) => row[0])));
    const out = [];
    for (const [label, sessions] of ordered) {
      sessions.sort((a, b) => b[0] - a[0]);
      const caret = expanded.has(label) ? '▾' : '▸';
      const count = sessions.length;
      out.push(`P:${label}\t${caret} ${padCodePoints(label, 28)} ${String(count).padStart(4)} session${count !== 1 ? 's' : ''}   last ${formatDate(sessions[0][0])}`);
      if (expanded.has(label)) {
        const cwd = sessions[0][3];
        if (cwd && !cwd.includes('\\')) out.push(`N:${cwd}\t      +  new session here`);
        for (const [last, id, title] of sessions.slice(0, 12)) out.push(`S:${id}\t      └ ${formatDate(last)}  ${title}`);
        const hidden = sessions.length - 12;
        if (hidden > 0) out.push(`M:${label}\t      … ${hidden} more session${hidden !== 1 ? 's' : ''} (enter: full list)`);
      }
    }
    out.push('F:-\t+  new session in any folder...');
    return `${out.join('\n')}\n`;
  }

  function buildHomeMap() {
    // Metadata bursts share the refresh floor. Fresh attribution is checked
    // at most once per floor, never once per Orch candidate or send lookup.
    if (homeMapMemo && nowMs() - homesCheckedAt < refreshFloorMs) return homeMapMemo.map;
    homesCheckedAt = nowMs();
    // With no configured profiles, the homes are DISCOVERED from the machine
    // rather than assumed. This used to be a literal three-entry list ending in
    // a `.claude-<person's-name>` directory nobody else owns, which meant an
    // unconfigured index scored every session against one specific person's
    // account layout and attributed nothing on anybody else's.
    const homes = profiles && profiles.length
      ? profiles.filter((profile) => profile && profile.configHome && profile.id).map((profile, index) => [index, profile.configHome, profile.id])
      : discoverProfiles(home).map((profile, index) => [index, profile.configHome, profile.id]);
    // The memo key names every input the map is built from, so a home that
    // appears or disappears, an appended history.jsonl, or a new session-env /
    // file-history entry each invalidate it, and nothing else does.
    const stamp = homes.map(([, root, id]) => [id, root, ...HOME_MAP_INPUTS.map((name) => inputStamp(path.join(root, name)))].join('|')).join('\n');
    if (homeMapMemo && homeMapMemo.stamp === stamp) return homeMapMemo.map;
    homeMapRetry = false;
    const scores = new Map();
    const score = (id, index, amount) => {
      if (!scores.has(id)) scores.set(id, Array(homes.length).fill(0));
      scores.get(id)[index] += amount;
    };
    for (const [index, root] of homes) {
      for (const [id, count] of historyCounts(root)) score(id, index, 2 * count);
      for (const directory of ['session-env', 'file-history']) {
        for (const id of folderIds(root, directory)) score(id, index, 1);
      }
    }
    const result = {};
    for (const [id, values] of scores) {
      const top = Math.max(...values);
      if (top > 0 && values.filter((value) => value === top).length === 1) result[id] = homes[values.indexOf(top)][2];
    }
    // A map built while an input would not read is served, but not memoized:
    // the next call reads that input again.
    homeMapMemo = homeMapRetry ? null : { stamp, map: result };
    return result;
  }

  function hydrate(args, env) {
    const days = args.includes('--days') ? Number(flagValue(args, '--days')) : 7;
    const per = args.includes('--per') ? Number(flagValue(args, '--per')) : 6;
    const maxProjects = args.includes('--max-projects') ? Number(flagValue(args, '--max-projects')) : 9;
    const cutoff = new Date(Date.now() - days * 86_400_000);
    const homes = buildHomeMap();
    const groups = new Map();
    for (const [, entry] of newestById(refreshIndex(false, env))) {
      const cwd = entry.cwd;
      if (!entry.title || !cwd || cwd.includes('\\')) continue;
      try { if (!fs.statSync(cwd).isDirectory()) continue; } catch { continue; }
      const label = projectLabel(cwd);
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push([entryLastDate(entry), entry.id, entry.title, cwd]);
    }
    const ordered = [...groups.entries()].sort((a, b) => Math.max(...b[1].map((row) => row[0])) - Math.max(...a[1].map((row) => row[0])));
    const kept = ordered.filter(([, sessions]) => new Date(Math.max(...sessions.map((row) => row[0]))) >= cutoff).slice(0, maxProjects);
    const out = [];
    for (const [label, sessions] of kept) {
      sessions.sort((a, b) => b[0] - a[0]);
      for (const [, id, title, cwd] of sessions.slice(0, per)) {
        const titleText = String(title);
        let tab = codePointSlice(titleText.replace(/\s+/gu, ' '), 24);
        if (tab.includes(' ') && Array.from(titleText).length > 24) tab = tab.slice(0, tab.lastIndexOf(' '));
        out.push(`${label}\t${cwd}\t${id}\t${homes[id] || 'team'}\t${tab}`);
      }
    }
    return out.length ? `${out.join('\n')}\n` : '';
  }

  let lookupSource = null;
  let entriesById = new Map();
  function findEntry(index, id) {
    if (lookupSource !== index) {
      entriesById = new Map();
      for (const candidate of Object.entries(index)) {
        const previous = entriesById.get(candidate[1].id);
        if (!previous || candidate[1].mt > previous[1].mt) entriesById.set(candidate[1].id, candidate);
      }
      lookupSource = index;
      options.onLookupBuild?.();
    }
    return entriesById.get(id) || [null, null];
  }

  function meta(id, env) {
    let index = applyGeneratedTitles(loadCache());
    let [file, entry] = findEntry(index, id);
    if (!entry) {
      index = refreshIndex(false, env);
      [file, entry] = findEntry(index, id);
    }
    if (!entry) throw new Error(`harbor-index: session ${id} not found`);
    return `${JSON.stringify({ id, cwd: entry.cwd, project: projectLabel(entry.cwd), title: entry.title,
      firstPrompt: entry.first_prompt || null, start: entry.start || null, mt: entry.mt ? entry.mt * 1000 : null,
      path: file, entrypoint: entry.entrypoint || null, home: buildHomeMap()[id] || null })}\n`;
  }

  function humanSize(value) {
    let number = value;
    for (const unit of ['B', 'KB', 'MB', 'GB']) {
      if (number < 1024 || unit === 'GB') return unit === 'B' ? `${number.toFixed(0)} ${unit}` : `${number.toFixed(1)} ${unit}`;
      number /= 1024;
    }
    return '';
  }

  function preview(id, env) {
    let index = applyGeneratedTitles(loadCache());
    if (!Object.keys(index).length) index = refreshIndex(false, env);
    const [file, entry] = findEntry(index, id);
    if (!entry) return `session ${id} not in index yet (press ctrl-r to reload)\n`;
    const last = entryLastDate(entry);
    const lines = [entry.title || '(no title)', '─'.repeat(40), `project      ${projectLabel(entry.cwd)}`, `directory    ${entry.cwd || '(unknown)'}`];
    const start = parseTimestamp(entry.start);
    const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    if (start) lines.push(`started      ${weekdays[start.getDay()]} ${formatDate(start)}`);
    lines.push(`last active  ${weekdays[last.getDay()]} ${formatDate(last)}`, `size         ${humanSize(entry.sz || 0)}`, `session id   ${id}`);
    if (entry.first_prompt) lines.push('', 'first prompt:', `  ${entry.first_prompt}`);
    if (entry.recent && entry.recent.length) lines.push('', 'recent prompts:', ...entry.recent.map((prompt) => `  • ${prompt}`));
    return `${lines.join('\n')}\n`;
  }

  function run(argv, env = process.env) {
    const [command, ...args] = argv;
    if (command === 'emit') return emit(args, env);
    if (command === 'tree') return tree(args, env);
    if (command === 'hydrate') return hydrate(args, env);
    if (command === 'meta' && args.length) return meta(args[0], env);
    if (command === 'preview' && args.length) return preview(args[0], env);
    throw new Error('harbor-index: invalid command');
  }

  return { run, emitDelta, refreshIndex, buildHomeMap, parseTranscript, projectLabel, migrateEntries, noteChanged, flush };
}

function createHistoryIndexWorker(options = {}) {
  let worker = null;
  let nextId = 1;
  let closed = false;
  const pending = new Map();

  function rejectPending(error) {
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  }

  function ensureWorker() {
    if (closed) throw new Error('history index worker is closed');
    if (worker) return worker;
    // workerData is structured-cloned: a function-valued option (onLog, a test's
    // fs or clock) would throw DataCloneError at spawn, so only plain data crosses.
    const workerOptions = Object.fromEntries(
      Object.entries(options).filter(([, value]) => typeof value !== 'function'),
    );
    worker = new Worker(__filename, {
      workerData: { historyIndexWorker: true, options: workerOptions },
    });
    worker.unref();
    worker.on('message', (message) => {
      // A log line from the worker (a cache write that would not land, say)
      // is forwarded to whoever owns this process's durable log; the worker's
      // own console is stderr, which a shortcut-launched app discards.
      if (message && message.persisted === true) {
        if (typeof options.onPersisted === 'function') options.onPersisted();
        return;
      }
      if (message && typeof message.log === 'string') {
        if (typeof options.onLog === 'function') options.onLog(message.log);
        else console.warn(message.log);
        return;
      }
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (!pending.size && worker) worker.unref();
      if (message.error) {
        const error = new Error(message.error.message);
        error.name = message.error.name || 'Error';
        error.code = message.error.code;
        request.reject(error);
      } else {
        request.resolve(message.result);
      }
    });
    worker.on('error', (error) => rejectPending(error));
    worker.on('exit', (code) => {
      const exited = worker;
      worker = null;
      if (!closed && exited) rejectPending(new Error(`history index worker exited with code ${code}`));
    });
    return worker;
  }

  function request(method, args = []) {
    const target = ensureWorker();
    const id = nextId;
    nextId += 1;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      target.ref();
      target.postMessage({ id, method, args });
    });
  }

  return {
    run: (argv, env = {}) => request('run', [argv, env]),
    buildHomeMap: () => request('buildHomeMap'),
    migrateEntries: (limit) => request('migrateEntries', [limit]),
    noteChanged: (names) => request('noteChanged', [names]),
    emitDelta: (argv, cursor, env = {}) => request('emitDelta', [argv, env, cursor]),
    flush: () => (worker && !closed ? request('flush') : Promise.resolve(false)),
    close: async () => {
      if (closed) return;
      // A pass still waiting for its save interval is written before the
      // thread goes; bounded so a stuck worker cannot hold up a quit.
      if (worker) {
        await Promise.race([
          request('flush').catch(() => false),
          new Promise((resolve) => { const t = setTimeout(resolve, 2000); t.unref?.(); }),
        ]);
      }
      closed = true;
      rejectPending(new Error('history index worker closed'));
      const target = worker;
      worker = null;
      if (target) await target.terminate();
    },
  };
}

module.exports = { CACHE_VERSION, codePointSlice, createHistoryIndex, createHistoryIndexWorker, parseTranscript };

if (!isMainThread && workerData && workerData.historyIndexWorker) {
  // Functions do not cross the worker boundary (workerData is structured
  // clone), so the log seam is re-established here as a message to the parent.
  const index = createHistoryIndex({
    ...(workerData.options || {}),
    log: (line) => parentPort.postMessage({ log: String(line) }),
    onPersisted: () => parentPort.postMessage({ persisted: true }),
  });
  parentPort.on('message', (message) => {
    try {
      let result;
      if (message.method === 'run') {
        const [argv, env] = message.args;
        result = index.run(argv, { ...process.env, ...env });
      } else if (message.method === 'buildHomeMap') {
        result = index.buildHomeMap();
      } else if (message.method === 'migrateEntries') {
        result = index.migrateEntries(...message.args);
      } else if (message.method === 'noteChanged') {
        result = index.noteChanged(...message.args);
      } else if (message.method === 'emitDelta') {
        const [argv, env, cursor] = message.args;
        result = index.emitDelta(argv, cursor, { ...process.env, ...env });
      } else if (message.method === 'flush') {
        result = index.flush();
      } else {
        throw new Error(`unknown history index worker method: ${message.method}`);
      }
      parentPort.postMessage({ id: message.id, result });
    } catch (error) {
      parentPort.postMessage({
        id: message.id,
        error: { name: error.name, message: error.message, code: error.code },
      });
    }
  });
}
