'use strict';

// Codex/cursor panes get their real session id from evidence, not a guess.
//
// Agent detection names the agent in a pane ('codex') but reports
// agent_session: null for it, always (verified live 2026-07-25 against the
// running daemon: the pane reports agent codex with agent_session null,
// while every claude pane carries an id). A pane with no session id has no
// transcript, so its window had nothing to render and fell back to the raw
// terminal; that fallback IS the "GPT sessions still look like a terminal"
// complaint. Harbor supplies the missing id itself, from what the CLIs write:
//
//   argv    `codex resume … <id>` / `cursor-agent --resume <id>` carry the id
//           in the pane's own command line: exact, no inference.
//   codex   ~/.codex/history.jsonl        one line per INTERACTIVE prompt:
//                                         {session_id, ts, text}. `codex exec`
//                                         workers never appear here (verified
//                                         2026-07-25), so a delegate fleet in
//                                         the same folder can never be
//                                         mistaken for the pane's session.
//           ~/.codex/sessions/Y/M/D/rollout-<stamp>-<id>.jsonl
//                                         first line is session_meta, which
//                                         carries the session's cwd.
//   cursor  ~/.cursor/projects/<munged-cwd>/agent-transcripts/<id>/<id>.jsonl
//                                         the cwd is the directory name and
//                                         the file's birth time is the start.
//
// The rule for a session Harbor did not launch: it belongs to the pane whose
// agent PROCESS started last before that session began, in the same cwd. A
// session that began before a pane's process existed cannot be running in it.
// When more than one pane in a folder qualifies, the tie is broken by reading
// the pane's own screen for that session's prompt text; a tie that cannot be
// broken stays UNLINKED, because rendering another session's conversation in
// this window would be worse than rendering none.

const { EventEmitter } = require('node:events');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

// One prompt line is small; this tail covers weeks of interactive codex use
// and bounds the read on a history file that only ever grows.
const HISTORY_TAIL_BYTES = 512 * 1024;
// Codex stamps history in whole seconds and /proc start times come from a
// different clock read; allow for that, not for a real ordering difference.
const START_SKEW_MS = 5_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Cursor's munge collapses every RUN of non-alphanumerics to one dash
// ('C:\dev\x' -> 'C-dev-x'). The per-character spelling this carried until
// 2026-08-23 pointed cursorSessionsFor at directories that never exist on a
// Windows machine, so no live cursor pane could be linked to its session by
// cwd. Matches mungeCwd in provider-history.js and transcript.js.
function cursorProjectDir(cwd) {
  return String(cwd || '').replace(/^\/+/, '').replace(/[^a-zA-Z0-9]+/g, '-');
}

// `codex resume <id>` / `cursor-agent --resume <id>`: the pane's command line
// names the session outright. Nothing else in either argv is uuid-shaped.
function sessionIdFromArgv(argv) {
  for (const arg of argv || []) {
    if (UUID_RE.test(String(arg).trim())) return String(arg).trim();
  }
  return null;
}

// Interactive codex prompts only. Returns the session's FIRST prompt time in
// milliseconds (when the session became real on disk) plus its most recent
// prompt texts, which break ties between panes sharing a folder.
async function readCodexHistory(historyPath, { maxBytes = HISTORY_TAIL_BYTES } = {}) {
  let handle = null;
  let text = '';
  try {
    const stat = await fsp.stat(historyPath);
    handle = await fsp.open(historyPath, 'r');
    const start = Math.max(0, stat.size - maxBytes);
    const buffer = Buffer.alloc(stat.size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    text = buffer.toString('utf8', 0, bytesRead);
    if (start > 0) text = text.slice(text.indexOf('\n') + 1); // drop the partial head line
  } catch {
    return new Map();
  } finally {
    await handle?.close().catch(() => {});
  }
  const sessions = new Map();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row = null;
    try { row = JSON.parse(line); } catch { continue; }
    const id = row?.session_id;
    const ts = Number(row?.ts);
    if (!id || !Number.isFinite(ts)) continue;
    const startedMs = ts * 1000;
    const seen = sessions.get(id);
    if (!seen) {
      sessions.set(id, { id, startedMs, texts: [String(row.text ?? '')] });
      continue;
    }
    if (startedMs < seen.startedMs) seen.startedMs = startedMs;
    seen.texts.push(String(row.text ?? ''));
    if (seen.texts.length > 4) seen.texts.shift();
  }
  return sessions;
}

// The rollout carries the session's cwd in its first line. Filenames embed a
// launch stamp, so the id alone cannot name the path: the dated directories
// are scanned newest-first.
async function findCodexRollout(sessionId, { home = os.homedir(), codexHome = null } = {}) {
  const root = path.join(codexHome || path.join(home, '.codex'), 'sessions');
  const years = (await fsp.readdir(root).catch(() => [])).sort().reverse();
  for (const year of years) {
    const months = (await fsp.readdir(path.join(root, year)).catch(() => [])).sort().reverse();
    for (const month of months) {
      const days = (await fsp.readdir(path.join(root, year, month)).catch(() => [])).sort().reverse();
      for (const day of days) {
        const dir = path.join(root, year, month, day);
        const names = await fsp.readdir(dir).catch(() => []);
        const name = names.find((item) => item.endsWith(`${sessionId}.jsonl`));
        if (name) return path.join(dir, name);
      }
    }
  }
  return null;
}

// The session_meta line has no size Harbor controls: codex 0.147.0 ships the
// whole system prompt inside it (payload.base_instructions), and a real
// rollout's first line measured 18,139 bytes on 2026-08-08. A fixed 8KB read
// parsed a truncated line and answered null for EVERY rollout on that codex
// version, which silently unlinked every codex pane from its session and made
// findFreshTranscript skip every candidate. So the WHOLE first line is read,
// chunked in the byte domain (0x0a cannot occur inside a UTF-8 sequence, so
// splitting on it never tears a character) and decoded once. The cap only
// bounds a corrupted file that never ends its first line.
const ROLLOUT_META_MAX_BYTES = 4 * 1024 * 1024;

async function readCodexRolloutCwd(rolloutPath) {
  let handle = null;
  try {
    handle = await fsp.open(rolloutPath, 'r');
    const chunks = [];
    let position = 0;
    let sawNewline = false;
    while (position < ROLLOUT_META_MAX_BYTES && !sawNewline) {
      const chunk = Buffer.alloc(64 * 1024);
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead <= 0) break;
      const slice = chunk.subarray(0, bytesRead);
      const newline = slice.indexOf(0x0a);
      chunks.push(newline >= 0 ? slice.subarray(0, newline) : slice);
      sawNewline = newline >= 0;
      position += bytesRead;
    }
    const row = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return row?.payload?.cwd || null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function listCursorSessions(cwd, { home = os.homedir() } = {}) {
  const dir = path.join(home, '.cursor', 'projects', cursorProjectDir(cwd), 'agent-transcripts');
  const ids = await fsp.readdir(dir).catch(() => []);
  const out = [];
  for (const id of ids) {
    const stat = await fsp.stat(path.join(dir, id, `${id}.jsonl`)).catch(() => null);
    if (!stat) continue;
    out.push({ id, cwd, startedMs: stat.birthtimeMs || stat.mtimeMs, texts: [] });
  }
  return out;
}

function normalizeForScreen(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

// Panes are {paneId, cwd, startedMs}; sessions are {id, cwd, startedMs, texts}.
// Sessions are applied oldest-first, so a pane that ran several sessions (codex
// /new keeps the same process) ends on its most recent one.
async function assignSessionsToPanes(panes, sessions, { readPaneText = null } = {}) {
  const links = new Map(); // paneId -> sessionId
  const screens = new Map();
  const screenFor = async (paneId) => {
    if (screens.has(paneId)) return screens.get(paneId);
    let text = null;
    try { text = readPaneText ? await readPaneText(paneId) : null; } catch { text = null; }
    const normalized = text ? normalizeForScreen(text) : null;
    screens.set(paneId, normalized);
    return normalized;
  };

  for (const session of [...sessions].sort((a, b) => a.startedMs - b.startedMs)) {
    if (!session.cwd) continue;
    const eligible = panes.filter((pane) => (
      pane.cwd === session.cwd
      && Number.isFinite(pane.startedMs)
      && pane.startedMs <= session.startedMs + START_SKEW_MS
    ));
    if (!eligible.length) continue;
    if (eligible.length === 1) {
      links.set(eligible[0].paneId, session.id);
      continue;
    }
    // More than one pane in this folder could hold the session. Ask the panes:
    // the one showing this session's prompt owns it. No match, no link.
    const needles = (session.texts || [])
      .map((text) => normalizeForScreen(text).slice(0, 60))
      .filter((needle) => needle.length >= 12);
    if (!needles.length) continue;
    const showing = [];
    for (const pane of eligible) {
      const screen = await screenFor(pane.paneId);
      if (screen && needles.some((needle) => screen.includes(needle))) showing.push(pane);
    }
    if (showing.length === 1) links.set(showing[0].paneId, session.id);
  }
  return links;
}

function createProviderSessionLinker(options = {}) {
  const {
    home = os.homedir(),
    profiles = [],
    listPanes,        // () => [{ pane_id, agent, agent_session, cwd, workspace_id }]
    paneAgentProcess, // async (paneId) => { pid, startedMs, cwd, argv } | null
    readPaneText = null, // async (paneId) => string  (tie-break only)
    annotateSessionIdentity = null, // async (paneId, { agent, agentSession }) => keeper acknowledgement
    rememberLink = null, // async (durable derived metadata) => void
    intervalMs = 5_000,
  } = options;
  const emitter = new EventEmitter();
  const links = new Map();      // paneId -> sessionId
  const rolloutCwd = new Map(); // sessionId -> cwd | null (null retried: the rollout may not exist yet)
  const identityMeta = new Map(); // sessionId -> owning provider-home facts
  const codexSources = profiles
    .filter((profile) => profile?.provider === 'codex' && profile.configHome)
    .map((profile) => ({ profileId: profile.id, configHome: profile.configHome }));
  if (!codexSources.length) codexSources.push({ profileId: null, configHome: path.join(home, '.codex') });
  let timer = null;
  let running = false;
  let closed = false;

  const codexCwdFor = async (sessionId, source) => {
    const cacheKey = `${source.configHome}\0${sessionId}`;
    const cached = rolloutCwd.get(cacheKey);
    if (cached) return cached;
    const rollout = await findCodexRollout(sessionId, { home, codexHome: source.configHome });
    const cwd = rollout ? await readCodexRolloutCwd(rollout) : null;
    rolloutCwd.set(cacheKey, cwd);
    if (rollout && cwd) identityMeta.set(sessionId, { ...source, transcriptPath: rollout });
    return cwd;
  };

  const record = async (paneId, sessionId, pane, rawPanes) => {
    if (!sessionId || links.get(paneId) === sessionId) return false;
    if (annotateSessionIdentity) {
      try {
        await annotateSessionIdentity(paneId, { agent: pane.agent, agentSession: sessionId });
      } catch (error) {
        // Discovery evidence remains valid and is reconsidered on the next
        // tick. Do not publish the overlay before keeper acknowledgement.
        if (emitter.listenerCount('error')) emitter.emit('error', error);
        return false;
      }
    }
    if (rememberLink) {
      const metadata = identityMeta.get(sessionId) || {};
      await rememberLink({
        id: sessionId,
        provider: pane.agent,
        cwd: pane.cwd || null,
        paneId,
        profileId: metadata.profileId || null,
        configHome: metadata.configHome || null,
        transcriptPath: metadata.transcriptPath || null,
      });
    }
    links.set(paneId, sessionId);
    emitter.emit('link', {
      paneId,
      sessionId,
      provider: pane?.agent || null,
      cwd: pane?.cwd || null,
      workspaceId: rawPanes.find((item) => item.pane_id === paneId)?.workspace_id || null,
    });
    return true;
  };

  const resolveOnce = async () => {
    const panes = (listPanes?.() || []).filter((pane) => (
      ['codex', 'cursor'].includes(pane?.agent) && !pane?.agent_session
    ));
    // A link outlives neither its pane nor its agent: a stale one would keep a
    // dead session green in the rail and route the next send at it.
    const alive = new Set(panes.map((pane) => pane.pane_id));
    let changed = false;
    for (const paneId of [...links.keys()]) {
      if (!alive.has(paneId)) { links.delete(paneId); changed = true; }
    }
    if (!panes.length) return changed;

    const withStart = [];
    for (const pane of panes) {
      const info = await paneAgentProcess(pane.pane_id).catch(() => null);
      if (!info || !Number.isFinite(info.startedMs)) continue;
      withStart.push({
        paneId: pane.pane_id,
        agent: pane.agent,
        // The agent process's own cwd beats the workspace's: a pane can be cd'd
        // elsewhere before the agent starts.
        cwd: info.cwd || pane.cwd || null,
        startedMs: info.startedMs,
        argv: info.argv || [],
      });
    }
    if (!withStart.length) return changed;

    // A resumed session names itself in argv. Nothing to infer.
    const inferred = [];
    for (const pane of withStart) {
      const fromArgv = sessionIdFromArgv(pane.argv);
      if (fromArgv) {
        if (await record(pane.paneId, fromArgv, pane, panes)) changed = true;
      } else if (!links.has(pane.paneId)) {
        inferred.push(pane);
      }
    }
    if (!inferred.length) return changed;

    const claimed = new Set(links.values());
    const candidates = [];

    const codexPanes = inferred.filter((pane) => pane.agent === 'codex' && pane.cwd);
    if (codexPanes.length) {
      const cwds = new Set(codexPanes.map((pane) => pane.cwd));
      const oldestPaneStart = Math.min(...codexPanes.map((pane) => pane.startedMs));
      for (const source of codexSources) {
        const history = await readCodexHistory(path.join(source.configHome, 'history.jsonl'));
        for (const session of history.values()) {
          // Only sessions that could belong to one of these panes are worth a
          // rollout scan; the history file spans months.
          if (session.startedMs + START_SKEW_MS < oldestPaneStart) continue;
          if (claimed.has(session.id)) continue;
          const cwd = await codexCwdFor(session.id, source);
          if (!cwd || !cwds.has(cwd)) continue;
          candidates.push({ ...session, cwd });
        }
      }
    }

    for (const pane of inferred.filter((item) => item.agent === 'cursor' && item.cwd)) {
      for (const session of await listCursorSessions(pane.cwd, { home })) {
        if (claimed.has(session.id)) continue;
        if (candidates.some((item) => item.id === session.id)) continue;
        candidates.push(session);
      }
    }
    if (!candidates.length) return changed;

    const resolved = await assignSessionsToPanes(inferred, candidates, { readPaneText });
    for (const [paneId, sessionId] of resolved) {
      const pane = inferred.find((item) => item.paneId === paneId);
      if (await record(paneId, sessionId, pane, panes)) changed = true;
    }
    return changed;
  };

  const tick = async () => {
    if (running || closed) return false;
    running = true;
    try {
      const changed = await resolveOnce();
      if (changed) emitter.emit('changed');
      return changed;
    } catch (error) {
      emitter.emit('error', error);
      return false;
    } finally {
      running = false;
    }
  };

  return {
    emitter,
    // Applied to the pane list before the sidebar model merges it: a resolved
    // pane looks exactly like a claude pane the daemon named itself, so the rail
    // row, the window key, and every ownership test downstream work unchanged.
    apply(panes) {
      if (!links.size) return panes;
      return (panes || []).map((pane) => {
        const sessionId = links.get(pane?.pane_id);
        if (!sessionId || pane.agent_session) return pane;
        return {
          ...pane,
          agent_session: {
            agent: pane.agent, kind: 'id', source: 'harbor:provider-link', value: sessionId,
          },
        };
      });
    },
    get(paneId) { return links.get(paneId) || null; },
    all() { return Object.fromEntries(links); },
    resolveNow: tick,
    start() {
      if (timer || closed) return;
      timer = setInterval(tick, intervalMs);
      timer.unref?.();
      tick();
    },
    close() {
      closed = true;
      clearInterval(timer);
      timer = null;
    },
  };
}

module.exports = {
  createProviderSessionLinker,
  readCodexHistory,
  findCodexRollout,
  readCodexRolloutCwd,
  listCursorSessions,
  assignSessionsToPanes,
  sessionIdFromArgv,
  cursorProjectDir,
};
