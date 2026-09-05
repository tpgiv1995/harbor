'use strict';

// THE CLI'S HANDOVER/RECOVER/STOP LANES (2026-08-30, r2-selfheal item 3),
// driven through the node runner per the cli.test porting rule (a shebang
// script is not executable on win32). The full-chain zero-drop proofs live in
// test/daemon/handover.test.js; these specs pin the CLI's refusals and the
// recover kill discipline, which is three-sided on purpose: the verified kill,
// the identity refusal, and the never-kill-healthy are each a distinct wrong
// if missing.

const { afterEach, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const { listenAddress } = require('../../src/daemon/paths.js');
const {
  DAEMON, CLI, guiNodeExec,
  alive, waitUntil, waitGone, canConnect, healthPid, freshStore, chainEnv, requestVerb,
} = require('../support/selfheal-harness.js');

const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

const runCli = (args, env, timeout = 120000) => spawnSync(guiNodeExec, [CLI, ...args], { env, encoding: 'utf8', timeout, windowsHide: true });
const lastJson = (result) => JSON.parse(result.stdout.trim().split('\n').pop());

async function muteStandIn(fixture) {
  const sockets = new Set();
  const server = net.createServer((socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {}); });
  await new Promise((resolve) => server.listen(listenAddress(fixture.socket), resolve));
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(fixture.store, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  return server;
}

test('stop exists, stops through the verb, and reports the released pipe', { timeout: 60000 }, async () => {
  const fixture = freshStore('hbr-cli-stop-');
  const daemon = spawn(guiNodeExec, [DAEMON], { windowsHide: true, env: chainEnv(fixture), stdio: 'ignore' });
  cleanups.push(async () => {
    try { daemon.kill('SIGKILL'); } catch {}
    fs.rmSync(fixture.store, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  await waitUntil(() => healthPid(fixture.socket), 'daemon never became healthy', 20000);

  const result = runCli(['stop', '--json'], chainEnv(fixture));
  assert.equal(result.status, 0, result.stderr);
  const verdict = lastJson(result);
  assert.equal(verdict.stopped, true);
  assert.equal(verdict.released, true, 'stop waits for the pipe to actually release');
  assert.equal(await canConnect(fixture.socket), false);
});

test('handover refuses a dead store and a mute incumbent, naming the right lane each time', { timeout: 60000 }, async () => {
  const dead = freshStore('hbr-cli-ho-dead-');
  cleanups.push(async () => fs.rmSync(dead.store, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  const deadResult = runCli(['handover', '--json'], chainEnv(dead));
  assert.equal(deadResult.status, 1, 'nothing to hand over is a refusal');
  assert.match(lastJson(deadResult).reason, /no daemon is serving this store/);

  const mute = freshStore('hbr-cli-ho-mute-');
  await muteStandIn(mute);
  const muteResult = runCli(['handover', '--json'], chainEnv(mute));
  assert.equal(muteResult.status, 1, 'a mute incumbent cannot yield');
  assert.match(lastJson(muteResult).reason, /run: harbor-sessiond recover/i);
  assert.equal(await canConnect(mute.socket), true, 'the refusal left the mute owner untouched');
});

test('handover swaps out a legacy incumbent that predates yield, via its shutdown verb', { timeout: 120000 }, async () => {
  // The FIRST real rollout's incumbent runs old code with no yield verb; the
  // runbook's own first swap depends on this fallback. The stand-in speaks
  // exactly the legacy protocol: answers health, refuses yield by name, exits
  // on shutdown.
  const fixture = freshStore('hbr-cli-ho-legacy-');
  const legacyPath = path.join(fixture.store, 'legacy-daemon.js');
  const harnessRoot = path.resolve(__dirname, '../..');
  fs.writeFileSync(legacyPath, `
    'use strict';
    const net = require('node:net');
    const { readRecords, writeRecord } = require(${JSON.stringify(path.join(harnessRoot, 'src/daemon/ndjson.js'))});
    const { listenAddress } = require(${JSON.stringify(path.join(harnessRoot, 'src/daemon/paths.js'))});
    const server = net.createServer((socket) => {
      socket.on('error', () => {});
      readRecords(socket, (record) => {
        if (record.type !== 'request') return;
        if (record.verb === 'health') { writeRecord(socket, { type: 'response', request_id: record.request_id, ok: true, result: { ok: true, pid: process.pid } }); return; }
        if (record.verb === 'shutdown') { writeRecord(socket, { type: 'response', request_id: record.request_id, ok: true, result: { stopping: true } }); setTimeout(() => process.exit(0), 50); return; }
        writeRecord(socket, { type: 'response', request_id: record.request_id, ok: false, error: 'unsupported verb: ' + record.verb });
      }, () => {});
    });
    server.listen(listenAddress(${JSON.stringify(fixture.socket)}));
  `);
  const legacy = spawn(guiNodeExec, [legacyPath], { windowsHide: true, stdio: 'ignore' });
  const env = chainEnv(fixture);
  cleanups.push(async () => {
    runCli(['stop', '--json'], env, 30000);
    try { legacy.kill('SIGKILL'); } catch {}
    fs.rmSync(fixture.store, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  await waitUntil(() => healthPid(fixture.socket), 'legacy stand-in never answered', 20000);

  const result = runCli(['handover', '--json'], env);
  assert.equal(result.status, 0, `handover must swap a legacy incumbent: ${result.stdout} ${result.stderr}`);
  const verdict = lastJson(result);
  cleanups.push(async () => { if (verdict.newPid) { try { process.kill(verdict.newPid, 'SIGKILL'); } catch {} } });
  assert.equal(verdict.handover, true);
  assert.equal(verdict.yielded, false, 'the verdict says the incumbent was stopped, not yielded');
  assert.equal(verdict.oldPid, legacy.pid);
  assert.ok(await waitGone(legacy.pid, 5000), 'the legacy incumbent exited on shutdown');
  assert.ok(verdict.newPid && verdict.newPid !== legacy.pid);
  assert.equal(verdict.healthy, true);
  assert.equal(await healthPid(fixture.socket), verdict.newPid, 'the new-code successor serves the store');
});

test('recover never kills a healthy owner', { timeout: 60000 }, async () => {
  const fixture = freshStore('hbr-cli-rec-ok-');
  const daemon = spawn(guiNodeExec, [DAEMON], { windowsHide: true, env: chainEnv(fixture), stdio: 'ignore' });
  cleanups.push(async () => {
    try { daemon.kill('SIGKILL'); } catch {}
    fs.rmSync(fixture.store, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  await waitUntil(() => healthPid(fixture.socket), 'daemon never became healthy', 20000);

  const result = runCli(['recover', '--json'], chainEnv(fixture));
  assert.equal(result.status, 0, result.stderr);
  const verdict = lastJson(result);
  assert.equal(verdict.healthy, true);
  assert.equal(verdict.recovered, false, 'nothing to recover');
  assert.ok(alive(daemon.pid), 'the healthy owner survives recover');
  assert.equal(await healthPid(fixture.socket), daemon.pid, 'and still serves');
});

test('recover refuses an identity mismatch: a recycled pid is never shot', { timeout: 120000 }, async () => {
  const fixture = freshStore('hbr-cli-rec-mismatch-');
  await muteStandIn(fixture);
  // The innocent bystander whose pid the stale owner.json names. Its exec
  // matches (same runner binary), so the discriminator under test is the
  // creation-time identity, exactly the recycled-pid shape.
  const innocent = spawn(guiNodeExec, ['-e', 'setInterval(() => {}, 1000);'], { windowsHide: true, stdio: 'ignore' });
  cleanups.push(async () => { try { innocent.kill('SIGKILL'); } catch {} });
  fs.writeFileSync(path.join(fixture.store, 'owner.json'), `${JSON.stringify({
    not_liveness: true,
    pid: innocent.pid,
    watcher_pid: null,
    boot_id: 'stale',
    bound_at: new Date().toISOString(),
    started_at_epoch_ms: Date.now() - 3600000,
    exec: path.basename(guiNodeExec),
  })}\n`);

  const env = chainEnv(fixture, { HARBOR_SESSIOND_RECOVER_CONFIRM_MS: '300' });
  const result = runCli(['recover', '--json'], env);
  assert.equal(result.status, 1, 'an unverifiable owner is a refusal');
  assert.match(lastJson(result).reason, /does not match the live process table/);
  assert.ok(alive(innocent.pid), 'the innocent process holding the recycled pid survives');
  assert.equal(await canConnect(fixture.socket), true, 'the mute pipe holder is left for a human');
});

test('recover kills a verified mute owner after two spaced strikes and starts a fresh daemon', { timeout: 120000 }, async () => {
  const fixture = freshStore('hbr-cli-rec-kill-');
  const env = chainEnv(fixture, { HARBOR_SESSIOND_RECOVER_CONFIRM_MS: '300' });
  // A REAL daemon that wrote its own owner.json on bind, then wedged.
  const daemon = spawn(guiNodeExec, [DAEMON], { windowsHide: true, env, stdio: 'ignore' });
  cleanups.push(async () => {
    runCli(['stop', '--json'], env, 30000);
    try { daemon.kill('SIGKILL'); } catch {}
    fs.rmSync(fixture.store, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  await waitUntil(() => healthPid(fixture.socket), 'daemon never became healthy', 20000);
  assert.deepEqual(await requestVerb(fixture, 'test-wedge'), { wedging: true });

  const result = runCli(['recover', '--json'], env);
  assert.equal(result.status, 0, `recover must succeed: ${result.stdout} ${result.stderr}`);
  const verdict = lastJson(result);
  cleanups.push(async () => { if (verdict.pid) { try { process.kill(verdict.pid, 'SIGKILL'); } catch {} } });
  assert.equal(verdict.recovered, true);
  assert.equal(verdict.healthy, true);
  assert.ok(await waitGone(daemon.pid, 5000), 'the verified wedged owner was put down');
  assert.ok(verdict.pid && verdict.pid !== daemon.pid, 'a fresh daemon serves the store');
  assert.equal(await healthPid(fixture.socket), verdict.pid);
});

test('recover shoots only a verified daemon-watch: a recycled watcher pid never hits an innocent (f8 H1)', { timeout: 120000 }, async () => {
  const fixture = freshStore('hbr-cli-rec-watcher-');
  const env = chainEnv(fixture, { HARBOR_SESSIOND_RECOVER_CONFIRM_MS: '300' });
  // The innocent is born BEFORE the daemon, so the age fence (watcher born no
  // later than its child) passes, and it runs the same exec as every keeper
  // and Harbor itself. Pre-fix, exec + age was the whole identity check and
  // this process died; the command line naming daemon-watch is what now
  // separates a real watcher from a keeper wearing a recycled pid.
  const innocent = spawn(guiNodeExec, ['-e', 'setInterval(() => {}, 1000);'], { windowsHide: true, stdio: 'ignore' });
  cleanups.push(async () => { try { innocent.kill('SIGKILL'); } catch {} });
  const daemon = spawn(guiNodeExec, [DAEMON], { windowsHide: true, env, stdio: 'ignore' });
  cleanups.push(async () => {
    runCli(['stop', '--json'], env, 30000);
    try { daemon.kill('SIGKILL'); } catch {}
    fs.rmSync(fixture.store, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  await waitUntil(() => healthPid(fixture.socket), 'daemon never became healthy', 20000);
  // Aim the stale watcher_pid at the innocent, keeping the daemon's own
  // honest owner fields: exactly what a recycled pid after a watcher death
  // looks like.
  const ownerPath = path.join(fixture.store, 'owner.json');
  const owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
  owner.watcher_pid = innocent.pid;
  fs.writeFileSync(ownerPath, `${JSON.stringify(owner)}\n`);
  assert.deepEqual(await requestVerb(fixture, 'test-wedge'), { wedging: true });

  const result = runCli(['recover', '--json'], env);
  assert.equal(result.status, 0, `recover must still recover the daemon: ${result.stdout} ${result.stderr}`);
  const verdict = lastJson(result);
  cleanups.push(async () => { if (verdict.pid) { try { process.kill(verdict.pid, 'SIGKILL'); } catch {} } });
  assert.equal(verdict.recovered, true);
  assert.ok(await waitGone(daemon.pid, 5000), 'the verified wedged daemon was put down');
  assert.ok(alive(innocent.pid), 'the innocent process wearing the recycled watcher pid must survive');
});
