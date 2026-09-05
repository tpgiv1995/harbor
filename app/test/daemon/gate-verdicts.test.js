'use strict';

// THE GATE'S VERDICT SPLIT (2026-08-30, r2-selfheal item 3). probeStoreOwner
// answers ok/mute/dead instead of a connect-only boolean: a wedged daemon
// still accepts connections out of the kernel backlog, so the old gate exited
// 3 claiming a healthy owner existed and nothing could ever replace the wedge.
// Three specs, one per verdict, because the split must make the gate MORE
// articulate and never more aggressive: a healthy owner still wins (exit 3,
// unchanged), a mute owner is refused with its own named answer (exit 4, no
// unlink, no bind, no kill), and a dead owner still yields the store.

const { afterEach, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { listenAddress } = require('../../src/daemon/paths.js');
const {
  DAEMON, guiNodeExec,
  alive, waitUntil, waitGone, canConnect, healthPid, freshStore, readLog, chainEnv, requestVerb,
} = require('../support/selfheal-harness.js');

const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

const exitOf = (child) => new Promise((resolve) => child.once('exit', (code) => resolve(code)));

test('a mute owner (accepts, never answers) makes start exit 4 by name, and is never unlinked or fought', { timeout: 60000 }, async () => {
  const fixture = freshStore('hbr-gate-mute-');
  // The stand-in wedge: a server that accepts and never writes a byte.
  const sockets = new Set();
  const standIn = net.createServer((socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {}); });
  await new Promise((resolve) => standIn.listen(listenAddress(fixture.socket), resolve));
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => standIn.close(resolve));
    fs.rmSync(fixture.store, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });

  const daemon = spawn(guiNodeExec, [DAEMON], { windowsHide: true, env: chainEnv(fixture), stdio: 'ignore' });
  cleanups.push(async () => { try { daemon.kill('SIGKILL'); } catch {} });
  assert.equal(await exitOf(daemon), 4, 'a mute owner is a DISTINCT refusal, not "already running"');
  assert.match(readLog(fixture.log), /accepts connections but does not answer health; a wedged daemon holds this pipe\. Run: harbor-sessiond recover/);
  assert.equal(await canConnect(fixture.socket), true, 'the mute lane never unlinked or stole the pipe');
});

test('a healthy owner still makes start exit 3, unchanged: the gate got more articulate, not more aggressive', { timeout: 60000 }, async () => {
  const fixture = freshStore('hbr-gate-ok-');
  const env = chainEnv(fixture);
  const first = spawn(guiNodeExec, [DAEMON], { windowsHide: true, env, stdio: 'ignore' });
  cleanups.push(async () => {
    try { first.kill('SIGKILL'); } catch {}
    fs.rmSync(fixture.store, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  await waitUntil(() => healthPid(fixture.socket), 'first daemon never became healthy', 20000);

  const second = spawn(guiNodeExec, [DAEMON], { windowsHide: true, env, stdio: 'ignore' });
  cleanups.push(async () => { try { second.kill('SIGKILL'); } catch {} });
  assert.equal(await exitOf(second), 3, 'a healthy owner is never fought');
  assert.match(readLog(fixture.log), /already listening .*refusing to start a second one/);
  assert.equal(await healthPid(fixture.socket), first.pid, 'the healthy owner still serves');
});

test('a dead owner yields the store: the daemon binds, writes owner.json, and a clean stop removes it', { timeout: 60000 }, async () => {
  const fixture = freshStore('hbr-gate-dead-');
  const daemon = spawn(guiNodeExec, [DAEMON], { windowsHide: true, env: chainEnv(fixture), stdio: 'ignore' });
  cleanups.push(async () => {
    try { daemon.kill('SIGKILL'); } catch {}
    fs.rmSync(fixture.store, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  const pid = await waitUntil(() => healthPid(fixture.socket), 'daemon never became healthy', 20000);
  assert.equal(pid, daemon.pid);

  const ownerPath = path.join(fixture.store, 'owner.json');
  const owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
  assert.equal(owner.not_liveness, true, 'owner.json says what it is NOT');
  assert.equal(owner.pid, daemon.pid);
  assert.equal(owner.watcher_pid, null, 'a direct spawn records no watcher: recover must never aim at an innocent parent');
  assert.equal(owner.exec, path.basename(guiNodeExec), 'exec names the real binary for the identity check');
  assert.ok(Math.abs(owner.started_at_epoch_ms - Date.now()) < 120000, 'started_at is the real process birth, not garbage');

  await requestVerb(fixture, 'shutdown');
  assert.ok(await waitGone(daemon.pid, 10000));
  assert.equal(fs.existsSync(ownerPath), false, 'a clean stop removes the kill-targeting record');
  assert.equal(await canConnect(fixture.socket), false);
});
