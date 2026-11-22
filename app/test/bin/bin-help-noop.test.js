'use strict';

// THE SIBLINGS OF harbor-sessiond's --help (2026-11-22). After
// `harbor-sessiond handover --help` performed a live handover, every other bin/
// wrapper was read for the same fault. Five acted on a help flag:
//   harbor-msg        `send ... --help` / `send ... -h` SENT the message
//   harbor-notes      `-h` was a word: `add -h` added a note, `rm <id> -h` deleted one
//   harbor-tasks      `add Buy milk -h` added the task "Buy milk -h"
//   harbor-board      `-h` joined the board-name search, so a write could land
//                     on any board whose name contains "-h"
//   harbor-mcp-login  with its flags given, --help still started the sign-in
// Each now prints usage and acts on nothing when an ARGUMENT is exactly --help
// or -h. A flag's value that happens to be "--help" or "-h", or prose that
// contains those words, is still data: the must-send and must-write controls
// below pin that, harbor-msg's in the exact shapes the team uses. Every run is
// against throwaway stores; harbor-msg's inbox is an in-test stub pipe that
// plays the recipient (it appends the enqueue record a real session would),
// and its typing fallback points at a dead local port.

const { afterEach, test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { execPath: guiNodeExec } = require('../support/gui-node.js');
const { realTmpDir } = require('../support/real-tmpdir.js');

const BIN = path.resolve(__dirname, '../../../bin');

const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(realTmpDir(), prefix));
  cleanups.push(async () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  return dir;
}

// Every file under dir with its bytes: "unchanged" means byte-identical.
function snapshot(dir) {
  const out = {};
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) { out[`${path.relative(dir, full)}/`] = ''; walk(full); }
      else out[path.relative(dir, full)] = fs.readFileSync(full).toString('base64');
    }
  };
  walk(dir);
  return out;
}

function cleanEnv(extra) {
  const env = { ...process.env, ...extra };
  for (const key of ['CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CODEX_THREAD_ID']) delete env[key];
  return env;
}

// Async: harbor-msg's stub answers from this event loop.
// harbor-mcp-login reads stdin for "cancel" and cancels at its end, so it gets
// an open pipe; everything else gets none.
function run(script, args, env, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const child = spawn(guiNodeExec, [path.join(BIN, script), ...args], { env, windowsHide: true, stdio: [script === 'harbor-mcp-login' ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, timeoutMs);
    child.on('close', (status, signal) => { clearTimeout(timer); resolve({ status, signal, stdout, stderr }); });
  });
}

function assertHelp(result, pattern) {
  assert.equal(result.signal, null, `had to be killed: ${result.stderr}`);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.match(result.stdout, pattern);
}

// --- harbor-msg ---------------------------------------------------------------

async function msgWorld() {
  const root = tempDir('hbr-msg-help-');
  const inboxDir = path.join(root, 'inboxes');
  fs.mkdirSync(inboxDir);
  const id = crypto.randomUUID();
  const pipeName = `cc-msg-${crypto.randomBytes(16).toString('hex')}`;
  const transcript = path.join(root, 'transcript.jsonl');
  fs.writeFileSync(transcript, '');
  fs.writeFileSync(path.join(inboxDir, `${id}.json`), JSON.stringify({
    sessionId: id, socket: pipeName, token: crypto.randomBytes(16).toString('hex'),
    transcriptPath: transcript, cwd: root, home: null, pid: null, at: new Date().toISOString(),
  }));
  const seen = { connections: 0, frames: [] };
  const sockets = new Set();
  const server = net.createServer((conn) => {
    seen.connections += 1;
    sockets.add(conn);
    conn.on('close', () => sockets.delete(conn));
    conn.on('error', () => {});
    let buffered = '';
    conn.on('data', (chunk) => {
      buffered += chunk;
      let newline;
      while ((newline = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        let record;
        try { record = JSON.parse(line); } catch { continue; }
        if (record.type !== 'user') continue;
        seen.frames.push(record);
        // What the receiving session writes when it takes the message.
        fs.appendFileSync(transcript, `${JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: record.message.content })}\n`);
      }
    });
  });
  await new Promise((resolve) => server.listen(`\\\\.\\pipe\\LOCAL\\${pipeName}`, resolve));
  cleanups.push(async () => {
    for (const conn of sockets) conn.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  const env = cleanEnv({
    HARBOR_INBOX_DIR: inboxDir,
    HARBOR_USER_DATA_DIR: path.join(root, 'userdata'),
    HARBOR_SERVER_WS: 'ws://127.0.0.1:9/ws',
  });
  const file = path.join(root, 'message.txt');
  fs.writeFileSync(file, 'a message from a file\n');
  return { root, id, env, seen, file, transcript };
}

const MSG_HELP = [
  (w) => ['send', '--to', w.id, '--from', 'tester', '--text', 'hi', '--help'],
  (w) => ['send', '--to', w.id, '--from', 'tester', '--text', 'hi', '-h'],
  (w) => ['send', '--help', '--to', w.id, '--text', 'hi'],
  (w) => ['send', '-h', '--to', w.id, '--from', 'tester', '--file', w.file],
  (w) => ['send', '--to', w.id, '--file', w.file, '--no-fallback', '--help'],
  (w) => ['status', '--to', w.id, '--help'],
  () => ['confirm', '--receipt', '20261122000000-abc', '-h'],
  () => ['--help'],
  () => ['-h'],
];

for (const shape of MSG_HELP) {
  test(`harbor-msg ${shape({ id: '<id>', file: '<file>' }).join(' ')} prints usage and sends nothing`, { timeout: 60000 }, async () => {
    const world = await msgWorld();
    const before = snapshot(world.root);
    const result = await run('harbor-msg', shape(world), world.env);
    assert.equal(world.seen.connections, 0, `reached the inbox: ${JSON.stringify(world.seen.frames)}`);
    assert.deepEqual(snapshot(world.root), before, 'wrote to the inbox store');
    assertHelp(result, /usage: harbor-msg/);
  });
}

const MSG_MUST_SEND = [
  ['--file', (w) => ['send', '--to', w.id, '--from', 'tester', '--file', w.file], 'a message from a file'],
  ['--text', (w) => ['send', '--to', w.id, '--from', 'tester', '--text', 'plain words'], 'plain words'],
  ['a --text whose value is --help', (w) => ['send', '--to', w.id, '--from', 'tester', '--text', '--help'], '--help'],
  ['a --text whose value is -h', (w) => ['send', '--to', w.id, '--from', 'tester', '--text', '-h'], '-h'],
  ['prose naming --help and -h', (w) => ['send', '--to', w.id, '--from', 'tester', '--text', 'run it with --help or -h first'], 'run it with --help or -h first'],
];

for (const [label, shape, expected] of MSG_MUST_SEND) {
  test(`control: harbor-msg send with ${label} still sends`, { timeout: 60000 }, async () => {
    const world = await msgWorld();
    const result = await run('harbor-msg', shape(world), world.env);
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const verdict = JSON.parse(result.stdout.trim().split('\n').pop());
    assert.equal(verdict.ok, true, result.stdout);
    assert.equal(verdict.delivered, true, result.stdout);
    assert.equal(world.seen.frames.length, 1);
    assert.ok(world.seen.frames[0].message.content.includes(`\n${expected}`), world.seen.frames[0].message.content);
    assert.match(world.seen.frames[0].message.content, /from-name="tester"/);
  });
}

test('control: harbor-msg confirm --receipt still reads the receipt', { timeout: 60000 }, async () => {
  const world = await msgWorld();
  const content = '<cross-session-message from-name="tester">\nlanded\n</cross-session-message>';
  fs.appendFileSync(world.transcript, `${JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content })}\n`);
  const receiptId = '20261122000000-abc123';
  fs.mkdirSync(path.join(world.root, 'receipts'));
  fs.writeFileSync(path.join(world.root, 'receipts', `${receiptId}.json`), JSON.stringify({ id: receiptId, sessionId: world.id, transcriptPath: world.transcript, since: 0, content }));
  const result = await run('harbor-msg', ['confirm', '--receipt', receiptId], world.env);
  assert.equal(result.status, 0, result.stderr);
  const verdict = JSON.parse(result.stdout);
  assert.equal(verdict.delivered, true, result.stdout);
  assert.equal(world.seen.connections, 0);
});

// --- harbor-notes, harbor-tasks, harbor-board -------------------------------

async function notesWorld() {
  const root = tempDir('hbr-notes-help-');
  const env = cleanEnv({ HARBOR_NOTES_FILE: path.join(root, 'notes.json') });
  const added = await run('harbor-notes', ['add', '--title', 'keep me', '--body', 'kept', '--json'], env);
  assert.equal(added.status, 0, added.stderr);
  return { root, env, noteId: JSON.parse(added.stdout).note.id };
}

for (const shape of [(w) => ['add', '-h'], (w) => ['rm', w.noteId, '-h'], () => ['add', '--title', 't', '--body', 'b', '-h'], () => ['-h']]) {
  test(`harbor-notes ${shape({ noteId: '<id>' }).join(' ')} prints usage and writes nothing`, { timeout: 60000 }, async () => {
    const world = await notesWorld();
    const before = snapshot(world.root);
    const result = await run('harbor-notes', shape(world), world.env);
    assert.deepEqual(snapshot(world.root), before, 'wrote to the notes file');
    assertHelp(result, /harbor-notes: read and edit/);
  });
}

test('control: harbor-notes add --body -h still adds a note whose body is -h', { timeout: 60000 }, async () => {
  const world = await notesWorld();
  const result = await run('harbor-notes', ['add', '--title', 'dash', '--body', '-h', '--json'], world.env);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).note.body, '-h');
});

async function tasksWorld() {
  const root = tempDir('hbr-tasks-help-');
  const env = cleanEnv({ HARBOR_TASKS_FILE: path.join(root, 'tasks.json') });
  const added = await run('harbor-tasks', ['add', 'Existing task', '--json'], env);
  assert.equal(added.status, 0, added.stderr);
  return { root, env };
}

for (const args of [['add', 'Buy', 'milk', '-h'], ['done', 'Existing', 'task', '-h'], ['-h']]) {
  test(`harbor-tasks ${args.join(' ')} prints usage and writes nothing`, { timeout: 60000 }, async () => {
    const world = await tasksWorld();
    const before = snapshot(world.root);
    const result = await run('harbor-tasks', args, world.env);
    assert.deepEqual(snapshot(world.root), before, 'wrote to the task list');
    assertHelp(result, /harbor-tasks: read and edit/);
  });
}

test('control: harbor-tasks add still adds', { timeout: 60000 }, async () => {
  const world = await tasksWorld();
  const before = snapshot(world.root);
  const result = await run('harbor-tasks', ['add', 'Buy', 'milk'], world.env);
  assert.equal(result.status, 0, result.stderr);
  assert.notDeepEqual(snapshot(world.root), before);
});

function boardsWorld() {
  const root = tempDir('hbr-board-help-');
  const board = { type: 'excalidraw', version: 2, source: 'test', name: 'q4-harbor', updatedAt: new Date(0).toISOString(), elements: [], appState: {}, files: {} };
  fs.writeFileSync(path.join(root, 'q4-harbor.json'), `${JSON.stringify(board)}\n`);
  return { root, env: cleanEnv({ HARBOR_BOARDS_DIR: root }) };
}

for (const args of [['add-sticky', '-h', '--text', 'x'], ['add-sticky', 'q4-harbor', '--text', 'x', '-h'], ['-h']]) {
  test(`harbor-board ${args.join(' ')} prints usage and writes nothing`, { timeout: 60000 }, async () => {
    const world = boardsWorld();
    const before = snapshot(world.root);
    const result = await run('harbor-board', args, world.env);
    assert.deepEqual(snapshot(world.root), before, 'wrote to a board');
    assertHelp(result, /harbor-board: read and write/);
  });
}

test('control: harbor-board add-sticky --text -h still writes a sticky reading -h', { timeout: 60000 }, async () => {
  const world = boardsWorld();
  const result = await run('harbor-board', ['add-sticky', 'q4-harbor', '--text', '-h', '--json'], world.env);
  assert.equal(result.status, 0, result.stderr);
  assert.match(fs.readFileSync(path.join(world.root, 'q4-harbor.json'), 'utf8'), /"text":\s*"-h"/);
});

// --- harbor-mcp-login ------------------------------------------------------------

function loginWorld() {
  const root = tempDir('hbr-mcp-help-');
  const marker = path.join(root, 'claude-ran.txt');
  const fake = path.join(root, 'fake-claude.cjs');
  fs.writeFileSync(fake, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, process.argv.slice(2).join(' '));\n`);
  return { root, marker, args: ['--claude', fake, '--home', root, '--cwd', root, '--name', 'srv', '--timeout-ms', '20000'], env: cleanEnv({}) };
}

for (const flag of ['--help', '-h']) {
  test(`harbor-mcp-login with its flags and ${flag} prints usage and starts nothing`, { timeout: 60000 }, async () => {
    const world = loginWorld();
    const result = await run('harbor-mcp-login', [...world.args, flag], world.env);
    assert.equal(fs.existsSync(world.marker), false, 'the sign-in CLI was started');
    assertHelp(result, /usage: harbor-mcp-login/);
  });
}

test('control: harbor-mcp-login without a help flag starts the CLI', { timeout: 60000 }, async () => {
  const world = loginWorld();
  await run('harbor-mcp-login', world.args, world.env);
  assert.equal(fs.readFileSync(world.marker, 'utf8'), 'mcp login --no-browser srv');
});
