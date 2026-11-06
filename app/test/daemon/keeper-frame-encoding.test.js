'use strict';
const { execPath: guiNodeExec } = require('../support/gui-node.js');

// A KEEPER ENCODES A PTY CHUNK ONLY FOR SOMEONE WHO IS WATCHING (2026-11-06).
// keeper.js base64-encoded every chunk the pty produced and built the event
// object around it even when no observer was attached, which is the case for
// nearly every session nearly all the time. Two-sided, against the real daemon
// and a real keeper with a hook that counts base64 encodings inside the keeper
// process: with no observer the count stays zero; the moment an observer
// attaches, frames carry both `text` and `bytes` exactly as before (the wire
// format is unchanged) and the count moves, which also proves the hook is live.

const { afterEach, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { SessionClient } = require('../../src/daemon/client.js');
const { realTmpDir } = require('../support/real-tmpdir.js');

const ROOT = path.resolve(__dirname, '../..');
const DAEMON = path.join(ROOT, 'src/daemon/daemon.js');
const cleanups = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const IS_WIN32 = process.platform === 'win32';

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

async function waitUntil(fn, message, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await sleep(50);
  }
  throw new Error(typeof message === 'function' ? await message() : message);
}

// One '.' per base64 toString inside a KEEPER process (the daemon and the
// resident hook host are ignored), into a file the test owns.
const BASE64_COUNTER_HOOK = `
if (/keeper\\.js$/.test(process.argv[1] || '')) {
  const fs = require('node:fs');
  const original = Buffer.prototype.toString;
  const counterFile = process.env.HARBOR_TEST_BASE64_COUNT;
  Buffer.prototype.toString = function countedToString(encoding, ...rest) {
    if (encoding === 'base64') { try { fs.appendFileSync(counterFile, '.'); } catch {} }
    return original.call(this, encoding, ...rest);
  };
}
`;

test('no observer, no encoding; an observer gets the same frames as ever', { timeout: 120_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(realTmpDir(), 'harbor-keeper-encode-'));
  const socketPath = path.join(dir, 'daemon.sock');
  const hookPath = path.join(dir, 'count-base64.js');
  const counterFile = path.join(dir, 'base64.txt');
  fs.writeFileSync(hookPath, BASE64_COUNTER_HOOK);
  fs.writeFileSync(counterFile, '');
  const count = () => fs.readFileSync(counterFile, 'utf8').length;

  const daemon = spawn(guiNodeExec, [DAEMON], {
    windowsHide: true,
    env: {
      ...process.env,
      HARBOR_SESSIOND_DIR: dir,
      HARBOR_SESSIOND_SOCKET: socketPath,
      HARBOR_NO_DAEMON_START: '1',
      HARBOR_TEST_BASE64_COUNT: counterFile,
      NODE_OPTIONS: `--require ${JSON.stringify(hookPath)}`,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  daemon.stderr.on('data', (chunk) => { stderr += chunk; });
  const client = new SessionClient({ socketPath });
  // Registered BEFORE the readiness wait (sessiond.md porting rules): a leaked
  // child keeps node --test alive forever, and an orphan ConPTY shell holds dir.
  cleanups.push(async () => {
    const pids = [];
    try {
      const listed = await client.request('list');
      for (const s of listed.sessions) {
        pids.push(s.keeper_pid, s.pid);
        await client.request('terminate', { id: s.id, signal: 'SIGKILL' }).catch(() => {});
      }
    } catch {}
    client.close();
    if (daemon.exitCode === null) { daemon.kill('SIGTERM'); await new Promise((resolve) => daemon.once('exit', resolve)); }
    const deadline = Date.now() + 5000;
    for (const pid of pids.filter(Boolean)) {
      while (Date.now() < deadline) { try { process.kill(pid, 0); } catch { break; } await sleep(50); }
    }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  });
  await waitUntil(async () => { try { return (await client.request('health')).ok; } catch { return false; } },
    () => `daemon never answered: ${stderr}`);

  const argv = IS_WIN32
    ? [process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe', '/Q', '/K']
    : ['/bin/bash', '--noprofile', '--norc'];
  const env = {};
  for (const key of ['SystemRoot', 'PATH', 'PATHEXT', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  const { id } = await client.request('spawn', { argv, cwd: dir, env, cols: 80, rows: 24 });
  const say = (marker) => client.request('input', { id, text: IS_WIN32 ? `echo ${marker}\r` : `echo ${marker}\n` });
  const onScreen = (marker) => waitUntil(
    async () => ((await client.request('screen', { id, scrollback: 50 })).text || '').includes(marker),
    `the pane never showed ${marker}`);

  // 1. Output with nobody watching: the shell's banner and prompt, then a burst.
  for (let i = 0; i < 5; i += 1) await say(`UNWATCHED_${i}`);
  await onScreen('UNWATCHED_4');
  await sleep(300);
  assert.equal(count(), 0, `the keeper encoded ${count()} chunks with no observer attached`);

  // 2. An observer attaches: frames keep the shape they always had.
  const frames = [];
  client.onEvent((event) => { if (event.type === 'frame') frames.push(event); });
  await client.request('observe', { id });
  await say('WATCHED_MARK');
  await waitUntil(() => frames.some((frame) => frame.text.includes('WATCHED_MARK')), () => `no frame carried the marker: ${JSON.stringify(frames)}`);
  assert.ok(count() > 0, 'the counting hook never saw an encoding, so step 1 proved nothing');
  for (const frame of frames) {
    assert.equal(typeof frame.text, 'string');
    assert.equal(Buffer.from(frame.bytes, 'base64').toString('utf8'), frame.text, 'bytes is the base64 of text');
    assert.equal(frame.id, id);
  }

  // 3. The observer goes away: encoding stops again.
  await client.request('unobserve', { id });
  await sleep(500);
  const settled = count();
  await say('UNWATCHED_AGAIN');
  await onScreen('UNWATCHED_AGAIN');
  await sleep(300);
  assert.equal(count(), settled, 'the keeper kept encoding after its last observer left');
});
