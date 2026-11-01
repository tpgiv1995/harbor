'use strict';
const nodeTest = require('node:test');
// v1 process identity covers Windows and Linux only (macOS answers UNSUPPORTED_PLATFORM),
// so on any other platform every lane test registers as skipped instead of failing.
const SUPPORTED = ['win32', 'linux'].includes(process.platform);
const test = SUPPORTED ? nodeTest : (name) => nodeTest(name, { skip: 'harbor-lane v1 identifies processes on Windows and Linux only' }, () => {});
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { Pool } = require('../../src/shared/lane/pool.cjs');
const { git, sha, inside } = require('../../src/shared/lane/workspace.cjs');
const { identity, ownerState } = require('../../src/shared/lane/identity.cjs');
const identityLib = require('../../src/shared/lane/identity.cjs');
const cli = path.resolve(__dirname, '../../../bin/harbor-lane');
const worker = path.join(__dirname, 'worker.cjs');
const verifiedVolumes = new Map();
function fixtureVolume(root) {
  const stamp = identityLib.volumeStamp(root);
  if (!verifiedVolumes.has(stamp.dev)) verifiedVolumes.set(stamp.dev, identityLib.volumeIdentity(root));
  // Verify the test volume once, while retaining each fixture's real root identity.
  // Production init-repo and the real CLI cycle still run the OS registration check.
  return { ...verifiedVolumes.get(stamp.dev), ...stamp };
}

function fixture(t, { size = 1, maxWrites = 4, allowlist = ['node_modules'], register = true } = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'harbor-lane-test-'));
  const repo = path.join(root, 'repository'); const poolRoot = path.join(root, 'pool'); const dir = path.join(root, 'state');
  fs.mkdirSync(repo); fs.mkdirSync(poolRoot);
  const prior = { HARBOR_LANES_DIR: process.env.HARBOR_LANES_DIR, HARBOR_SESSIOND_DIR: process.env.HARBOR_SESSIOND_DIR, HARBOR_NO_DAEMON_START: process.env.HARBOR_NO_DAEMON_START };
  Object.assign(process.env, { HARBOR_LANES_DIR: dir, HARBOR_SESSIOND_DIR: path.join(root, 'unused-sessiond'), HARBOR_NO_DAEMON_START: '1' });
  t.after(() => {
    for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    assert(inside(fs.realpathSync.native(os.tmpdir()), root));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  });
  git(repo, ['init', '-b', 'main']); git(repo, ['config', 'user.name', 'Synthetic Tester']); git(repo, ['config', 'user.email', 'tester@example.invalid']);
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'initial\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\nignored/\n*.cache\nlink-out/\n');
  fs.writeFileSync(path.join(repo, 'package-lock.json'), '{"lockfileVersion":3,"packages":{}}\n');
  git(repo, ['add', '.']); git(repo, ['commit', '-qm', 'Synthetic base']);
  const base = sha(repo, 'HEAD'); const pool = new Pool({ identities: { ...identityLib, volumeIdentity: fixtureVolume } });
  if (register) pool.init({ repo: 'sample', path: repo, poolRoot, size, allowlist, maxWrites });
  const lease = (name = 'first', extra = {}) => pool.lease({ repo: 'sample', lane: name, branch: `work/${name}`, base, type: 'write', ownerPid: process.pid, ...extra });
  const release = lane => pool.release({ ...lane, final: sha(lane.path, 'HEAD') });
  return { root, repo, poolRoot, dir, base, pool, lease, release };
}
function throwsCode(fn, code) { assert.throws(fn, error => error.code === code, `expected ${code}`); }
function run(args, env = process.env) {
  const result = spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8', windowsHide: true, timeout: 120000 });
  assert.ifError(result.error);
  assert.equal(result.stderr, '');
  const lines = result.stdout.trim().split('\n'); assert.equal(lines.length, 1);
  return { exit: result.status, ...JSON.parse(lines[0]) };
}
function child(mode, f, lane = mode) {
  const result = spawnSync(process.execPath, [worker, mode, JSON.stringify({ repo: 'sample', lane, branch: `work/${lane}`, base: f.base, type: 'write' })], { env: process.env, windowsHide: true, encoding: 'utf8', timeout: 120000 });
  assert.ifError(result.error); assert.equal(result.stderr, '');
  return { exit: result.status, lease: result.stdout.trim() ? JSON.parse(result.stdout) : null };
}
function commit(cwd, text) {
  fs.writeFileSync(path.join(cwd, 'tracked.txt'), text); git(cwd, ['add', 'tracked.txt']); git(cwd, ['commit', '-qm', 'Synthetic change']); return sha(cwd, 'HEAD');
}

module.exports = { test, assert, fs, path, os, spawn, spawnSync, once, Pool, git, sha, inside, identity, ownerState, cli, worker, fixture, throwsCode, run, child, commit };
