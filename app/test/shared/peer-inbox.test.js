'use strict';

// Messages between sessions go into the recipient's own Claude Code inbox
// (src/shared/peer-inbox.cjs, bin/harbor-msg). A real named-pipe server stands
// in for the session, and a fake transcript for its delivery record. The
// typing fallback is pointed at a dead port so no test can reach a real Harbor.
process.env.HARBOR_SERVER_WS = 'ws://127.0.0.1:9/ws';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const inbox = require('../../src/shared/peer-inbox.cjs');
const harborMsg = require('../../../bin/harbor-msg');

const realTmp = () => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'peer-inbox-')));
const SID = '0a1b2c3d-1111-2222-3333-444455556666';
const SID2 = '0a1b2c3d-7777-2222-3333-444455556666';
const TOKEN = 'ab'.repeat(16);
const isWin = process.platform === 'win32';
// A sender environment with no Claude or Codex session in it (the suite may run
// inside one), plus a named sender session when a test wants one.
const SENDER_VARS = ['CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CODEX_THREAD_ID', 'CLAUDE_CONFIG_DIR'];
function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of SENDER_VARS) delete env[key];
  return { ...env, ...extra };
}
const SENDER = '9f8e7d6c-1111-2222-3333-444455556666';
const SENDER_PIPE = `\\\\.\\pipe\\LOCAL\\cc-msg-${'7'.repeat(32)}`;
const deadPipe = () => `\\\\.\\pipe\\LOCAL\\cc-msg-${crypto.randomBytes(16).toString('hex')}`;

// A stand-in session inbox: records every line, and on the message line writes
// the enqueue record Claude writes, unless told to stay silent. `dedupe` drops
// a repeat of text it already took, the way Claude drops identical repeats.
function fakeSession({ transcript, silent = false, dedupe = false } = {}) {
  const name = `cc-msg-${crypto.randomBytes(16).toString('hex')}`;
  const address = `\\\\.\\pipe\\LOCAL\\${name}`;
  const lines = [];
  const seen = new Set();
  const server = net.createServer((socket) => {
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        const msg = JSON.parse(line);
        lines.push(msg);
        if (msg.type !== 'user' || !transcript || silent) continue;
        if (dedupe && seen.has(msg.message.content)) continue;
        seen.add(msg.message.content);
        fs.appendFileSync(transcript, `${JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: msg.message.content })}\n`);
      }
    });
  });
  return new Promise((resolve) => server.listen(address, () => resolve({ address, lines, close: () => new Promise((r) => server.close(r)) })));
}

function freshInbox() {
  const dir = realTmp();
  const transcript = path.join(dir, 't.jsonl');
  fs.writeFileSync(transcript, '');
  return { dir, transcript, env: cleanEnv({ HARBOR_INBOX_DIR: path.join(dir, 'inboxes') }) };
}

// --- the wrapper and the frame ----------------------------------------------

test('the wrapper is the form Claude draws as "Message from @<name>"', async () => {
  assert.equal(inbox.wrapMessage('hello\nthere', { fromName: 'Router' }), '<cross-session-message from-name="Router">\nhello\nthere\n</cross-session-message>');
  assert.equal(inbox.wrapMessage('x'), '<cross-session-message>\nx\n</cross-session-message>');
});

test('the wrapper keeps Claude\'s attribute order (from, from-session, hop-chain, from-name), which its receiver checks', async () => {
  const id = inbox.newMessageId();
  assert.match(id, /^[0-9a-f]{24}$/);
  const wrapped = inbox.wrapMessage('x', { fromName: 'Router', fromSession: SENDER.toUpperCase(), fromAddress: SENDER_PIPE, messageId: id });
  assert.equal(wrapped.split('\n')[0], `<cross-session-message from="uds:${SENDER_PIPE}" from-session="${SENDER}" hop-chain="${id}" from-name="Router">`);
  assert.equal(inbox.wrapMessage('x', { messageId: 'not-hex' }).split('\n')[0], '<cross-session-message>');
  assert.equal(inbox.wrapMessage('x', { fromSession: 'not-a-session', fromAddress: 'C:\\evil' }).split('\n')[0], '<cross-session-message>', 'bad values are left out');
  assert.deepEqual(inbox.senderIdentity({ CLAUDE_CODE_SESSION_ID: SENDER, CLAUDE_CODE_MESSAGING_SOCKET: SENDER_PIPE }), { fromSession: SENDER, fromAddress: SENDER_PIPE });
  assert.deepEqual(inbox.senderIdentity({}), { fromSession: null, fromAddress: null });
});

// Claude's own name cleaner (measured in the 2.1.321 bundle): strip quotes and
// angle brackets, strip invisible and control characters, trim, and cut past 64
// characters with an ellipsis. Ours must be a fixed point of it, or Claude's
// re-serialization differs and it drops the sender details.
function claudeCleans(name) {
  const n = name.replace(/["<>]/g, '').replace(/[\p{Cf}\p{Cc}\p{Cs}\p{Zl}\p{Zp}]/gu, '').trim();
  const chars = [...n];
  return chars.length > 64 ? `${chars.slice(0, 64).join('')}\u2026` : n;
}

test('a sender name is one Claude would write back unchanged', async () => {
  for (const raw of ['The "Product" <Owner>\n', `N\tame${'x'.repeat(70)}`, 'Zero\u200bwidth', `${'é'.repeat(80)}`, '  Router  ']) {
    const clean = inbox.cleanName(raw);
    assert.equal(claudeCleans(clean), clean, `fixed point for ${JSON.stringify(raw)}`);
    assert.ok([...clean].length <= 64);
  }
  assert.equal(inbox.cleanName('The "Product" <Owner>\n'), 'The Product Owner');
  assert.equal(inbox.cleanName('\u200b'), null);
});

test('a body holding the closing tag is escaped the way Claude stores it; other tags are left alone', async () => {
  const wrapped = inbox.wrapMessage('a </cross-session-message> b </div>', { fromName: 'T' });
  assert.equal(wrapped, '<cross-session-message from-name="T">\na <\\/cross-session-message> b </div>\n</cross-session-message>');
  assert.equal(inbox.escapeBody('x </Cross-Session-Message y'), 'x <\\/Cross-Session-Message y');
});

test('every frame names its target session (Claude drops a frame naming another)', async () => {
  const frame = JSON.parse(inbox.messageFrame({ sessionId: SID.toUpperCase() }, 'x'));
  assert.deepEqual(frame, { type: 'user', message: { role: 'user', content: 'x' }, session_id: SID });
  assert.equal(JSON.parse(inbox.messageFrame({}, 'x')).session_id, undefined);
});

test('only a real cc-msg pipe name is accepted, in every spelling Claude exports', async () => {
  const hex = 'f'.repeat(32);
  assert.equal(inbox.pipeAddress(`\\\\.\\pipe\\LOCAL\\cc-msg-${hex}`), `\\\\.\\pipe\\LOCAL\\cc-msg-${hex}`);
  assert.equal(inbox.pipeAddress(`uds:\\\\.\\pipe\\LOCAL\\cc-msg-${hex}`), `\\\\.\\pipe\\LOCAL\\cc-msg-${hex}`);
  assert.equal(inbox.pipeAddress(`cc-msg-${hex}`), `\\\\.\\pipe\\LOCAL\\cc-msg-${hex}`);
  assert.equal(inbox.pipeAddress('\\\\.\\pipe\\something-else'), null);
  assert.equal(inbox.pipeAddress(''), null);
});

// --- records ------------------------------------------------------------------

test('a record is written once, re-written only when it changes, read back, and dropped', async () => {
  const env = { HARBOR_INBOX_DIR: realTmp() };
  const record = { sessionId: SID.toUpperCase(), socket: `\\\\.\\pipe\\LOCAL\\cc-msg-${'1'.repeat(32)}`, token: TOKEN, transcriptPath: 'C:\\t.jsonl' };
  assert.equal((await inbox.writeRecord(record, env)).written, true);
  assert.equal((await inbox.writeRecord(record, env)).reason, 'unchanged');
  assert.equal((await inbox.writeRecord({ ...record, token: 'cd'.repeat(16) }, env)).written, true, 'a new token is written');
  assert.equal(inbox.readRecord(SID, env).token, 'cd'.repeat(16));
  assert.equal((await inbox.writeRecord({ ...record, socket: 'not-a-pipe' }, env)).written, false);
  assert.equal((await inbox.writeRecord({ ...record, token: 'xyz' }, env)).written, false);
  await inbox.dropRecord(SID, env);
  assert.equal(inbox.readRecord(SID, env), null);
});

test('after /clear the old session is marked "cleared into" the new one, never routed into it', async () => {
  const { env } = freshInbox();
  const pipe = deadPipe();
  await inbox.writeRecord({ sessionId: SID, socket: pipe, token: TOKEN }, env);
  await inbox.writeRecord({ sessionId: SID2, socket: pipe, token: TOKEN }, env);
  assert.deepEqual({ ...inbox.lookup(SID, env), at: null }, { sessionId: SID, clearedInto: SID2, at: null });
  assert.equal(inbox.readRecord(SID, env), null);
  assert.equal(inbox.readRecord(SID2, env).socket, pipe);
  const sent = await harborMsg.send({ to: SID, text: 'for the old conversation', env });
  assert.equal(sent.ok, false);
  assert.equal(sent.clearedInto, SID2);
  assert.equal(sent.tried, undefined, 'no typing fallback into the new conversation');
  assert.equal(harborMsg.status(SID, env).clearedInto, SID2);
});

test('a dead record is removed only if it is still the one the sender read', async () => {
  const { env } = freshInbox();
  const oldPipe = deadPipe();
  const newPipe = deadPipe();
  await inbox.writeRecord({ sessionId: SID, socket: newPipe, token: TOKEN }, env);
  assert.equal(await inbox.dropRecord(SID, env, { socket: oldPipe }), false);
  assert.equal(inbox.readRecord(SID, env).socket, newPipe, 'a resume\'s fresh record survives');
  assert.equal(await inbox.dropRecord(SID, env, { socket: newPipe }), true);
  assert.equal(inbox.readRecord(SID, env), null);
});

test('records nobody refreshed in two weeks are pruned', async () => {
  const env = { HARBOR_INBOX_DIR: realTmp() };
  await inbox.writeRecord({ sessionId: SID, socket: `cc-msg-${'2'.repeat(32)}`, token: TOKEN }, env);
  const file = inbox.recordPath(SID, env);
  const old = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...old, at: new Date(Date.now() - 15 * 86_400_000).toISOString() }));
  assert.equal(await inbox.pruneRecords(env), 1);
  assert.equal(inbox.readRecord(SID, env), null);
});

// Round twenty-one: the pane keeps the old id for as long as it lives.
test('a /clear marker is never pruned by age, and a resume of the old session is routed again', async () => {
  const { env } = freshInbox();
  const pipe = deadPipe();
  await inbox.writeRecord({ sessionId: SID, socket: pipe, token: TOKEN }, env);
  await inbox.writeRecord({ sessionId: SID2, socket: pipe, token: TOKEN }, env);
  const file = inbox.clearedPath(SID, env);
  const marker = JSON.parse(fs.readFileSync(file, 'utf8'));
  const monthAgo = new Date(Date.now() - 30 * 86_400_000).toISOString();
  fs.writeFileSync(file, JSON.stringify({ ...marker, clears: marker.clears.map((entry) => ({ ...entry, at: monthAgo })) }));
  // An older Harbor wrote markers into the record's own file: those are kept too.
  const LEGACY = '0a1b2c3d-5555-2222-3333-444455556666';
  fs.writeFileSync(inbox.recordPath(LEGACY, env), JSON.stringify({ sessionId: LEGACY, clearedInto: SID2, at: new Date(Date.now() - 30 * 86_400_000).toISOString() }));
  await inbox.pruneRecords(env);
  assert.equal(inbox.lookup(SID, env)?.clearedInto, SID2, 'the 30-day-old marker still stands');
  assert.equal(inbox.clearedMarker(LEGACY, env)?.clearedInto, SID2, 'and the old-format one');
  const resumed = deadPipe();
  await inbox.writeRecord({ sessionId: SID, socket: resumed, token: TOKEN }, env);
  assert.equal(inbox.readRecord(SID, env)?.socket, resumed, 'a resume of the old session is routed again');
});

// Round twenty-two: the marker lives apart from the record, and only the cleared pane's own process ends it.
test('a resume in another process does not erase the /clear marker; the cleared process resuming it does', async () => {
  const { env } = freshInbox();
  const paneX = deadPipe();
  await inbox.writeRecord({ sessionId: SID, socket: paneX, token: TOKEN }, env);
  await inbox.writeRecord({ sessionId: SID2, socket: paneX, token: TOKEN }, env);
  // Resumed in another Claude process: its inbox is the route, the marker stays.
  const elsewhere = deadPipe();
  await inbox.writeRecord({ sessionId: SID, socket: elsewhere, token: TOKEN }, env);
  assert.equal(inbox.readRecord(SID, env)?.socket, elsewhere);
  assert.equal(inbox.clearedMarker(SID, env)?.clearedInto, SID2, 'the cleared pane still advertises the old id');
  // That process exits: its record is dropped, and the marker answers again.
  await inbox.dropRecord(SID, env, { socket: elsewhere });
  assert.equal(inbox.lookup(SID, env)?.clearedInto, SID2);
  const sent = await harborMsg.send({ to: SID, text: 'for the old conversation', env });
  assert.equal(sent.ok, false);
  assert.equal(sent.clearedInto, SID2, 'refused as cleared, never typed into the new conversation');
  assert.equal(sent.tried, undefined);
  // The cleared pane's own process goes back to the old session: it holds it again.
  await inbox.writeRecord({ sessionId: SID, socket: paneX, token: TOKEN }, env);
  assert.equal(inbox.clearedMarker(SID, env), null);
  assert.equal(inbox.lookup(SID2, env)?.clearedInto, SID, 'and the other session is now the cleared one');
});

// Round twenty-three: one entry per cleared pane process; a resume removes only its own.
test('a second process clearing and resuming the session never erases the first pane\'s /clear marker', async () => {
  const { env } = freshInbox();
  const SID3 = '0a1b2c3d-8888-2222-3333-444455556666';
  const paneP = deadPipe();
  const procQ = deadPipe();
  await inbox.writeRecord({ sessionId: SID, socket: paneP, token: TOKEN }, env); // P runs A
  await inbox.writeRecord({ sessionId: SID2, socket: paneP, token: TOKEN }, env); // P: /clear A into B
  await inbox.writeRecord({ sessionId: SID, socket: procQ, token: TOKEN }, env); // Q resumes A
  await inbox.writeRecord({ sessionId: SID3, socket: procQ, token: TOKEN }, env); // Q: /clear A into C
  assert.deepEqual(JSON.parse(fs.readFileSync(inbox.clearedPath(SID, env), 'utf8')).clears.map((e) => [e.socket, e.clearedInto]), [[paneP, SID2], [procQ, SID3]]);
  await inbox.writeRecord({ sessionId: SID, socket: procQ, token: TOKEN }, env); // Q resumes A in-process
  assert.equal(inbox.clearedMarker(SID, env)?.clearedInto, SID2, 'only Q\'s own entry ended; P still advertises A');
  await inbox.dropRecord(SID, env, { socket: procQ }); // Q exits
  const sent = await harborMsg.send({ to: SID, text: 'for the old conversation', env });
  assert.equal(sent.clearedInto, SID2, 'refused as cleared');
  assert.equal(sent.tried, undefined, 'no typing fallback');
});

test('an agent\'s message after a resume elsewhere exits falls back to nothing: the inbox drop finds the marker', async () => {
  const { env } = freshInbox();
  const paneX = deadPipe();
  await inbox.writeRecord({ sessionId: SID, socket: paneX, token: TOKEN }, env);
  await inbox.writeRecord({ sessionId: SID2, socket: paneX, token: TOKEN }, env);
  await inbox.writeRecord({ sessionId: SID, socket: deadPipe(), token: TOKEN }, env);
  // The resumed process is gone (its pipe is dead): the post fails, the record is dropped.
  const sent = await harborMsg.send({ to: SID, text: 'for the old conversation', env });
  assert.equal(sent.ok, false);
  assert.equal(sent.clearedInto, SID2);
  assert.equal(sent.tried, undefined, 'no typing fallback into the pane that runs the new conversation');
});

test('the hook records the inbox Claude exports, and records nothing without one', async () => {
  const env = cleanEnv({ HARBOR_INBOX_DIR: realTmp() });
  const hook = path.resolve(__dirname, '../../../bin/harbor-inbox-hook');
  const input = JSON.stringify({ session_id: SID, transcript_path: 'C:\\x\\t.jsonl', cwd: 'C:\\x', hook_event_name: 'UserPromptSubmit' });
  const bare = spawnSync(process.execPath, [hook], { input, env: { ...env, CLAUDE_CODE_MESSAGING_SOCKET: '', CLAUDE_CODE_MESSAGING_TOKEN: '' }, windowsHide: true });
  assert.equal(bare.status, 0);
  assert.equal(inbox.readRecord(SID, env), null, 'no inbox exported: nothing recorded');
  const run = spawnSync(process.execPath, [hook], {
    input,
    env: { ...env, CLAUDE_CODE_MESSAGING_SOCKET: `\\\\.\\pipe\\LOCAL\\cc-msg-${'3'.repeat(32)}`, CLAUDE_CODE_MESSAGING_TOKEN: TOKEN },
    windowsHide: true,
  });
  assert.equal(run.status, 0);
  assert.equal(String(run.stdout), '', 'the hook adds no context');
  const record = inbox.readRecord(SID, env);
  assert.equal(record.token, TOKEN);
  assert.equal(record.transcriptPath, 'C:\\x\\t.jsonl');
  const broken = spawnSync(process.execPath, [hook], { input: 'not json', env: { ...env, CLAUDE_CODE_MESSAGING_SOCKET: 'x', CLAUDE_CODE_MESSAGING_TOKEN: 'y' }, windowsHide: true });
  assert.equal(broken.status, 0, 'a fault never blocks a prompt');
});

// --- posting and proof ----------------------------------------------------------

test('a post opens with the session token, then sends one framed message, and the transcript proves delivery', { skip: !isWin }, async () => {
  const { transcript } = freshInbox();
  fs.writeFileSync(transcript, '{"type":"user"}\n');
  const session = await fakeSession({ transcript });
  try {
    const record = { sessionId: SID, socket: session.address, token: TOKEN, transcriptPath: transcript };
    const content = inbox.wrapMessage('a "quoted" <body>\n'.repeat(2000), { fromName: 'Router' });
    const since = inbox.transcriptSize(record);
    assert.deepEqual(await inbox.postMessage(record, content), { ok: true });
    const proof = await inbox.confirmDelivery(record, content, { since, timeoutMs: 3000, pollMs: 20 });
    assert.equal(proof.confirmed, true);
    assert.deepEqual(session.lines[0], { type: 'auth', token: TOKEN });
    assert.deepEqual(session.lines[1], { type: 'user', message: { role: 'user', content }, session_id: SID });
  } finally { await session.close(); }
});

test('a message the transcript never shows is unconfirmed, and a vanished transcript never throws', { skip: !isWin }, async () => {
  const { transcript } = freshInbox();
  const session = await fakeSession({ transcript, silent: true });
  try {
    const record = { socket: session.address, token: TOKEN, transcriptPath: transcript };
    assert.equal((await inbox.postMessage(record, inbox.wrapMessage('hi'))).ok, true);
    const pending = inbox.confirmDelivery(record, inbox.wrapMessage('hi'), { since: 0, timeoutMs: 400, pollMs: 20 });
    fs.rmSync(transcript);
    assert.equal((await pending).confirmed, false);
  } finally { await session.close(); }
});

test('a gone pipe is definite (safe to send another way); the size limit counts the serialized frame', { skip: !isWin }, async () => {
  const record = { socket: deadPipe(), token: TOKEN };
  const gone = await inbox.postMessage(record, 'x', { timeoutMs: 3000 });
  assert.equal(gone.code, 'ENOENT');
  assert.equal(gone.definite, true);
  // Under a million characters raw, over it once every quote is escaped.
  const quotes = '"'.repeat(600_000);
  const big = await inbox.postMessage(record, quotes);
  assert.equal(big.code, 'TOO_LARGE');
  assert.ok(big.size > inbox.MAX_FRAME_CHARS);
});

// --- harbor-msg -----------------------------------------------------------------

test('harbor-msg delivers through the inbox; a dead inbox is dropped and reported, not retried blind', { skip: !isWin }, async () => {
  const { transcript, env } = freshInbox();
  const session = await fakeSession({ transcript });
  try {
    await inbox.writeRecord({ sessionId: SID, socket: session.address, token: TOKEN, transcriptPath: transcript }, env);
    const sent = await harborMsg.viaInbox(SID, 'status please', { from: 'Router', env, confirmMs: 3000 });
    assert.deepEqual(sent, { ok: true, route: 'inbox', delivered: true, via: 'enqueue' });
    assert.match(session.lines[1].message.content, /^<cross-session-message hop-chain="[0-9a-f]{24}" from-name="Router">\nstatus please\n<\/cross-session-message>$/);
    assert.equal(session.lines[1].session_id, SID);
  } finally { await session.close(); }
  const gone = await harborMsg.viaInbox(SID, 'again', { env, confirmMs: 500 });
  assert.equal(gone.ok, false);
  assert.equal(gone.definite, true);
  assert.match(gone.why, /inbox is gone/);
  assert.equal(inbox.readRecord(SID, env), null, 'the ended session\'s record is dropped');
});

test('a session that restarted on a new pipe is reached on the fresh record', { skip: !isWin }, async () => {
  const { transcript, env } = freshInbox();
  const session = await fakeSession({ transcript });
  const realPost = inbox.postMessage;
  let calls = 0;
  inbox.postMessage = async (record, content, opts) => {
    calls += 1;
    // The first post finds the old pipe gone, just as a resume publishes the new one.
    if (calls === 1) { await inbox.writeRecord({ sessionId: SID, socket: session.address, token: TOKEN, transcriptPath: transcript }, env); }
    return realPost(record, content, opts);
  };
  try {
    await inbox.writeRecord({ sessionId: SID, socket: deadPipe(), token: TOKEN, transcriptPath: transcript }, env);
    const sent = await harborMsg.viaInbox(SID, 'after restart', { env, confirmMs: 3000 });
    assert.equal(sent.delivered, true);
    assert.equal(calls, 2);
  } finally { inbox.postMessage = realPost; await session.close(); }
});

test('a post that may have landed is never sent another way: it leaves a receipt instead', async () => {
  const { transcript, env } = freshInbox();
  await inbox.writeRecord({ sessionId: SID, socket: deadPipe(), token: TOKEN, transcriptPath: transcript }, env);
  const realPost = inbox.postMessage;
  inbox.postMessage = async () => ({ ok: false, code: 'TIMEOUT', definite: false });
  try {
    const sent = await harborMsg.send({ to: SID, text: 'maybe landed', from: 'Router', env });
    assert.equal(sent.ok, 'unconfirmed');
    assert.equal(sent.delivered, 'unknown');
    assert.equal(sent.tried, undefined, 'no typing fallback');
    assert.match(sent.receipt, /^\d{14}-[0-9a-f]+$/);
    assert.equal(inbox.checkReceipt(sent.receipt, env).delivered, 'pending', 'no record yet is pending, never "not delivered"');
    // It turns up in the transcript later (its own id): the receipt now says so.
    const receipt = JSON.parse(fs.readFileSync(path.join(path.dirname(env.HARBOR_INBOX_DIR), 'receipts', `${sent.receipt}.json`), 'utf8'));
    assert.match(receipt.content, /hop-chain="[0-9a-f]{24}"/);
    fs.appendFileSync(transcript, `${JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: inbox.wrapMessage('maybe landed', { fromName: 'Router' }) })}\n`);
    assert.equal(inbox.checkReceipt(sent.receipt, env).delivered, 'pending', 'the same words without its id are not its delivery');
    fs.appendFileSync(transcript, `${JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: receipt.content })}\n`);
    assert.equal(inbox.checkReceipt(sent.receipt, env).delivered, true);
    fs.rmSync(transcript);
    assert.equal(inbox.checkReceipt(sent.receipt, env).delivered, 'unknown', 'no transcript is "unknown", never "not delivered"');
  } finally { inbox.postMessage = realPost; }
});

test('a busy pipe is retried, then delivered', { skip: !isWin }, async () => {
  const { transcript, env } = freshInbox();
  const session = await fakeSession({ transcript });
  const realPost = inbox.postMessage;
  let calls = 0;
  inbox.postMessage = async (...args) => { calls += 1; return calls <= 2 ? { ok: false, code: 'EBUSY', definite: true } : realPost(...args); };
  try {
    await inbox.writeRecord({ sessionId: SID, socket: session.address, token: TOKEN, transcriptPath: transcript }, env);
    assert.equal((await harborMsg.viaInbox(SID, 'busy', { env, confirmMs: 3000 })).delivered, true);
    assert.equal(calls, 3);
  } finally { inbox.postMessage = realPost; await session.close(); }
});

// Every message carries its own id (the wrapper's hop-chain field; measured:
// Claude keeps it in the enqueue record), so a send can only be proven by its
// OWN record, never by an earlier identical one.
test('two sends of the same words are two messages, each proven by its own record', { skip: !isWin }, async () => {
  const { transcript, env } = freshInbox();
  const session = await fakeSession({ transcript, dedupe: true });
  try {
    await inbox.writeRecord({ sessionId: SID, socket: session.address, token: TOKEN, transcriptPath: transcript }, env);
    const results = await Promise.all([1, 2].map(() => harborMsg.viaInbox(SID, 'same text', { env, confirmMs: 3000 })));
    assert.deepEqual(results.map((r) => r.ok), [true, true]);
    const contents = session.lines.filter((l) => l.type === 'user').map((l) => l.message.content);
    assert.equal(new Set(contents).size, 2, 'distinct ids');
  } finally { await session.close(); }
});

// The receipt scan reads to the end in 8 MiB chunks with one UTF-8 decoder,
// so a record past the first chunk, with a character split across two reads,
// is still found (Sol's review, round two).
test('a receipt finds its record past the first read chunk, across a split character', async () => {
  const { transcript, env } = freshInbox();
  const content = inbox.wrapMessage('caf\u00e9 \u2026 late', { fromName: 'Router', messageId: inbox.newMessageId() });
  const record = JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content });
  const CHUNK = 8 * 1024 * 1024;
  // Pad so the record's first multi-byte character straddles the chunk edge.
  const prefixBytes = Buffer.byteLength(record.slice(0, record.indexOf('\u00e9')));
  const pad = CHUNK - prefixBytes - 1 - 1; // one newline, then one byte of the 2-byte character before the edge
  fs.writeFileSync(transcript, `${'x'.repeat(pad)}\n${record}\n`);
  const id = inbox.writeReceipt({ sessionId: SID, transcriptPath: transcript, since: 0, content }, env);
  assert.equal(inbox.checkReceipt(id, env).delivered, true);
});

test('a session resumed on a new pipe is never marked cleared by a /clear on its old pipe', async () => {
  const { env } = freshInbox();
  const oldPipe = deadPipe();
  await inbox.writeRecord({ sessionId: SID, socket: oldPipe, token: TOKEN }, env);
  await inbox.writeRecord({ sessionId: SID, socket: deadPipe(), token: TOKEN }, env); // resumed elsewhere
  await inbox.writeRecord({ sessionId: SID2, socket: oldPipe, token: TOKEN }, env); // the old process ran /clear
  assert.equal(inbox.lookup(SID, env).clearedInto, undefined);
  assert.ok(inbox.readRecord(SID, env).socket !== oldPipe);
});

test('an oversized message is refused outright, not typed instead', async () => {
  const { transcript, env } = freshInbox();
  await inbox.writeRecord({ sessionId: SID, socket: deadPipe(), token: TOKEN, transcriptPath: transcript }, env);
  const sent = await harborMsg.send({ to: SID, text: 'x'.repeat(1_100_000), env });
  assert.equal(sent.ok, false);
  assert.equal(sent.final, true);
  assert.match(sent.why, /1,048,576/);
  assert.equal(sent.tried, undefined);
});

// --- replies ----------------------------------------------------------------------

// Claude's SendMessage can answer only an inbox registered under its own config
// home, so the return address goes only to a recipient on the sender's plan, and
// everyone else gets a line naming the harbor-msg command to answer with.
test('a sender on the recipient\'s plan gets a native return address; another plan gets a reply line', { skip: !isWin }, async () => {
  const { transcript, env: base } = freshInbox();
  const session = await fakeSession({ transcript });
  const team = 'C:\\Users\\someone\\.claude-team';
  const sender = (home) => ({ ...base, CLAUDE_CODE_SESSION_ID: SENDER, CLAUDE_CODE_MESSAGING_SOCKET: SENDER_PIPE, CLAUDE_CODE_MESSAGING_TOKEN: TOKEN, CLAUDE_CONFIG_DIR: home });
  try {
    await inbox.writeRecord({ sessionId: SID, socket: session.address, token: TOKEN, transcriptPath: transcript, home: team }, base);
    assert.equal((await harborMsg.viaInbox(SID, 'same plan', { from: 'Router', env: sender(`${team.toUpperCase()}\\`), confirmMs: 3000 })).delivered, true);
    const same = session.lines.at(-1).message.content;
    assert.ok(same.startsWith(`<cross-session-message from="uds:${SENDER_PIPE}" from-session="${SENDER}" hop-chain="`), same);
    assert.match(same, /hop-chain="[0-9a-f]{24}" from-name="Router">\nsame plan\n<\/cross-session-message>$/);
    assert.equal((await harborMsg.viaInbox(SID, 'other plan', { from: 'Router', env: sender('C:\\Users\\someone\\.claude-gordon'), confirmMs: 3000 })).delivered, true);
    const other = session.lines.at(-1).message.content;
    assert.match(other, new RegExp(`^<cross-session-message from-session="${SENDER}" hop-chain="[0-9a-f]{24}" from-name="Router">\\nother plan\\n\\n\\(To reply: node C:/dev/harbor/bin/harbor-msg send --to ${SENDER} `));
    assert.doesNotMatch(other, /from="uds:/, 'no return address SendMessage would refuse');
  } finally { await session.close(); }
});

test('the reply line names the Claude or Codex session harbor-msg runs in, or --reply-to', async () => {
  assert.equal(harborMsg.senderSession(null, { CODEX_THREAD_ID: SENDER.toUpperCase() }), SENDER);
  assert.equal(harborMsg.senderSession(SID, { CLAUDE_CODE_SESSION_ID: SENDER }), SID);
  assert.equal(harborMsg.senderSession('nonsense', {}), null);
  assert.equal(harborMsg.replyLine(null), '', 'no sender session, no reply line');
});

test('config homes compare by their real path', async () => {
  const dir = realTmp();
  assert.equal(harborMsg.configHome(dir), harborMsg.configHome(`${dir.toUpperCase()}${path.sep}`));
  assert.equal(harborMsg.configHome(null), harborMsg.configHome(path.join(os.homedir(), '.claude')));
});
