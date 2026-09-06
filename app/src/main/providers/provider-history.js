'use strict';

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
const { readCodexRolloutCwd } = require('./provider-session-link.js');

const CODEX_ID_RE = /([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEAD_BYTES = 256 * 1024;
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

async function readHead(file) {
  const handle = await fsp.open(file, 'r');
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.toString('utf8', 0, bytesRead);
  } finally {
    await handle.close();
  }
}

// Parse the head of a provider transcript with the real conversation parser
// and pull the facts a rail row needs: the first genuinely-human user text
// (title material) and, for codex, the session_meta cwd.
async function extractRowFacts(file, provider) {
  const head = await readHead(file);
  const lines = head.split('\n').slice(0, HEAD_LINES);
  const parser = new TranscriptParser(provider);
  // The first Codex record is unbounded (it currently embeds the system
  // prompt), so cwd uses the complete-line reader rather than this module's
  // bounded conversation head.
  let cwd = provider === 'codex' ? await readCodexRolloutCwd(file) : null;
  for (const line of lines) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (provider === 'codex' && obj.type === 'session_meta') {
      cwd = obj.payload?.cwd || null;
    }
    try { parser.applyLine(obj); } catch { /* a malformed line never kills the row */ }
    const firstUser = parser.blocks.find((b) => b.kind === 'user' && b.text);
    if (firstUser && (provider !== 'codex' || cwd)) {
      return { cwd, firstUser: firstUser.text };
    }
  }
  const firstUser = parser.blocks.find((b) => b.kind === 'user' && b.text);
  return { cwd, firstUser: firstUser?.text || null };
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
      const watcher = fs.watch(dir, { recursive }, scheduleChanged);
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
    try { facts = await extractRowFacts(file, provider); } catch { /* unreadable head; row still lists */ }
    const cwd = facts.cwd || cwdHint || metadata.cwd || null;
    const row = {
      id,
      lastActive: formatLocal(stat.mtimeMs),
      project: (cwd ? projectLabelForCwd(cwd) : projectHint) || projectHint || '',
      title: oneLine(facts.firstUser) || `(${provider} session)`,
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
    for (const item of codexRoots) watchDir(typeof item === 'string' ? item : item.root, { recursive: true });
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
