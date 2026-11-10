'use strict';

const readline = require('node:readline');
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
//   codex:  ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
//   cursor: ~/.cursor/projects/<munged-cwd>/agent-transcripts/<id>/<id>.jsonl
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
const { readCodexRolloutMeta } = require('./provider-session-link.js');

const CODEX_ID_RE = /([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEAD_BYTES = 4 * 1024 * 1024;
const HEAD_LINES = 120;
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

// Every rail refresh munges every cwd Harbor knows (thousands) to reverse
// cursor's folder names; the answers never change, so they are remembered.
const mungedCwds = new Map();
function mungeCwdCached(cwd) {
  let munged = mungedCwds.get(cwd);
  if (munged === undefined) {
    if (mungedCwds.size >= 50_000) mungedCwds.clear();
    munged = mungeCwd(cwd);
    mungedCwds.set(cwd, munged);
  }
  return munged;
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
  for (const file of [__filename, './transcript.js', './session-title.cjs', './provider-session-link.js', '../../shared/claude-turn-state.cjs']) {
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

// Read complete records: a large session_meta line must not consume the entire
// title budget. Stop early once a real prompt is found, with a bounded scan.
async function extractRowFacts(file, provider) {
  // The first Codex record is unbounded (it currently embeds the system
  // prompt), so cwd + lineage use the complete-line reader rather than this
  // module's bounded conversation head.
  const meta = provider === 'codex' ? await readCodexRolloutMeta(file) : null;
  let cwd = meta?.cwd || null;
  const lineage = meta?.lineage || null;
  const stream = fs.createReadStream(file, { end: HEAD_BYTES - 1 });
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
  // NOT REWRITTEN ON EVERY REFRESH (2026-11-06). Any live codex session grows
  // its log, which changes its stored facts, so every rail refresh restringified
  // and rewrote the whole 4 MB file, in the app and again in the phone server
  // (about 34 MB a minute of allocations in the phone server alone). The file
  // only spares a cold start its head reads, so it is written at most once per
  // factsSaveIntervalMs (the newest facts, on a trailing timer, and on close).
  const factsSaveIntervalMs = Math.max(0, Number(options.factsSaveIntervalMs ?? 120_000) || 0);
  let lastFactsSaveAt = -Infinity;
  let factsSaveTimer = null;
  const saveStoredFacts = async (seen) => {
    if (!storedFacts) return;
    for (const file of Object.keys(storedFacts)) {
      if (!seen.has(file)) { delete storedFacts[file]; storedFactsDirty = true; }
    }
    if (!storedFactsDirty) return;
    const wait = lastFactsSaveAt + factsSaveIntervalMs - Date.now();
    if (wait > 0) {
      if (!factsSaveTimer) {
        factsSaveTimer = setTimeout(() => { factsSaveTimer = null; writeStoredFacts().catch(() => {}); }, wait);
        factsSaveTimer.unref?.();
      }
      return;
    }
    await writeStoredFacts();
  };
  // Writes the facts still waiting for their interval, synchronously (close).
  // Each write takes a generation; an asynchronous write renames only if no
  // newer write started since, so an older trailing write can never land over
  // the close-time flush (Astra review round 2).
  let factsWriteGen = 0;
  const flushStoredFacts = () => {
    const pendingTimer = Boolean(factsSaveTimer);
    if (factsSaveTimer) { clearTimeout(factsSaveTimer); factsSaveTimer = null; }
    if (!pendingTimer && !factsWriteInFlight) return;
    factsWriteGen += 1;
    if (!storedFacts || !storedFactsDirty && !factsWriteInFlight) return;
    writeFactsSync();
  };
  const writeFactsSync = () => {
    if (!storedFacts) return;
    const temporary = `${factsCacheFile}.${process.pid}.${Date.now()}.sync.tmp`;
    try {
      fs.mkdirSync(path.dirname(factsCacheFile), { recursive: true });
      fs.writeFileSync(temporary, JSON.stringify({ format: FACTS_FORMAT, files: storedFacts }));
      fs.renameSync(temporary, factsCacheFile);
      storedFactsDirty = false;
    } catch {
      try { fs.rmSync(temporary, { force: true }); } catch { /* best effort */ }
    }
  };
  let factsWriteInFlight = false;
  const writeStoredFacts = async () => {
    if (!storedFacts || !storedFactsDirty) return;
    storedFactsDirty = false;
    lastFactsSaveAt = Date.now();
    const gen = ++factsWriteGen;
    factsWriteInFlight = true;
    const temporary = `${factsCacheFile}.${process.pid}.${Date.now()}.${gen}.tmp`;
    try {
      await fsp.mkdir(path.dirname(factsCacheFile), { recursive: true });
      await fsp.writeFile(temporary, JSON.stringify({ format: FACTS_FORMAT, files: storedFacts }));
      if (gen !== factsWriteGen) { await fsp.rm(temporary, { force: true }).catch(() => {}); return; }
      // Windows refuses a rename over a file another process has open for a
      // moment (the index.json lesson, 2026-09-04): retry briefly, and a cache
      // that still cannot be written just costs the next launch a rescan.
      for (let attempt = 0; ; attempt += 1) {
        if (gen !== factsWriteGen) { await fsp.rm(temporary, { force: true }).catch(() => {}); return; }
        try {
          await fsp.rename(temporary, factsCacheFile);
          // A close-time flush that ran while this rename was on its way may
          // have landed first; the newest facts are written again so the older
          // rename cannot be the last word.
          if (gen !== factsWriteGen) writeFactsSync();
          break;
        } catch (error) {
          if (attempt >= 4 || !['EPERM', 'EACCES', 'EBUSY'].includes(error?.code)) throw error;
          await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
        }
      }
    } catch {
      storedFactsDirty = true;
      await fsp.rm(temporary, { force: true }).catch(() => {});
    } finally {
      if (gen === factsWriteGen) factsWriteInFlight = false;
    }
  };

  const emitter = new EventEmitter();
  const cache = new Map(); // file path -> { size, mtimeMs, row }
  const metaById = new Map(); // session id -> { provider, cwd, path }
  let durableMetadata = null;
  const watchers = [];
  let changedTimer = null;
  const watchFactory = options.watchFactory || ((dir, opts, listener) => watchPath(dir, opts, listener));

  // RE-CHECK ONLY WHAT CHANGED (2026-11-01). Every refresh used to walk every
  // codex and cursor log (about 4,000 files across three codex homes) because
  // ANY change anywhere (a claude transcript line included) refreshes the rail.
  // With agents writing all night that was a full walk every 5 to 30 s in the
  // desktop and again in the phone server, measured at about half a core each.
  // The watchers already say which file changed, so a refresh after the first
  // full walk re-checks only those files and rebuilds the rest from memory.
  // A full walk still runs on the first listing, when a watcher reports no
  // filename or a folder-level change it cannot map to one log, after a
  // watcher error, and always when a configured root could not be watched.
  const known = new Map(); // file path -> { provider, id, profileId, configHome, projectHint, order }
  const dirty = new Set();
  let fullScanNeeded = true;
  let rootsUnwatched = 0;

  const scheduleChanged = () => {
    clearTimeout(changedTimer);
    changedTimer = setTimeout(() => emitter.emit('changed'), debounceMs);
    changedTimer.unref?.();
  };

  const watchDir = (dir, { recursive = false, onEvent = null } = {}) => {
    try {
      const watcher = watchFactory(dir, { recursive }, (eventType, filename) => {
        if (onEvent) onEvent(filename);
        scheduleChanged();
      });
      watcher.on?.('error', () => { fullScanNeeded = true; });
      watchers.push(watcher);
      return true;
    } catch { return false; /* provider not installed on this machine */ }
  };

  const relParts = (filename) => String(filename).split(/[\\/]+/).filter(Boolean);
  const noteCodexEvent = (root) => (filename) => {
    if (filename == null) { fullScanNeeded = true; return; }
    const parts = relParts(filename);
    if (parts.length === 4 && CODEX_ID_RE.test(parts[3])) { dirty.add(path.join(root, ...parts)); return; }
    // A year, month or day folder appearing or going away: rare, walk again.
    if (parts.length && parts.length < 4 && !/\.[^\\/]+$/.test(parts[parts.length - 1])) fullScanNeeded = true;
  };
  const noteCursorEvent = (filename) => {
    if (filename == null) { fullScanNeeded = true; return; }
    const parts = relParts(filename);
    if (parts.length === 4 && parts[1] === 'agent-transcripts' && UUID_RE.test(parts[2]) && parts[3] === `${parts[2]}.jsonl`) {
      dirty.add(path.join(cursorRoot, ...parts));
      return;
    }
    // A project folder, or one chat's folder, appearing or going away. Worker
    // logs and terminals inside a project (the churn) change nothing listed.
    if (parts.length === 1 || (parts.length === 3 && parts[1] === 'agent-transcripts')) fullScanNeeded = true;
  };

  // Codex's native title index is re-read only when it changes.
  const titlesByHome = new Map(); // home -> { size, mtimeMs, titles }
  const titlesFor = async (home) => {
    const stat = await fsp.stat(path.join(home, 'session_index.jsonl')).catch(() => null);
    const hit = titlesByHome.get(home);
    if (stat && hit && hit.size === stat.size && hit.mtimeMs === stat.mtimeMs) return hit.titles;
    const titles = await readCodexTitles(home);
    if (stat) titlesByHome.set(home, { size: stat.size, mtimeMs: stat.mtimeMs, titles });
    else titlesByHome.delete(home);
    return titles;
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
    id, stat, cwdHint = null, projectHint = null, profileId = null, configHome = null,
  }) => {
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
      };
    }
    let facts = { cwd: null, firstUser: null };
    const stored = loadStoredFacts()?.[file];
    if (stored && stored.size === stat.size && stored.mtimeMs === stat.mtimeMs) {
      facts = stored.facts;
      if (stored.format && stored.format !== FACTS_FORMAT) pendingMigration.set(file, provider);
    } else {
      try {
        facts = await extractRowFacts(file, provider);
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
    };
    cache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, row });
    return row;
  };

  const rootInfo = (item) => (typeof item === 'string' ? { root: item, profileId: null, configHome: null } : item);

  // Walks one codex root into `into` (file -> entry) and `stats` (file -> stat).
  const walkCodexRoot = async (into, stats, rank) => {
    const { root: codexRoot, profileId = null, configHome = null } = rootInfo(codexRoots[rank]);
    const years = await fsp.readdir(codexRoot).catch(() => []);
    for (const year of years) {
      const months = await fsp.readdir(path.join(codexRoot, year)).catch(() => []);
      for (const month of months) {
        const days = await fsp.readdir(path.join(codexRoot, year, month)).catch(() => []);
        for (const day of days) {
          const dir = path.join(codexRoot, year, month, day);
          const names = await fsp.readdir(dir).catch(() => []);
          for (const name of names) {
            const id = name.match(CODEX_ID_RE)?.[1];
            if (!id) continue;
            const file = path.join(dir, name);
            const stat = await fsp.stat(file).catch(() => null);
            if (!stat) continue;
            into.set(file, { provider: 'codex', id, profileId, configHome, projectHint: null, rank });
            stats.set(file, stat);
          }
        }
      }
    }
  };

  const walkCursor = async (into, stats) => {
    const projects = await fsp.readdir(cursorRoot).catch(() => []);
    for (const project of projects) {
      const transcriptsDir = path.join(cursorRoot, project, 'agent-transcripts');
      const ids = await fsp.readdir(transcriptsDir).catch(() => []);
      for (const id of ids) {
        if (!UUID_RE.test(id)) continue;
        const file = path.join(transcriptsDir, id, `${id}.jsonl`);
        const stat = await fsp.stat(file).catch(() => null);
        if (!stat) continue;
        into.set(file, { provider: 'cursor', id, profileId: null, configHome: null, projectHint: project, rank: codexRoots.length });
        stats.set(file, stat);
      }
    }
  };

  // Which listed log a reported path is, or null (the same tests the walk applies).
  const entryForPath = (file) => {
    for (let rank = 0; rank < codexRoots.length; rank += 1) {
      const { root, profileId = null, configHome = null } = rootInfo(codexRoots[rank]);
      if (!file.startsWith(root + path.sep)) continue;
      const parts = relParts(file.slice(root.length + 1));
      const id = parts.length === 4 ? parts[3].match(CODEX_ID_RE)?.[1] : null;
      return id ? { provider: 'codex', id, profileId, configHome, projectHint: null, rank } : null;
    }
    if (file.startsWith(cursorRoot + path.sep)) {
      const parts = relParts(file.slice(cursorRoot.length + 1));
      if (parts.length === 4 && parts[1] === 'agent-transcripts' && UUID_RE.test(parts[2]) && parts[3] === `${parts[2]}.jsonl`) {
        return { provider: 'cursor', id: parts[2], profileId: null, configHome: null, projectHint: parts[0], rank: codexRoots.length };
      }
    }
    return null;
  };

  // Brings `known` up to date and returns the stats taken this pass: everything
  // on a full walk, only the reported files otherwise.
  const refreshKnown = async () => {
    const stats = new Map();
    if (fullScanNeeded || rootsUnwatched || !watchers.length) {
      fullScanNeeded = false;
      dirty.clear();
      const next = new Map();
      for (let rank = 0; rank < codexRoots.length; rank += 1) await walkCodexRoot(next, stats, rank);
      await walkCursor(next, stats);
      for (const file of cache.keys()) if (!next.has(file)) cache.delete(file);
      known.clear();
      for (const [file, entry] of next) known.set(file, entry);
      return stats;
    }
    const pending = [...dirty];
    dirty.clear();
    for (const file of pending) {
      const entry = entryForPath(file);
      if (!entry) continue;
      const stat = await fsp.stat(file).catch(() => null);
      if (!stat || !stat.isFile()) { known.delete(file); cache.delete(file); continue; }
      known.set(file, entry);
      stats.set(file, stat);
    }
    return stats;
  };

  // Codex roots in their configured order, then cursor; within each, the
  // folder order NTFS hands back (case-insensitive). Both refresh paths list
  // in this one order, so an incremental listing equals a full one.
  const listingOrder = (a, b) => (a[1].rank - b[1].rank)
    || (a[0].toLowerCase() < b[0].toLowerCase() ? -1 : a[0].toLowerCase() > b[0].toLowerCase() ? 1 : 0);

  const listSessions = async ({ knownCwds } = {}) => {
    const rows = [];
    await loadMetadata();
    const fresh = await refreshKnown();
    // Reverse the cwd munge from cwds Harbor already knows (claude history,
    // codex session_meta, live workspaces): a cursor transcript itself never
    // records its cwd. An unmatched project dir still lists, labeled by its
    // munged name, with cwd honestly null.
    const unmunge = new Map();
    for (const cwd of knownCwds || []) {
      if (cwd) unmunge.set(mungeCwdCached(cwd), cwd);
    }
    for (const [file, entry] of [...known].sort(listingOrder)) {
      let stat = fresh.get(file);
      const hit = cache.get(file);
      if (!stat && hit) {
        // Unchanged since it was last read: the cached row, with the keeper
        // metadata applied exactly as a cache hit in rowFor applies it.
        const metadata = durableMetadata?.[entry.id] || {};
        rows.push({
          ...hit.row,
          cwd: hit.row.cwd || metadata.cwd || null,
          profileId: hit.row.profileId || metadata.profileId || null,
          configHome: hit.row.configHome || metadata.configHome || null,
        });
        continue;
      }
      if (!stat) stat = await fsp.stat(file).catch(() => null);
      if (!stat) { known.delete(file); cache.delete(file); continue; }
      rows.push(await rowFor(file, entry.provider, {
        id: entry.id,
        stat,
        cwdHint: entry.provider === 'cursor' ? unmunge.get(entry.projectHint) || null : null,
        projectHint: entry.projectHint,
        profileId: entry.profileId,
        configHome: entry.configHome,
      }));
    }
    const nativeByHome = new Map();
    for (const item of codexRoots) {
      const home = typeof item === 'string' ? path.dirname(item) : item.configHome || path.dirname(item.root);
      nativeByHome.set(home, await titlesFor(home));
    }
    for (const row of rows) {
      if (row.provider !== 'codex' || row.isInternalSession) continue;
      const source = codexRoots.find(item => row.path.startsWith((typeof item === 'string' ? item : item.root) + path.sep));
      const home = source && (typeof source === 'string' ? path.dirname(source) : source.configHome || path.dirname(source.root));
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
      metaById.set(row.id, meta);
    }
    return rows;
  };

  // The transcript provider resolves sessions through this: path + provider
  // straight from the scan, no hints needed from the renderer.
  const metaFor = (id) => metaById.get(id) || null;

  const start = () => {
    // EXACTLY two watchers. A per-project watcher set was the first design
    // and it exhausted inotify instances (fs.watch = one instance each;
    // ~50 cursor projects pushed a single app past the 128 default alongside
    // the desktop's ~90, and the e2e harness daemon's reads went dark —
    // live-caught 2026-07-24 as spec 6 flaking). Cursor's non-transcript
    // churn (worker.log, terminals) is absorbed by the debounce.
    rootsUnwatched = 0;
    for (const item of codexRoots) {
      const root = typeof item === 'string' ? item : item.root;
      if (!watchDir(root, { recursive: true, onEvent: noteCodexEvent(root) })) rootsUnwatched += 1;
      // Renaming a chat changes this sibling index without touching its rollout
      // (re-read through titlesFor's size and mtime check).
      watchDir(path.dirname(root));
    }
    if (!watchDir(cursorRoot, { recursive: true, onEvent: noteCursorEvent })) rootsUnwatched += 1;
    fullScanNeeded = true;
  };

  const migrateEntries = async (limit = 8) => {
    let changed = 0; let attempted = 0;
    for (const [file, provider] of pendingMigration) {
      if (attempted++ >= limit) break;
      pendingMigration.delete(file);
      const stored = storedFacts?.[file]; if (!stored) continue;
      try {
        if (!COMPATIBLE_FACTS.has(stored.format)) {
          // Other reader fingerprints (including mixed checkout line endings)
          // refresh the whole head, but only after boot and one batch at a time.
          stored.facts = storableFacts(await extractRowFacts(file, provider));
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
    flushStoredFacts();
    migrationClosed = true; clearTimeout(migrationTimer);
    clearTimeout(changedTimer);
    for (const watcher of watchers) watcher.close();
    watchers.length = 0;
  };

  return {
    emitter, listSessions, metaFor, start, close, migrateEntries, startBackgroundMigration,
    rememberedLinkFor: async id => (await loadMetadata())[id] || null,
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

module.exports = { createProviderHistory, formatLocal, mungeCwd, mergeProviderKeeperRows };
