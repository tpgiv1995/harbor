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
// The pipe gives no reply, so delivery is proven from the transcript.

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const PIPE_RE = /^(?:\\\\\.\\pipe\\)?(?:LOCAL\\)?cc-msg-[0-9a-f]{32}$/i;
const TOKEN_RE = /^[0-9a-f]{16,128}$/i;
const SESSION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Claude refuses past about a million serialized characters; stay well under.
const MAX_MESSAGE_CHARS = 900_000;
const RECORD_MAX_AGE_MS = 14 * 24 * 60 * 60_000;

function inboxDir(env = process.env) {
  return env.HARBOR_INBOX_DIR || path.join(os.homedir(), '.harbor', 'inboxes');
}

function recordPath(sessionId, env = process.env) {
  if (!SESSION_RE.test(String(sessionId || ''))) throw new Error(`not a session id: ${sessionId}`);
  return path.join(inboxDir(env), `${String(sessionId).toLowerCase()}.json`);
}

// The pipe as Node's net.connect wants it.
function pipeAddress(socket) {
  const raw = String(socket || '').replace(/^uds:/, '');
  if (!PIPE_RE.test(raw)) return null;
  if (raw.startsWith('\\\\')) return raw;
  return `\\\\.\\pipe\\${raw.startsWith('LOCAL\\') ? raw : `LOCAL\\${raw}`}`;
}

// Writes the record only when something changed (the hook runs on every
// prompt), atomically, so a reader never sees half a file.
function writeRecord(record, env = process.env) {
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
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...next, at: new Date().toISOString() }));
  fs.renameSync(tmp, file);
  return { written: true, file };
}

function readRecord(sessionId, env = process.env) {
  try {
    const record = JSON.parse(fs.readFileSync(recordPath(sessionId, env), 'utf8'));
    if (!pipeAddress(record.socket) || !TOKEN_RE.test(String(record.token || ''))) return null;
    return record;
  } catch {
    return null;
  }
}

function dropRecord(sessionId, env = process.env) {
  try { fs.rmSync(recordPath(sessionId, env), { force: true }); } catch { /* already gone */ }
}

// Records nobody has refreshed in two weeks belong to sessions long gone.
function pruneRecords(env = process.env, now = Date.now()) {
  let dropped = 0;
  let names = [];
  try { names = fs.readdirSync(inboxDir(env)); } catch { return 0; }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(inboxDir(env), name);
    try {
      const { at } = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (now - Date.parse(at || 0) > RECORD_MAX_AGE_MS) { fs.rmSync(file, { force: true }); dropped += 1; }
    } catch { try { fs.rmSync(file, { force: true }); dropped += 1; } catch { /* locked */ } }
  }
  return dropped;
}

// A sender label the wrapper accepts: no quotes, angle brackets or line breaks.
function cleanName(name) {
  const clean = String(name || '').replace(/["<>\r\n]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);
  return clean || null;
}

// Claude's own peer-message wrapper (the form its receiver parses and draws as
// "Message from @<name>"). Every attribute is optional; from= (a reply pipe) is
// left out on purpose, since a reply goes back through harbor-msg.
function wrapMessage(text, { fromName = null } = {}) {
  const name = cleanName(fromName);
  const attrs = name ? ` from-name="${name}"` : '';
  return `<cross-session-message${attrs}>\n${String(text)}\n</cross-session-message>`;
}

// Posts one message. Resolves { ok: true } once the bytes are written and the
// connection closed cleanly; { ok: false, code } when the pipe is gone (ENOENT:
// the session ended or never bound one) or the write failed. The pipe answers
// nothing either way, so "ok" means sent, not delivered: see confirmDelivery.
function postMessage(record, content, { timeoutMs = 10_000, connect = net.connect } = {}) {
  return new Promise((resolve) => {
    const address = pipeAddress(record?.socket);
    if (!address) { resolve({ ok: false, code: 'NO_PIPE' }); return; }
    if (String(content).length > MAX_MESSAGE_CHARS) { resolve({ ok: false, code: 'TOO_LARGE' }); return; }
    let settled = false;
    const done = (result) => { if (settled) return; settled = true; clearTimeout(timer); resolve(result); };
    const socket = connect(address);
    const timer = setTimeout(() => { socket.destroy(); done({ ok: false, code: 'TIMEOUT' }); }, timeoutMs);
    socket.on('error', (error) => done({ ok: false, code: error.code || 'ERROR', message: error.message }));
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ type: 'auth', token: record.token })}\n`);
      socket.end(`${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`, () => done({ ok: true }));
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
  let offset = since;
  let carry = '';
  while (Date.now() < deadline) {
    let size = 0;
    try { size = fs.statSync(file).size; } catch { size = 0; }
    if (size > offset) {
      const fd = fs.openSync(file, 'r');
      try {
        const length = Math.min(size - offset, 64 * 1024 * 1024);
        const buffer = Buffer.alloc(length);
        fs.readSync(fd, buffer, 0, length, offset);
        offset += length;
        const lines = (carry + buffer.toString('utf8')).split('\n');
        carry = lines.pop();
        for (const line of lines) {
          if (!line.includes('cross-session-message')) continue;
          let obj;
          try { obj = JSON.parse(line); } catch { continue; }
          if (obj.type === 'queue-operation' && obj.operation === 'enqueue' && obj.content === content) return { confirmed: true, via: 'enqueue' };
          const body = typeof obj.message?.content === 'string' ? obj.message.content : '';
          if (obj.type === 'user' && body.includes(content)) return { confirmed: true, via: 'user-record' };
        }
      } finally { fs.closeSync(fd); }
    }
    await wait(pollMs);
  }
  return { confirmed: false, reason: 'not in the transcript yet' };
}

function transcriptSize(record) {
  try { return fs.statSync(record.transcriptPath).size; } catch { return 0; }
}

module.exports = {
  MAX_MESSAGE_CHARS,
  inboxDir,
  recordPath,
  pipeAddress,
  writeRecord,
  readRecord,
  dropRecord,
  pruneRecords,
  cleanName,
  wrapMessage,
  postMessage,
  confirmDelivery,
  transcriptSize,
};
