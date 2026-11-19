'use strict';

// MESSAGES BETWEEN SESSIONS GO INTO THE RECIPIENT'S OWN INBOX, NOT ITS PROMPT
// (2026-11-18, Pat: "this bootleg process of sessions pretending to be me and
// pasting in shit is not anywhere close to a 'best practice' approach").
//
// Since Nov 17 every agent-to-agent message (100 to 200 an hour) was typed into
// the recipient's terminal prompt and confirmed by reading the screen, which is
// tmux send-keys under another name: long pastes collapse to "[Pasted text #N]",
// a stalled Claude shows the text minutes late, retries stack, and text is left
// unsent in prompts. Claude Code (v2.1.234+ on native Windows, so the installed
// 2.1.321) binds a per-session INBOX for cross-session messaging: a named pipe
// \\.\pipe\LOCAL\cc-msg-<32 hex> that other local processes post to, never
// through Anthropic's servers, so it works across every config home and plan.
// An idle session starts a turn with the message; a busy one reads it between
// tool calls (code.claude.com/docs/en/cross-session-messaging).
//
// Measured on this machine (2026-11-18, throwaway sessions on the personal and
// Team homes, scratch C:\dev\.harbor-scratch\chan-test):
//   - The session exports its pipe and a per-session token to hooks as
//     CLAUDE_CODE_MESSAGING_SOCKET / CLAUDE_CODE_MESSAGING_TOKEN, so a
//     SessionStart / UserPromptSubmit hook (bin/harbor-inbox-hook) records them.
//   - A connection's first line must be {"type":"auth","token":...} on Windows;
//     with the session's own token the message counts as the session's own
//     child and is delivered without an approval dialog, bypass mode included.
//   - The next line {"type":"user","message":{"role":"user","content":...}}
//     carrying Claude's own wrapper, <cross-session-message from-name="Router">
//     \n body \n</cross-session-message>, shows in the recipient as
//     "› Message from @Router: ..." and Claude is told it came from a peer
//     session, not from Pat. A 1,500-character body with quotes and angle
//     brackets arrived intact; the documented cap is about a million characters.
//   - The transcript records a queue-operation "enqueue" whose content is
//     exactly the wrapped text the moment it lands (the delivery proof used
//     below), then an isMeta user record "Another Claude session sent a
//     message:" when Claude reads it. Harbor's window draws the enqueue as a
//     named peer bubble (providers/transcript.js peerMessageParts).
//   - Measured the same night, after Sol's adversarial review (gpt-6.2-sol):
//     a frame carrying session_id is delivered only when it names the session
//     that owns the pipe (a wrong id is DROPPED, silently), so every frame names
//     its target; after /clear one process (one pipe) runs a NEW session id, and
//     a message meant for the old conversation must never land in the new one.
//     Claude stores a body's "</cross-session-message" as "<\/cross-session-
//     message" (other tags untouched) and cleans sender names (strips invisible
//     and control characters, cuts at 64 characters); its own serializer must
//     reproduce what it parsed or the sender details are dropped, so ours makes
//     the same text. Its size limit counts the SERIALIZED frame (1,048,576).
//   - Round two of the same review: every message carries a random
//     hop-chain id (Claude's own wrapper field, 24 hex characters, meant for
//     relay-loop detection). Measured: Claude delivers it, keeps it in the
//     transcript's enqueue record and hides it from the model, so the proof of
//     delivery matches THIS send only, never an earlier identical one.
// The pipe gives no reply, so delivery is proven from the transcript.

const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');
const { withLock } = require('./os-lock.cjs');

const PIPE_RE = /^(?:\\\\\.\\pipe\\)?(?:LOCAL\\)?cc-msg-[0-9a-f]{32}$/i;
const TOKEN_RE = /^[0-9a-f]{16,128}$/i;
const SESSION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Claude refuses a frame past 1,048,576 serialized characters; stay under it.
const MAX_FRAME_CHARS = 1_000_000;
const RECEIPT_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
const RECORD_MAX_AGE_MS = 14 * 24 * 60 * 60_000;

function inboxDir(env = process.env) {
  return env.HARBOR_INBOX_DIR || path.join(os.homedir(), '.harbor', 'inboxes');
}

function recordPath(sessionId, env = process.env) {
  if (!SESSION_RE.test(String(sessionId || ''))) throw new Error(`not a session id: ${sessionId}`);
  return path.join(inboxDir(env), `${String(sessionId).toLowerCase()}.json`);
}

// A /clear marker lives in its OWN file beside the record (Sol's review, round
// twenty-two): written into the record's file, a resume of the old session in
// ANOTHER process replaced it, and once that process exited and its record was
// dropped, the pane cleared away from that session (which still advertises its
// launch id) took an agent's message for it. listRecords never lists these, so
// neither the age prune nor the per-write scan reads them.
function clearedPath(sessionId, env = process.env) {
  if (!SESSION_RE.test(String(sessionId || ''))) throw new Error(`not a session id: ${sessionId}`);
  return path.join(inboxDir(env), `${String(sessionId).toLowerCase()}.cleared.json`);
}

// The pipe as Node's net.connect wants it.
function pipeAddress(socket) {
  const raw = String(socket || '').replace(/^uds:/, '');
  if (!PIPE_RE.test(raw)) return null;
  if (raw.startsWith('\\\\')) return raw;
  return `\\\\.\\pipe\\${raw.startsWith('LOCAL\\') ? raw : `LOCAL\\${raw}`}`;
}

// Every change to the registry (a record published, a session marked
// cleared, a dead record removed, pruning) holds one short lock, so a resume
// publishing a fresh record can never be overwritten or deleted by a change
// that read the old one (Sol's review, round two). Transcript polling never
// holds it.
// Named by the directory's real path, so two spellings of one folder (an 8.3
// short name, a relative path) share one lock.
function registryLockName(env) {
  const dir = inboxDir(env);
  let real = path.resolve(dir);
  try { real = fs.realpathSync.native(dir); } catch { /* not created yet: the resolved path */ }
  return `harbor-inbox-registry:${real.toLowerCase()}`;
}
function withRegistry(env, fn) {
  return withLock(registryLockName(env), fn, { waitMs: 10_000 });
}

// Writes the record only when something changed (the hook runs on every
// prompt), atomically, so a reader never sees half a file.
async function writeRecord(record, env = process.env) {
  try {
    return await withRegistry(env, () => writeRecordLocked(record, env));
  } catch (error) {
    if (error?.code === 'LOCK_TIMEOUT') return { written: false, reason: 'registry busy' };
    throw error;
  }
}

function writeRecordLocked(record, env) {
  const sessionId = String(record.sessionId || '').toLowerCase();
  if (!SESSION_RE.test(sessionId)) return { written: false, reason: 'no session id' };
  if (!pipeAddress(record.socket)) return { written: false, reason: 'no inbox pipe' };
  if (!TOKEN_RE.test(String(record.token || ''))) return { written: false, reason: 'no token' };
  const file = recordPath(sessionId, env);
  const next = {
    sessionId,
    socket: String(record.socket),
    token: String(record.token),
    transcriptPath: record.transcriptPath || null,
    cwd: record.cwd || null,
    home: record.home || null,
    pid: Number.isInteger(record.pid) ? record.pid : null,
  };
  try {
    const prev = JSON.parse(fs.readFileSync(file, 'utf8'));
    const same = ['socket', 'token', 'transcriptPath', 'cwd', 'home'].every((key) => prev[key] === next[key]);
    // Refresh the timestamp at most hourly, so an unchanged record still ages out only when unused.
    if (same && Date.now() - Date.parse(prev.at || 0) < 60 * 60_000) return { written: false, reason: 'unchanged' };
  } catch { /* no record yet */ }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // A marker an older Harbor wrote INTO this file is kept as an entry with no
  // pipe (no resume can claim it) before the record goes over it.
  const legacy = readJson(file);
  if (legacy?.clearedInto && SESSION_RE.test(String(legacy.clearedInto))) {
    writeClears(sessionId, [...readClears(sessionId, env), { socket: null, clearedInto: legacy.clearedInto, at: legacy.at || null }], env);
  }
  atomicWrite(file, { ...next, at: new Date().toISOString() });
  // This very process back on this session (an in-process /resume in the pane
  // that was cleared away from it): that pane holds the session again, so ITS
  // entry ends. Entries left by OTHER processes' panes stay: each of those
  // panes still advertises this id while running something else (round
  // twenty-three: one entry per session let a second process's clear replace
  // the first pane's, and its own resume then erase the only one).
  const own = readClears(sessionId, env);
  if (own.some((entry) => entry.socket === next.socket)) writeClears(sessionId, own.filter((entry) => entry.socket !== next.socket), env);
  // One pipe belongs to one process, and one process runs one conversation at
  // a time: any OTHER session still recorded on this pipe was cleared into this
  // one (/clear keeps the process and its inbox, and changes the session id).
  // Its record gives way to a marker entry saying so, never a route into the new one.
  for (const name of listRecords(env)) {
    if (name === path.basename(file)) continue;
    const other = readJson(path.join(inboxDir(env), name));
    // Read under the registry lock, so a resume's fresh record (a new pipe)
    // can never be the one marked here.
    if (!other || other.socket !== next.socket || other.sessionId === sessionId) continue;
    const kept = readClears(other.sessionId, env).filter((entry) => entry.socket !== next.socket);
    writeClears(other.sessionId, [...kept, { socket: next.socket, clearedInto: sessionId, at: new Date().toISOString() }], env);
    fs.rmSync(path.join(inboxDir(env), name), { force: true });
  }
  return { written: true, file };
}

// A session's /clear marker: one entry per pane process (pipe) that was
// cleared away from it and still advertises its id. Written under the
// registry lock. Round twenty-two's single-entry file reads as one entry.
function readClears(sessionId, env = process.env) {
  const marker = readJson(clearedPath(sessionId, env));
  if (!marker) return [];
  const entries = Array.isArray(marker.clears) ? marker.clears : [marker];
  return entries
    .filter((entry) => entry && entry.clearedInto && SESSION_RE.test(String(entry.clearedInto)))
    .map((entry) => ({ socket: entry.socket || null, clearedInto: String(entry.clearedInto), at: entry.at || null }));
}

function writeClears(sessionId, clears, env = process.env) {
  const file = clearedPath(sessionId, env);
  if (!clears.length) { fs.rmSync(file, { force: true }); return; }
  atomicWrite(file, { sessionId: String(sessionId).toLowerCase(), clears });
}

function atomicWrite(file, value) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function listRecords(env = process.env) {
  try { return fs.readdirSync(inboxDir(env)).filter((name) => /^[0-9a-f-]{36}\.json$/.test(name)); } catch { return []; }
}

function readRecord(sessionId, env = process.env) {
  const record = lookup(sessionId, env);
  return record && !record.clearedInto ? record : null;
}

// The record (the live route), or { clearedInto } for a session that ran
// /clear and has no live record, or null.
function lookup(sessionId, env = process.env) {
  let record;
  try { record = readJson(recordPath(sessionId, env)); } catch { return null; }
  if (record && !(record.clearedInto && SESSION_RE.test(String(record.clearedInto)))
    && pipeAddress(record.socket) && TOKEN_RE.test(String(record.token || ''))) return record;
  return clearedMarker(sessionId, env);
}

// The /clear marker for a session, whether or not it also has a live record
// (a resume elsewhere): { sessionId, clearedInto, at } or null. A marker
// written into the record's own file by an older Harbor still counts.
// With several entries the newest names the conversation reported.
function clearedMarker(sessionId, env = process.env) {
  let entries;
  try {
    entries = readClears(sessionId, env);
    const legacy = readJson(recordPath(sessionId, env));
    if (legacy?.clearedInto && SESSION_RE.test(String(legacy.clearedInto))) entries.push({ socket: null, clearedInto: String(legacy.clearedInto), at: legacy.at || null });
  } catch { return null; }
  if (!entries.length) return null;
  const newest = entries.reduce((a, b) => (Date.parse(b.at || 0) >= Date.parse(a.at || 0) ? b : a));
  return { sessionId: String(sessionId).toLowerCase(), clearedInto: newest.clearedInto, at: newest.at };
}

// Removes a record whose pipe is gone, but only if it is still the record the
// sender read: a resume may have published a fresh one in the meantime.
async function dropRecord(sessionId, env = process.env, { socket = null } = {}) {
  try {
    return await withRegistry(env, () => {
      const file = recordPath(sessionId, env);
      if (socket !== null && readJson(file)?.socket !== socket) return false;
      fs.rmSync(file, { force: true });
      return true;
    });
  } catch { return false; }
}

// Records nobody has refreshed in two weeks belong to sessions long gone.
// A /clear marker is NOT pruned by age (Sol's review, round twenty-one): a
// Claude pane keeps advertising its launch id after /clear, for as long as it
// lives, so a marker dropped at two weeks let an agent's message to the old id
// be typed into the new conversation. A genuine resume of the old session
// writes a fresh record over its marker; markers are rare (one per /clear).
async function pruneRecords(env = process.env, now = Date.now()) {
  try { return await withRegistry(env, () => pruneRecordsLocked(env, now)); } catch { return 0; }
}

function pruneRecordsLocked(env, now) {
  let dropped = 0;
  for (const name of listRecords(env)) {
    const file = path.join(inboxDir(env), name);
    try {
      const { at, clearedInto } = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (clearedInto && SESSION_RE.test(String(clearedInto))) continue;
      if (now - Date.parse(at || 0) > RECORD_MAX_AGE_MS) { fs.rmSync(file, { force: true }); dropped += 1; }
    } catch { try { fs.rmSync(file, { force: true }); dropped += 1; } catch { /* locked */ } }
  }
  return dropped;
}

// A sender label exactly as Claude would write it back: no quotes or angle
// brackets, no invisible or control characters, at most 64 characters (the
// 64th an ellipsis when it was longer), so its re-serialization matches.
function cleanName(name) {
  const visible = String(name || '').replace(/["<>]/g, '').replace(/[\p{Cf}\p{Cc}\p{Cs}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim();
  const chars = [...visible];
  const clean = chars.length > 64 ? `${chars.slice(0, 63).join('').trimEnd()}\u2026` : visible;
  return clean || null;
}

// A body that holds the wrapper's own closing tag is escaped the way Claude
// escapes it, so the stored text is the text sent.
function escapeBody(text) {
  return String(text).replace(/<\/(?=cross-session-message)/gi, '<\\/');
}

// Claude's own peer-message wrapper (the form its receiver parses and draws as
// "Message from @<name>"). Every attribute is optional, but the receiver
// re-serializes what it parsed and drops the wrapper unless it comes out
// identical, so the order is Claude's own: from, from-session, from-name.
// from= is the sender's return address ("uds:" + its own inbox pipe) and
// from-session its session id: without them a recipient that answers with its
// SendMessage tool gets "No agent named '<name>' is reachable" (2026-11-18,
// Vox answering the first inbox message ever sent this way). Sent from inside a
// Claude session, harbor-msg fills both from the session's own environment.
const ADDRESS_RE = /^[A-Za-z0-9%:_/.\\-]{1,300}$/;
const HOP_RE = /^[0-9a-f]{24}$/;
function newMessageId() { return crypto.randomBytes(12).toString('hex'); }
function wrapMessage(text, { fromName = null, fromAddress = null, fromSession = null, messageId = null } = {}) {
  const attrs = [];
  const address = fromAddress && pipeAddress(fromAddress) ? `uds:${pipeAddress(fromAddress)}` : null;
  if (address && ADDRESS_RE.test(address)) attrs.push(`from="${address}"`);
  if (fromSession && SESSION_RE.test(String(fromSession))) attrs.push(`from-session="${String(fromSession).toLowerCase()}"`);
  if (messageId && HOP_RE.test(String(messageId))) attrs.push(`hop-chain="${messageId}"`);
  const name = cleanName(fromName);
  if (name) attrs.push(`from-name="${name}"`);
  return `<cross-session-message${attrs.length ? ` ${attrs.join(' ')}` : ''}>\n${escapeBody(text)}\n</cross-session-message>`;
}

// Who is sending, when harbor-msg runs inside a Claude session (its Bash and
// hooks carry the session's id and inbox): the return address for replies.
function senderIdentity(env = process.env) {
  const fromSession = SESSION_RE.test(String(env.CLAUDE_CODE_SESSION_ID || '')) ? env.CLAUDE_CODE_SESSION_ID : null;
  const fromAddress = pipeAddress(env.CLAUDE_CODE_MESSAGING_SOCKET) || null;
  return { fromSession, fromAddress };
}

// The frame, naming its target session (a frame naming any other session is
// dropped by the receiver: see the header).
function messageFrame(record, content) {
  const frame = { type: 'user', message: { role: 'user', content } };
  if (SESSION_RE.test(String(record?.sessionId || ''))) frame.session_id = String(record.sessionId).toLowerCase();
  return `${JSON.stringify(frame)}\n`;
}

// Posts one message. The pipe answers nothing, so the outcome is about the
// bytes, not delivery (see confirmDelivery):
//   { ok: true }                         written and closed cleanly
//   { ok: false, code, definite: true }  nothing reached the session (no pipe,
//                                        ENOENT: the session ended, too large)
//   { ok: false, code, definite: false } connected, then failed or timed out:
//                                        it MAY have landed, so it is never
//                                        retried or sent another way blindly
function postMessage(record, content, { timeoutMs = 10_000, connect = net.connect } = {}) {
  return new Promise((resolve) => {
    const address = pipeAddress(record?.socket);
    if (!address) { resolve({ ok: false, code: 'NO_PIPE', definite: true }); return; }
    const frame = messageFrame(record, content);
    if (frame.length > MAX_FRAME_CHARS) { resolve({ ok: false, code: 'TOO_LARGE', definite: true, size: frame.length }); return; }
    let settled = false;
    let connected = false;
    const done = (result) => { if (settled) return; settled = true; clearTimeout(timer); resolve(result); };
    const socket = connect(address);
    const timer = setTimeout(() => { socket.destroy(); done({ ok: false, code: 'TIMEOUT', definite: !connected }); }, timeoutMs);
    socket.on('error', (error) => done({ ok: false, code: error.code || 'ERROR', message: error.message, definite: !connected }));
    socket.on('connect', () => {
      connected = true;
      socket.write(`${JSON.stringify({ type: 'auth', token: record.token })}\n`);
      socket.end(frame, () => done({ ok: true }));
    });
  });
}

// Did the recipient take it? Its transcript gets a queue-operation "enqueue"
// holding exactly the wrapped text when the message lands (or, for a session
// that read it at once, the isMeta user record carrying it). Reads only what the
// transcript grew by since `since` (its size before the post).
async function confirmDelivery(record, content, { since = 0, timeoutMs = 15_000, pollMs = 250, sleep } = {}) {
  const file = record?.transcriptPath;
  if (!file) return { confirmed: false, reason: 'no transcript path' };
  const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const deadline = Date.now() + timeoutMs;
  const scan = newScan(since);
  const want = normalized(content);
  do {
    const found = scanTranscript(file, scan, want);
    if (found.via) return { confirmed: true, via: found.via };
    if (Date.now() >= deadline) break;
    await wait(pollMs);
  } while (Date.now() < deadline);
  return { confirmed: false, reason: scan.missing ? 'the recipient\'s transcript could not be read' : 'not in the transcript yet' };
}

function newScan(offset) {
  return { offset, decoder: new StringDecoder('utf8'), carry: '', missing: false };
}

// Claude may escape a closing tag we did not (a lookalike form): compare with
// its escape undone on both sides.
function normalized(text) {
  return String(text).replace(/<\\\//g, '</');
}

// Reads what the transcript grew by since the scan's offset, to the end, in
// chunks, with one UTF-8 decoder across them (a character split between two
// reads survives); never throws (a transcript that vanished or is mid-rename
// reads as nothing new, and scan.missing says so).
const SCAN_CHUNK = 8 * 1024 * 1024;
function scanTranscript(file, scan, want) {
  let size = 0;
  try { size = fs.statSync(file).size; scan.missing = false; } catch { scan.missing = true; return {}; }
  if (size < scan.offset) { scan.offset = size; scan.carry = ''; scan.decoder = new StringDecoder('utf8'); return {}; }
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    while (scan.offset < size) {
      const length = Math.min(size - scan.offset, SCAN_CHUNK);
      const buffer = Buffer.alloc(length);
      const read = fs.readSync(fd, buffer, 0, length, scan.offset);
      if (read <= 0) break;
      scan.offset += read;
      const lines = (scan.carry + scan.decoder.write(buffer.subarray(0, read))).split('\n');
      scan.carry = lines.pop();
      for (const line of lines) {
        if (!line.includes('cross-session-message')) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }
        if (obj.type === 'queue-operation' && obj.operation === 'enqueue' && normalized(obj.content) === want) return { via: 'enqueue' };
      }
    }
    return {};
  } catch {
    // Read after a successful stat failed (vanished, locked, replaced):
    // unknown, never "no match".
    scan.missing = true;
    return {};
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* closed */ } }
  }
}

// A send whose delivery could not be proven leaves a receipt, so the sender (or
// Pat) can ask later whether it landed instead of resending blind.
function receiptDir(env = process.env) {
  return path.join(path.dirname(inboxDir(env)), 'receipts');
}

function writeReceipt({ sessionId, transcriptPath, since, content }, env = process.env, now = Date.now()) {
  const id = `${new Date(now).toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${Math.random().toString(16).slice(2, 10)}`;
  const dir = receiptDir(env);
  try {
    fs.mkdirSync(dir, { recursive: true });
    for (const name of fs.readdirSync(dir)) {
      try { if (now - fs.statSync(path.join(dir, name)).mtimeMs > RECEIPT_MAX_AGE_MS) fs.rmSync(path.join(dir, name), { force: true }); } catch { /* raced */ }
    }
    atomicWrite(path.join(dir, `${id}.json`), { id, sessionId, transcriptPath, since, content, at: new Date(now).toISOString() });
    return id;
  } catch { return null; }
}

function checkReceipt(id, env = process.env) {
  if (!/^[0-9]{14}-[0-9a-f]{1,8}$/.test(String(id || ''))) return { ok: false, why: 'not a receipt id' };
  const receipt = readJson(path.join(receiptDir(env), `${id}.json`));
  if (!receipt) return { ok: false, why: 'no such receipt (receipts are kept 7 days)' };
  const scan = newScan(receipt.since || 0);
  const found = scanTranscript(receipt.transcriptPath, scan, normalized(receipt.content));
  if (found.via) return { ok: true, receipt: id, session: receipt.sessionId, delivered: true, via: found.via };
  if (scan.missing) return { ok: true, receipt: id, session: receipt.sessionId, delivered: 'unknown', why: 'that session\'s transcript could not be read; ask again later' };
  // No record yet is not a refusal: a busy session can enqueue it later.
  // Nothing here ever answers false (round three of Sol's review).
  return { ok: true, receipt: id, session: receipt.sessionId, delivered: 'pending', why: 'not in that session\'s transcript yet; ask again later' };
}

function transcriptSize(record) {
  try { return fs.statSync(record.transcriptPath).size; } catch { return 0; }
}

module.exports = {
  MAX_FRAME_CHARS,
  lookup,
  messageFrame,
  escapeBody,
  writeReceipt,
  checkReceipt,
  inboxDir,
  recordPath,
  clearedPath,
  clearedMarker,
  pipeAddress,
  writeRecord,
  readRecord,
  dropRecord,
  pruneRecords,
  cleanName,
  wrapMessage,
  newMessageId,
  senderIdentity,
  postMessage,
  confirmDelivery,
  transcriptSize,
};
