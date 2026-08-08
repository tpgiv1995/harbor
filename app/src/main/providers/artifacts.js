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
// Three shapes cover how paths appear in transcript JSON: bare (no spaces),
// a whole JSON string that IS the path (Write's file_path; spaces fine), and
// a single-quoted path inside a shell command. '.' never occurs in base64, so
// embedded image payloads can never fake an extension match.
const BARE_PATH_RE = new RegExp(`(?:\\/[^\\/\\0"'\\\\\\s]+)+\\.(?:${EXT_RE})\\b`, 'gi');
const JSON_STRING_PATH_RE = new RegExp(`"(\\/(?:[^"\\\\]|\\\\.){2,400}?\\.(?:${EXT_RE}))"`, 'gi');
const QUOTED_PATH_RE = new RegExp(`'(\\/[^']{2,400}?\\.(?:${EXT_RE}))'`, 'gi');
const CWD_RE = /"cwd"\s*:\s*"((?:[^"\\]|\\.)+)"/;
const TIMESTAMP_RE = /"timestamp"\s*:\s*"([^"]+)"/;

// Paths that are never a deliverable: build output, dependency trees, VCS
// internals, cache stores (pasted-screenshot inputs live in ~/.cache/harbor),
// session scratchpads, and the transcript store itself.
const EXCLUDED_SEGMENTS = ['/node_modules/', '/.git/', '/dist/', '/.cache/'];
const EXCLUDED_PREFIXES = ['/tmp/claude-', '/proc/', '/sys/'];

function artifactKind(candidate) {
  const ext = path.extname(candidate).slice(1).toLowerCase();
  return EXT_KIND[ext] || null;
}

function isExcluded(candidate) {
  const value = String(candidate);
  if (EXCLUDED_SEGMENTS.some((segment) => value.includes(segment))) return true;
  if (/\/\.claude[^/]*\//.test(value)) return true;
  return EXCLUDED_PREFIXES.some((prefix) => value.startsWith(prefix));
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
  const all = [...found].filter((candidate) => artifactKind(candidate) && !isExcluded(candidate));
  // A spaced path also yields its tail as a bare-regex fragment ("Foo
  // Bar/report.html" -> "/report.html"); a candidate that is a strict suffix
  // of another is that fragment, never a real second file.
  return all.filter((candidate) => !all.some((other) => other !== candidate && other.endsWith(candidate)));
}

async function parseTranscript(filePath) {
  const candidates = new Set();
  let cwd = null;
  let startMs = null;
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
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
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return { candidates: [...candidates], cwd, startMs };
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

  let cache = { version: 1, files: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (raw?.version === 1 && raw.files) cache = raw;
  } catch { /* cold start */ }

  let lastArtifacts = [];
  let servableDirs = new Set();
  let servableFiles = new Set();
  let scanPromise = null;
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

  async function runScan() {
    const now = nowFn();
    const cutoff = now - windowDays * 24 * 60 * 60 * 1000;
    const transcripts = await listTranscripts();
    const nextFiles = {};
    // path -> { sessionId, cwd, transcriptMtimeMs, startMs }
    const byArtifactPath = new Map();

    for (const transcriptPath of transcripts) {
      let stat;
      try { stat = await fsp.stat(transcriptPath); } catch { continue; }
      if (stat.mtimeMs < cutoff) continue;
      const cached = cache.files[transcriptPath];
      let entry;
      if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
        entry = cached;
      } else {
        const parsed = await parseTranscript(transcriptPath).catch(() => null);
        if (!parsed) continue;
        entry = { size: stat.size, mtimeMs: stat.mtimeMs, ...parsed };
      }
      nextFiles[transcriptPath] = entry;
      const sessionId = path.basename(transcriptPath, '.jsonl');
      for (const candidate of entry.candidates || []) {
        const prior = byArtifactPath.get(candidate);
        if (prior && prior.transcriptMtimeMs >= stat.mtimeMs) continue;
        byArtifactPath.set(candidate, {
          sessionId,
          cwd: entry.cwd || null,
          transcriptMtimeMs: stat.mtimeMs,
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

    cache = { version: 1, files: nextFiles };
    lastArtifacts = bounded;
    servableFiles = new Set(bounded.map((a) => a.path));
    servableDirs = new Set(bounded.map((a) => path.dirname(a.path)));
    lastScanMs = now;
    try {
      await fsp.mkdir(path.dirname(cacheFile), { recursive: true });
      await fsp.writeFile(cacheFile, JSON.stringify(cache));
    } catch { /* cache is an optimization, never a failure */ }
    return bounded;
  }

  return {
    // Single-flight scan; callers arriving mid-scan share the result.
    async list() {
      if (!scanPromise) {
        scanPromise = runScan().finally(() => { scanPromise = null; });
      }
      const artifacts = await scanPromise;
      return { ok: true, artifacts, scannedAt: lastScanMs };
    },
    // The artifact protocol serves ONLY indexed files and their sibling assets
    // (a report's ./chart.png), never an arbitrary path.
    isServable(candidate) {
      const normalized = path.normalize(String(candidate || ''));
      if (normalized.includes('\0')) return false;
      if (servableFiles.has(normalized)) return true;
      for (const dir of servableDirs) {
        if (normalized.startsWith(`${dir}${path.sep}`)) return true;
      }
      return false;
    },
  };
}

module.exports = {
  createArtifactsProvider,
  extractCandidates,
  artifactKind,
  isExcluded,
  WINDOW_DAYS,
};
