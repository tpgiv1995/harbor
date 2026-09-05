'use strict';

// Artifact discovery for the Artifacts view: the files agents produced FOR A
// HUMAN TO LOOK AT (HTML reports, images, PDFs, decks, renders), found from
// the session transcripts rather than a filesystem sweep, because a transcript
// names exactly what the session touched while a directory scan cannot tell an
// agent-written report from any other repo file.
//
// A path counts as an artifact when:
// - a transcript inside the scan window mentions it (Write file_path, a Bash
//   command, a tool result echoing the output path; the extraction is a raw
//   regex over each line, so it catches all of those without caring which),
// - it has a viewable extension,
// - it still exists on disk, and
// - its mtime is not older than the mentioning session's start: a session that
//   merely READ an old image does not make that image its output, while a file
//   it wrote (even one Pat hand-edited later) stays.
//
// Results carry the owning session id and cwd so the renderer can group them
// by project exactly like the rail groups sessions.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

const DEFAULT_ROOTS = [path.join(os.homedir(), '.claude', 'projects')];
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
const BARE_PATH_RE = new RegExp(`(?:\\/[^\\/\\0"'\\\\\\s]+)+\\.(?:${EXT_RE})\\b`, 'gi');
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
const WIN_BARE_PATH_RE = new RegExp(`[A-Za-z]:(?:\\\\\\\\|/)(?:[^"\\s\\\\]|\\\\\\\\)+?\\.(?:${EXT_RE})\\b`, 'gi');
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

// All artifact-shaped absolute paths in one transcript line.
function extractCandidates(line) {
  const found = new Set();
  for (const match of line.matchAll(BARE_PATH_RE)) found.add(match[0]);
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
  const CACHE_VERSION = 3;
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
          if (name.endsWith('.jsonl')) out.push(path.join(dir, name));
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
    for (const transcriptPath of transcripts) {
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
        const parsed = await parseTranscript(
          transcriptPath,
          resumable ? { fromByte: cached.parsedBytes, prior: cached } : {},
        ).catch(() => null);
        if (!parsed) continue;
        entry = { size: stat.size, mtimeMs: stat.mtimeMs, ...parsed };
      }
      nextFiles[transcriptPath] = entry;
    }
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
    for (const [transcriptPath, entry] of Object.entries(cache.files)) {
      const sessionId = path.basename(transcriptPath, '.jsonl');
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
          cwd: entry.cwd || null,
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
      return { ok: true, artifacts, scannedAt: lastScanMs };
    },
    // The artifact protocol serves ONLY indexed files and their sibling assets
    // (a report's ./chart.png), never an arbitrary path.
    // Canonicalised the SAME way the index was, by the same object, so the two
    // cannot disagree the way they did on Windows until 2026-08-13.
    isServable: (candidate) => allowlist.allows(candidate),
  };
}

module.exports = {
  createArtifactsProvider,
  createServeAllowlist,
  extractCandidates,
  artifactKind,
  isExcluded,
  WINDOW_DAYS,
};
