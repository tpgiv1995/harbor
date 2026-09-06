'use strict';

// Model catalog: the auto-update engine behind Harbor's Claude model menus.
// The ground truth for "which models can a session actually run" is the
// INSTALLED Claude CLI binary; Harbor launches every session through it, so
// its accepted id set is the consumer-side fact (a docs page or API listing
// can know about models this CLI build cannot launch yet). Discovery scans
// the binary's strings for dateless first-party model ids, caches the result
// keyed to the exact binary (path+size+mtime), and merges it over the shipped
// static seed so the menus can only GAIN models when discovery works and
// never lose the known floor when it does not (missing binary, unreadable
// file, empty scan: the seed stands).
//
// Labels are DERIVED from the id (claude-opus-5 -> "Opus 5"), never looked up
// in a table that can go stale; this is the same no-stale-table doctrine as
// the context gauge's no-guessed-denominator rule.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

// Families Harbor offers. mythos is deliberately absent: the id exists in the
// CLI but access is invitation-only (Project Glasswing), so listing it would
// offer a dead menu row on these accounts.
const FAMILIES = ['fable', 'opus', 'sonnet', 'haiku'];

// A launchable dateless first-party id: claude-<family>-<gen>[-<minor>] where
// every numeric segment is 1-2 digits. This rejects dated snapshots
// (claude-opus-4-5-20251101), bedrock variants (-v1:0), fast-mode routing ids
// (claude-opus-4-6-fast), doc slugs (claude-fable-5.md, claude-fable-5-mythos-5)
// and bare-major aliases (claude-opus-4: generation 4 ids carry a minor;
// generation 5+ ids are single-segment).
const MODEL_ID_RE = /claude-(fable|opus|sonnet|haiku)-\d{1,2}(?:-\d{1,2})?(?![\w.@:-])/g;

function isLaunchableId(id) {
  const m = String(id).match(/^claude-(fable|opus|sonnet|haiku)-(\d{1,2})(?:-(\d{1,2}))?$/);
  if (!m) return false;
  const major = Number(m[2]);
  const hasMinor = m[3] != null;
  // Generation 4 ships as major-minor (claude-opus-4-8); the bare major there
  // is an alias, not a distinct model. Generation 5+ ids are single-segment.
  if (!hasMinor && major < 5) return false;
  return true;
}

function familyOf(id) {
  return String(id).match(/^claude-([a-z]+)-/)?.[1] || null;
}

// claude-opus-4-8 -> [4, 8]; claude-opus-5 -> [5]
function versionOf(id) {
  return String(id).replace(/^claude-[a-z]+-/, '').split('-').map(Number);
}

function compareVersionsDesc(a, b) {
  const va = versionOf(a);
  const vb = versionOf(b);
  for (let i = 0; i < Math.max(va.length, vb.length); i += 1) {
    const d = (vb[i] ?? 0) - (va[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

// claude-opus-4-8 -> "Opus 4.8"; claude-opus-5 -> "Opus 5"
function labelForId(id) {
  const family = familyOf(id);
  const version = versionOf(id).join('.');
  return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${version}`;
}

// Extract candidate ids from an arbitrary byte buffer (a slice of the CLI
// binary decoded as latin1). Returns raw matches; the launchable filter and
// the boundary lookahead in MODEL_ID_RE do the pruning.
function extractIdsFromText(text, into = new Set()) {
  for (const match of text.matchAll(MODEL_ID_RE)) {
    if (isLaunchableId(match[0])) into.add(match[0]);
  }
  return into;
}

// Resolve the claude binary the way a shell would: $HARBOR_CLAUDE_BIN is an
// exact pin (used alone, no fallback: a pin that silently fell through to
// PATH would scan a different binary than the one asked for), then PATH,
// then the known install location. Returns a realpath or null.
async function resolveClaudeBinary(env = process.env) {
  const candidates = [];
  if (env.HARBOR_CLAUDE_BIN) {
    candidates.push(env.HARBOR_CLAUDE_BIN);
  } else {
    // Two separate Windows bugs lived here, and fixing only the first one still
    // leaves the catalogue silently falling back to MODEL_VERSION_SEED forever:
    //
    //   1. The split was ':'. On Windows PATH is ';'-separated AND every entry
    //      contains a ':' of its own ("C:\..."), so a ':' split shreds the list.
    //   2. Even split correctly, this looked for an extensionless `claude`.
    //      Windows installs it as claude.cmd / claude.exe, so nothing matched.
    //
    // setup/detect.js's findOnPath had both right already; this is the same
    // rule, kept local because this module resolves a binary to SCAN rather
    // than one to run.
    const exts = process.platform === 'win32'
      ? String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
      : [''];
    for (const dir of String(env.PATH || '').split(path.delimiter)) {
      if (!dir) continue;
      for (const ext of exts) candidates.push(path.join(dir, `claude${ext}`));
    }
    // POSIX convention; harmless elsewhere because it simply will not exist.
    candidates.push(path.join(os.homedir(), '.local', 'bin', 'claude'));
  }
  const pinned = Boolean(env.HARBOR_CLAUDE_BIN);
  for (const candidate of candidates) {
    try {
      const real = await fsp.realpath(candidate);
      const stat = await fsp.stat(real);
      if (!stat.isFile()) continue;
      // Third Windows bug in this resolver, one hop past the other two: PATH
      // resolves to claude.cmd, an npm SHIM of a few hundred bytes, and a shim
      // scans to zero ids, which reads as "no new models, ever". The 279MB
      // binary the shim launches lives beside it in the package
      // (node_modules/@anthropic-ai/claude-code/bin/), so a resolved file too
      // small to BE the CLI is followed into the package it wraps. The
      // HARBOR_CLAUDE_BIN pin stays exact and is never unwrapped: a pin means
      // scan THIS file, and silently scanning a different one is the exact
      // failure the pin's own comment warns about.
      if (!pinned && stat.size < 1024 * 1024) {
        const packagedName = process.platform === 'win32' ? 'claude.exe' : 'claude';
        const packaged = path.join(
          path.dirname(real),
          'node_modules', '@anthropic-ai', 'claude-code', 'bin', packagedName,
        );
        try {
          const packagedReal = await fsp.realpath(packaged);
          const packagedStat = await fsp.stat(packagedReal);
          if (packagedStat.isFile() && packagedStat.size > stat.size) {
            return { path: packagedReal, size: packagedStat.size, mtimeMs: packagedStat.mtimeMs };
          }
        } catch { /* no packaged binary beside the shim; scan the shim honestly */ }
      }
      return { path: real, size: stat.size, mtimeMs: stat.mtimeMs };
    } catch { /* not here; keep looking */ }
  }
  return null;
}

// Stream the binary through the extractor. Chunked with a small overlap so an
// id split across a chunk boundary still matches.
async function scanBinaryForIds(binPath) {
  const ids = new Set();
  const CHUNK = 8 * 1024 * 1024;
  const OVERLAP = 128;
  const handle = await fsp.open(binPath, 'r');
  try {
    const { size } = await handle.stat();
    const buffer = Buffer.alloc(Math.min(CHUNK, size));
    let tail = '';
    let position = 0;
    while (position < size) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      position += bytesRead;
      const text = tail + buffer.toString('latin1', 0, bytesRead);
      extractIdsFromText(text, ids);
      tail = text.slice(-OVERLAP);
    }
  } finally {
    await handle.close();
  }
  return ids;
}

function buildVersions(ids) {
  const byFamily = new Map(FAMILIES.map((f) => [f, []]));
  for (const id of ids) {
    const family = familyOf(id);
    if (byFamily.has(family)) byFamily.get(family).push(id);
  }
  const versions = [];
  for (const family of FAMILIES) {
    const sorted = byFamily.get(family).sort(compareVersionsDesc);
    for (const id of sorted) versions.push({ id, label: labelForId(id), family });
  }
  return versions;
}

function buildFamilies(versions) {
  return FAMILIES
    .map((family) => {
      const flagship = versions.find((v) => v.family === family);
      return flagship ? { alias: family, label: flagship.label, family } : null;
    })
    .filter(Boolean);
}

// The catalog: seeded synchronously from the static list, refreshed
// asynchronously from the installed CLI. current() is always answerable.
function createModelCatalog({ seedIds, cacheFile } = {}) {
  const seed = new Set(seedIds || []);
  let ids = new Set(seed);
  let versions = buildVersions(ids);
  let families = buildFamilies(versions);

  const apply = (nextIds) => {
    ids = new Set([...seed, ...nextIds].filter(isLaunchableId));
    versions = buildVersions(ids);
    families = buildFamilies(versions);
  };

  const readCache = async () => {
    try {
      return JSON.parse(await fsp.readFile(cacheFile, 'utf8'));
    } catch {
      return null;
    }
  };

  const refresh = async ({ env = process.env } = {}) => {
    const bin = await resolveClaudeBinary(env);
    if (!bin) return { ok: false, reason: 'claude binary not found', added: [] };
    const cached = cacheFile ? await readCache() : null;
    const cacheHit = cached
      && cached.binPath === bin.path
      && cached.size === bin.size
      && cached.mtimeMs === bin.mtimeMs
      && Array.isArray(cached.ids);
    const before = new Set(ids);
    let scanned;
    if (cacheHit) {
      scanned = new Set(cached.ids.filter(isLaunchableId));
    } else {
      try {
        scanned = await scanBinaryForIds(bin.path);
      } catch (error) {
        return { ok: false, reason: `scan failed: ${error.message}`, added: [] };
      }
      // An empty scan is a scan FAILURE, not an empty model list; the seed
      // stands and the cache is not poisoned.
      if (!scanned.size) return { ok: false, reason: 'scan found no model ids', added: [] };
      if (cacheFile) {
        await fsp.mkdir(path.dirname(cacheFile), { recursive: true }).catch(() => {});
        await fsp.writeFile(cacheFile, JSON.stringify({
          binPath: bin.path,
          size: bin.size,
          mtimeMs: bin.mtimeMs,
          ids: [...scanned].sort(),
          scannedAt: new Date().toISOString(),
        })).catch(() => { /* cache write must never break the refresh */ });
      }
    }
    apply(scanned);
    const added = [...ids].filter((id) => !before.has(id)).sort(compareVersionsDesc);
    return { ok: true, cacheHit: Boolean(cacheHit), added };
  };

  return {
    refresh,
    ids: () => [...ids],
    versions: () => versions.map((v) => ({ ...v })),
    families: () => families.map((f) => ({ ...f })),
  };
}

module.exports = {
  createModelCatalog,
  extractIdsFromText,
  isLaunchableId,
  labelForId,
  compareVersionsDesc,
  resolveClaudeBinary,
  buildVersions,
  buildFamilies,
  FAMILIES,
};
