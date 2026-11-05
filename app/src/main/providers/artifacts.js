'use strict';

// Artifact discovery for the Artifacts view: the files agents produced FOR A
// HUMAN TO LOOK AT (HTML reports, images, PDFs, decks, renders), found from
// the session transcripts rather than a filesystem sweep, because a transcript
// names exactly what the session touched while a directory scan cannot tell an
// agent-written report from any other repo file.
//
// A path counts as an artifact when:
// - a transcript inside the scan window mentions it (Write file_path, a Bash
//   command, a tool result echoing the output path; the extraction scans each
//   raw line, so it catches all of those without caring which),
// - it has a viewable extension,
// - it still exists on disk, and
// - its mtime is not older than the mentioning session's start: a session that
//   merely READ an old image does not make that image its output, while a file
//   it wrote (even one Pat hand-edited later) stays.
//
// Results carry the owning session id and cwd so the renderer can group them
// by project exactly like the rail groups sessions.
//
// CODEX (2026-10-15): the view was wired to Claude's projects dir alone, so a
// codex session's report or render never appeared. Codex rollouts are read
// STRUCTURALLY, never by the raw line regex: a codex line embeds whole command
// outputs and file bodies, so "a path appears somewhere" is far fuzzier there
// than in a Claude transcript. What counts is what codex itself records as
// written: a FileChange item's add/update paths (and an update's move_path),
// an apply_patch call's "*** Add File:" / "*** Update File:" / "*** Move to:"
// targets (relative ones resolved against the turn's cwd), an image
// generation's savedPath, and every file under <codex home>/generated_images/
// <thread id>/, which is codex's own output store. CommandExecution writes are
// deliberately NOT mined (too fuzzy). The same viewable-extension, existence,
// exclusion and not-older-than-the-session rules then apply unchanged.
// Rollouts codex has compressed (.jsonl.zst, its cold and archived sessions)
// are decompressed in the stream (codex-rollout-files.js, the zstd reader the
// rail uses too); they are immutable, so one parse is cached.
//
// The walk is cheap on purpose: it runs every 60 s
// while the Files view is open, and listing + stat'ing every rollout codex
// ever wrote each time is the cost to avoid. A sessions/YYYY/MM/DD folder whose date ends before the window is
// skipped by NAME, except on a full sweep every FULL_SWEEP_MS (a session
// resumed weeks later appends to its OLD day folder's rollout, and the sweep
// is what finds it again); a rollout already in the window stays checked on
// every pass whatever its folder. Folder listings are cached by the folder's
// mtime, so an unchanged folder is one stat, not a readdir.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const {
  CODEX_ID_RE, zstdAvailable, isCompressed, createRolloutReadStream,
} = require('./codex-rollout-files.js');

const DEFAULT_ROOTS = [path.join(os.homedir(), '.claude', 'projects')];
const DAY_MS = 24 * 60 * 60 * 1000;
const FULL_SWEEP_MS = 10 * 60 * 1000;
const DEFAULT_CACHE = path.join(os.homedir(), '.cache', 'harbor', 'artifacts-index.json');
const WINDOW_DAYS = 14;
const MENTION_GRACE_MS = 5 * 60 * 1000;
const MAX_CANDIDATES_PER_FILE = 200;
const MAX_ARTIFACTS = 500;

const EXT_KIND = {
  html: 'html',
  htm: 'html',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  svg: 'image',
  pdf: 'pdf',
  mp4: 'video',
  webm: 'video',
};

const EXT_RE = 'html?|png|jpe?g|gif|webp|svg|pdf|mp4|webm';
// Three shapes cover how a POSIX path appears in transcript JSON: bare (no
// spaces), a whole JSON string that IS the path (Write's file_path; spaces
// fine), and a single-quoted path inside a shell command. '.' never occurs in
// base64, so embedded image payloads can never fake an extension match.
//
// THE BARE SHAPE IS TOKENIZED, NOT MATCHED IN ONE REGEX (2026-10-21 audit). It
// was `(?:\/[^/\0"'\\\s]+)+\.(ext)\b` run over the raw line, and a run of
// segments with no extension made it rescan the rest of the run from every
// later '/': quadratic. A 1.3 MB slash-rich base64 image record (one pasted
// screenshot) held the event loop for 18.5 s and found nothing, freezing
// harbor-server's sockets and daemon links with it. The same answer comes in
// linear time: find each maximal '/segment' chain once, then keep it up to its
// LAST '.ext' (the old greedy match), because a retry from a later '/' inside
// a chain can only reach extensions the first attempt already saw.
// test/providers/artifacts.test.js pins both shapes against the old regex.
const BARE_CHAIN_RE = /(?:\/[^\/\0"'\\\s]+)+/g;
const EXT_AT_RE = new RegExp(`\\.(?:${EXT_RE})\\b`, 'iy');
const JSON_STRING_PATH_RE = new RegExp(`"(\\/(?:[^"\\\\]|\\\\.){2,400}?\\.(?:${EXT_RE}))"`, 'gi');
const QUOTED_PATH_RE = new RegExp(`'(\\/[^']{2,400}?\\.(?:${EXT_RE}))'`, 'gi');
// The same two shapes for a DRIVE-LETTERED path, which is what Write's
// file_path actually records on Windows. Without these the primary signal this
// module is built on is invisible on a Windows host: measured against the real
// 14-day corpus on 2026-08-13, POSIX-only extraction found 72 files that exist
// on disk while the drive-lettered shapes found 610. The handful that did
// arrive were an accident of Node resolving a leading '/' against the current
// drive, which is also why they were stored drive-less and disagreed with
// every consumer downstream.
//
// Both arrive JSON-ESCAPED in a .jsonl line ('C:\\dev\\x.png'), so the match is
// unescaped through decodeJsonString exactly like the POSIX JSON shape. The
// quoted form allows spaces because the quotes bound it; the embedded form
// (a Bash command) does not, for the same reason BARE_PATH_RE does not.
const WIN_JSON_PATH_RE = new RegExp(`"([A-Za-z]:(?:\\\\\\\\|/)(?:[^"\\\\]|\\\\.){2,400}?\\.(?:${EXT_RE}))"`, 'gi');
// Bounded at 400 like every sibling shape: unbounded, each 'x:/' (every
// "https://") rescanned to the end of its run, the bare shape's trap again.
const WIN_BARE_PATH_RE = new RegExp(`[A-Za-z]:(?:\\\\\\\\|/)(?:[^"\\s\\\\]|\\\\\\\\){1,400}?\\.(?:${EXT_RE})\\b`, 'gi');
// The missing Windows twin of QUOTED_PATH_RE (live-caught 2026-08-30: a
// session in C:\dev\Surveys\Exit Interviews delivered its PDFs via
// single-quoted PowerShell paths, and the whole project was invisible in the
// Files view). A single-quoted drive-lettered path inside a shell command
// allows spaces because the quotes bound it; the double-quoted embedded form
// arrives with its quotes JSON-escaped (\" ... \") and is covered too. Both
// unescape through decodeJsonString so the doubled backslashes collapse.
const WIN_QUOTED_PATH_RE = new RegExp(`'([A-Za-z]:(?:\\\\\\\\|/)[^']{2,400}?\\.(?:${EXT_RE}))'`, 'gi');
const WIN_DQUOTED_PATH_RE = new RegExp(`\\\\"([A-Za-z]:(?:\\\\\\\\|/)(?:[^"\\\\]|\\\\\\\\.){2,400}?\\.(?:${EXT_RE}))\\\\"`, 'gi');
const CWD_RE = /"cwd"\s*:\s*"((?:[^"\\]|\\.)+)"/;
const TIMESTAMP_RE = /"timestamp"\s*:\s*"([^"]+)"/;

// Paths that are never a deliverable: build output, dependency trees, VCS
// internals, cache stores (pasted-screenshot inputs live in ~/.cache/harbor),
// session scratchpads, and the transcript store itself.
const EXCLUDED_SEGMENTS = ['/node_modules/', '/.git/', '/dist/', '/.cache/'];
const EXCLUDED_PREFIXES = ['/tmp/claude-', '/proc/', '/sys/'];
// A session scratchpad, in the shape a Windows host writes it:
// <temp>/claude/<project-slug>/<session-id>/scratchpad/. The POSIX spelling of
// the same rule is the '/tmp/claude-' prefix above. Both name the directory an
// agent is told to put throwaway files in, so neither ever holds a deliverable.
// This is the SAME exclusion, not a new one; it was simply never ported, and on
// the real corpus it is the single largest source of noise (probe renders,
// intermediate crops), enough to crowd real work out of the 500-artifact cap.
const WIN_SCRATCHPAD_RE = /\/claude\/[^/]+\/[^/]+\/scratchpad\//i;

function artifactKind(candidate) {
  const ext = path.extname(candidate).slice(1).toLowerCase();
  return EXT_KIND[ext] || null;
}

function isExcluded(candidate) {
  // Compared in the '/' spelling so one rule covers both separators: a Windows
  // path is excluded for containing node_modules exactly like a POSIX one.
  const value = String(candidate).replace(/\\/g, '/');
  if (EXCLUDED_SEGMENTS.some((segment) => value.includes(segment))) return true;
  if (/\/\.claude[^/]*\//.test(value)) return true;
  if (WIN_SCRATCHPAD_RE.test(value)) return true;
  return EXCLUDED_PREFIXES.some((prefix) => value.startsWith(prefix));
}

// THE SERVE ALLOWLIST, and the one canonical spelling of an artifact path:
// absolute, one separator flavour. The index, this allowlist and the URL
// handler all speak it, because they used to speak three different ones. A
// transcript can name the same file as 'C:\dev\x.png' and '/dev/x.png' (Node
// resolves a leading '/' against the current drive), and until both collapsed
// to one key this compared a path.normalize'd candidate against a set holding
// the raw forward-slash spelling: it answered false for every artifact on
// Windows, so the scheme 403'd every request and artifacts:thumb refused
// before generating a single preview.
//
// PARAMETERISED ON THE PATH FLAVOUR ON PURPOSE. This decision is the one that
// broke: it answered false for every artifact on Windows, and no Linux run
// could have caught it, because both the rule and its spec asked the HOST's
// path module. The e2e gate is Linux-only by construction (xvfb, a session bus,
// a real pty), so "the gate would catch it next time" was never true for a
// platform-shaped bug. Taking the flavour as an argument makes the Windows
// behaviour assertable FROM LINUX, which is the same shape project-label.cjs
// was rewritten into on 2026-08-12 after posix-only specs lied on a Windows
// runner. Production passes the native `path` and behaves exactly as before.
function createServeAllowlist(pathImpl = path) {
  let files = new Set();
  let dirs = new Set();

  const canonical = (value) => {
    const raw = String(value == null ? '' : value);
    if (!raw || raw.includes('\0')) return null;
    return pathImpl.resolve(raw);
  };

  return {
    canonical,
    // Rebuilt from each scan's results, so the allowlist and the index are the
    // same list canonicalised the same way and cannot disagree.
    set(paths) {
      files = new Set();
      dirs = new Set();
      for (const entry of paths) {
        const resolved = canonical(entry);
        if (!resolved) continue;
        files.add(resolved);
        dirs.add(pathImpl.dirname(resolved));
      }
    },
    // An indexed artifact, or a sibling asset beside one (a report's
    // ./chart.png). Any equivalent SPELLING of either is accepted, because a
    // URL round trip hands this the '/' form of a native path.
    allows(candidate) {
      const normalized = canonical(candidate);
      if (!normalized) return false;
      if (files.has(normalized)) return true;
      for (const dir of dirs) {
        if (normalized.startsWith(`${dir}${pathImpl.sep}`)) return true;
      }
      return false;
    },
  };
}

function decodeJsonString(raw) {
  try { return JSON.parse(`"${raw}"`); } catch { return null; }
}

// The bare POSIX shape, in order, exactly as the old single regex matched it
// (see BARE_CHAIN_RE). A chain's match ends at its rightmost '.ext' whose '.'
// follows a segment character, never a '/'.
function barePaths(text) {
  const out = [];
  for (const [chain] of text.matchAll(BARE_CHAIN_RE)) {
    for (let dot = chain.lastIndexOf('.'); dot > 0; dot = chain.lastIndexOf('.', dot - 1)) {
      if (chain[dot - 1] === '/') continue;
      EXT_AT_RE.lastIndex = dot;
      const ext = EXT_AT_RE.exec(chain);
      if (ext) { out.push(chain.slice(0, dot + ext[0].length)); break; }
    }
  }
  return out;
}

// A run this long of nothing but base64 alphabet is a payload (a pasted image,
// a PDF, a base64 dump), never a path: a real path breaks on '.', '-', '_', a
// space or a drive colon long before 1 KiB. Blanking it keeps every pattern
// below off image data entirely; one linear pass, no regex.
const BLOB_RUN = 1024;
function isBase64Code(code) {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57)
    || code === 43 || code === 47 || code === 61;
}
function withoutBlobs(line) {
  if (line.length < BLOB_RUN) return line;
  let out = '';
  let kept = 0;
  let runStart = -1;
  for (let i = 0; i <= line.length; i += 1) {
    if (i < line.length && isBase64Code(line.charCodeAt(i))) {
      if (runStart < 0) runStart = i;
      continue;
    }
    if (runStart >= 0 && i - runStart >= BLOB_RUN) {
      out += `${line.slice(kept, runStart)} `;
      kept = i;
    }
    runStart = -1;
  }
  return kept === 0 ? line : out + line.slice(kept);
}

// All artifact-shaped absolute paths in one transcript line. The output is the
// same as before the 2026-10-21 rework for every real path (the bare shape is
// an exact rewrite; only a 1 KiB extensionless base64-alphabet run or a
// 400-character Windows path differ), so the candidate cache stays valid and
// CACHE_VERSION is deliberately not bumped: a bump would re-parse 14 days of
// transcripts to reproduce the answer already cached.
function extractCandidates(rawLine) {
  const line = withoutBlobs(rawLine);
  const found = new Set();
  for (const candidate of barePaths(line)) found.add(candidate);
  for (const match of line.matchAll(JSON_STRING_PATH_RE)) {
    const decoded = decodeJsonString(match[1]);
    if (decoded && decoded.startsWith('/')) found.add(decoded);
  }
  for (const match of line.matchAll(QUOTED_PATH_RE)) found.add(match[1]);
  for (const match of line.matchAll(WIN_JSON_PATH_RE)) {
    const decoded = decodeJsonString(match[1]);
    if (decoded) found.add(decoded);
  }
  for (const match of line.matchAll(WIN_BARE_PATH_RE)) {
    const decoded = decodeJsonString(match[0]);
    if (decoded) found.add(decoded);
  }
  for (const match of line.matchAll(WIN_QUOTED_PATH_RE)) {
    const decoded = decodeJsonString(match[1]);
    if (decoded) found.add(decoded);
  }
  for (const match of line.matchAll(WIN_DQUOTED_PATH_RE)) {
    const decoded = decodeJsonString(match[1]);
    if (decoded) found.add(decoded);
  }
  const all = [...found].filter((candidate) => artifactKind(candidate) && !isExcluded(candidate));
  // A spaced path also yields its tail as a bare-regex fragment ("Foo
  // Bar/report.html" -> "/report.html"); a candidate that is a strict suffix
  // of another is that fragment, never a real second file.
  return all.filter((candidate) => !all.some((other) => other !== candidate && other.endsWith(candidate)));
}

// Transcripts are APPEND-ONLY, and the hot ones are enormous: a live session's
// JSONL grows past 100MB in a day of orchestration, and re-reading all of it
// on every refresh is what turned the Files view into a convoy (live-caught
// 2026-08-22: each collection re-parsed every hot transcript end to end, the
// event loop and disk saturated, and 5-second polls piled assemblies on top
// until the view starved for minutes). parsedBytes records the byte offset of
// the last COMPLETE line consumed; a later parse resumes there and touches
// only the appended tail, carrying the prior candidates/cwd/startMs forward.
// Splitting buffers at 0x0A is UTF-8-safe (a multibyte sequence never contains
// it), and the partial trailing line is deliberately left uncounted so the
// next pass re-reads it whole.
async function parseTranscript(filePath, parseOptions = {}) {
  const fromByte = Number.isFinite(parseOptions.fromByte) && parseOptions.fromByte > 0
    ? parseOptions.fromByte : 0;
  const prior = parseOptions.prior || null;
  const candidates = new Set(prior ? prior.candidates || [] : []);
  let cwd = prior ? prior.cwd ?? null : null;
  let startMs = prior ? prior.startMs ?? null : null;
  let consumed = fromByte;
  let carry = Buffer.alloc(0);
  const takeLine = (line) => {
    if (!cwd) {
      const match = line.match(CWD_RE);
      if (match) cwd = decodeJsonString(match[1]);
    }
    if (startMs === null) {
      const match = line.match(TIMESTAMP_RE);
      if (match) {
        const parsed = Date.parse(match[1]);
        if (Number.isFinite(parsed)) startMs = parsed;
      }
    }
    if (candidates.size < MAX_CANDIDATES_PER_FILE) {
      for (const candidate of extractCandidates(line)) candidates.add(candidate);
    }
  };
  const stream = fs.createReadStream(filePath, fromByte ? { start: fromByte } : {});
  try {
    for await (const chunk of stream) {
      const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      const lastNl = buf.lastIndexOf(0x0A);
      if (lastNl === -1) { carry = buf; continue; }
      const complete = buf.subarray(0, lastNl + 1);
      carry = buf.subarray(lastNl + 1);
      consumed += complete.length;
      for (const line of complete.toString('utf8').split('\n')) {
        if (line) takeLine(line.endsWith('\r') ? line.slice(0, -1) : line);
      }
    }
  } finally {
    stream.destroy();
  }
  return { candidates: [...candidates], cwd, startMs, parsedBytes: consumed };
}

// Codex homes the Files view reads: every configured codex profile's home, else
// an inherited CODEX_HOME, else ~/.codex. The same order codexHomes()
// (codex-model-catalog.js) and defaultCodexHome() (accounts.js) use, which is
// bin/ai's: with no profile, codex itself writes under CODEX_HOME.
function codexHomesFromProfiles(profiles, homedir = os.homedir(), { env = process.env } = {}) {
  const configured = (profiles || [])
    .filter((profile) => profile?.provider === 'codex' && profile.configHome)
    .map((profile) => profile.configHome);
  return configured.length ? [...new Set(configured)] : [env.CODEX_HOME || path.join(homedir, '.codex')];
}

// The ms a sessions/ date folder's days END, from its path parts below
// sessions/ ([YYYY], [YYYY, MM] or [YYYY, MM, DD]); null when the names are
// not a date (such a folder is always walked).
function dateFolderEndMs(parts) {
  const [y, m, d] = parts.map((part) => (/^\d+$/.test(part) ? Number(part) : NaN));
  if (!Number.isFinite(y) || parts.length > 3) return null;
  if (parts.length === 1) return Date.UTC(y + 1, 0, 1);
  if (!Number.isFinite(m) || m < 1 || m > 12) return null;
  if (parts.length === 2) return Date.UTC(y, m, 1);
  if (!Number.isFinite(d) || d < 1 || d > 31) return null;
  return Date.UTC(y, m - 1, d + 1);
}

// The paths ONE codex rollout record says were written. `cwd` resolves an
// apply_patch path given relative to the turn. Pure, so every shape is testable.
function codexRecordOutputs(record, cwd) {
  const out = [];
  const payload = record?.payload;
  if (!payload || typeof payload !== 'object') return out;
  const add = (candidate) => {
    if (typeof candidate !== 'string' || !candidate) return;
    let value = candidate.trim();
    if (!path.isAbsolute(value) && !/^[A-Za-z]:[\\/]/.test(value)) {
      if (!cwd) return;
      value = path.resolve(cwd, value);
    }
    if (artifactKind(value) && !isExcluded(value)) out.push(value);
  };
  if (record.type === 'event_msg' && payload.type === 'item_completed') {
    const item = payload.item || {};
    if (item.type === 'FileChange' && item.changes && typeof item.changes === 'object') {
      for (const [file, change] of Object.entries(item.changes)) {
        if (change?.type === 'delete') continue;
        add(change?.move_path || file);
      }
    }
    // Image generation (an Extension item) names the file it saved.
    if (item.type === 'Extension' && typeof item.savedPath === 'string') add(item.savedPath);
  }
  if (record.type === 'response_item' && payload.type === 'custom_tool_call' && payload.name === 'apply_patch') {
    for (const match of String(payload.input || '').matchAll(/^\*\*\* (?:Add File|Update File|Move to): (.+?)\s*$/gm)) {
      // An update that also moves names its source first and its target after;
      // only the target still exists, and the existence check drops the source.
      add(match[1]);
    }
  }
  return out;
}

// Cheap pre-filter: only these records can carry an output or the facts the
// parse needs, and a rollout line can be megabytes (session_meta embeds the
// whole system prompt), so the rest are never JSON.parsed.
const CODEX_INTERESTING_RE = /"(?:session_meta|turn_context|FileChange|apply_patch|Extension)"/;

async function parseCodexRollout(filePath, parseOptions = {}) {
  const compressed = isCompressed(filePath);
  // A compressed rollout is immutable and cannot be resumed mid-stream.
  const fromByte = !compressed && Number.isFinite(parseOptions.fromByte) && parseOptions.fromByte > 0
    ? parseOptions.fromByte : 0;
  const prior = fromByte ? parseOptions.prior || null : null;
  const candidates = new Set(prior ? prior.candidates || [] : []);
  let cwd = prior ? prior.cwd ?? null : null;
  let turnCwd = prior ? prior.turnCwd ?? cwd : null;
  let startMs = prior ? prior.startMs ?? null : null;
  let consumed = fromByte;
  const takeLine = (line) => {
    if (!CODEX_INTERESTING_RE.test(line)) return;
    let record;
    try { record = JSON.parse(line); } catch { return; }
    if (record?.type === 'session_meta') {
      cwd = cwd || record.payload?.cwd || null;
      turnCwd = turnCwd || cwd;
      if (startMs === null) {
        const parsed = Date.parse(record.payload?.timestamp || record.timestamp);
        if (Number.isFinite(parsed)) startMs = parsed;
      }
      return;
    }
    if (record?.type === 'turn_context') {
      if (record.payload?.cwd) turnCwd = record.payload.cwd;
      return;
    }
    if (candidates.size >= MAX_CANDIDATES_PER_FILE) return;
    for (const candidate of codexRecordOutputs(record, turnCwd || cwd)) candidates.add(candidate);
  };
  if (compressed) {
    // Throws when this runtime cannot decompress zstd; destroying the stream
    // releases the file too.
    const input = createRolloutReadStream(filePath);
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) if (line) takeLine(line);
    } finally {
      lines.close();
      input.destroy();
    }
    return { candidates: [...candidates], cwd, turnCwd, startMs, parsedBytes: 0 };
  }
  let carry = Buffer.alloc(0);
  const stream = fs.createReadStream(filePath, fromByte ? { start: fromByte } : {});
  try {
    for await (const chunk of stream) {
      const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      const lastNl = buf.lastIndexOf(0x0A);
      if (lastNl === -1) { carry = buf; continue; }
      const complete = buf.subarray(0, lastNl + 1);
      carry = buf.subarray(lastNl + 1);
      consumed += complete.length;
      for (const line of complete.toString('utf8').split('\n')) {
        if (line) takeLine(line.endsWith('\r') ? line.slice(0, -1) : line);
      }
    }
  } finally {
    stream.destroy();
  }
  return { candidates: [...candidates], cwd, turnCwd, startMs, parsedBytes: consumed };
}

function createArtifactsProvider(options = {}) {
  // The env vars OUTRANK the composed options: they are the harness/operator
  // escape, same contract as HARBOR_CONTEXT_DIR and HARBOR_MODEL_CACHE_FILE.
  // Gate-caught 2026-07-28: the config-store work made index.js pass explicit
  // roots/cacheFile, which silently killed both overrides, and the ISOLATED
  // e2e app scanned the real transcript roots and wrote the real cache.
  const roots = (process.env.HARBOR_ARTIFACTS_ROOTS
    ? process.env.HARBOR_ARTIFACTS_ROOTS.split(path.delimiter).filter(Boolean)
    : null)
    || options.roots
    || DEFAULT_ROOTS;
  // Codex homes follow the same isolation contract: the env var outranks, and a
  // harness that relocated the Claude roots (env or an explicit `roots`) gets NO
  // codex default, so an isolated run can never read the real ~/.codex.
  // `codexHomes` may be a FUNCTION, asked on every collection: the composition
  // root passes one so a profile saved after launch (the wizard reassigns the
  // config) is read without a restart.
  const pinnedCodexHomes = process.env.HARBOR_ARTIFACTS_CODEX_HOMES
    ? process.env.HARBOR_ARTIFACTS_CODEX_HOMES.split(path.delimiter).filter(Boolean)
    : process.env.HARBOR_ARTIFACTS_ROOTS ? []
      : options.codexHomes ? null
        : options.roots ? [] : codexHomesFromProfiles([]);
  const codexHomes = () => {
    if (pinnedCodexHomes) return pinnedCodexHomes;
    if (typeof options.codexHomes !== 'function') return options.codexHomes;
    try {
      const homes = options.codexHomes();
      return Array.isArray(homes) ? homes.filter(Boolean) : [];
    } catch { return []; }
  };
  const fullSweepMs = options.fullSweepMs ?? FULL_SWEEP_MS;
  const cacheFile = process.env.HARBOR_ARTIFACTS_CACHE || options.cacheFile || DEFAULT_CACHE;
  const windowDays = options.windowDays ?? WINDOW_DAYS;
  const nowFn = options.now || Date.now;

  // BUMP THIS WHENEVER extractCandidates CHANGES. The cache is keyed by each
  // transcript's size+mtime, so an unchanged transcript is never re-parsed:
  // without a version bump a new extraction rule would only ever apply to
  // sessions written after it shipped, and the fix would look like it did
  // nothing on exactly the history the user is looking at. (v2: drive-lettered
  // Windows paths.)
  // v3: WIN_QUOTED_PATH_RE / WIN_DQUOTED_PATH_RE (spaced Windows paths inside
  // shell commands). The cache is keyed by transcript size+mtime, so without
  // this bump the new shapes would apply only to sessions written after they
  // shipped and the fix would look inert on exactly the history being viewed.
  // (2026-10-21: the linear rewrite kept the output, so no bump; see
  // extractCandidates.)
  // v4: codex rollouts and generated_images (entries now carry provider and
  // sessionId).
  const CACHE_VERSION = 4;
  let cache = { version: CACHE_VERSION, files: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (raw?.version === CACHE_VERSION && raw.files) cache = raw;
  } catch { /* cold start */ }

  let lastArtifacts = [];
  // Injectable so a spec can drive the win32 flavour from a Linux runner; the
  // default is the native path module, so production is unchanged.
  const allowlist = createServeAllowlist(options.pathImpl || path);
  let scanPromise = null;
  let assemblePromise = null;
  let lastScanMs = 0;
  // dir -> { mtimeMs, entries: [{ name, isDir }] }: a folder is re-read only
  // when its mtime moved (a file added, removed or renamed in it).
  const dirListings = new Map();
  let lastSweepMs = -Infinity;
  const listDir = async (dir) => {
    let stat;
    try { stat = await fsp.stat(dir); } catch { dirListings.delete(dir); return null; }
    const hit = dirListings.get(dir);
    if (hit && hit.mtimeMs === stat.mtimeMs) return hit.entries;
    let dirents;
    try { dirents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return null; }
    const entries = dirents.map((dirent) => ({ name: dirent.name, isDir: dirent.isDirectory() }));
    dirListings.set(dir, { mtimeMs: stat.mtimeMs, entries });
    return entries;
  };

  // Each transcript with the provider that parses it and the session it
  // belongs to (a codex rollout's id is the thread id in its file name).
  async function listTranscripts() {
    const out = [];
    for (const root of roots) {
      let projectDirs = [];
      try { projectDirs = await fsp.readdir(root, { withFileTypes: true }); } catch { continue; }
      for (const dirent of projectDirs) {
        if (!dirent.isDirectory()) continue;
        const dir = path.join(root, dirent.name);
        let entries = [];
        try { entries = await fsp.readdir(dir); } catch { continue; }
        for (const name of entries) {
          if (name.endsWith('.jsonl')) out.push({ file: path.join(dir, name), provider: 'claude', sessionId: path.basename(name, '.jsonl') });
        }
      }
    }
    // sessions/YYYY/MM/DD/ and archived_sessions/ (flat today; walked to the
    // same depth in case codex dates it too). Under sessions/, a date folder
    // that ends before the window (a day of slack for time zones) is skipped
    // unless this pass is a full sweep.
    const now = nowFn();
    const sweep = now - lastSweepMs >= fullSweepMs;
    const oldBefore = now - windowDays * DAY_MS - DAY_MS;
    const seen = new Set();
    const walkCodex = async (dir, depth, dated = null) => {
      const entries = await listDir(dir);
      if (!entries) return;
      for (const { name, isDir } of entries) {
        const full = path.join(dir, name);
        if (isDir) {
          if (depth <= 0) continue;
          const parts = dated ? [...dated, name] : null;
          const endMs = parts ? dateFolderEndMs(parts) : null;
          if (!sweep && endMs !== null && endMs < oldBefore) continue;
          await walkCodex(full, depth - 1, parts);
          continue;
        }
        const id = name.match(CODEX_ID_RE)?.[1];
        if (!id) continue;
        if (isCompressed(name) && !zstdAvailable()) continue;
        seen.add(full);
        out.push({ file: full, provider: 'codex', sessionId: id });
      }
    };
    for (const home of codexHomes()) {
      await walkCodex(path.join(home, 'sessions'), 3, []);
      await walkCodex(path.join(home, 'archived_sessions'), 3);
    }
    // A rollout the last collection found inside the window is checked again
    // whatever folder it sits in (collectFiles drops it once it ages out).
    if (!sweep) {
      for (const [file, entry] of Object.entries(cache.files)) {
        if (entry.provider !== 'codex' || seen.has(file) || file.startsWith('codex-images:')) continue;
        out.push({ file, provider: 'codex', sessionId: entry.sessionId || file.match(CODEX_ID_RE)?.[1] || null });
      }
    } else {
      lastSweepMs = now;
    }
    return out;
  }

  // <codex home>/generated_images/<thread id>/<file>: codex's own image output
  // store. Owned by that thread; inside the window by the FILE's mtime.
  async function listGeneratedImages(cutoff) {
    const out = [];
    for (const home of codexHomes()) {
      const root = path.join(home, 'generated_images');
      let threads = [];
      try { threads = await fsp.readdir(root, { withFileTypes: true }); } catch { continue; }
      for (const thread of threads) {
        if (!thread.isDirectory()) continue;
        const dir = path.join(root, thread.name);
        let names = [];
        try { names = await fsp.readdir(dir); } catch { continue; }
        const candidates = [];
        let newest = 0;
        for (const name of names) {
          const file = path.join(dir, name);
          if (!artifactKind(file)) continue;
          let stat;
          try { stat = await fsp.stat(file); } catch { continue; }
          if (!stat.isFile() || stat.mtimeMs < cutoff) continue;
          candidates.push(file);
          newest = Math.max(newest, stat.mtimeMs);
        }
        if (candidates.length) {
          out.push({ key: `codex-images:${dir}`, entry: { provider: 'codex', sessionId: thread.name, candidates, cwd: null, startMs: null, mtimeMs: newest } });
        }
      }
    }
    return out;
  }

  // The EXPENSIVE half: walk transcripts, re-parse only the changed ones, and
  // persist the candidate cache. This is what made the Files view sit on
  // "Scanning transcripts" for minutes (live-caught 2026-08-22): a poll-driven
  // list() re-parsed every hot transcript before returning ANYTHING, and a day
  // of orchestration made the hot set enormous. Collection now runs in the
  // background at most once per staleMs; nobody waits on it unless there has
  // never been a cache at all.
  async function collectFiles() {
    const now = nowFn();
    const cutoff = now - windowDays * 24 * 60 * 60 * 1000;
    const transcripts = await listTranscripts();
    const nextFiles = {};
    for (const { file: transcriptPath, provider, sessionId } of transcripts) {
      let stat;
      try { stat = await fsp.stat(transcriptPath); } catch { continue; }
      if (stat.mtimeMs < cutoff) continue;
      const cached = cache.files[transcriptPath];
      let entry;
      if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
        entry = cached;
      } else {
        // A grown file resumes from its last complete line instead of
        // re-reading the whole thing (transcripts are append-only; a file that
        // SHRANK was rewritten and gets the full parse). Entries from before
        // parsedBytes existed lack the field and take one full parse to earn it.
        const resumable = cached && Number.isFinite(cached.parsedBytes)
          && cached.parsedBytes > 0 && stat.size >= cached.parsedBytes;
        const parse = provider === 'codex' ? parseCodexRollout : parseTranscript;
        const parsed = await parse(
          transcriptPath,
          resumable ? { fromByte: cached.parsedBytes, prior: cached } : {},
        ).catch(() => null);
        if (!parsed) continue;
        entry = { size: stat.size, mtimeMs: stat.mtimeMs, provider, sessionId, ...parsed };
      }
      nextFiles[transcriptPath] = entry;
    }
    for (const { key, entry } of await listGeneratedImages(cutoff)) nextFiles[key] = entry;
    cache = { version: CACHE_VERSION, files: nextFiles };
    lastScanMs = now;
    try {
      await fsp.mkdir(path.dirname(cacheFile), { recursive: true });
      await fsp.writeFile(cacheFile, JSON.stringify(cache));
    } catch { /* cache is an optimization, never a failure */ }
  }

  // The CHEAP half: candidates -> artifacts. Runs on EVERY list() call against
  // whatever candidate set the cache holds, so existence is always verified
  // fresh (a deleted artifact drops immediately) while the parse refresh above
  // lands for a later poll. On the real corpus this is a few thousand stats,
  // well under a second.
  async function assembleArtifacts() {
    // path -> { sessionId, cwd, transcriptMtimeMs, startMs }
    const byArtifactPath = new Map();
    // A generated image's store names only its thread; the rollout knows the cwd.
    const codexCwd = new Map();
    for (const entry of Object.values(cache.files)) {
      if (entry.provider === 'codex' && entry.cwd && entry.sessionId) codexCwd.set(entry.sessionId, entry.cwd);
    }
    for (const [transcriptPath, entry] of Object.entries(cache.files)) {
      const sessionId = entry.sessionId || path.basename(transcriptPath, '.jsonl');
      const provider = entry.provider || 'claude';
      for (const raw of entry.candidates || []) {
        // Keyed by the CANONICAL path, so the two spellings of one file
        // ('C:\dev\x.png' from Write, '/dev/x.png' from a bare-regex match on
        // the same line) collapse into a single artifact instead of two cards
        // pointing at the same bytes.
        const candidate = allowlist.canonical(raw);
        if (!candidate) continue;
        const prior = byArtifactPath.get(candidate);
        if (prior && prior.transcriptMtimeMs >= entry.mtimeMs) continue;
        byArtifactPath.set(candidate, {
          sessionId,
          provider,
          cwd: entry.cwd || (provider === 'codex' ? codexCwd.get(sessionId) : null) || null,
          transcriptMtimeMs: entry.mtimeMs,
          startMs: entry.startMs ?? null,
        });
      }
    }

    const artifacts = [];
    for (const [artifactPath, mention] of byArtifactPath) {
      let stat;
      try { stat = await fsp.stat(artifactPath); } catch { continue; }
      if (!stat.isFile()) continue;
      // Older than the mentioning session started: the session read it, it
      // did not produce it.
      if (mention.startMs !== null && stat.mtimeMs < mention.startMs - MENTION_GRACE_MS) continue;
      artifacts.push({
        path: artifactPath,
        kind: artifactKind(artifactPath),
        name: path.basename(artifactPath),
        bytes: stat.size,
        mtimeMs: stat.mtimeMs,
        sessionId: mention.sessionId,
        provider: mention.provider,
        cwd: mention.cwd,
      });
    }
    artifacts.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const bounded = artifacts.slice(0, MAX_ARTIFACTS);
    lastArtifacts = bounded;
    allowlist.set(bounded.map((a) => a.path));
    return bounded;
  }

  return {
    // Serve stale-while-revalidate: assembly (with fresh existence checks) is
    // answered NOW from the cached candidate set, and the parse refresh runs
    // single-flight in the background at most once per staleMs. Only a
    // first-ever run with no disk cache has nothing to serve and waits.
    async list() {
      const staleMs = options.staleMs ?? 60_000;
      const kickCollect = () => {
        if (!scanPromise && nowFn() - lastScanMs > staleMs) {
          scanPromise = collectFiles()
            .catch(() => {})
            .finally(() => { scanPromise = null; });
        }
        return scanPromise;
      };
      // TRUE cold start (no disk cache at all): there is nothing to assemble
      // until one collection lands, so this one path waits.
      if (Object.keys(cache.files).length === 0) {
        const first = kickCollect();
        if (first) await first;
      }
      // SINGLE-FLIGHT assembly, ANSWERED BEFORE any collection is kicked: the
      // drive rig measured 16.5s to first cards when a catch-up collection got
      // started first and the assembly crawled through the contended loop
      // (2026-08-22). Alone, assembly is a subsecond stat sweep. Sequential
      // callers still each get a fresh pass, so a deleted artifact drops on
      // the very next call; only OVERLAPPING callers share one.
      if (!assemblePromise) {
        assemblePromise = assembleArtifacts().finally(() => { assemblePromise = null; });
      }
      const artifacts = await assemblePromise;
      kickCollect();
      // Files need the labels of their own source sessions, including machine
      // runs absent from the rail. Resolve only this request's artifact ids.
      const labeled = options.getSessionLabel ? artifacts.map((artifact) => {
        const session = options.getSessionLabel(artifact.sessionId);
        return { ...artifact, sessionTitle: session?.title || null, sessionProject: session?.project || null };
      }) : artifacts;
      return { ok: true, artifacts: labeled, scannedAt: lastScanMs };
    },
    // The artifact protocol serves ONLY indexed files and their sibling assets
    // (a report's ./chart.png), never an arbitrary path.
    // Canonicalised the SAME way the index was, by the same object, so the two
    // cannot disagree the way they did on Windows until 2026-08-13.
    isServable: (candidate) => allowlist.allows(candidate),
    // One collection now (tests and measurement; list() schedules its own).
    _collect: () => collectFiles(),
  };
}

module.exports = {
  createArtifactsProvider,
  createServeAllowlist,
  codexHomesFromProfiles,
  codexRecordOutputs,
  parseCodexRollout,
  extractCandidates,
  barePaths,
  artifactKind,
  isExcluded,
  WINDOW_DAYS,
};
