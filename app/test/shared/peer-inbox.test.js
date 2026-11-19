'use strict';

// Messages between sessions go into the recipient's own Claude Code inbox
// (src/shared/peer-inbox.cjs). A real named-pipe server stands in for the
// session, and a fake transcript for its delivery record.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const inbox = require('../../src/shared/peer-inbox.cjs');

const realTmp = () => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'peer-inbox-')));
const SID = '0a1b2c3d-1111-2222-3333-444455556666';
const TOKEN = 'ab'.repeat(16);
const isWin = process.platform === 'win32';

// A stand-in session inbox: records every line, and on the message line writes
// the enqueue record Claude writes, unless told to stay silent.
function fakeSession({ transcript, silent = false } = {}) {
  const name = `cc-msg-${crypto.randomBytes(16).toString('hex')}`;
  const address = `\\\\.\\pipe\\LOCAL\\${name}`;
  const lines = [];
  const server = net.createServer((socket) => {
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        lines.push(JSON.parse(line));
        const msg = lines.at(-1);
        if (msg.type === 'user' && transcript && !silent) {
          fs.appendFileSync(transcript, `${JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: msg.message.content })}\n`);
        }
      }
    });
  });
  return new Promise((resolve) => server.listen(address, () => resolve({ address, lines, close: () => new Promise((r) => server.close(r)) })));
}

test('the wrapper is the form Claude draws as "Message from @<name>", with the name made safe', () => {
  assert.equal(inbox.wrapMessage('hello\nthere', { fromName: 'Router' }), '<cross-session-message from-name="Router">\nhello\nthere\n</cross-session-message>');
  assert.equal(inbox.wrapMessage('x'), '<cross-session-message>\nx\n</cross-session-message>');
  assert.equal(inbox.cleanName('The "Product" <Owner>\n'), 'The Product Owner');
});

test('only a real cc-msg pipe name is accepted, in every spelling Claude exports', () => {
  const hex = 'f'.repeat(32);
  assert.equal(inbox.pipeAddress(`\\\\.\\pipe\\LOCAL\\cc-msg-${hex}`), `\\\\.\\pipe\\LOCAL\\cc-msg-${hex}`);
  assert.equal(inbox.pipeAddress(`uds:\\\\.\\pipe\\LOCAL\\cc-msg-${hex}`), `\\\\.\\pipe\\LOCAL\\cc-msg-${hex}`);
  assert.equal(inbox.pipeAddress(`cc-msg-${hex}`), `\\\\.\\pipe\\LOCAL\\cc-msg-${hex}`);
  assert.equal(inbox.pipeAddress('\\\\.\\pipe\\something-else'), null);
  assert.equal(inbox.pipeAddress(''), null);
});

test('a record is written once, re-written only when it changes, read back, and dropped', () => {
  const env = { HARBOR_INBOX_DIR: realTmp() };
  const record = { sessionId: SID.toUpperCase(), socket: `\\\\.\\pipe\\LOCAL\\cc-msg-${'1'.repeat(32)}`, token: TOKEN, transcriptPath: 'C:\\t.jsonl' };
  assert.equal(inbox.writeRecord(record, env).written, true);
  assert.equal(inbox.writeRecord(record, env).reason, 'unchanged');
  assert.equal(inbox.writeRecord({ ...record, token: 'cd'.repeat(16) }, env).written, true, 'a new token is written');
  assert.equal(inbox.readRecord(SID, env).token, 'cd'.repeat(16));
  assert.equal(inbox.writeRecord({ ...record, socket: 'not-a-pipe' }, env).written, false);
  assert.equal(inbox.writeRecord({ ...record, token: 'xyz' }, env).written, false);
  inbox.dropRecord(SID, env);
  assert.equal(inbox.readRecord(SID, env), null);
});

test('records nobody refreshed in two weeks are pruned', () => {
  const env = { HARBOR_INBOX_DIR: realTmp() };
  inbox.writeRecord({ sessionId: SID, socket: `cc-msg-${'2'.repeat(32)}`, token: TOKEN }, env);
  const file = inbox.recordPath(SID, env);
  const old = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...old, at: new Date(Date.now() - 15 * 86_400_000).toISOString() }));
  assert.equal(inbox.pruneRecords(env), 1);
  assert.equal(inbox.readRecord(SID, env), null);
});

test('a post opens with the session token, then sends one user message, and the transcript proves delivery', { skip: !isWin }, async () => {
  const dir = realTmp();
  const transcript = path.join(dir, 't.jsonl');
  fs.writeFileSync(transcript, '{"type":"user"}\n');
  const session = await fakeSession({ transcript });
  try {
    const record = { socket: session.address, token: TOKEN, transcriptPath: transcript };
    const content = inbox.wrapMessage('a "quoted" <body>\n'.repeat(2000), { fromName: 'Router' });
    const since = inbox.transcriptSize(record);
    assert.deepEqual(await inbox.postMessage(record, content), { ok: true });
    const proof = await inbox.confirmDelivery(record, content, { since, timeoutMs: 3000, pollMs: 20 });
    assert.equal(proof.confirmed, true);
    assert.deepEqual(session.lines[0], { type: 'auth', token: TOKEN });
    assert.deepEqual(session.lines[1], { type: 'user', message: { role: 'user', content } });
  } finally { await session.close(); }
});

test('a message the transcript never shows is reported unconfirmed, not delivered', { skip: !isWin }, async () => {
  const dir = realTmp();
  const transcript = path.join(dir, 't.jsonl');
  fs.writeFileSync(transcript, '');
  const session = await fakeSession({ transcript, silent: true });
  try {
    const record = { socket: session.address, token: TOKEN, transcriptPath: transcript };
    assert.equal((await inbox.postMessage(record, inbox.wrapMessage('hi'))).ok, true);
    const proof = await inbox.confirmDelivery(record, inbox.wrapMessage('hi'), { since: 0, timeoutMs: 400, pollMs: 20 });
    assert.equal(proof.confirmed, false);
  } finally { await session.close(); }
});

test('a pipe that is gone answers ENOENT, and an oversized message never leaves', { skip: !isWin }, async () => {
  const record = { socket: `\\\\.\\pipe\\LOCAL\\cc-msg-${crypto.randomBytes(16).toString('hex')}`, token: TOKEN };
  assert.equal((await inbox.postMessage(record, 'x', { timeoutMs: 3000 })).code, 'ENOENT');
  assert.equal((await inbox.postMessage(record, 'x'.repeat(inbox.MAX_MESSAGE_CHARS + 1))).code, 'TOO_LARGE');
});

test('the hook records the inbox Claude exports, and records nothing without one', () => {
  const env = { ...process.env, HARBOR_INBOX_DIR: realTmp() };
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

test('harbor-msg delivers through the inbox, and a dead inbox is dropped and reported', { skip: !isWin }, async () => {
  const env = { ...process.env, HARBOR_INBOX_DIR: realTmp() };
  const transcript = path.join(env.HARBOR_INBOX_DIR, 't.jsonl');
  fs.writeFileSync(transcript, '');
  const session = await fakeSession({ transcript });
  const harborMsg = require('../../../bin/harbor-msg');
  try {
    inbox.writeRecord({ sessionId: SID, socket: session.address, token: TOKEN, transcriptPath: transcript }, env);
    const sent = await harborMsg.viaInbox(SID, 'status please', { from: 'Router', env, confirmMs: 3000 });
    assert.deepEqual(sent, { ok: true, route: 'inbox', delivered: true, via: 'enqueue' });
    assert.equal(session.lines[1].message.content, '<cross-session-message from-name="Router">\nstatus please\n</cross-session-message>');
  } finally { await session.close(); }
  const gone = await harborMsg.viaInbox(SID, 'again', { env, confirmMs: 500 });
  assert.equal(gone.ok, false);
  assert.match(gone.why, /ENOENT/);
  assert.equal(inbox.readRecord(SID, env), null, 'the ended session\'s record is dropped');
});
