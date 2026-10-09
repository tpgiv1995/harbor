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

function oneLine(text, max = TITLE_MAX) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// The persisted facts are only as good as the code that read them, so their
// format IS that code: a hash of every module extractRowFacts runs. Any change
// to the parser, the title rule or the rollout-meta reader rebuilds the cache
// on the next launch by itself; nobody has to remember to bump a number.
const FACTS_FORMAT = (() => {
  const hash = require('node:crypto').createHash('sha1');
  for (const file of [__filename, './transcript.js', './session-title.cjs', './provider-session-link.js', '../../shared/claude-turn-state.cjs']) {
    try { hash.update(fs.readFileSync(file === __filename ? file : require.resolve(file))); } catch { hash.update(file); }
  }
  return hash.digest('hex').slice(0, 16);
})();
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
  const loadStoredFacts = () => {
    if (storedFacts || !factsCacheFile) return storedFacts;
    storedFacts = {};
    try {
      const parsed = JSON.parse(fs.readFileSync(factsCacheFile, 'utf8'));
      if (parsed?.format === FACTS_FORMAT && parsed.files && typeof parsed.files === 'object') storedFacts = parsed.files;
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
  let changedTimer = null;

  const scheduleChanged = () => {
    clearTimeout(changedTimer);
    changedTimer = setTimeout(() => emitter.emit('changed'), debounceMs);
    changedTimer.unref?.();
  };

  const watchDir = (dir, { recursive = false } = {}) => {
    try {
      const watcher = watchPath(dir, { recursive }, scheduleChanged);
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
    } else {
      try {
        facts = await extractRowFacts(file, provider);
        if (storedFacts) {
          storedFacts[file] = { size: stat.size, mtimeMs: stat.mtimeMs, facts: storableFacts(facts) };
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

  const scanCodexRoot = async (rows, { root: codexRoot, profileId, configHome }) => {
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
            rows.push(await rowFor(file, 'codex', { id, stat, profileId, configHome }));
          }
        }
      }
    }
  };

  const scanCodex = async (rows) => {
    for (const root of codexRoots) await scanCodexRoot(rows, typeof root === 'string' ? { root } : root);
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
    for (const item of codexRoots) {
      const root = typeof item === 'string' ? item : item.root;
      watchDir(root, { recursive: true });
      // Renaming a chat changes this sibling index without touching its rollout.
      watchDir(path.dirname(root));
    }
    watchDir(cursorRoot, { recursive: true });
  };

  const close = () => {
    clearTimeout(changedTimer);
    for (const watcher of watchers) watcher.close();
    watchers.length = 0;
  };

  return {
    emitter, listSessions, metaFor, start, close,
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
