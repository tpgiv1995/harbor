'use strict';

const readline = require('node:readline');
const { Transform } = require('node:stream');
const { readCodexTitles } = require('./native-session-titles.cjs');
const { sessionTitleText } = require('./session-title.cjs');

const { watchPath } = require('../watch-path.js');

// Provider history: codex and cursor sessions for the rail. The rail is the
// ONLY session browser, and until this module existed it listed Claude
// sessions alone (harbor-index.py indexes ~/.claude/projects), so a codex or
// cursor session had no identity in Harbor: its window could never resolve a
// transcript, fell back to the raw terminal, and vanished entirely on app
// restart (Pat, 2026-07-20/24). This scans the providers' own transcript
// stores, the same files the transcript provider tails, and produces rows in
// the exact shape harbor-index emits, so the sidebar model, transcript open,
// and the stage treat all three providers alike.
//
//   codex:  ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl[.zst]
//           ~/.codex/archived_sessions/rollout-<ts>-<uuid>.jsonl[.zst]
//   cursor: ~/.cursor/projects/<munged-cwd>/agent-transcripts/<id>/<id>.jsonl
//
// COMPRESSED and ARCHIVED codex sessions. Codex compresses a rollout to
// .jsonl.zst once it is about a week old and moves an archived chat to
// archived_sessions/; a scan of plain .jsonl under sessions/ alone missed most
// codex history (463 of 533 rollouts on one real home). Both are listed, one
// row per id. An archived row carries `archived` and the sidebar model hides
// it until searched, like codex's own list. A compressed head is read through
// the zstd stream with a byte cap, and its facts persist like any other row's
// (the path is the key, so archived and compressed come back with them).
// Opening one decompresses it ONCE into the cache (readableMetaFor), because
// the transcript tailer reads plain JSONL; codex never appends to a .zst.
//
// Titles come from the first user block the REAL parser produces (the same
// TranscriptParser the conversation window uses), so what the rail shows is
// exactly what the window will render. Rows are cached per file by
// (size, mtime); a scan re-reads only what changed.

const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { TranscriptParser } = require('./transcript.js');
const { readCodexRolloutMeta, codexLineage } = require('./provider-session-link.js');
const {
  zstdAvailable, isCompressed, walkRollouts, rolloutRank, createRolloutReadStream, decompressRollout, pruneRolloutCopies,
} = require('./codex-rollout-files.js');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEAD_BYTES = 4 * 1024 * 1024;
// A compressed rollout has no byte range to cut, so an uncapped head read
// decompressed to the 120th line, or to EOF when it held no user text: about
// 350MB of zstd per cold scan on one real home, 236MB of it from subagent
// rollouts that carry no user text at all. The decompressed bytes AFTER the
// first line are capped here; the first line (session_meta, which embeds the
// system prompt) is always read whole, the rule readCodexRolloutMeta applies
// to a plain file. On 464 real compressed rollouts every title and cwd sat
// inside 823KB, and the capped scan changed none of them.
const COMPRESSED_HEAD_BYTES = 1024 * 1024;
const HEAD_LINES = 120;
// Decompressed copies are pruned at most this often (and on the first copy).
const COPY_PRUNE_EVERY_MS = 6 * 60 * 60 * 1000;
const TITLE_MAX = 96;

// Same local format harbor-index emits ("2026-07-24 20:18"); the sidebar's
// parseLocalDateTime reads it back.
function formatLocal(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// The munge cursor applies to a cwd for its project dir name: strip leading
// slashes, then every RUN of non-alphanumerics becomes ONE dash. Verified
// against the dirs cursor actually created in both eras; a dotted username
// shows the posix shape ('/home/ada.lovelace/dev/widget' ->
// 'home-ada-lovelace-dev-widget', 'C:\dev\.orch\e8-...' -> 'C-dev-orch-e8-...').
// Until 2026-08-23 this
// modeled cursor with Claude's PER-CHARACTER munge ('C--dev--orch-e8-...'),
// which no Windows path ever produces ('C:\' alone yields '--'), so the
// unmunge map below matched nothing on this machine and every cursor row
// listed with cwd null and its munged dir name as its project, which is how
// orchestration worktree debris reached the rail as fake projects. Matches
// cursorProjectDir in transcript.js and provider-session-link.js.
function mungeCwd(cwd) {
  return String(cwd || '').replace(/^\/+/, '').replace(/[^a-zA-Z0-9]+/g, '-');
}

function oneLine(text, max = TITLE_MAX) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// The persisted facts are only as good as the code that read them, so their
// format IS that code: a hash of every module extractRowFacts runs. Known
// compatible releases migrate their changed fields after the window opens;
// other reader fingerprints refresh bounded heads in the background. A foreign
// envelope that is not a reader fingerprint is never trusted.
const FACTS_FORMAT = (() => {
  const hash = require('node:crypto').createHash('sha1');
  for (const file of [__filename, './transcript.js', './session-title.cjs', './provider-session-link.js', './codex-rollout-files.js', '../../shared/claude-turn-state.cjs']) {
    try { hash.update(fs.readFileSync(file === __filename ? file : require.resolve(file))); } catch { hash.update(file); }
  }
  return hash.digest('hex').slice(0, 16);
})();
// These releases differ only in Codex lineage classification. Keep their
// prompt facts at boot and upgrade the metadata in bounded background batches.
const COMPATIBLE_FACTS = new Set(['e823c78fa0869b94', 'f3de39fcfce83c81', 'a7655fd77549f45b', '574fa962fc2a884d']);
// A first prompt can be a whole pasted document, and every reader of it goes
// through oneLine with a max of at most 400, so the stored copy is collapsed
// and clipped well past that: oneLine(stored, max) === oneLine(original, max)
// for any max under 2000. A whitespace-only prompt keeps one raw character so
// its truthiness, which decides firstPrompt's null, is unchanged.
function storableFacts(facts) {
  const firstUser = facts.firstUser == null ? null : String(facts.firstUser);
  const collapsed = firstUser == null ? null : firstUser.replace(/\s+/g, ' ').trim();
  return {
    cwd: facts.cwd || null,
    lineage: facts.lineage || null,
    firstUser: firstUser == null ? null : (collapsed ? collapsed.slice(0, 2000) : firstUser.slice(0, 1)),
    isInternalSession: Boolean(facts.isInternalSession),
  };
}

// Pass the first line whole, then at most `maxBytes` more, then end. The
// source is destroyed at the cap, so decompression stops there too; the torn
// last line fails JSON.parse and is skipped like any partial record.
function capAfterFirstLine(source, maxBytes) {
  let firstLineDone = false;
  let budget = maxBytes;
  let ended = false;
  const capped = new Transform({
    transform(chunk, _encoding, callback) {
      if (ended) { callback(); return; }
      let rest = chunk;
      if (!firstLineDone) {
        const newline = chunk.indexOf(0x0a);
        if (newline < 0) { callback(null, chunk); return; }
        firstLineDone = true;
        this.push(chunk.subarray(0, newline + 1));
        rest = chunk.subarray(newline + 1);
      }
      if (rest.length < budget) {
        budget -= rest.length;
        callback(null, rest);
        return;
      }
      this.push(rest.subarray(0, budget));
      budget = 0;
      ended = true;
      this.push(null);
      source.unpipe(capped);
      source.destroy();
      callback();
    },
  });
  source.on('error', (error) => capped.destroy(error));
  capped.on('close', () => source.destroy());
  return source.pipe(capped);
}

// Read complete records: a large session_meta line must not consume the entire
// title budget. Stop early once a real prompt is found, with a bounded scan.
async function extractRowFacts(file, provider, { compressedHeadBytes = COMPRESSED_HEAD_BYTES } = {}) {
  const compressed = isCompressed(file);
  // The first Codex record is unbounded (it currently embeds the system
  // prompt), so cwd + lineage use the complete-line reader rather than this
  // module's bounded conversation head. A compressed rollout's first line is
  // read whole by the decompressing line reader below instead.
  const meta = provider === 'codex' && !compressed ? await readCodexRolloutMeta(file) : null;
  let cwd = meta?.cwd || null;
  let lineage = meta?.lineage || null;
  const stream = compressed
    ? capAfterFirstLine(createRolloutReadStream(file), compressedHeadBytes)
    : fs.createReadStream(file, { end: HEAD_BYTES - 1 });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const parser = new TranscriptParser(provider);
  let isInternalSession = lineage?.kind === 'guardian';
  let count = 0;
  let firstUser = null;
  try {
    for await (const line of lines) {
      if (++count > HEAD_LINES) break;
      if (!line.trim()) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      if (provider === 'codex' && obj.type === 'session_meta') {
        cwd = obj.payload?.cwd || cwd;
        lineage = lineage || codexLineage(obj.payload || {});
        isInternalSession = isInternalSession || obj.payload?.source?.subagent?.other === 'guardian';
      }
      try { parser.applyLine(obj); } catch { /* malformed records cannot kill indexing */ }
      firstUser = parser.blocks.filter(b => b.kind === 'user' && b.text)
        .map(b => sessionTitleText(b.text, { internal: isInternalSession })).find(Boolean);
      if (firstUser && (provider !== 'codex' || cwd)) return { cwd, lineage, firstUser, isInternalSession };
    }
    return { cwd, lineage, firstUser: firstUser || null, isInternalSession };
  } finally {
    lines.close();
    stream.destroy();
  }
}

// The codex-home watcher's filter. A platform that reports no filename gets
// every event (the conservative reading); otherwise only the session index
// and the two session dirs themselves (created, renamed, removed).
const CODEX_HOME_ENTRIES = new Set(['session_index.jsonl', 'sessions', 'archived_sessions']);
function acceptCodexHomeEvent(filename) {
  if (filename == null) return true;
  return CODEX_HOME_ENTRIES.has(path.basename(String(filename)));
}

// Trailing debounce with a max wait: quiet for `debounceMs` fires, and a
// stream of events that never goes quiet still fires `maxWaitMs` after the
// first one.
function createChangeScheduler(fire, { debounceMs, maxWaitMs, now = Date.now } = {}) {
  let timer = null;
  let pendingSinceMs = null;
  const cancel = () => { clearTimeout(timer); timer = null; pendingSinceMs = null; };
  const schedule = () => {
    const at = now();
    if (pendingSinceMs == null) pendingSinceMs = at;
    clearTimeout(timer);
    const wait = Math.max(0, Math.min(debounceMs, pendingSinceMs + maxWaitMs - at));
    timer = setTimeout(() => { cancel(); fire(); }, wait);
    timer.unref?.();
  };
  return { schedule, cancel };
}

function createProviderHistory(options = {}) {
  const homedir = options.homedir || os.homedir();
  const profiles = options.profiles || [];
  const configuredCodexRoots = profiles
    .filter((profile) => profile?.provider === 'codex' && profile.configHome)
    .map((profile) => ({ root: path.join(profile.configHome, 'sessions'), profileId: profile.id, configHome: profile.configHome }));
  const codexRoots = options.codexRoots
    || (options.codexRoot ? [{ root: options.codexRoot, profileId: null, configHome: null }] : null)
    || (configuredCodexRoots.length ? configuredCodexRoots : [{ root: path.join(homedir, '.codex', 'sessions'), profileId: null, configHome: path.join(homedir, '.codex') }]);
  const cursorRoot = options.cursorRoot || path.join(homedir, '.cursor', 'projects');
  const metadataFile = options.metadataFile || process.env.HARBOR_PROVIDER_METADATA_FILE
    || path.join(homedir, '.cache', 'harbor', 'provider-session-metadata.json');
  const projectLabelForCwd = options.projectLabelForCwd || ((cwd) => {
    const parts = String(cwd || '').split('/').filter(Boolean);
    return parts.length ? parts[parts.length - 1] : null;
  });
  const debounceMs = options.debounceMs ?? 5000;
  // A pure trailing debounce never fired while any rollout kept streaming, so
  // a session started outside Harbor (Codex Desktop, a terminal) stayed off
  // the rail until every codex run went quiet.
  const maxWaitMs = options.maxWaitMs ?? 30000;
  const compressedHeadBytes = options.compressedHeadBytes ?? COMPRESSED_HEAD_BYTES;
  // Decompressed copies of .jsonl.zst rollouts, made only when one is opened.
  const rolloutCacheDir = options.rolloutCacheDir || path.join(path.dirname(metadataFile), 'codex-rollouts');

  // WHAT A HEAD READ LEARNED SURVIVES A RESTART (2026-10-09). The row cache
  // below lives in memory, so every launch re-read the head of every codex and
  // cursor log (3,415 files: 12.5s measured) before Harbor could show its
  // window, and the window waits on this scan. Only what extractRowFacts READ
  // is persisted, keyed by the file's size and mtime; the row is rebuilt from
  // those facts every time, so project labels and keeper metadata stay live.
  // Opt-in by path (the app passes one; tests and the phone server do not).
  // Bump FACTS_FORMAT whenever extractRowFacts changes what it returns.
  const factsCacheFile = options.factsCacheFile || null;
  let storedFacts = null; // file path -> { size, mtimeMs, facts }
  let storedFactsDirty = false;
  const pendingMigration = new Map();
  let migrationTimer = null; let migrationClosed = false;
  const loadStoredFacts = () => {
    if (storedFacts || !factsCacheFile) return storedFacts;
    storedFacts = {};
    try {
      const parsed = JSON.parse(fs.readFileSync(factsCacheFile, 'utf8'));
      if (/^[a-f0-9]{16}$/.test(parsed?.format) && parsed.files && typeof parsed.files === 'object') {
        storedFacts = parsed.files;
        for (const entry of Object.values(storedFacts)) entry.format ||= parsed.format;
      }
    } catch { /* first launch, or an unreadable cache: the scan rebuilds it */ }
    return storedFacts;
  };
  const saveStoredFacts = async (seen) => {
    if (!storedFacts) return;
    for (const file of Object.keys(storedFacts)) {
      if (!seen.has(file)) { delete storedFacts[file]; storedFactsDirty = true; }
    }
    if (!storedFactsDirty) return;
    storedFactsDirty = false;
    const temporary = `${factsCacheFile}.${process.pid}.${Date.now()}.tmp`;
    try {
      await fsp.mkdir(path.dirname(factsCacheFile), { recursive: true });
      await fsp.writeFile(temporary, JSON.stringify({ format: FACTS_FORMAT, files: storedFacts }));
      // Windows refuses a rename over a file another process has open for a
      // moment (the index.json lesson, 2026-09-04): retry briefly, and a cache
      // that still cannot be written just costs the next launch a rescan.
      for (let attempt = 0; ; attempt += 1) {
        try { await fsp.rename(temporary, factsCacheFile); break; } catch (error) {
          if (attempt >= 4 || !['EPERM', 'EACCES', 'EBUSY'].includes(error?.code)) throw error;
          await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
        }
      }
    } catch {
      storedFactsDirty = true;
      await fsp.rm(temporary, { force: true }).catch(() => {});
    }
  };

  const emitter = new EventEmitter();
  const cache = new Map(); // file path -> { size, mtimeMs, row }
  const metaById = new Map(); // session id -> { provider, cwd, path }
  let durableMetadata = null;
  const watchers = [];
  const changes = createChangeScheduler(() => emitter.emit('changed'), { debounceMs, maxWaitMs });
  const scheduleChanged = changes.schedule;

  // `accept(filename)` filters a watcher's events (null = every event).
  const watchDir = (dir, { recursive = false, accept = null } = {}) => {
    try {
      const listener = accept ? (_event, filename) => { if (accept(filename)) scheduleChanged(); } : scheduleChanged;
      const watcher = watchPath(dir, { recursive }, listener);
      watcher.on('error', () => { /* dir may vanish; rescan re-arms nothing */ });
      watchers.push(watcher);
    } catch { /* provider not installed on this machine */ }
  };

  const loadMetadata = async () => {
    if (durableMetadata) return durableMetadata;
    try {
      const parsed = JSON.parse(await fsp.readFile(metadataFile, 'utf8'));
      durableMetadata = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch { durableMetadata = {}; }
    return durableMetadata;
  };

  const rememberKeeperIdentity = async (fact) => {
    if (!fact?.id || !['codex', 'cursor'].includes(fact.provider)) {
      throw new TypeError('provider metadata requires id and codex/cursor provider');
    }
    const metadata = await loadMetadata();
    const prior = metadata[fact.id] || {};
    metadata[fact.id] = {
      id: fact.id,
      provider: fact.provider,
      cwd: fact.cwd || prior.cwd || null,
      profileId: fact.profileId ?? prior.profileId ?? null,
      configHome: fact.configHome ?? prior.configHome ?? null,
      transcriptPath: fact.transcriptPath ?? prior.transcriptPath ?? null,
      observedAt: fact.observedAt || new Date().toISOString(),
    };
    await fsp.mkdir(path.dirname(metadataFile), { recursive: true });
    const temporary = `${metadataFile}.${process.pid}.${Date.now()}.tmp`;
    await fsp.writeFile(temporary, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
    await fsp.rename(temporary, metadataFile);
    return metadata[fact.id];
  };

  const rowFor = async (file, provider, {
    id, stat, cwdHint = null, projectHint = null, profileId = null, configHome = null, archived = false,
  }) => {
    // Derived from the path, which is the facts key, so they persist with it.
    const flags = {
      ...(archived ? { archived: true } : {}),
      ...(isCompressed(file) ? { compressed: true } : {}),
    };
    const metadata = (await loadMetadata())[id] || {};
    const hit = cache.get(file);
    if (hit && hit.size === stat.size && hit.mtimeMs === stat.mtimeMs) {
      // mtime moves lastActive even on a cache hit for the row facts.
      return {
        ...hit.row,
        lastActive: formatLocal(stat.mtimeMs),
        cwd: hit.row.cwd || metadata.cwd || null,
        profileId: hit.row.profileId || metadata.profileId || null,
        configHome: hit.row.configHome || metadata.configHome || null,
        ...flags,
      };
    }
    let facts = { cwd: null, firstUser: null };
    const stored = loadStoredFacts()?.[file];
    if (stored && stored.size === stat.size && stored.mtimeMs === stat.mtimeMs) {
      facts = stored.facts;
      if (stored.format && stored.format !== FACTS_FORMAT) pendingMigration.set(file, provider);
    } else {
      try {
        facts = await extractRowFacts(file, provider, { compressedHeadBytes });
        if (storedFacts) {
          storedFacts[file] = { size: stat.size, mtimeMs: stat.mtimeMs, facts: storableFacts(facts), format: FACTS_FORMAT };
          storedFactsDirty = true;
        }
      } catch { /* unreadable head; row still lists, and the next scan retries */ }
    }
    const cwd = facts.cwd || cwdHint || metadata.cwd || null;
    const row = {
      id,
      lastActive: formatLocal(stat.mtimeMs),
      project: (cwd ? projectLabelForCwd(cwd) : projectHint) || projectHint || '',
      isInternalSession: Boolean(facts.isInternalSession),
      title: facts.lineage?.kind === 'guardian' ? (oneLine(facts.firstUser) || 'approval review')
        : facts.lineage?.parentThreadId ? [facts.lineage.nickname || 'subagent', facts.lineage.agentPath && `(${facts.lineage.agentPath})`].filter(Boolean).join(' ')
          : oneLine(facts.firstUser) || `(${provider} session)`,
      lineage: facts.lineage || null,
      delegatedBy: facts.lineage?.parentThreadId || null,
      lastWriteMs: stat.mtimeMs,
      firstPrompt: facts.firstUser ? oneLine(facts.firstUser, 400) : null,
      cwd: cwd || null,
      provider,
      path: file,
      profileId: profileId || metadata.profileId || null,
      configHome: configHome || metadata.configHome || null,
      ...flags,
    };
    cache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, row });
    return row;
  };

  const scanCodexRoot = async (rows, { root: codexRoot, profileId, configHome }) => {
    const archivedRoot = path.join(configHome || path.dirname(codexRoot), 'archived_sessions');
    for (const [dir, archived] of [[codexRoot, false], [archivedRoot, true]]) {
      await walkRollouts(dir, 3, async (file, id) => {
        const stat = await fsp.stat(file).catch(() => null);
        if (!stat) return;
        rows.push(await rowFor(file, 'codex', { id, stat, profileId, configHome, archived }));
      });
    }
  };

  // One row per codex id; see rolloutRank. Ties go to the newest write.
  const dedupeCodex = (rows) => {
    const best = new Map();
    for (const row of rows) {
      const prior = best.get(row.id);
      if (!prior || rolloutRank(row) < rolloutRank(prior)
        || (rolloutRank(row) === rolloutRank(prior) && row.lastWriteMs > prior.lastWriteMs)) best.set(row.id, row);
    }
    return [...best.values()];
  };

  const scanCodex = async (rows) => {
    const codexRows = [];
    for (const root of codexRoots) await scanCodexRoot(codexRows, typeof root === 'string' ? { root } : root);
    rows.push(...dedupeCodex(codexRows));
  };

  const scanCursor = async (rows, knownCwds) => {
    // Reverse the cwd munge from cwds Harbor already knows (claude history,
    // codex session_meta, live workspaces): a cursor transcript itself never
    // records its cwd. An unmatched project dir still lists, labeled by its
    // munged name, with cwd honestly null.
    const unmunge = new Map();
    for (const cwd of knownCwds || []) {
      if (cwd) unmunge.set(mungeCwd(cwd), cwd);
    }
    const projects = await fsp.readdir(cursorRoot).catch(() => []);
    for (const project of projects) {
      const transcriptsDir = path.join(cursorRoot, project, 'agent-transcripts');
      const ids = await fsp.readdir(transcriptsDir).catch(() => []);
      for (const id of ids) {
        if (!UUID_RE.test(id)) continue;
        const file = path.join(transcriptsDir, id, `${id}.jsonl`);
        const stat = await fsp.stat(file).catch(() => null);
        if (!stat) continue;
        rows.push(await rowFor(file, 'cursor', {
          id,
          stat,
          cwdHint: unmunge.get(project) || null,
          projectHint: project,
        }));
      }
    }
  };

  const listSessions = async ({ knownCwds } = {}) => {
    const rows = [];
    await loadMetadata();
    await scanCodex(rows);
    await scanCursor(rows, knownCwds);
    const nativeByHome = new Map();
    for (const item of codexRoots) {
      const home = typeof item === 'string' ? path.dirname(item) : item.configHome || path.dirname(item.root);
      nativeByHome.set(home, await readCodexTitles(home));
    }
    const homeOf = (item) => (typeof item === 'string' ? path.dirname(item) : item.configHome || path.dirname(item.root));
    for (const row of rows) {
      if (row.provider !== 'codex' || row.isInternalSession) continue;
      // An archived rollout lives beside sessions/, under the same home.
      const source = codexRoots.find(item => row.path.startsWith((typeof item === 'string' ? item : item.root) + path.sep)
        || row.path.startsWith(path.join(homeOf(item), 'archived_sessions') + path.sep));
      const home = source && homeOf(source);
      const title = nativeByHome.get(home)?.get(row.id);
      if (title) row.title = title;
    }
    await saveStoredFacts(new Set(rows.map((row) => row.path)));
    metaById.clear();
    for (const row of rows) {
      const meta = {
        provider: row.provider,
        cwd: row.cwd,
        path: row.path,
      };
      if (row.profileId) meta.profileId = row.profileId;
      if (row.configHome) meta.configHome = row.configHome;
      if (row.archived) meta.archived = true;
      if (row.compressed) {
        // No reader may take a .zst for JSONL, so the plain meta names no
        // path; readableMetaFor decompresses on demand.
        meta.compressed = true;
        meta.rolloutPath = row.path;
        meta.path = null;
      }
      metaById.set(row.id, meta);
    }
    return rows;
  };

  // A compressed rollout, decompressed once into the cache so the transcript
  // tailer (plain JSONL) can open it. Keyed by the source's mtime, which the
  // copy carries; single-flight per file. Returns null when it cannot be made.
  // The copy directory is pruned on the first copy and every 6 hours after.
  const materializing = new Map();
  let lastCopyPruneMs = -Infinity;
  const pruneCopies = (keep) => {
    if (Date.now() - lastCopyPruneMs < COPY_PRUNE_EVERY_MS) return;
    lastCopyPruneMs = Date.now();
    pruneRolloutCopies(rolloutCacheDir, { keep: new Set([keep]) }).catch(() => {});
  };
  const materializeRollout = (file) => {
    if (materializing.has(file)) return materializing.get(file);
    const job = (async () => {
      const source = await fsp.stat(file);
      const target = path.join(rolloutCacheDir, path.basename(file).replace(/\.zst$/, ''));
      const existing = await fsp.stat(target).catch(() => null);
      if (existing && Math.trunc(existing.mtimeMs / 1000) === Math.trunc(source.mtimeMs / 1000)) return target;
      await fsp.mkdir(rolloutCacheDir, { recursive: true });
      const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
      try {
        await decompressRollout(file, temporary);
        await fsp.utimes(temporary, source.atime, source.mtime);
        await fsp.rename(temporary, target);
      } catch (error) {
        await fsp.rm(temporary, { force: true }).catch(() => {});
        throw error;
      }
      return target;
    })().then((target) => { pruneCopies(target); return target; }, () => null)
      .finally(() => materializing.delete(file));
    materializing.set(file, job);
    return job;
  };

  // Callers resolve sessions through this: path + provider straight from the
  // scan, no hints needed from the renderer. Synchronous, and it never
  // decompresses: identity, cwd and liveness lookups (the Orch join asks for
  // every candidate worker) must not write a copy of every old rollout.
  const metaFor = (id) => metaById.get(id) || null;

  // For a reader of the conversation (the transcript window, the preview): a
  // compressed row answers with its decompressed copy as `path`.
  const readableMetaFor = async (id) => {
    const meta = metaById.get(id);
    if (!meta) return null;
    if (!meta.compressed) return meta;
    const plain = zstdAvailable() ? await materializeRollout(meta.rolloutPath) : null;
    return { ...meta, path: plain };
  };

  const start = () => {
    // EXACTLY two watchers. A per-project watcher set was the first design
    // and it exhausted inotify instances (fs.watch = one instance each;
    // ~50 cursor projects pushed a single app past the 128 default alongside
    // the desktop's ~90, and the e2e harness daemon's reads went dark —
    // live-caught 2026-07-24 as spec 6 flaking). Cursor's non-transcript
    // churn (worker.log, terminals) is absorbed by the debounce.
    for (const item of codexRoots) {
      const root = typeof item === 'string' ? item : item.root;
      watchDir(root, { recursive: true });
      // Renaming a chat changes this sibling index without touching its rollout.
      // The watch is non-recursive on the codex HOME, so it also fires for
      // every write codex makes to its own logs, databases and caches
      // (logs_2.sqlite about every 90s even when idle), and each one used to
      // refresh the whole rail. Only the index and the session dirs count.
      watchDir(path.dirname(root), { accept: acceptCodexHomeEvent });
    }
    watchDir(cursorRoot, { recursive: true });
  };

  const migrateEntries = async (limit = 8) => {
    let changed = 0; let attempted = 0;
    for (const [file, provider] of pendingMigration) {
      if (attempted++ >= limit) break;
      pendingMigration.delete(file);
      const stored = storedFacts?.[file]; if (!stored) continue;
      try {
        if (!COMPATIBLE_FACTS.has(stored.format) || isCompressed(file)) {
          // Other reader fingerprints (including mixed checkout line endings)
          // refresh the whole head, but only after boot and one batch at a time.
          // A compressed rollout always takes this path: the lineage-only
          // reader below reads plain JSONL.
          stored.facts = storableFacts(await extractRowFacts(file, provider, { compressedHeadBytes }));
        } else if (provider === 'codex') {
          const meta = await readCodexRolloutMeta(file);
          stored.facts.lineage = meta?.lineage || null;
          stored.facts.isInternalSession = meta?.lineage?.kind === 'guardian';
        }
        stored.format = FACTS_FORMAT; storedFactsDirty = true; cache.delete(file); changed++;
      } catch { /* unreadable metadata remains unknown until the file changes */ }
    }
    if (!pendingMigration.size) await saveStoredFacts(new Set(Object.keys(storedFacts || {})));
    return { changed, remaining: pendingMigration.size };
  };
  const startBackgroundMigration = () => {
    if (migrationClosed || migrationTimer) return;
    let changed = false;
    const step = async () => {
      try {
        const result = await migrateEntries();
        changed ||= result.changed > 0;
        if (migrationClosed) return;
        if (result.remaining) migrationTimer = setTimeout(step, 100);
        else { migrationTimer = null; if (changed) emitter.emit('changed'); }
      } catch { migrationTimer = null; }
    };
    migrationTimer = setTimeout(step, 0);
  };
  const close = () => {
    migrationClosed = true; clearTimeout(migrationTimer);
    changes.cancel();
    for (const watcher of watchers) watcher.close();
    watchers.length = 0;
  };

  return {
    emitter, listSessions, metaFor, readableMetaFor, materializeRollout, start, close, migrateEntries, startBackgroundMigration,
    rememberKeeperIdentity,
    rememberLink: rememberKeeperIdentity,
  };
}

// Join exact provider ids without inventing liveness in history. Keeper facts
// fill only metadata a transcript cannot intrinsically provide; the caller's
// ordinary live-pane merge remains the sole owner of live/dead presentation.
function mergeProviderKeeperRows(historyRows, livePanes) {
  const liveById = new Map();
  for (const pane of livePanes || []) {
    const id = typeof pane.agent_session === 'string' ? pane.agent_session : pane.agent_session?.value;
    if (id) liveById.set(id, pane);
  }
  return (historyRows || []).map((row) => {
    const pane = liveById.get(row.id);
    if (!pane) return row;
    return { ...row, cwd: row.cwd || pane.cwd || null, provider: row.provider || pane.agent || null };
  });
}

module.exports = {
  createProviderHistory, formatLocal, mungeCwd, mergeProviderKeeperRows,
  acceptCodexHomeEvent, createChangeScheduler, extractRowFacts, COMPRESSED_HEAD_BYTES,
};
