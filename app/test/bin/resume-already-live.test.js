'use strict';

// ONE CONVERSATION, ONE PANE (2026-11-15, Pat: "what caused a second vox
// session? ... i dont even see a second one anywhere").
//
// Vox (5894c81a) was idle in a Harbor pane for six minutes. Another session
// sent it a note naming only its session id, the send resumed it, and
// bin/claude-sessions started a SECOND claude on the same transcript in a new
// pane: its only live check was "was the transcript written in the last 90
// seconds", and an idle session fails that. Both copies then ran for 45
// minutes on one conversation file.
//
// The launchers now ask the session daemon whether a live pane already holds
// the session. These specs run the REAL bin/claude-sessions and bin/ai against
// a stand-in daemon on an isolated socket (the real daemon is never reached),
// and every refusal has its two-sided twin: the same command must reach the
// daemon's spawn when the holder is gone, or the refusal could be passing for
// the wrong reason.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawnSync } = require('node:child_process');
const { listenAddress } = require('../../src/daemon/paths.js');
const { realTmpDir } = require('../support/real-tmpdir.js');

const ROOT = path.resolve(__dirname, '../../..');
const CLAUDE_SESSIONS = path.join(ROOT, 'bin', 'claude-sessions');
const AI = path.join(ROOT, 'bin', 'ai');
const SESSION_ID = 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb';
const CLAUDE_EXE = process.platform === 'win32' ? 'C:\\tools\\claude\\claude.exe' : '/usr/local/bin/claude';

// A stand-in daemon: answers `list` with the records a test gives it and
// records every `spawn` instead of starting anything.
async function fakeDaemon(dir, records) {
  const socketPath = path.join(dir, 'sessiond.sock');
  const spawns = [];
  const server = net.createServer((socket) => {
    let buffered = '';
    socket.on('data', (chunk) => {
      buffered += chunk;
      let at;
      while ((at = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, at);
        buffered = buffered.slice(at + 1);
        if (!line.trim()) continue;
        const request = JSON.parse(line);
        let reply;
        if (request.verb === 'list') reply = { ok: true, result: { sessions: records } };
        else if (request.verb === 'spawn') {
          spawns.push(request.params);
          reply = { ok: true, result: { id: 'fake-fresh-pane' } };
        } else reply = { ok: false, error: `unexpected verb ${request.verb}` };
        socket.write(`${JSON.stringify({ type: 'response', request_id: request.request_id, ...reply })}\n`);
      }
    });
    socket.on('error', () => {});
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(listenAddress(socketPath), resolve);
  });
  return { socketPath, spawns, close: () => new Promise((resolve) => server.close(resolve)) };
}

function fixture() {
  const dir = fs.mkdtempSync(path.join(realTmpDir(), 'harbor-already-live-'));
  const cwd = path.join(dir, 'project');
  fs.mkdirSync(cwd);
  const transcript = path.join(dir, `${SESSION_ID}.jsonl`);
  fs.writeFileSync(transcript, `${JSON.stringify({ type: 'last-prompt', lastPrompt: 'waiting on the team', sessionId: SESSION_ID })}\n`);
  // Idle for ten minutes: exactly the case the 90-second guard cannot see.
  const when = new Date(Date.now() - 600 * 1000);
  fs.utimesSync(transcript, when, when);
  const cacheDir = path.join(dir, 'cache');
  fs.mkdirSync(cacheDir);
  fs.writeFileSync(path.join(cacheDir, 'index.json'), JSON.stringify({
    v: 2,
    files: {
      [transcript]: {
        id: SESSION_ID, cwd, title: 'Vox', mt: fs.statSync(transcript).mtimeMs,
        sz: fs.statSync(transcript).size, last: when.toISOString(),
      },
    },
  }));
  const configFile = path.join(dir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ paths: { cacheDir, projectsDir: path.join(dir, 'projects') } }));
  const codexHome = path.join(dir, 'codex-home');
  fs.mkdirSync(codexHome);
  return { dir, cwd, configFile, codexHome };
}

function run(script, args, { configFile, socketPath, cwd }) {
  return new Promise((resolve) => {
    execFile(process.execPath, [script, ...args], {
      cwd,
      encoding: 'utf8',
      timeout: 30000,
      windowsHide: true,
      env: {
        ...process.env,
        HARBOR_SESSION_BACKEND: 'sessiond',
        HARBOR_CONFIG_FILE: configFile,
        HARBOR_NO_DAEMON_START: '1',
        HARBOR_SESSIOND_SOCKET: socketPath,
        HARBOR_SESSIOND_REQUEST_TIMEOUT_MS: '5000',
        HARBOR_CODEX_VERSION: '0.155.1',
      },
    }, (error, stdout, stderr) => resolve({ status: error ? (error.code ?? 1) : 0, stdout, stderr }));
  });
}

const livePane = (overrides = {}) => ({
  id: 'pane-vox',
  argv: [CLAUDE_EXE, '--dangerously-skip-permissions', '--session-id', SESSION_ID],
  agent: 'claude',
  agent_session: SESSION_ID,
  pid: process.pid, // a pid that is certainly alive: this test runner
  created_at: '2026-11-15T21:37:00.912Z',
  exit: null,
  ...overrides,
});

function deadPid() {
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8', windowsHide: true });
  return Number(child.stdout);
}

async function withDaemon(records, body) {
  const f = fixture();
  const daemon = await fakeDaemon(f.dir, records);
  try {
    await body({ ...f, socketPath: daemon.socketPath, spawns: daemon.spawns });
  } finally {
    await daemon.close();
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
}

test('a session already live in a pane is never resumed into a second pane, with or without --live-ok', async () => {
  await withDaemon([livePane()], async (f) => {
    for (const extra of [[], ['--live-ok']]) {
      const result = await run(CLAUDE_SESSIONS, ['--resume-id', SESSION_ID, ...extra], f);
      assert.notEqual(result.status, 0, `resume ${extra.join(' ')} must refuse`);
      assert.match(result.stderr, /already running in Harbor \(pane pane-vox, open since 2026-11-15T21:37:00\.912Z\)/);
      assert.match(result.stderr, /Send to that pane instead/);
    }
    assert.equal(f.spawns.length, 0, 'nothing may reach the daemon spawn');
  });
});

test('the same resume goes through once the holder is gone: exited, its process dead, or a different session', async () => {
  const cases = [
    ['exited', livePane({ exit: { code: 0, signal: null, at: '2026-11-16T00:08:56.429Z' } })],
    ['process gone', livePane({ pid: deadPid() })],
    ['another session', livePane({ agent_session: 'cccccccc-1111-2222-3333-dddddddddddd' })],
    // A shell's pid outlives a crashed claude, so it proves nothing; the send
    // path's dead-shell check resumes exactly this case on purpose.
    ['shell-hosted pane', livePane({ argv: [process.platform === 'win32' ? 'C:\\Windows\\System32\\cmd.exe' : '/bin/bash'] })],
  ];
  for (const [label, record] of cases) {
    await withDaemon([record], async (f) => {
      const result = await run(CLAUDE_SESSIONS, ['--resume-id', SESSION_ID], f);
      assert.doesNotMatch(result.stderr, /already running in Harbor/, label);
      assert.equal(result.status, 0, `${label}: ${result.stderr}`);
      assert.match(result.stdout, /in sessiond session fake-fresh-pane/, label);
      assert.equal(f.spawns.length, 1, label);
      assert.equal(f.spawns[0].agent_session, SESSION_ID, label);
    });
  }
});

test('a codex resume through bin/ai gets the same refusal; a codex pane showing another thread does not hold it', async () => {
  const codexPane = (prefix) => livePane({
    argv: ['codex', 'resume', '--dangerously-bypass-approvals-and-sandbox', SESSION_ID],
    agent: 'codex',
    codex_title: { prefix },
  });
  await withDaemon([codexPane(SESSION_ID.slice(0, 8))], async (f) => {
    const result = await run(AI, ['--provider', 'codex', '--home', f.codexHome, '--resume-id', SESSION_ID], f);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /already running in Harbor \(pane pane-vox/);
    assert.equal(f.spawns.length, 0);
  });
  // Thread-following: the pane's argv still names this id, but its title
  // shows another chat, so this thread is not live anywhere.
  await withDaemon([codexPane('ffffffff')], async (f) => {
    const result = await run(AI, ['--provider', 'codex', '--home', f.codexHome, '--resume-id', SESSION_ID], f);
    assert.doesNotMatch(result.stderr, /already running in Harbor/);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /started codex in sessiond session fake-fresh-pane/);
    assert.equal(f.spawns.length, 1);
  });
});
