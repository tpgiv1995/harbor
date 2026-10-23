'use strict';
const { parentPort } = require('node:worker_threads');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { createBackgroundState, applyBackgroundLine, backgroundSnapshot, interestingLine } = require('./background-tasks.js');
const { readSessionOwner } = require('./session-owner.js');
const { isCompressed, createRolloutReadStream } = require('./codex-rollout-files.js');
const RECENT_WINDOW_MS = 48 * 60 * 60 * 1000;
// A Codex parent's shell commands are evidence only when they can launch an
// agent; everything else (ls, grep, the test run) is not inventory. The word
// test is only a cheap prefilter: `sed ... codex-screen.js`, `cat
// ~/.claude/settings.json` and `rg claude` all pass it, so every candidate is
// then parsed by the dispatch grammar and only a real dispatch is kept. A
// lookalike that reached the capped list would evict the real dispatches.
const DISPATCH_WORDS = /\b(codex|claude|cursor-agent|astra-run)\b/;
let dispatchGrammar = null;
function isDispatch(text, cwd) {
  if (!DISPATCH_WORDS.test(text)) return false;
  // Required lazily: delegations.js is the grammar's one home. It is not
  // hashed into FOLD_FORMAT: codexBackground re-reads every kept command
  // through the same grammar, so a grammar change cannot surface a stale one.
  dispatchGrammar ||= require('./delegations.js').dispatchFor;
  return Boolean(dispatchGrammar({ command: text, cwd: cwd || null }, cwd || null));
}
const RESULT_MAX = 2000;
const COMMANDS_MAX = 50;

// Codex runs every shell command as [shell, '-lc', script]; the script is what
// the dispatch grammar reads. Any other argv is re-quoted into one shell line.
function commandText(command) {
  if (typeof command === 'string') return command;
  if (!Array.isArray(command)) return '';
  if (command.length === 3 && /^-\w*c$/.test(String(command[1]))) return String(command[2]);
  return command.map((word) => (/[\s'"\\$;&|<>]/.test(String(word)) ? `'${String(word).replace(/'/g, "'\\''")}'` : String(word))).join(' ');
}
function durationMs(duration) {
  if (duration && typeof duration === 'object') return (Number(duration.secs) || 0) * 1000 + (Number(duration.nanos) || 0) / 1e6;
  return Number(duration) || 0;
}
// `codex exec --json` prints `thread.started {thread_id}` first. When the
// parent captured that stdout, it is the child's exact identity.
function startedThreadId(output) {
  for (const line of String(output || '').split('\n')) {
    if (!line.includes('thread.started')) continue;
    const id = line.match(/"thread_id"\s*:\s*"([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})"/i)?.[1];
    if (id) return id;
  }
  return null;
}
// Turn ends are three-valued: a task_complete carrying `error` is a failed
// turn, never "done", and turn_aborted is a stop the user or CLI made.
function applyCodexSignal(signal, row) {
  const ms = Date.parse(row.timestamp) || 0;
  const payload = row.payload || {};
  signal.lastSignalMs = Math.max(signal.lastSignalMs || 0, ms);
  if (row.type === 'turn_context' && payload.model) signal.model = payload.model;
  if (row.type !== 'event_msg') return;
  if (payload.type === 'task_started') Object.assign(signal, { working: true, startedMs: ms, error: null, result: null });
  if (['task_complete', 'turn_aborted'].includes(payload.type)) {
    const failed = payload.type === 'task_complete' && payload.error;
    Object.assign(signal, { working: false, endedMs: ms,
      outcome: payload.type === 'turn_aborted' ? 'stopped' : failed ? 'failed' : 'done',
      error: failed ? String(payload.error.message || 'turn failed').slice(0, 500) : null });
    if (payload.type === 'task_complete' && typeof payload.last_agent_message === 'string' && payload.last_agent_message.trim()) {
      signal.result = payload.last_agent_message.trim().slice(0, RESULT_MAX);
    }
  }
  const item = payload.type === 'item_completed' ? payload.item : null;
  if (item?.type !== 'CommandExecution') return;
  const text = commandText(item.command);
  if (!isDispatch(text, item.cwd)) return;
  const exitCode = Number.isInteger(item.exit_code) ? item.exit_code : null;
  const commands = signal.commands || (signal.commands = []);
  commands.push({
    id: `cmd:${item.id || item.process_id || ms}`, kind: 'command', command: text.slice(0, 16000), cwd: item.cwd || null,
    processId: item.process_id ?? null, exitCode,
    status: item.status === 'failed' || (exitCode != null && exitCode !== 0) ? 'failed' : 'completed',
    startedMs: Math.max(0, Math.round(ms - durationMs(item.duration))), endedMs: ms, lastSignalMs: ms, blocking: false,
    description: text.replace(/\s+/g, ' ').trim().slice(0, 120),
    threadId: text.includes('--json') ? startedThreadId(item.aggregated_output ?? item.stdout) : null,
  });
  if (commands.length > COMMANDS_MAX) commands.splice(0, commands.length - COMMANDS_MAX);
}

// Splits byte chunks into lines and applies the interesting ones. The final
// partial line stays in the carry (split UTF-8 and huge lines included).
function createLineApplier(entry, provider) {
  let carry = []; let carryBytes = 0;
  const apply = (line) => {
    if (provider === 'claude' ? !interestingLine(line) : !line.includes('event_msg') && !line.includes('turn_context')) return;
    let row; try { row = JSON.parse(line); } catch { return; }
    if (provider === 'claude') applyBackgroundLine(entry.state, row);
    else applyCodexSignal(entry.signal, row);
  };
  return {
    push(data) {
      let start = 0; let end;
      while ((end = data.indexOf(10, start)) >= 0) {
        const piece = data.subarray(start, end);
        const line = carry.length ? Buffer.concat([...carry, piece], carryBytes + piece.length).toString('utf8') : piece.toString('utf8');
        carry = []; carryBytes = 0; start = end + 1;
        apply(line);
      }
      if (start < data.length) { carry.push(data.subarray(start)); carryBytes += data.length - start; }
    },
    // A closed file's last line may lack its newline.
    flush() { if (carryBytes) apply(Buffer.concat(carry, carryBytes).toString('utf8')); carry = []; carryBytes = 0; },
    get carryBytes() { return carryBytes; },
  };
}

// A .jsonl.zst rollout is closed: codex compresses only a finished session and
// never appends to it. Read raw, its bytes never contain "event_msg", so every
// compressed child kept an empty signal and showed running or quiet, with its
// result and error lost. It is decompressed once; the entry is reused while
// size and mtime hold (for a closed file, forever) and persists with the fold.
// A rollout that closed inside a turn (the process died, then codex compressed
// it) cannot still be running: it reads as ended, outcome unknown.
async function scanCompressed(file, entry) {
  const applier = createLineApplier(entry, 'codex');
  const stream = createRolloutReadStream(file);
  try {
    for await (const chunk of stream) {
      applier.push(chunk);
      await new Promise((resolve) => setImmediate(resolve));
    }
    applier.flush();
  } finally { stream.destroy(); }
  const signal = entry.signal;
  if (signal.working) Object.assign(signal, { working: false, endedMs: signal.lastSignalMs || 0, outcome: 'ended', closedMidTurn: true });
}

// THE FOLD RESUMES WHERE IT STOPPED, ACROSS RESTARTS (2026-10-09). Each file's
// fold (byte offset, background state, codex signal) lived only in this
// worker's memory, so every launch re-read every transcript active in the last
// 48 hours from byte 0: 116 files, 1.4GB, 13s measured, and the window waits on
// it. With a cache file the entries are loaded once and saved after any pass
// that moved them, so a launch reads only what was appended since. The format
// is a hash of the code that produced the entries (this file and the fold), so
// a changed fold rule rebuilds from byte 0 by itself.
const FOLD_FORMAT = (() => {
  const hash = require('node:crypto').createHash('sha1');
  for (const file of [__filename, require.resolve('./background-tasks.js')]) {
    try { hash.update(fs.readFileSync(file)); } catch { hash.update(file); }
  }
  return hash.digest('hex').slice(0, 16);
})();
// These releases used the identical Claude fold; only worker IPC changed.
// Include LF/CRLF checkout combinations. Retire these aliases if fold rules change.
// The codex fold did change after them (failed and stopped turn ends, shell
// dispatches, compressed rollouts), so an alias keeps its Claude entries and
// drops every entry carrying a codex signal, which then refolds from byte 0.
const COMPATIBLE_FOLDS = new Set(['da8a47743f347015', 'b7d5c8c82fa4a0d8', '3bacf1adab371f28', 'b6ab383315834542',
  '772090574c4aa232', '095de10019fae719', 'fa5791d81001f1bc', '98053b8e3ca2e151']);

function createScanner() {
  const files = new Map();
  const touched = new Set();
  let dirty = false;
  async function scan(file, provider = 'claude') {
    touched.add(file);
    const stat = await fsp.stat(file);
    let entry = files.get(file);
    if (entry && entry.size === stat.size && entry.mtimeMs === stat.mtimeMs) return entry;
    dirty = true;
    if (provider !== 'claude' && isCompressed(file)) {
      entry = { offset: 0, state: createBackgroundState(), signal: {} };
      await scanCompressed(file, entry);
      Object.assign(entry, { offset: stat.size, size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino });
      files.set(file, entry);
      return entry;
    }
    if (!entry || stat.size <= entry.size || stat.ino !== entry.ino) entry = { offset: 0, state: createBackgroundState(), signal: {} };
    // The final partial line is held by
    // offset, then read again on append, including split UTF-8 and huge lines.
    let bytes = entry.offset;
    const handle = await fsp.open(file, 'r');
    const applier = createLineApplier(entry, provider);
    try {
      while (bytes < stat.size) {
        const buffer = Buffer.alloc(Math.min(64 * 1024, stat.size - bytes));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, bytes);
        if (!bytesRead) break;
        bytes += bytesRead;
        applier.push(buffer.subarray(0, bytesRead));
        await new Promise((resolve) => setImmediate(resolve));
      }
    } finally { await handle.close(); }
    Object.assign(entry, { offset: bytes - applier.carryBytes, size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino });
    files.set(file, entry);
    return entry;
  }
  // Seeded once from disk; a missing, unreadable or other-format file seeds
  // nothing and the first pass reads from byte 0, exactly as before.
  scan.load = (cacheFile) => {
    try {
      const parsed = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if ((parsed?.format !== FOLD_FORMAT && !COMPATIBLE_FOLDS.has(parsed?.format)) || !parsed.files || typeof parsed.files !== 'object') return;
      const alias = parsed.format !== FOLD_FORMAT;
      for (const [file, entry] of Object.entries(parsed.files)) {
        if (alias && entry?.signal && Object.keys(entry.signal).length) continue;
        if (entry && Number.isFinite(entry.offset) && entry.state && entry.signal) files.set(file, entry);
      }
    } catch { /* first launch */ }
  };
  // Saves the entries this pass touched (a file that left the 48h window is
  // dropped with it). A failed write costs the next launch a reread, nothing more.
  scan.save = async (cacheFile) => {
    for (const file of [...files.keys()]) if (!touched.has(file)) { files.delete(file); dirty = true; }
    touched.clear();
    if (!dirty) return;
    dirty = false;
    // Serialized BEFORE the first await: the next pass can start the moment
    // this one yields, and it mutates entries in place as it folds, so a later
    // snapshot could pair one pass's state with another's offset.
    const body = JSON.stringify({ format: FOLD_FORMAT, files: Object.fromEntries(files) });
    const temporary = `${cacheFile}.${process.pid}.${Date.now()}.tmp`;
    try {
      await fsp.mkdir(path.dirname(cacheFile), { recursive: true });
      await fsp.writeFile(temporary, body);
      for (let attempt = 0; ; attempt += 1) {
        try { await fsp.rename(temporary, cacheFile); break; } catch (error) {
          if (attempt >= 4 || !['EPERM', 'EACCES', 'EBUSY'].includes(error?.code)) throw error;
          await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
        }
      }
    } catch {
      dirty = true;
      await fsp.rm(temporary, { force: true }).catch(() => {});
    }
  };
  scan.endPass = () => touched.clear();
  return scan;
}
const scan = createScanner();
let loadedCacheFile = null;
// A Codex session is a parent when it dispatched agents through its shell or
// spawned subagents/guardians of its own. It is never a parent when it is
// itself somebody's child (lineage or a dispatch link), which keeps one family
// from being drawn twice.
function codexBackground(row, dispatchFor) {
  const signal = row.signal || {};
  return { tasks: (signal.commands || []).filter((task) => dispatchFor(task, row.cwd)),
    working: Boolean(signal.working), awaitingFinal: false,
    lastInTurnMs: signal.working ? signal.lastSignalMs || 0 : 0, lastSignalMs: signal.lastSignalMs || 0 };
}
// `-o FILE` is the only result an --ephemeral child leaves. Its present bytes
// prove the historical run only when the file was written during that run.
async function readOutputResult(dispatch) {
  if (!dispatch.outputFile || !dispatch.endedMs) return null;
  const file = path.resolve(dispatch.cwd || '', dispatch.outputFile);
  try {
    const stat = await fsp.stat(file);
    if (stat.mtimeMs < dispatch.startedMs - 1000 || stat.mtimeMs > dispatch.endedMs + 60_000) return null;
    const handle = await fsp.open(file, 'r');
    try {
      const buffer = Buffer.alloc(Math.min(4096, stat.size));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      return buffer.subarray(0, bytesRead).toString('utf8').trim().slice(0, RESULT_MAX) || null;
    } finally { await handle.close(); }
  } catch { return null; }
}
async function scanRows(rows, liveIds = [], now = Date.now(), ownerOptions) {
  const live = new Set(liveIds); const claudeParents = []; const providers = [];
  for (const row of rows) {
    if (!row.path) continue;
    if (row.provider === 'codex') {
      providers.push({ ...row, signal: {} });
    } else if (!row.provider || row.provider === 'claude') {
      if (!live.has(row.id) && Date.parse(row.lastActive) < now - RECENT_WINDOW_MS) continue;
      try {
        const entry = await scan(row.path);
        const ownerEvidence = { ...await readSessionOwner(row.id, ownerOptions), lastWriteMs: entry.mtimeMs };
        claudeParents.push({ ...row, isLive: live.has(row.id), ownerEvidence, background: backgroundSnapshot(entry.state, now) });
      } catch { /* unreadable file is retried */ }
    }
  }
  const scanned = new Set();
  const scanProvider = async (row) => {
    if (scanned.has(row.id)) return;
    scanned.add(row.id);
    try {
      const entry = await scan(row.path, 'codex');
      row.signal = entry.signal; row.lastWriteMs = entry.mtimeMs;
    } catch { /* unreadable linked evidence remains unknown */ }
  };
  // Discovery: live or recent Codex rollouts are read first, because a Codex
  // parent's dispatches live in its own rollout and must exist before linking.
  for (const row of providers) {
    if (live.has(row.id) || row.lastWriteMs >= now - RECENT_WINDOW_MS) await scanProvider(row);
  }
  // The window limits discovery, never evidence for an established link.
  // Resolve against metadata first, then include every linked descendant,
  // even when rows arrive in child-before-parent order or the root is absent.
  const { linkDispatches, buildDelegationGroups, dispatchFor } = require('./delegations.js');
  const children = new Map();
  for (const row of providers) {
    const parentId = row.lineage?.parentThreadId || row.delegatedBy;
    if (!parentId) continue;
    if (!children.has(parentId)) children.set(parentId, []);
    children.get(parentId).push(row.id);
  }
  const spawners = new Set(providers.map((row) => row.lineage?.parentThreadId).filter(Boolean));
  const codexParentsExcept = (claimed) => providers.filter((row) => scanned.has(row.id)
    && !row.lineage?.parentThreadId && !row.delegatedBy && !claimed[row.id] && row.lineage?.kind !== 'guardian')
    .map((row) => ({ ...row, isLive: live.has(row.id), ownerEvidence: { lastWriteMs: row.lastWriteMs || 0 }, background: codexBackground(row, dispatchFor) }))
    .filter((row) => row.background.tasks.length || spawners.has(row.id));
  // A Codex session a Claude parent dispatched is that parent's child, never
  // a parent of its own; and one a Codex parent dispatched is the same.
  let codexParents = codexParentsExcept(linkDispatches(claudeParents, providers).delegatedBy);
  let links = linkDispatches([...claudeParents, ...codexParents], providers);
  const stillParents = codexParents.filter((row) => !links.delegatedBy[row.id]);
  if (stillParents.length !== codexParents.length) {
    codexParents = stillParents;
    links = linkDispatches([...claudeParents, ...codexParents], providers);
  }
  const parents = [...claudeParents, ...codexParents];
  const linked = new Set([...parents.map(p => p.id), ...Object.keys(links.delegatedBy)]);
  const pending = [...linked];
  for (let i = 0; i < pending.length; i++) for (const id of children.get(pending[i]) || []) {
    if (!linked.has(id)) { linked.add(id); pending.push(id); }
  }
  for (const row of providers) if (linked.has(row.id)) await scanProvider(row);
  for (const dispatch of links.dispatches) {
    if (dispatch.outputFile && !dispatch.child?.signal?.result) dispatch.outputResult = await readOutputResult(dispatch);
  }
  const built = buildDelegationGroups(parents, providers, now, links);
  return { parents, providers, built };
}
let residentRows = []; let residentById = new Map();
if (parentPort) parentPort.on('message', async ({ rows, linkUpdates, liveIds, ownerOptions, cacheFile }) => {
  try {
    if (rows) { residentRows = rows; residentById = new Map(rows.map((row) => [row.id, row])); }
    for (const [id, parent] of Object.entries(linkUpdates || {})) {
      const row = residentById.get(id); if (row) row.delegatedBy = row.lineage?.parentThreadId || parent || null;
    }
    if (cacheFile && loadedCacheFile !== cacheFile) { scan.load(cacheFile); loadedCacheFile = cacheFile; }
    const result = await scanRows(residentRows, liveIds, Date.now(), ownerOptions);
    // Providers are the resident input, not a result. Returning them cloned
    // every historical rollout back into main on every idle notification.
    parentPort.postMessage({ parents: result.parents.map(({ id, background, ownerEvidence }) => ({ id, background, ownerEvidence })), built: result.built });
    if (cacheFile) await scan.save(cacheFile);
    else scan.endPass();
  } catch (error) { parentPort.postMessage({ error: error.message }); }
});
module.exports = { createScanner, scanRows, commandText, startedThreadId };
